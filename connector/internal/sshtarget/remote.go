package sshtarget

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"parallax/connector/internal/cause"
	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/redact"
	"parallax/connector/internal/target"
)

// Remote is the `ssh` target (docs/design/connector.md §5.1, §6): after the stages of Check it
// runs runtime, notebook_auth and kernels by exec over the same connection, and opens sessions
// whose Jupyter server runs on the host, reached only through a tunnel to the session's fixed
// 127.0.0.1 port. A host without a POSIX shell is shell_unsupported for every operation.
type Remote struct {
	// SSH runs the stages up to forwarding and makes the connections.
	SSH *Target
	// Log receives every line the remote Jupyter prints, redacted.
	Log func(line string)
	// ReadyTimeout is the start poll's limit (design §6: 30 s); PollInterval its step (250 ms).
	ReadyTimeout, PollInterval time.Duration
	// Keepalive is the keepalive interval (15 s) and KeepaliveLoss how long it may go
	// unanswered before the transport counts as lost (45 s), design §5.3 and §5.5.
	Keepalive, KeepaliveLoss time.Duration
	// ReuseFor is how long a connection that passed Test connection is kept for the Connect
	// that follows (120 s, design §5.3).
	ReuseFor time.Duration
	// Interfaces reads this computer's network interfaces for the loss causes; nil reads them.
	Interfaces func() (cause.Snapshot, error)
	// Ports picks the port of a start attempt; nil picks one at random in 20000–59999.
	Ports func() int

	mu     sync.Mutex
	parked map[string]*parkedConn
}

var _ target.Target = (*Remote)(nil)

// Limits of design §6.
const (
	startAttempts    = 5
	portLow, portHi  = 20000, 59999
	runtimeDeadline  = 45 * time.Second
	defaultReady     = 30 * time.Second
	defaultPoll      = 250 * time.Millisecond
	defaultKeepalive = 15 * time.Second
	defaultLoss      = 45 * time.Second
	defaultReuse     = 120 * time.Second
	stopBudget       = 30 * time.Second
	maxAttachable    = 16
)

func (r *Remote) readyTimeout() time.Duration { return orDefault(r.ReadyTimeout, defaultReady) }
func (r *Remote) pollInterval() time.Duration { return orDefault(r.PollInterval, defaultPoll) }
func (r *Remote) keepalive() time.Duration    { return orDefault(r.Keepalive, defaultKeepalive) }
func (r *Remote) keepaliveLoss() time.Duration {
	return orDefault(r.KeepaliveLoss, defaultLoss)
}
func (r *Remote) reuseFor() time.Duration { return orDefault(r.ReuseFor, defaultReuse) }

func orDefault(d, def time.Duration) time.Duration {
	if d > 0 {
		return d
	}
	return def
}

func (r *Remote) port() int {
	if r.Ports != nil {
		return r.Ports()
	}
	n, err := rand.Int(rand.Reader, big.NewInt(portHi-portLow+1))
	if err != nil {
		return portLow
	}
	return portLow + int(n.Int64())
}

func (r *Remote) interfaces() cause.Snapshot {
	read := r.Interfaces
	if read == nil {
		read = cause.Interfaces
	}
	s, _ := read()
	return s
}

func (r *Remote) logLine(line string) {
	if r.Log != nil {
		r.Log(line)
	}
}

func login(rt protocol.Runtime) bool { return rt.Login != nil && *rt.Login }

