// Package cli is the parallax-connector command line: pair, run, status, unpair, doctor and
// version (docs/design/connector.md §3, §4, §13).
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
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"

	"golang.org/x/term"

	"parallax/connector/internal/doctor"
	"parallax/connector/internal/identity"
	"parallax/connector/internal/pairing"
	"parallax/connector/internal/redact"
	"parallax/connector/internal/state"
	"parallax/connector/internal/version"
)

// Exit statuses.
const (
	ExitOK    = 0
	ExitError = 1
	ExitUsage = 2
)

// Env is everything a command reads or writes outside its arguments.
type Env struct {
	Stdin          io.Reader
	Stdout, Stderr io.Writer
	GOOS, GOARCH   string
	StateDir       func() (string, error)
	Hostname       func() (string, error)
	// IsTerminal reports whether Stdin is a terminal a person can answer in.
	IsTerminal func() bool
	HTTP       *http.Client
	Now        func() time.Time
	Sleep      pairing.Sleeper
	// Doctor builds the doctor's environment for a state directory.
	Doctor func(store *state.Store, storeErr error) doctor.Env
	// Getenv, ReadFile and Stat let `run` describe this computer in hello; nil means unknown.
	Getenv   func(string) string
	ReadFile func(string) ([]byte, error)
	Stat     func(string) (fs.FileInfo, error)
}

// DefaultEnv is the real process.
func DefaultEnv() Env {
	return Env{
		Stdin:      os.Stdin,
		Stdout:     os.Stdout,
		Stderr:     os.Stderr,
		GOOS:       runtime.GOOS,
		GOARCH:     runtime.GOARCH,
		StateDir:   state.Dir,
		Hostname:   os.Hostname,
		IsTerminal: func() bool { return term.IsTerminal(int(os.Stdin.Fd())) },
		HTTP:       pairing.NewHTTPClient(),
		Now:        time.Now,
		Sleep:      pairing.Sleep,
		Doctor: func(store *state.Store, storeErr error) doctor.Env {
			env := doctor.DefaultEnv()
			env.Store, env.StoreErr = store, storeErr
			return env
		},
		Getenv:   os.Getenv,
		ReadFile: os.ReadFile,
		Stat:     os.Stat,
	}
}

const usage = `Usage: parallax-connector <command> [flags]

Commands:
  pair --server URL --code XXXX-XXXX [--name NAME] [--force]
                    pair this computer with your Parallax account
  run [--allow-net CIDR]... [--state-dir DIR]
                    connect this computer to Parallax and keep it connected
  status [--json]   show whether this computer is paired, and with which server
  unpair [--yes]    revoke this computer in Parallax and delete its identity
  doctor [--json]   check what the connector needs on this computer
  version           print the version
`

// usageError is a mistake in the command line; it exits with status 2.
type usageError struct{ msg string }

func (e usageError) Error() string { return e.msg }

// Main runs one command and returns the exit status.
func Main(ctx context.Context, args []string, env Env) int {
	if len(args) == 0 {
		fmt.Fprint(env.Stderr, usage)
		return ExitUsage
	}
	var err error
	code := ExitOK
	switch args[0] {
	case "pair":
		err = pair(ctx, args[1:], env)
	case "run":
		err = run(ctx, args[1:], env)
	case "status":
		err = status(args[1:], env)
	case "unpair":
		err = unpair(ctx, args[1:], env)
	case "doctor":
		code, err = runDoctor(ctx, args[1:], env)
	case "version", "--version":
		err = printVersion(args[1:], env)
	case "help", "-h", "-help", "--help":
		fmt.Fprint(env.Stdout, usage)
		return ExitOK
	default:
		fmt.Fprintf(env.Stderr, "parallax-connector: unknown command %q\n\n%s", args[0], usage)
		return ExitUsage
	}
	if err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return ExitOK
		}
		fmt.Fprintf(env.Stderr, "parallax-connector: %s\n", redact.Redact(err.Error()))
		var ue usageError
		if errors.As(err, &ue) {
			return ExitUsage
		}
		return ExitError
	}
	return code
}

func newFlags(name string, env Env) *flag.FlagSet {
	f := flag.NewFlagSet(name, flag.ContinueOnError)
	f.SetOutput(env.Stderr)
	return f
}

func parse(f *flag.FlagSet, args []string) error {
	if err := f.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return err
		}
		return usageError{err.Error()}
	}
	if f.NArg() != 0 {
		return usageError{fmt.Sprintf("%s: unexpected argument %q", f.Name(), f.Arg(0))}
	}
	return nil
}

func openStore(env Env) (*state.Store, error) {
	dir, err := env.StateDir()
	if err != nil {
		return nil, err
	}
	return state.Open(dir), nil
}

