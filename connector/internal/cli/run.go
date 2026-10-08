package cli

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net/netip"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"parallax/connector/internal/identity"
	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/link"
	"parallax/connector/internal/managed"
	"parallax/connector/internal/netscope"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/redact"
	"parallax/connector/internal/safetext"
	"parallax/connector/internal/session"
	"parallax/connector/internal/sshtarget"
	"parallax/connector/internal/state"
	"parallax/connector/internal/target"
	"parallax/connector/internal/version"
)

// maxAllowNet is the number of --allow-net ranges hello can carry.
const maxAllowNet = netscope.MaxRanges

// exitBudget is how long stopping the owned sessions may take when run exits (design §6).
const exitBudget = 10 * time.Second

// allowNet collects repeated --allow-net CIDR flags.
type allowNet []string

func (a *allowNet) String() string { return strings.Join(*a, ",") }

func (a *allowNet) Set(v string) error {
	p, err := netip.ParsePrefix(strings.TrimSpace(v))
	if err != nil {
		return fmt.Errorf("%q is not a CIDR range such as 10.0.0.0/8", v)
	}
	if len(*a) >= maxAllowNet {
		return fmt.Errorf("at most %d --allow-net ranges", maxAllowNet)
	}
	*a = append(*a, p.Masked().String())
	return nil
}

func run(ctx context.Context, args []string, env Env) error {
	flags := newFlags("run", env)
	var nets allowNet
	flags.Var(&nets, "allow-net", "also allow this private range, such as 10.20.0.0/16 (repeatable)")
	stateDir := flags.String("state-dir", "", "state directory (default: the one for this computer)")
	confirm := flags.Bool("confirm-sessions", false, "ask on this terminal before opening each session")
	managedMode := flags.Bool("managed", false, "run as a managed connector, configured only from the environment")
	if err := parse(flags, args); err != nil {
		return err
	}
	getenv := env.Getenv
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	if *managedMode {
		if len(nets) > 0 || *stateDir != "" || *confirm {
			return usageError{"run --managed is configured only from the environment; it takes no other flag"}
		}
		return runManaged(ctx, env, getenv)
	}
	scope, err := netscope.ParseScope(nets, getenv(netscope.EnvAllowNet))
	if err != nil {
		return usageError{fmt.Sprintf("%s: %v", netscope.EnvAllowNet, err)}
	}
	if *confirm && (env.IsTerminal == nil || !env.IsTerminal()) {
		return usageError{"--confirm-sessions needs a terminal to ask in; run the connector in a terminal"}
	}
	var store *state.Store
	if *stateDir != "" {
		dir, err := filepath.Abs(*stateDir)
		if err != nil {
			return usageError{err.Error()}
		}
		store = state.Open(dir)
	} else {
		s, err := openStore(env)
		if err != nil {
			return err
		}
		store = s
	}

	cfg, err := store.ReadConfig()
	if errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("this computer is not paired (no %s in %s). Pair it first: parallax-connector pair --server URL --code CODE",
			state.ConfigFile, store.Dir)
	}
	if err != nil {
		return err
	}
	data, err := store.ReadFile(state.IdentityFile)
	if err != nil {
		return fmt.Errorf("paired, but the identity key cannot be read (%v); pair again with --force", err)
	}
	id, err := identity.ParsePEM(data)
	if err != nil {
		return fmt.Errorf("paired, but the identity key is unusable (%v); pair again with --force", err)
	}
	hello := protocol.Hello{
		Version: version.String(),
		OS:      env.GOOS,
		Arch:    env.GOARCH,
		Mode:    cfg.Mode,
		// The design's personal-mode targets.
		Targets:      []string{protocol.TargetLocal, protocol.TargetSSH},
		Features:     features(env),
		NetworkScope: protocol.NetworkScope{CIDRs: scope.CIDRs(), Hosts: []string{}},
	}
	if cfg.Mode == "managed" {
		hello.Targets = []string{protocol.TargetManaged}
	}
	if _, err := protocol.Encode(&hello); err != nil {
		return fmt.Errorf("this computer cannot run the connector: %v", err)
	}

	out := env.Stdout
	jupyterLog := func(line string) { fmt.Fprintf(env.Stderr, "jupyter: %s\n", line) }
	remote := &sshtarget.Remote{
		SSH: &sshtarget.Target{
			Dialer:     &netscope.Dialer{Scope: scope},
			KnownHosts: &sshtarget.KnownHosts{Path: store.Path(state.KnownHostsFile)},
			Agent:      sshtarget.DialAgent,
			TTY:        hello.Features.TTY,
			Terminal:   sshtarget.NewTTY(),
			Log:        func(line string) { fmt.Fprintln(out, redact.Redact(line)) },
		},
		Log: jupyterLog,
	}
	mgrCfg := session.Config{
		Targets: map[string]target.Target{
			protocol.TargetLocal: &target.Local{OS: env.GOOS, Arch: env.GOARCH, Log: jupyterLog},
			protocol.TargetSSH:   remote,
		},
		// An owned remote server left by a crash is stopped over a non-interactive connection.
		SweepRemote: func(ctx context.Context, rec session.Record) error {
			return remote.SweepOrphan(ctx, rec.Target, rec.SessionID, rec.Process.PID, jupyter.DefaultStopTimes)
		},
	}
	if cfg.Mode == "managed" {
		mgrCfg.Targets = map[string]target.Target{}
		mgrCfg.SweepRemote = nil
	}
	if *confirm {
		mgrCfg.Confirm = newAsker(env.Stdin, out).ask
	}
	return serve(ctx, env, serving{
		store: store, name: cfg.Name, server: cfg.Server, connectorID: cfg.ConnectorID,
		identity: id, hello: hello, mgr: mgrCfg, confirm: *confirm,
	})
}