// Test runs the eight stages of an `ssh` target. It starts no server, runs no cell and writes no
// file; a connection that passed is kept for the Connect that follows (design §5.3).
func (r *Remote) Test(ctx context.Context, req *protocol.TestConnection, progress target.Progress) *protocol.TestResult {
	s := &target.Stages{Progress: progress}
	res := &protocol.TestResult{RequestID: req.RequestID}
	conn := r.SSH.Check(ctx, req, s)
	rt := req.Runtime
	resolved := resolvedWorkspace(s.List)
	var env *protocol.Environment
	var version string
	var server jupyter.Server

	s.Run(ctx, "runtime", func(ctx context.Context) (*protocol.StageData, error) {
		osName, err := checkPOSIX(ctx, conn.Client)
		if err != nil {
			return nil, err
		}
		env = &protocol.Environment{OS: osName}
		if rt.Mode == protocol.RuntimeStart {
			info, err := probe(ctx, conn.Client, login(rt), rt.Python)
			if err != nil {
				return nil, err
			}
			version, env.Runtime = info.version, info.runtime()
			return &protocol.StageData{State: "startable", Version: cleanVersion(info.version)}, nil
		}
		srv, err := findAttach(ctx, conn.Client, rt.Port, resolved)
		if err != nil {
			return nil, err
		}
		server, version = srv, srv.Version
		data := &protocol.StageData{State: "running", Version: cleanVersion(srv.Version)}
		if validPath(srv.RootDir) {
			data.RootDir = srv.RootDir
		}
		return data, nil
	})
	var client *jupyter.Client
	s.Run(ctx, "notebook_auth", func(ctx context.Context) (*protocol.StageData, error) {
		if rt.Mode == protocol.RuntimeStart {
			return nil, target.Skipped("not_started")
		}
		if server.Token == "" {
			return nil, &target.Failure{Code: protocol.CodeTokenUnavailable, Detail: fmt.Sprintf("the server on port %d has no token the connector can read", server.Port)}
		}
		client = jupyter.NewClient(server.Port, server.Token, tunnelDial(conn.Client, server.Port))
		return nil, client.Status(ctx)
	})
	if client != nil {
		defer client.CloseIdle()
	}
	s.Run(ctx, "kernels", func(ctx context.Context) (*protocol.StageData, error) {
		var specs []protocol.Kernelspec
		var err error
		source := "cli"
		if rt.Mode == protocol.RuntimeStart {
			specs, err = cliKernelspecs(ctx, conn.Client, login(rt), rt.Python)
		} else {
			source = "service"
			specs, err = client.Kernelspecs(ctx)
		}
		if err != nil {
			return nil, asFailure(err, protocol.CodeNoKernelspec)
		}
		res.Kernelspecs = specs
		return &protocol.StageData{Source: source}, checkKernel(specs, rt.KernelName)
	})
	res.Stages = s.List
	res.Outcome = s.Outcome()
	res.JupyterVersion = cleanVersion(version)
	res.Environment = env
	if conn == nil {
		return res
	}
	if rt.Mode == protocol.RuntimeStart && s.BlockedBy() == "" && ctx.Err() == nil {
		// So the person can choose Attach instead; best effort, never a failure.
		lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		if servers, err := listServers(lctx, conn.Client, login(rt), rt.Python); err == nil {
			res.Attachable = attachable(servers)
		}
		cancel()
	}
	if res.Outcome == "ready" || res.Outcome == "ready_to_start" {
		r.park(req.Target, conn, resolved)
	} else {
		conn.Close()
	}
	return res
}

// resolvedWorkspace is the canonical workspace the workspace stage reported.
func resolvedWorkspace(stages []protocol.Stage) string {
	for _, st := range stages {
		if st.Name == "workspace" && st.Status == "ok" && st.Data != nil {
			return st.Data.ResolvedPath
		}
	}
	return ""
}

// Open starts Jupyter on the host or attaches to a server running there, reached through the
// session's tunnel. The connection that passed Test connection within ReuseFor is reused, so a
// second factor is asked once, not twice.
func (r *Remote) Open(ctx context.Context, req *protocol.OpenSession) (*target.Runtime, error) {
	conn, resolved, err := r.connection(ctx, req)
	if err != nil {
		return nil, err
	}
	rr := &remoteRuntime{r: r, target: req.Target, runtime: req.Runtime, sessionID: req.SessionID,
		owned: req.Runtime.Mode == protocol.RuntimeStart, conn: conn,
		losses: make(chan target.Loss, 4), closed: make(chan struct{})}
	rctx, cancel := context.WithTimeout(ctx, runtimeDeadline)
	defer cancel()
	out, err := rr.open(rctx, resolved)
	if err != nil {
		if rctx.Err() != nil && ctx.Err() == nil {
			var f *target.Failure
			if !errors.As(err, &f) {
				err = target.DeadlineFailure("runtime", runtimeDeadline)
			}
		}
		rr.Close()
		return nil, err
	}
	rr.watch()
	return out, nil
}