// lockStore takes run.lock for a command that changes the state directory. runtime.json is
// written by `run` only while it holds the lock, so one found by a new holder is stale and goes;
// `status` therefore reads a held lock with runtime.json as a running connector.
func lockStore(s *state.Store) (*state.Lock, error) {
	lock, err := s.Lock()
	if errors.Is(err, state.ErrLocked) {
		return nil, fmt.Errorf("another parallax-connector process (perhaps `run`) is using %s; stop it first", s.Dir)
	}
	if err != nil {
		return nil, err
	}
	if err := s.Remove(state.RuntimeFile); err != nil {
		lock.Release()
		return nil, err
	}
	return lock, nil
}

func pair(ctx context.Context, args []string, env Env) error {
	flags := newFlags("pair", env)
	server := flags.String("server", "", "address of Parallax, such as https://parallax.example.org")
	code := flags.String("code", "", "the pairing code shown in Parallax, such as K7M2-Q9XD")
	name := flags.String("name", "", "name for this computer in Parallax (default: its host name)")
	force := flags.Bool("force", false, "replace an existing identity on this computer")
	if err := parse(flags, args); err != nil {
		return err
	}
	if *server == "" || *code == "" {
		return usageError{"pair needs --server and --code"}
	}
	origin, err := pairing.NormaliseServer(*server)
	if err != nil {
		return usageError{err.Error()}
	}
	normalCode, err := pairing.NormaliseCode(*code)
	if err != nil {
		return usageError{err.Error()}
	}
	deviceName := *name
	if deviceName == "" {
		host, _ := env.Hostname()
		deviceName = pairing.DefaultName(host)
	} else if err := pairing.CheckName(deviceName); err != nil {
		return usageError{err.Error()}
	}

	store, err := openStore(env)
	if err != nil {
		return err
	}
	lock, err := lockStore(store)
	if err != nil {
		return err
	}
	defer lock.Release()

	hasKey, err := store.Exists(state.IdentityFile)
	if err != nil {
		return err
	}
	hasConfig, err := store.Exists(state.ConfigFile)
	if err != nil {
		return err
	}
	if (hasKey || hasConfig) && !*force {
		return fmt.Errorf("this computer already has a connector identity in %s. "+
			"To pair it again, run `parallax-connector unpair` first, or pair with --force and then revoke the old device in Parallax", store.Dir)
	}

	id, err := identity.Generate()
	if err != nil {
		return err
	}
	req := pairing.PairRequest{
		Code:      normalCode,
		PublicKey: id.PublicKeyBase64(),
		Name:      deviceName,
		OS:        env.GOOS,
		Arch:      env.GOARCH,
		Version:   version.String(),
	}
	if err := req.Validate(); err != nil {
		return err
	}
	out := env.Stdout
	fmt.Fprintf(out, "Pairing this computer with %s as %q.\n", origin, deviceName)
	fmt.Fprintf(out, "Fingerprint: %s\n", id.Fingerprint())

	client := &pairing.Client{Origin: origin, HTTP: env.HTTP, Now: env.Now}
	resp, err := client.Pair(ctx, req, id.Fingerprint())
	switch {
	case errors.Is(err, pairing.ErrNotFound):
		return errors.New("the code was not accepted: it is wrong, already used or expired. Create a new code in Parallax and try again")
	case err != nil:
		return fmt.Errorf("pairing failed: %w", err)
	}
	approveBy, _ := time.Parse(time.RFC3339, resp.ApproveBy)
	fmt.Fprintf(out, "Waiting for approval. In Parallax, check that the new device shows the fingerprint above, then approve it before %s.\n",
		approveBy.UTC().Format("15:04 UTC"))

	err = client.WaitForApproval(ctx, id, resp, env.Sleep)
	switch {
	case errors.Is(err, pairing.ErrRejected):
		return errors.New("the device was rejected in Parallax. Nothing was saved on this computer")
	case errors.Is(err, pairing.ErrExpired):
		return errors.New("the device was not approved in time. Nothing was saved on this computer; create a new code and pair again")
	case errors.Is(err, context.Canceled):
		return errors.New("pairing cancelled. Nothing was saved on this computer; the unapproved device expires in Parallax on its own")
	case err != nil:
		return fmt.Errorf("waiting for approval failed: %w. Nothing was saved on this computer", err)
	}

	pemBytes, err := id.MarshalPEM()
	if err != nil {
		return err
	}
	if err := store.WritePrivate(state.IdentityFile, pemBytes); err != nil {
		return err
	}
	if *force {
		// Records of the replaced identity no longer belong to this connector.
		if err := store.Remove(state.SessionsFile, state.RuntimeFile); err != nil {
			return err
		}
	}
	cfg := state.Config{
		V:           1,
		Server:      origin,
		ConnectorID: resp.ConnectorID,
		Name:        deviceName,
		PairedAt:    env.Now().UTC().Format(time.RFC3339),
		Mode:        "personal",
	}
	if err := store.WriteConfig(cfg); err != nil {
		return err
	}
	fmt.Fprintf(out, "Paired as %q (%s). Run `parallax-connector run` to connect this computer.\n", deviceName, resp.ConnectorID)
	if *force && (hasKey || hasConfig) {
		fmt.Fprintln(out, "The previous identity was replaced; revoke the old device in Parallax.")
	}
	return nil
}