// runManaged is `run --managed` (design §12): everything from the environment, a scope that
// starts empty, pinned host keys, keys from the key store, `managed` targets only, no prompts.
func runManaged(ctx context.Context, env Env, getenv func(string) string) error {
	if env.GOOS == "windows" {
		return usageError{"run --managed runs on Linux or macOS; its secret files are judged by their POSIX permissions"}
	}
	cfg, err := managed.Load(getenv)
	if err != nil {
		return usageError{err.Error()}
	}
	store, err := openStore(env)
	if err != nil {
		return err
	}
	hello := protocol.Hello{
		Version: version.String(),
		OS:      env.GOOS,
		Arch:    env.GOARCH,
		Mode:    "managed",
		Targets: []string{protocol.TargetManaged},
		// No terminal and no agent: nothing is ever asked, and only the key store signs.
		Features:     protocol.Features{},
		NetworkScope: protocol.NetworkScope{CIDRs: cfg.Scope.CIDRs(), Hosts: cfg.Scope.Hosts()},
	}
	if _, err := protocol.Encode(&hello); err != nil {
		return fmt.Errorf("this computer cannot run the connector: %v", err)
	}
	out := env.Stdout
	mt := &managed.Target{
		Targets: cfg.Targets,
		Remote: &sshtarget.Remote{
			SSH: managed.NewSSH(cfg, func(line string) { fmt.Fprintln(out, redact.Redact(line)) }),
			Log: func(line string) { fmt.Fprintf(env.Stderr, "jupyter: %s\n", line) },
		},
	}
	fmt.Fprintf(out, "Managed connector %s, identity %s, targets %s.\n",
		cfg.ConnectorID, cfg.Identity.Fingerprint(), strings.Join(cfg.Targets.IDs(), ", "))
	return serve(ctx, env, serving{
		store: store, name: "managed connector " + cfg.ConnectorID, server: cfg.Server, connectorID: cfg.ConnectorID,
		identity: cfg.Identity, hello: hello,
		mgr: session.Config{
			Targets: map[string]target.Target{protocol.TargetManaged: mt},
			SweepRemote: func(ctx context.Context, rec session.Record) error {
				return mt.SweepOrphan(ctx, rec.Target, rec.SessionID, rec.Process.PID)
			},
		},
	})
}

// serving is what `run` links with, in either mode.
type serving struct {
	store       *state.Store
	name        string
	server      string
	connectorID string
	identity    *identity.Identity
	hello       protocol.Hello
	// mgr holds the targets, the sweep and the confirmation; serve fills in the rest.
	mgr     session.Config
	confirm bool
}