// open runs the runtime, notebook_auth and kernels checks of Connect and starts or attaches.
func (rr *remoteRuntime) open(ctx context.Context, resolved string) (*target.Runtime, error) {
	rt := rr.runtime
	client := rr.conn.Client
	osName, err := checkPOSIX(ctx, client)
	if err != nil {
		return nil, err
	}
	env := &protocol.Environment{OS: osName}
	out := &target.Runtime{Owned: rr.owned, Environment: env, Remote: rr}
	if !rr.owned {
		srv, err := findAttach(ctx, client, rt.Port, resolved)
		if err != nil {
			return nil, err
		}
		if srv.Token == "" {
			return nil, &target.Failure{Code: protocol.CodeTokenUnavailable, Detail: fmt.Sprintf("the server on port %d has no token the connector can read", srv.Port)}
		}
		root, err := posixContentRoot(srv.RootDir, resolved)
		if err != nil {
			return nil, err
		}
		rr.port, rr.token = srv.Port, srv.Token
		redact.Register(rr.token)
		rr.client = jupyter.NewClient(rr.port, rr.token, rr.dial)
		out.Client, out.ContentRoot, out.JupyterVersion = rr.client, root, cleanVersion(srv.Version)
		if err := rr.client.Status(ctx); err != nil {
			return nil, asFailure(err, protocol.CodeNotebookServiceUnreachable)
		}
	} else {
		info, err := probe(ctx, client, login(rt), rt.Python)
		if err != nil {
			return nil, err
		}
		env.Runtime = info.runtime()
		out.JupyterVersion = cleanVersion(info.version)
		token, err := jupyter.NewToken()
		if err != nil {
			return nil, &target.Failure{Code: protocol.CodeInternal, Detail: "no randomness for a token"}
		}
		rr.token = token
		redact.Register(token)
		if err := rr.start(ctx, resolved); err != nil {
			return nil, err
		}
		out.Client = rr.client
	}
	specs, err := rr.client.Kernelspecs(ctx)
	if err == nil {
		err = checkKernel(specs, rt.KernelName)
	}
	if err != nil {
		if rr.owned {
			rr.stopAfterFailure(ctx)
		}
		return nil, asFailure(err, protocol.CodeNotebookServiceUnreachable)
	}
	out.Kernelspecs = specs
	if v, err := rr.client.Version(ctx); err == nil && out.JupyterVersion == "" {
		out.JupyterVersion = cleanVersion(v)
	}
	return out, nil
}

// parkedConn is a connection that passed Test connection, kept for the Connect that follows.
type parkedConn struct {
	conn     *Conn
	resolved string
	timer    *time.Timer
}

// connKey names a connection: the same account on the same route with the same credentials and
// workspace (the protocol has no connection id; design §5.3).
func connKey(t protocol.Target) string {
	k := struct {
		Host      string
		Port      int
		User      string
		Auth      *protocol.AuthRef
		Jump      *protocol.Hop
		Workspace string
	}{strings.ToLower(t.Host), t.Port, t.User, t.Auth, t.Jump, t.Workspace}
	b, _ := json.Marshal(k)
	return string(b)
}

// park keeps a tested connection for ReuseFor, replacing an older one for the same key.
func (r *Remote) park(t protocol.Target, conn *Conn, resolved string) {
	key := connKey(t)
	p := &parkedConn{conn: conn, resolved: resolved}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.parked == nil {
		r.parked = map[string]*parkedConn{}
	}
	if old := r.parked[key]; old != nil {
		old.timer.Stop()
		old.conn.Close()
	}
	r.parked[key] = p
	p.timer = time.AfterFunc(r.reuseFor(), func() {
		r.mu.Lock()
		if r.parked[key] == p {
			delete(r.parked, key)
		}
		r.mu.Unlock()
		p.conn.Close()
	})
}

// take returns the parked connection for a target, once, if it still answers.
func (r *Remote) take(ctx context.Context, t protocol.Target) (*Conn, string) {
	key := connKey(t)
	r.mu.Lock()
	p := r.parked[key]
	if p != nil && p.timer.Stop() {
		delete(r.parked, key)
	} else {
		p = nil
	}
	r.mu.Unlock()
	if p == nil {
		return nil, ""
	}
	if keepaliveOK(ctx, p.conn.Client, 5*time.Second) {
		return p.conn, p.resolved
	}
	p.conn.Close()
	return nil, ""
}

// connection is the authenticated connection for an open_session and its canonical workspace:
// the tested one when it is still parked, else a fresh run of the stages up to forwarding, whose
// first failure is the open's failure.
func (r *Remote) connection(ctx context.Context, req *protocol.OpenSession) (*Conn, string, error) {
	if conn, resolved := r.take(ctx, req.Target); conn != nil {
		return conn, resolved, nil
	}
	s := &target.Stages{}
	tr := &protocol.TestConnection{RequestID: req.RequestID, Target: req.Target, Runtime: req.Runtime}
	conn := r.SSH.Check(ctx, tr, s)
	if conn == nil {
		return nil, "", firstFailure(s.List)
	}
	return conn, resolvedWorkspace(s.List), nil
}