type statusReport struct {
	Paired      bool   `json:"paired"`
	StateDir    string `json:"stateDir"`
	Server      string `json:"server,omitempty"`
	ConnectorID string `json:"connectorId,omitempty"`
	Name        string `json:"name,omitempty"`
	PairedAt    string `json:"pairedAt,omitempty"`
	Mode        string `json:"mode,omitempty"`
	Fingerprint string `json:"fingerprint,omitempty"`
	Running     bool   `json:"running"`
	Busy        bool   `json:"busy,omitempty"`
	Link        string `json:"link,omitempty"`
	LinkSince   string `json:"linkSince,omitempty"`
	LastError   string `json:"lastError,omitempty"`
	Sessions    *int   `json:"sessions,omitempty"`
}

func status(args []string, env Env) error {
	flags := newFlags("status", env)
	asJSON := flags.Bool("json", false, "print JSON")
	if err := parse(flags, args); err != nil {
		return err
	}
	store, err := openStore(env)
	if err != nil {
		return err
	}
	rep := statusReport{StateDir: store.Dir}
	cfg, err := store.ReadConfig()
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	if cfg != nil {
		rep.Paired = true
		rep.Server, rep.ConnectorID, rep.Name, rep.PairedAt, rep.Mode = cfg.Server, cfg.ConnectorID, cfg.Name, cfg.PairedAt, cfg.Mode
		data, err := store.ReadFile(state.IdentityFile)
		if err != nil {
			return fmt.Errorf("paired, but the identity key cannot be read (%v); pair again with --force", err)
		}
		id, err := identity.ParsePEM(data)
		if err != nil {
			return fmt.Errorf("paired, but the identity key is unusable (%v); pair again with --force", err)
		}
		rep.Fingerprint = id.Fingerprint()
	}
	// `run` holds run.lock while alive and keeps runtime.json only then; `pair` and `unpair` take
	// the lock too but remove runtime.json. So a held lock with runtime.json is a running
	// connector, a held lock without it is another command, and a lock we can take means any
	// runtime.json is stale. Only an existing run.lock is tried, so status never creates anything.
	if ok, _ := store.Exists(state.LockFile); ok {
		lock, err := store.Lock()
		switch {
		case errors.Is(err, state.ErrLocked):
			if rt, err := store.ReadRuntime(); err == nil {
				n := rt.Sessions
				rep.Running = true
				rep.Link, rep.LinkSince, rep.LastError, rep.Sessions = rt.Link, rt.Since, rt.LastError, &n
			} else {
				rep.Busy = true
			}
		case err == nil:
			lock.Release()
		}
	}

	if *asJSON {
		enc := json.NewEncoder(env.Stdout)
		enc.SetIndent("", "  ")
		return enc.Encode(rep)
	}
	out := env.Stdout
	if !rep.Paired {
		fmt.Fprintf(out, "Not paired. State directory: %s\n", rep.StateDir)
		fmt.Fprintln(out, "Pair with: parallax-connector pair --server URL --code CODE")
		return nil
	}
	fmt.Fprintf(out, "Paired with %s as %q.\n", rep.Server, rep.Name)
	fmt.Fprintf(out, "Connector id: %s\n", rep.ConnectorID)
	fmt.Fprintf(out, "Fingerprint:  %s\n", rep.Fingerprint)
	fmt.Fprintf(out, "Paired at:    %s\n", rep.PairedAt)
	fmt.Fprintf(out, "State:        %s\n", rep.StateDir)
	switch {
	case rep.Busy:
		fmt.Fprintln(out, "Not running; another parallax-connector command (pair or unpair) is using the state directory.")
	case !rep.Running:
		fmt.Fprintln(out, "Not running. Start it with: parallax-connector run")
	default:
		fmt.Fprintf(out, "Running. Link %s since %s; %d session(s).\n", rep.Link, rep.LinkSince, *rep.Sessions)
		if rep.LastError != "" {
			fmt.Fprintf(out, "Last error: %s\n", redact.Redact(rep.LastError))
		}
	}
	return nil
}

// unpairTimeout bounds the signed unpair request; local deletion follows either way.
const unpairTimeout = 15 * time.Second