// serve holds the state directory's lock, keeps runtime.json current and keeps the link up until
// ctx ends or the link is revoked, stopping every owned session on the way out.
func serve(ctx context.Context, env Env, sv serving) error {
	store := sv.store
	lock, err := lockStore(store)
	if err != nil {
		return err
	}
	defer lock.Release()

	rec := &runtimeRecorder{store: store, env: env, rt: state.Runtime{
		V: 1, PID: os.Getpid(), StartedAt: stamp(env.Now()), Link: string(link.Connecting), Since: stamp(env.Now()),
	}}
	if err := rec.write(); err != nil {
		return err
	}
	defer store.Remove(state.RuntimeFile)

	out := env.Stdout
	fmt.Fprintf(out, "Connecting %q to %s.\n", sv.name, sv.server)
	if sv.confirm {
		fmt.Fprintln(out, "Each session will be shown here for you to allow or decline.")
	}
	mgrCfg := sv.mgr
	mgrCfg.Log, mgrCfg.Now, mgrCfg.Store, mgrCfg.OS = out, env.Now, store, env.GOOS
	mgr := session.New(ctx, mgrCfg)
	// Sessions an earlier run left: stopped ones wait for the first heartbeat, orphans are swept.
	mgr.Restore(ctx)
	// Ctrl-C, SIGTERM and a revoked link all end Run; every owned session is then stopped with
	// cause connector_exit (design §3, §6).
	defer func() {
		sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), exitBudget)
		mgr.Close(sctx)
		cancel()
	}()
	var mu sync.Mutex
	last := link.Connecting
	err = link.Run(ctx, link.Config{
		Origin:      sv.server,
		ConnectorID: sv.connectorID,
		Identity:    sv.identity,
		Hello:       sv.hello,
		HTTPClient:  env.HTTP,
		Handler:     mgr,
		Sessions:    mgr.Sessions,
		Now:         env.Now,
		OnEvent: func(e link.Event) {
			mu.Lock()
			defer mu.Unlock()
			rec.update(e)
			if e.State == last && e.State != link.Down {
				return
			}
			switch e.State {
			case link.Up:
				fmt.Fprintf(out, "Connected to %s. Press Ctrl+C to disconnect.\n", sv.server)
			case link.Down, link.Pending:
				fmt.Fprintf(out, "%s. Next attempt in %s.\n", redact.Redact(e.Message), e.Retry.Round(100*time.Millisecond))
			case link.Revoked, link.Rejected:
				// Run returns the explanation as its error.
			}
			last = e.State
		},
	})
	if err != nil {
		return err
	}
	fmt.Fprintln(out, "Stopped.")
	return nil
}

// features reports what this computer offers (hello.features).
func features(env Env) protocol.Features {
	getenv := env.Getenv
	if getenv == nil {
		getenv = func(string) string { return "" }
	}
	f := protocol.Features{TTY: env.IsTerminal != nil && env.IsTerminal()}
	switch env.GOOS {
	case "windows":
		if env.Stat != nil {
			_, err := env.Stat(`\\.\pipe\openssh-ssh-agent`)
			f.Agent = err == nil
		}
	default:
		f.Agent = getenv("SSH_AUTH_SOCK") != ""
	}
	if env.GOOS == "linux" && env.ReadFile != nil {
		if v, err := env.ReadFile("/proc/version"); err == nil {
			lower := strings.ToLower(string(v))
			f.WSL = strings.Contains(lower, "microsoft") || strings.Contains(lower, "wsl")
		}
	}
	return f
}

// asker asks the person at this terminal and reads one answer per question.
type asker struct {
	out   io.Writer
	lines chan string
	mu    sync.Mutex
}

func newAsker(in io.Reader, out io.Writer) *asker {
	a := &asker{out: out, lines: make(chan string)}
	go func() {
		sc := bufio.NewScanner(in)
		for sc.Scan() {
			a.lines <- sc.Text()
		}
		close(a.lines)
	}()
	return a
}

// ask prints the question and returns true only for an answer of y or yes before ctx ends.
func (a *asker) ask(ctx context.Context, question string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	fmt.Fprintf(a.out, "%s [y/N] ", question)
	select {
	case line, ok := <-a.lines:
		if !ok {
			fmt.Fprintln(a.out)
			return false
		}
		switch strings.ToLower(strings.TrimSpace(line)) {
		case "y", "yes":
			return true
		}
		return false
	case <-ctx.Done():
		fmt.Fprintln(a.out, "\nNo answer; declined.")
		return false
	}
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }

// runtimeRecorder keeps runtime.json in step with the link, for `status`.
type runtimeRecorder struct {
	store *state.Store
	env   Env
	rt    state.Runtime
}

func (r *runtimeRecorder) write() error {
	if err := r.rt.Validate(); err != nil {
		return err
	}
	data, err := json.MarshalIndent(r.rt, "", "  ")
	if err != nil {
		return err
	}
	return r.store.WritePrivate(state.RuntimeFile, append(data, '\n'))
}

func (r *runtimeRecorder) update(e link.Event) {
	if string(e.State) != r.rt.Link {
		r.rt.Link = string(e.State)
		r.rt.Since = stamp(r.env.Now())
	}
	switch e.State {
	case link.Up:
		r.rt.LastError = ""
	case link.Down, link.Pending, link.Revoked, link.Rejected:
		r.rt.LastError = safetext.Clip(safetext.Line(redact.Redact(e.Message)), 200)
	}
	if err := r.write(); err != nil {
		fmt.Fprintf(r.env.Stderr, "parallax-connector: could not update %s: %v\n", state.RuntimeFile, err)
	}
}

var _ flag.Value = (*allowNet)(nil)