// keepaliveOK sends keepalive@openssh.com and reports whether the host answered in time; any
// answer, even a refusal, proves the transport is alive.
func keepaliveOK(ctx context.Context, client *ssh.Client, limit time.Duration) bool {
	done := make(chan error, 1)
	go func() {
		_, _, err := client.SendRequest("keepalive@openssh.com", true, nil)
		done <- err
	}()
	t := time.NewTimer(limit)
	defer t.Stop()
	select {
	case err := <-done:
		return err == nil
	case <-t.C:
		return false
	case <-ctx.Done():
		return false
	}
}

// cmdResult is one remote command's outcome.
type cmdResult struct {
	stdout, stderr string
	// status is the exit status, or -1 when the command ended without one.
	status int
}

// runCommand runs one command on the host with stdin as its standard input. err is set only when
// the command could not be run at all (no session channel, exec refused, transport gone).
func runCommand(ctx context.Context, client *ssh.Client, command, stdin string) (cmdResult, error) {
	sess, err := client.NewSession()
	if err != nil {
		return cmdResult{}, err
	}
	defer sess.Close()
	stop := context.AfterFunc(ctx, func() { sess.Close() })
	defer stop()
	var stdout, stderr limitedBuffer
	sess.Stdout, sess.Stderr = &stdout, &stderr
	if stdin != "" {
		sess.Stdin = strings.NewReader(stdin)
	}
	if err := sess.Start(command); err != nil {
		return cmdResult{}, err
	}
	err = sess.Wait()
	if ctx.Err() != nil {
		return cmdResult{}, ctx.Err()
	}
	res := cmdResult{stdout: stdout.String(), stderr: stderr.String()}
	var ee *ssh.ExitError
	switch {
	case err == nil:
	case errors.As(err, &ee):
		res.status = ee.ExitStatus()
	default:
		var missing *ssh.ExitMissingError
		if !errors.As(err, &missing) {
			return cmdResult{}, err
		}
		res.status = -1
	}
	return res, nil
}

// checkPOSIX is the POSIX check of design §6: `uname -s` answers with a POSIX system's name. It
// returns the operating system for the session's environment ("" when not one the protocol
// names). Anything else, Windows OpenSSH included, is shell_unsupported.
func checkPOSIX(ctx context.Context, client *ssh.Client) (string, error) {
	res, err := runCommand(ctx, client, unameCommand, "")
	if err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", &target.Failure{Code: protocol.CodeRemoteExecDenied, Detail: "the host does not let this account run commands over SSH"}
	}
	name := lastLine(res.stdout)
	if res.status != 0 || !reSystem.MatchString(name) || nonPOSIX.MatchString(name) {
		return "", &target.Failure{Code: protocol.CodeShellUnsupported, Detail: "the host has no POSIX shell; start Jupyter there yourself and attach"}
	}
	switch name {
	case "Linux":
		return "linux", nil
	case "Darwin":
		return "darwin", nil
	}
	return "", nil
}