func unpair(ctx context.Context, args []string, env Env) error {
	flags := newFlags("unpair", env)
	yes := flags.Bool("yes", false, "do not ask for confirmation")
	if err := parse(flags, args); err != nil {
		return err
	}
	store, err := openStore(env)
	if err != nil {
		return err
	}
	out := env.Stdout
	cfg, cfgErr := store.ReadConfig()
	if cfgErr != nil && !errors.Is(cfgErr, fs.ErrNotExist) {
		fmt.Fprintf(env.Stderr, "config.json is unusable (%v); deleting the local state only.\n", cfgErr)
	}
	hasKey, err := store.Exists(state.IdentityFile)
	if err != nil {
		return err
	}
	if cfg == nil && !hasKey && errors.Is(cfgErr, fs.ErrNotExist) {
		fmt.Fprintln(out, "This computer is not paired; nothing to do.")
		return nil
	}

	if !*yes {
		if !env.IsTerminal() {
			return usageError{"unpair asks for confirmation; pass --yes when there is no terminal"}
		}
		target := "Parallax"
		if cfg != nil {
			target = cfg.Server
		}
		fmt.Fprintf(out, "Unpair this computer from %s and delete its identity? [y/N] ", target)
		line, _ := bufio.NewReader(env.Stdin).ReadString('\n')
		if a := strings.ToLower(strings.TrimSpace(line)); a != "y" && a != "yes" {
			fmt.Fprintln(out, "Cancelled; nothing changed.")
			return nil
		}
	}

	lock, err := lockStore(store)
	if err != nil {
		return err
	}

	revokeHint := "Revoke this device in Parallax (your connected computers) so it cannot be used again."
	if cfg != nil {
		var id *identity.Identity
		if data, err := store.ReadFile(state.IdentityFile); err == nil {
			id, err = identity.ParsePEM(data)
			if err != nil {
				id = nil
			}
		}
		if id == nil {
			fmt.Fprintf(out, "The identity key is missing or unusable, so %s could not be told. %s\n", cfg.Server, revokeHint)
		} else {
			reqCtx, cancel := context.WithTimeout(ctx, unpairTimeout)
			client := &pairing.Client{Origin: cfg.Server, HTTP: env.HTTP, Now: env.Now}
			err := client.Unpair(reqCtx, id, cfg.ConnectorID)
			cancel()
			var api *pairing.APIError
			switch {
			case err == nil:
				fmt.Fprintf(out, "%s revoked this device.\n", cfg.Server)
			case errors.As(err, &api) && !pairing.Transient(err):
				fmt.Fprintf(out, "%s did not accept the request (%v); it may already be revoked. %s\n", cfg.Server, err, revokeHint)
			default:
				fmt.Fprintf(out, "Could not reach %s (%v). %s\n", cfg.Server, err, revokeHint)
			}
		}
	}

	if cfg == nil && cfgErr != nil && !errors.Is(cfgErr, fs.ErrNotExist) {
		fmt.Fprintf(out, "The server could not be told because config.json is unusable. %s\n", revokeHint)
	}

	// run.lock stays: deleting it would let a process that opened the old file lock an unlinked
	// copy while another creates a new one, and two holders could then use the directory.
	removeErr := store.Remove(state.IdentityFile, state.ConfigFile, state.SessionsFile, state.RuntimeFile, state.KnownHostsFile)
	lockErr := lock.Release()
	if err := errors.Join(removeErr, lockErr); err != nil {
		return fmt.Errorf("could not delete the local state in %s: %w", store.Dir, err)
	}
	fmt.Fprintf(out, "Deleted this computer's identity and connector state in %s.\n", store.Dir)
	fmt.Fprintln(out, "This does not revoke your SSH accounts or keys on other computers; remove that access there if you no longer want it.")
	return nil
}

func runDoctor(ctx context.Context, args []string, env Env) (int, error) {
	flags := newFlags("doctor", env)
	asJSON := flags.Bool("json", false, "print JSON")
	if err := parse(flags, args); err != nil {
		return 0, err
	}
	store, storeErr := openStore(env)
	report := doctor.Run(ctx, env.Doctor(store, storeErr))
	if *asJSON {
		enc := json.NewEncoder(env.Stdout)
		enc.SetIndent("", "  ")
		if err := enc.Encode(report); err != nil {
			return 0, err
		}
	} else if err := doctor.WriteText(env.Stdout, report); err != nil {
		return 0, err
	}
	if report.Failed() {
		return ExitError, nil
	}
	return ExitOK, nil
}

func printVersion(args []string, env Env) error {
	flags := newFlags("version", env)
	if err := parse(flags, args); err != nil {
		return err
	}
	fmt.Fprintf(env.Stdout, "parallax-connector %s (commit %s, %s/%s)\n", version.String(), version.Commit, env.GOOS, env.GOARCH)
	return nil
}