var (
	reSystem = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.-]{0,63}$`)
	// nonPOSIX are the names uname gives under Windows shells (Git Bash, MSYS, Cygwin).
	nonPOSIX = regexp.MustCompile(`(?i)^(windows|mingw|msys|cygwin)`)
)

// runtimeInfo is what the probe learned.
type runtimeInfo struct{ version, python string }

func (i runtimeInfo) runtime() string {
	if i.python == "" || len(i.python) > 32 {
		return ""
	}
	return "Python " + i.python
}

var reVersion = regexp.MustCompile(`^(\d+)\.(\d+)(\.\d+)?[A-Za-z0-9.+-]*$`)

// probe is the runtime stage in start mode: the interpreter runs, jupyter_server imports and is
// at least 2.0 (or `jupyter server --version` answers when no interpreter was chosen).
func probe(ctx context.Context, client *ssh.Client, login bool, python string) (runtimeInfo, error) {
	res, err := runCommand(ctx, client, probeCommand(login, python), "")
	if err != nil {
		if ctx.Err() != nil {
			return runtimeInfo{}, ctx.Err()
		}
		return runtimeInfo{}, &target.Failure{Code: protocol.CodeRemoteExecDenied, Detail: "the host refused to run the runtime check: " + firstLine(err)}
	}
	var info runtimeInfo
	if python != "" {
		var v struct {
			Python        string  `json:"python"`
			JupyterServer *string `json:"jupyter_server"`
		}
		switch {
		case res.status == 3:
			return info, &target.Failure{Code: protocol.CodeJupyterMissing, Detail: fmt.Sprintf("jupyter_server is not installed for %s", python)}
		case res.status != 0:
			return info, &target.Failure{Code: protocol.CodeEnvironmentInvalid, Detail: fmt.Sprintf("the interpreter %s cannot run: %s", python, redact.Redact(lastLine(res.stderr)))}
		}
		if json.Unmarshal([]byte(lastLine(res.stdout)), &v) != nil || v.JupyterServer == nil {
			return info, &target.Failure{Code: protocol.CodeEnvironmentInvalid, Detail: fmt.Sprintf("%s did not report its version", python)}
		}
		info = runtimeInfo{version: *v.JupyterServer, python: v.Python}
	} else {
		if res.status != 0 {
			return info, &target.Failure{Code: protocol.CodeJupyterMissing, Detail: "jupyter cannot run: " + redact.Redact(lastLine(res.stderr))}
		}
		info.version = lastLine(res.stdout)
	}
	m := reVersion.FindStringSubmatch(info.version)
	if m == nil {
		return info, &target.Failure{Code: protocol.CodeJupyterIncompatible, Detail: "the Jupyter Server version could not be read"}
	}
	if major, _ := strconv.Atoi(m[1]); major < 2 {
		return info, &target.Failure{Code: protocol.CodeJupyterIncompatible, Detail: fmt.Sprintf("Jupyter Server %s is older than 2.0", cleanVersion(info.version))}
	}
	return info, nil
}

// toolFailure maps a Jupyter tool that did not run: 126 or 127 from the shell means the
// interpreter or jupyter is not there.
func toolFailure(res cmdResult, python string) *target.Failure {
	if (res.status == 126 || res.status == 127) && python != "" {
		return &target.Failure{Code: protocol.CodeEnvironmentInvalid, Detail: fmt.Sprintf("the interpreter %s cannot run", python)}
	}
	return &target.Failure{Code: protocol.CodeJupyterMissing, Detail: "jupyter cannot run: " + redact.Redact(lastLine(res.stderr))}
}

// listServers runs `jupyter server list --json` on the host. The tokens it returns never leave
// the connector.
func listServers(ctx context.Context, client *ssh.Client, login bool, python string) ([]jupyter.Server, error) {
	res, err := runCommand(ctx, client, serverListCommand(login, python), "")
	if err != nil {
		return nil, err
	}
	if res.status != 0 {
		return nil, toolFailure(res, python)
	}
	return jupyter.ParseServerList([]byte(res.stdout)), nil
}

// cliKernelspecs runs `jupyter kernelspec list --json` on the host.
func cliKernelspecs(ctx context.Context, client *ssh.Client, login bool, python string) ([]protocol.Kernelspec, error) {
	res, err := runCommand(ctx, client, kernelspecCommand(login, python), "")
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, &target.Failure{Code: protocol.CodeInternal, Detail: "the host refused to list kernels: " + firstLine(err)}
	}
	if res.status != 0 {
		return nil, toolFailure(res, python)
	}
	specs, err := jupyter.ParseKernelspecList([]byte(res.stdout))
	if err != nil {
		return nil, &target.Failure{Code: protocol.CodeNoKernelspec, Detail: "the kernel list could not be read"}
	}
	return specs, nil
}

// findAttach finds the server to attach to on port: a loopback listener from `jupyter server
// list` on the host whose root_dir contains the workspace (design §6, §8 rule 5).
func findAttach(ctx context.Context, client *ssh.Client, port int, workspace string) (jupyter.Server, error) {
	servers, err := listServers(ctx, client, false, "")
	if err != nil {
		if ctx.Err() != nil {
			return jupyter.Server{}, ctx.Err()
		}
		return jupyter.Server{}, &target.Failure{Code: protocol.CodeAttachNoneFound, Detail: "no Jupyter server could be listed: " + err.Error()}
	}
	for _, s := range servers {
		if s.Port != port {
			continue
		}
		if !s.Loopback {
			return jupyter.Server{}, &target.Failure{Code: protocol.CodeAttachNotLoopback, Detail: fmt.Sprintf("the server on port %d listens on %s, not on loopback", port, s.Hostname)}
		}
		if _, err := posixContentRoot(s.RootDir, workspace); err != nil {
			return jupyter.Server{}, err
		}
		return s, nil
	}
	// Not listed: tell "nothing there" from "a server whose token the connector cannot read".
	dctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	conn, err := tunnelDial(client, port)(dctx)
	cancel()
	if err == nil {
		conn.Close()
		return jupyter.Server{}, &target.Failure{Code: protocol.CodeTokenUnavailable, Detail: fmt.Sprintf("something listens on port %d, but no Jupyter server whose token the connector can read", port)}
	}
	if len(servers) == 0 {
		return jupyter.Server{}, &target.Failure{Code: protocol.CodeAttachNoneFound, Detail: "no running Jupyter server was found"}
	}
	return jupyter.Server{}, &target.Failure{Code: protocol.CodeAttachPortUnreachable, Detail: fmt.Sprintf("nothing answers on port %d", port)}
}

// posixContentRoot returns the workspace relative to a remote server's root, compared segment by
// segment, or workspace_outside_root.
func posixContentRoot(root, workspace string) (string, error) {
	if !strings.HasPrefix(root, "/") || !strings.HasPrefix(workspace, "/") {
		return "", &target.Failure{Code: protocol.CodeWorkspaceOutsideRoot, Detail: fmt.Sprintf("%s is not inside the server's root %s", workspace, root)}
	}
	r, w := path.Clean(root), path.Clean(workspace)
	switch {
	case r == w:
		return "", nil
	case r == "/":
		return strings.TrimPrefix(w, "/"), nil
	case strings.HasPrefix(w, r+"/"):
		return strings.TrimPrefix(w, r+"/"), nil
	}
	return "", &target.Failure{Code: protocol.CodeWorkspaceOutsideRoot, Detail: fmt.Sprintf("%s is not inside the server's root %s", workspace, root)}
}

func attachable(servers []jupyter.Server) []protocol.Attachable {
	var out []protocol.Attachable
	for _, s := range servers {
		if !s.Attachable() || !validPath(s.RootDir) {
			continue
		}
		a := protocol.Attachable{Port: s.Port, RootDir: s.RootDir}
		if s.PID >= 1 && s.PID <= 4194304 {
			a.PID = s.PID
		}
		out = append(out, a)
		if len(out) == maxAttachable {
			break
		}
	}
	return out
}

func checkKernel(specs []protocol.Kernelspec, name string) error {
	if len(specs) == 0 {
		return &target.Failure{Code: protocol.CodeNoKernelspec, Detail: "Jupyter lists no kernel"}
	}
	if name != "" && !jupyter.HasKernel(specs, name) {
		return &target.Failure{Code: protocol.CodeKernelspecNotFound, Detail: fmt.Sprintf("the kernel %s is not installed", name)}
	}
	return nil
}

// asFailure keeps a *target.Failure or a *jupyter.Failure's code, else uses fallback.
func asFailure(err error, fallback protocol.Code) *target.Failure {
	var f *target.Failure
	if errors.As(err, &f) {
		return f
	}
	var jf *jupyter.Failure
	if errors.As(err, &jf) {
		return &target.Failure{Code: jf.Code, Detail: jf.Detail}
	}
	return &target.Failure{Code: fallback, Detail: err.Error()}
}

// cleanVersion keeps a version only in the form the protocol accepts.
func cleanVersion(v string) string {
	if len(v) > 32 || !reVersion.MatchString(v) {
		return ""
	}
	return v
}

// remoteRuntime is one session's Jupyter server on an SSH host: the connection, the tunnel to
// its fixed port and, for an owned server, the exec channel it runs in and its pid.
type remoteRuntime struct {
	r         *Remote
	target    protocol.Target
	runtime   protocol.Runtime
	sessionID string
	owned     bool
	token     string
	port      int
	client    *jupyter.Client

	losses    chan target.Loss
	closed    chan struct{}
	closeOnce sync.Once

	mu   sync.Mutex
	conn *Conn
	pid  int
	// execDone is closed when the owned server's exec channel ends: the process exited, or the
	// transport carrying the channel went away. nil once the session reconnected.
	execDone chan struct{}
	// monitor stops the running monitor; nil when none runs.
	monitor context.CancelFunc
	// before and route are the network at the last healthy check (design §5.5 rules 3, 4).
	before cause.Snapshot
	route  string
}

var _ target.Remote = (*remoteRuntime)(nil)

// Process is the owned server's pid and port.
func (rr *remoteRuntime) Process() (int, int) {
	rr.mu.Lock()
	defer rr.mu.Unlock()
	if !rr.owned {
		return 0, 0
	}
	return rr.pid, rr.port
}

// Losses delivers each loss until Close.
func (rr *remoteRuntime) Losses() <-chan target.Loss { return rr.losses }

func (rr *remoteRuntime) current() *Conn {
	rr.mu.Lock()
	defer rr.mu.Unlock()
	return rr.conn
}

// dial is the tunnel: a direct-tcpip channel to 127.0.0.1:<P> of the session, whatever a
// request names (design §8 rule 5).
func (rr *remoteRuntime) dial(ctx context.Context) (net.Conn, error) {
	rr.mu.Lock()
	c, port := rr.conn, rr.port
	rr.mu.Unlock()
	if c == nil {
		return nil, errors.New("the SSH connection is closed")
	}
	return tunnelDial(c.Client, port)(ctx)
}

// errAddressInUse is a start attempt whose port was taken.
var errAddressInUse = errors.New("address already in use")

// start runs the start template on random ports until one is free, then waits until
// /api/status answers with the token.
func (rr *remoteRuntime) start(ctx context.Context, workspace string) error {
	var err error
	for attempt := 0; attempt < startAttempts; attempt++ {
		err = rr.startOnce(ctx, workspace, rr.r.port())
		if !errors.Is(err, errAddressInUse) {
			return err
		}
	}
	return &target.Failure{Code: protocol.CodeJupyterStartFailed, Detail: fmt.Sprintf("every port tried was in use (%d attempts)", startAttempts)}
}

func (rr *remoteRuntime) startOnce(ctx context.Context, workspace string, port int) error {
	rt := rr.runtime
	client := rr.current().Client
	sess, err := client.NewSession()
	if err != nil {
		return &target.Failure{Code: protocol.CodeJupyterStartFailed, Detail: "the host refused a session channel: " + firstLine(err)}
	}
	stdin, err := sess.StdinPipe()
	if err != nil {
		sess.Close()
		return &target.Failure{Code: protocol.CodeInternal, Detail: "no standard input for the start command"}
	}
	out := newStartOutput(rr.token, rr.r.logLine)
	sess.Stdout, sess.Stderr = out.writer(), out.writer()
	if err := sess.Start(startCommand(login(rt), workspace, rt.Python, port, rr.sessionID)); err != nil {
		sess.Close()
		return &target.Failure{Code: protocol.CodeJupyterStartFailed, Detail: "the host refused to start Jupyter: " + firstLine(err)}
	}
	// The token is the first line of standard input, which is then closed (design §6).
	_, werr := io.WriteString(stdin, rr.token+"\n")
	stdin.Close()
	done := make(chan struct{})
	var waitErr error
	go func() {
		waitErr = sess.Wait()
		out.close()
		sess.Close()
		close(done)
	}()
	if werr != nil {
		sess.Close()
		<-done
		return &target.Failure{Code: protocol.CodeJupyterStartFailed, Detail: "the start command did not take the token"}
	}
	rr.mu.Lock()
	rr.port, rr.execDone = port, done
	rr.mu.Unlock()
	rr.client = jupyter.NewClient(port, rr.token, rr.dial)

	deadline := time.NewTimer(rr.r.readyTimeout())
	defer deadline.Stop()
	tick := time.NewTicker(rr.r.pollInterval())
	defer tick.Stop()
	giveUp := func(code protocol.Code, detail string) error {
		rr.setPID(out.pid())
		rr.stopAfterFailure(ctx)
		return &target.Failure{Code: code, Detail: detail}
	}
	for {
		if pid := out.pid(); pid > 0 {
			sctx, cancel := context.WithTimeout(ctx, max(rr.r.pollInterval()*4, time.Second))
			err := rr.client.Status(sctx)
			cancel()
			var jf *jupyter.Failure
			switch {
			case err == nil:
				rr.setPID(pid)
				return nil
			case errors.As(err, &jf) && jf.Code == protocol.CodeTokenRejected:
				return giveUp(protocol.CodeTokenRejected, jf.Detail)
			}
		}
		select {
		case <-done:
			rr.client.CloseIdle()
			return startExit(waitErr, out.last(), rt.Python)
		case <-deadline.C:
			return giveUp(protocol.CodeJupyterStartTimeout, fmt.Sprintf("Jupyter did not answer within %s", rr.r.readyTimeout()))
		case <-ctx.Done():
			return giveUp(protocol.CodeJupyterStartTimeout, "Jupyter did not become ready in time")
		case <-tick.C:
		}
	}
}

// stopAfterFailure stops a server whose start failed, even when the open's context ended, within
// the stop budget.
func (rr *remoteRuntime) stopAfterFailure(ctx context.Context) {
	sctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), stopBudget)
	defer cancel()
	if err := rr.Stop(sctx, jupyter.DefaultStopTimes); err != nil {
		rr.r.logLine(fmt.Sprintf("the Jupyter server of session %s may still be running: %v", rr.sessionID, err))
	}
}

func (rr *remoteRuntime) setPID(pid int) {
	rr.mu.Lock()
	rr.pid = pid
	rr.mu.Unlock()
}

// startExit is the failure of a start command that ended before Jupyter answered.
func startExit(waitErr error, tail, python string) error {
	status := -1
	var ee *ssh.ExitError
	if errors.As(waitErr, &ee) {
		status = ee.ExitStatus()
	}
	switch {
	case strings.Contains(strings.ToLower(tail), "already in use"):
		return errAddressInUse
	case status == exitNoWorkspace:
		return &target.Failure{Code: protocol.CodeWorkspaceMissing, Detail: "the workspace could not be entered"}
	case status == exitNoToken:
		return &target.Failure{Code: protocol.CodeInternal, Detail: "the start command did not receive the token"}
	case status == 126 || status == 127:
		return toolFailure(cmdResult{status: status, stderr: tail}, python)
	}
	return &target.Failure{Code: protocol.CodeJupyterStartFailed, Detail: clipTail("Jupyter exited while starting: " + tail)}
}

// clipTail keeps the end of a detail within the 512 characters a message allows.
func clipTail(s string) string {
	r := []rune(s)
	if len(r) <= 512 {
		return s
	}
	return "…" + string(r[len(r)-511:])
}

// startOutput reads the start command's output: every line is redacted (the token itself and
// token query values) before it is logged or kept, and the PARALLAX_PID= line gives the pid.
type startOutput struct {
	mu    sync.Mutex
	red   redact.Redactor
	log   func(string)
	lines []string
	pidV  int
	wg    sync.WaitGroup
	pipes []*io.PipeWriter
}

func newStartOutput(token string, log func(string)) *startOutput {
	o := &startOutput{log: log}
	o.red.Register(token)
	return o
}

// writer returns one stream's writer; each is split into lines on its own.
func (o *startOutput) writer() io.Writer {
	pr, pw := io.Pipe()
	o.mu.Lock()
	o.pipes = append(o.pipes, pw)
	o.mu.Unlock()
	o.wg.Add(1)
	go func() {
		defer o.wg.Done()
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		for sc.Scan() {
			o.line(sc.Text())
		}
		io.Copy(io.Discard, pr)
	}()
	return pw
}

var rePIDLine = regexp.MustCompile(`^` + pidPrefix + `([0-9]{1,7})$`)

func (o *startOutput) line(raw string) {
	raw = strings.TrimRight(raw, "\r")
	o.mu.Lock()
	if m := rePIDLine.FindStringSubmatch(raw); m != nil && o.pidV == 0 {
		if pid, err := strconv.Atoi(m[1]); err == nil && validPID(pid) {
			o.pidV = pid
		}
		o.mu.Unlock()
		return
	}
	line := sanitize(o.red.Redact(redact.Redact(raw)))
	o.lines = append(o.lines, line)
	if len(o.lines) > 20 {
		o.lines = o.lines[len(o.lines)-20:]
	}
	o.mu.Unlock()
	if o.log != nil {
		o.log(line)
	}
}

// close ends every stream once the command ended and waits for the last lines.
func (o *startOutput) close() {
	o.mu.Lock()
	pipes := o.pipes
	o.mu.Unlock()
	for _, p := range pipes {
		p.Close()
	}
	o.wg.Wait()
}

func (o *startOutput) pid() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.pidV
}

func (o *startOutput) last() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return strings.Join(o.lines, "\n")
}
