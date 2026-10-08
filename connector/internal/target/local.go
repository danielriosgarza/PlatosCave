package target

import (
	"context"
	"errors"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/redact"
	"parallax/connector/internal/state"
)

// Local is the `local` target: this computer, with no SSH. It dials nothing but the loopback
// port of the Jupyter server it started or attached to.
type Local struct {
	OS, Arch string
	// Log receives Jupyter's output, redacted.
	Log func(line string)
	// StageLimit shortens every stage deadline, for tests; zero keeps design §5.1's.
	StageLimit time.Duration
	// ReadyTimeout is the start poll's limit; zero keeps design §6's 30 s.
	ReadyTimeout time.Duration
}

// maxAttachable is the number of servers a test_result can list.
const maxAttachable = 16

// Test runs workspace, runtime, notebook_auth and kernels for this computer.
func (l *Local) Test(ctx context.Context, req *protocol.TestConnection, progress Progress) *protocol.TestResult {
	s := &Stages{Progress: progress, Limit: l.StageLimit}
	res := &protocol.TestResult{RequestID: req.RequestID}
	rt := req.Runtime
	python, pyErr := expandHome(rt.Python)
	rt.Python = python
	var resolved string
	var info jupyter.RuntimeInfo
	var server jupyter.Server

	s.Run(ctx, "workspace", func(ctx context.Context) (*protocol.StageData, error) {
		p, err := checkWorkspace(req.Target.Workspace)
		if err != nil {
			return nil, err
		}
		resolved = p
		return &protocol.StageData{ResolvedPath: p}, nil
	})
	s.Run(ctx, "runtime", func(ctx context.Context) (*protocol.StageData, error) {
		if rt.Mode == protocol.RuntimeStart {
			if pyErr != nil {
				return nil, pyErr
			}
			i, err := jupyter.ProbeRuntime(ctx, rt.Python)
			if err != nil {
				return nil, err
			}
			info = i
			return &protocol.StageData{State: "startable", Version: i.Version}, nil
		}
		srv, err := findAttach(ctx, rt.Port, resolved)
		if err != nil {
			return nil, err
		}
		server = srv
		info.Version = srv.Version
		return &protocol.StageData{State: "running", Version: srv.Version, RootDir: srv.RootDir}, nil
	})
	var client *jupyter.Client
	s.Run(ctx, "notebook_auth", func(ctx context.Context) (*protocol.StageData, error) {
		if rt.Mode == protocol.RuntimeStart {
			return nil, &skip{reason: "not_started"}
		}
		if server.Token == "" {
			return nil, fail(protocol.CodeTokenUnavailable, "the server on port %d has no token the connector can read", server.Port)
		}
		client = jupyter.NewClient(server.Port, server.Token, jupyter.LoopbackDial(server.Port))
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
			specs, err = jupyter.CLIKernelspecs(ctx, rt.Python)
		} else {
			source = "service"
			specs, err = client.Kernelspecs(ctx)
		}
		if err != nil {
			return nil, asFailure(err, protocol.CodeNoKernelspec)
		}
		res.Kernelspecs = specs
		data := &protocol.StageData{Source: source}
		return data, checkKernel(specs, rt.KernelName)
	})
	res.Stages = s.List
	res.Outcome = s.Outcome()
	res.JupyterVersion = jupyterVersion(info.Version)
	res.Environment = l.environment(info)
	if rt.Mode == protocol.RuntimeStart && ctx.Err() == nil {
		// So the person can choose Attach instead; best effort, never a failure.
		lctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		if servers, err := jupyter.ListServers(lctx, rt.Python); err == nil {
			res.Attachable = attachable(servers)
		}
		cancel()
	}
	return res
}

// Open starts Jupyter on this computer, or attaches to a server running here.
func (l *Local) Open(ctx context.Context, req *protocol.OpenSession) (*Runtime, error) {
	rt := req.Runtime
	resolved, err := checkWorkspace(req.Target.Workspace)
	if err != nil {
		return nil, err
	}
	if rt.Python, err = expandHome(rt.Python); err != nil {
		return nil, err
	}
	if rt.Mode == protocol.RuntimeAttach {
		return l.attach(ctx, rt, resolved)
	}
	info, err := jupyter.ProbeRuntime(ctx, rt.Python)
	if err != nil {
		return nil, asFailure(err, protocol.CodeJupyterStartFailed)
	}
	token, err := jupyter.NewToken()
	if err != nil {
		return nil, fail(protocol.CodeInternal, "no randomness for a token")
	}
	p, err := jupyter.Start(ctx, jupyter.StartOptions{
		SessionID: req.SessionID, Workspace: resolved, Python: rt.Python, Token: token,
		Log: l.Log, ReadyTimeout: l.ReadyTimeout,
	})
	if err != nil {
		return nil, asFailure(err, protocol.CodeJupyterStartFailed)
	}
	r := &Runtime{Client: p.Client, Owned: true, Process: p, Environment: l.environment(info)}
	if err := l.verify(ctx, r, rt.KernelName); err != nil {
		p.Stop(context.WithoutCancel(ctx), jupyter.DefaultStopTimes)
		return nil, err
	}
	if r.JupyterVersion == "" {
		r.JupyterVersion = jupyterVersion(info.Version)
	}
	return r, nil
}

func (l *Local) attach(ctx context.Context, rt protocol.Runtime, resolved string) (*Runtime, error) {
	srv, err := findAttach(ctx, rt.Port, resolved)
	if err != nil {
		return nil, err
	}
	if srv.Token == "" {
		return nil, fail(protocol.CodeTokenUnavailable, "the server on port %d has no token the connector can read", srv.Port)
	}
	root, err := contentRoot(srv.RootDir, resolved)
	if err != nil {
		return nil, err
	}
	// The token is redacted from every detail and log line for as long as the session holds it
	// (design §6); Release drops this reference.
	redact.Register(srv.Token)
	c := jupyter.NewClient(srv.Port, srv.Token, jupyter.LoopbackDial(srv.Port))
	r := &Runtime{Client: c, ContentRoot: root, JupyterVersion: jupyterVersion(srv.Version), Environment: l.environment(jupyter.RuntimeInfo{}), attachedToken: srv.Token}
	if err := c.Status(ctx); err != nil {
		r.Release()
		return nil, asFailure(err, protocol.CodeNotebookServiceUnreachable)
	}
	if err := l.verify(ctx, r, rt.KernelName); err != nil {
		r.Release()
		return nil, err
	}
	return r, nil
}

// verify is the check before `ready`: the service lists a kernel, and the chosen one.
func (l *Local) verify(ctx context.Context, r *Runtime, kernel string) error {
	specs, err := r.Client.Kernelspecs(ctx)
	if err != nil {
		return asFailure(err, protocol.CodeNotebookServiceUnreachable)
	}
	if err := checkKernel(specs, kernel); err != nil {
		return err
	}
	r.Kernelspecs = specs
	if v, err := r.Client.Version(ctx); err == nil && r.JupyterVersion == "" {
		r.JupyterVersion = jupyterVersion(v)
	}
	return nil
}

func checkKernel(specs []protocol.Kernelspec, name string) error {
	if len(specs) == 0 {
		return fail(protocol.CodeNoKernelspec, "Jupyter lists no kernel")
	}
	if name != "" && !jupyter.HasKernel(specs, name) {
		return fail(protocol.CodeKernelspecNotFound, "the kernel %s is not installed", name)
	}
	return nil
}

// expandHome expands a leading ~/ of a validated interpreter path (design §4.4 rule 5); a home
// directory that is not known is environment_invalid.
func expandHome(p string) (string, error) {
	path, err := state.ExpandHome(p)
	if err != nil {
		return "", fail(protocol.CodeEnvironmentInvalid, "%v", err)
	}
	return path, nil
}

// findAttach finds the server to attach to on port: a loopback listener from `jupyter server
// list` whose root_dir contains the workspace.
func findAttach(ctx context.Context, port int, workspace string) (jupyter.Server, error) {
	servers, err := jupyter.ListServers(ctx, "")
	if err != nil {
		return jupyter.Server{}, asFailure(err, protocol.CodeAttachNoneFound)
	}
	for _, s := range servers {
		if s.Port != port {
			continue
		}
		if !s.Loopback {
			return jupyter.Server{}, fail(protocol.CodeAttachNotLoopback, "the server on port %d listens on %s, not on loopback", port, s.Hostname)
		}
		if _, err := contentRoot(s.RootDir, workspace); err != nil {
			return jupyter.Server{}, err
		}
		return s, nil
	}
	// Not listed: tell "nothing there" from "a server whose token the connector cannot read".
	var d net.Dialer
	dctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	conn, err := d.DialContext(dctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	cancel()
	if err == nil {
		conn.Close()
		return jupyter.Server{}, fail(protocol.CodeTokenUnavailable, "something listens on port %d, but no Jupyter server whose token the connector can read", port)
	}
	if len(servers) == 0 {
		return jupyter.Server{}, fail(protocol.CodeAttachNoneFound, "no running Jupyter server was found")
	}
	return jupyter.Server{}, fail(protocol.CodeAttachPortUnreachable, "nothing answers on port %d", port)
}

// contentRoot returns the workspace relative to root, `/`-separated, or workspace_outside_root.
func contentRoot(root, workspace string) (string, error) {
	r, err := filepath.EvalSymlinks(root)
	if err != nil {
		r = filepath.Clean(root)
	}
	rel, err := filepath.Rel(r, workspace)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fail(protocol.CodeWorkspaceOutsideRoot, "%s is not inside the server's root %s", workspace, root)
	}
	if rel == "." {
		return "", nil
	}
	return filepath.ToSlash(rel), nil
}

// checkWorkspace is the workspace stage on this computer: it exists, is a directory and is
// writable. It returns the canonical path and creates nothing.
func checkWorkspace(ws string) (string, error) {
	st, err := os.Stat(ws)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return "", fail(protocol.CodeWorkspaceMissing, "%s does not exist", ws)
	case err != nil:
		return "", fail(protocol.CodeWorkspaceNotWritable, "%s cannot be read", ws)
	case !st.IsDir():
		return "", fail(protocol.CodeWorkspaceNotDirectory, "%s is not a directory", ws)
	}
	resolved, err := filepath.EvalSymlinks(ws)
	if err != nil {
		return "", fail(protocol.CodeWorkspaceMissing, "%s cannot be resolved", ws)
	}
	if !writable(resolved) {
		return resolved, fail(protocol.CodeWorkspaceNotWritable, "this account cannot write to %s", resolved)
	}
	return resolved, nil
}

func attachable(servers []jupyter.Server) []protocol.Attachable {
	out := []protocol.Attachable{}
	for _, s := range servers {
		if !s.Attachable() || s.RootDir == "" || len(s.RootDir) > 1024 || strings.ContainsFunc(s.RootDir, func(r rune) bool { return r < 0x20 || r == 0x7f }) {
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
	if len(out) == 0 {
		return nil
	}
	return out
}

func (l *Local) environment(info jupyter.RuntimeInfo) *protocol.Environment {
	e := &protocol.Environment{OS: l.OS, Arch: l.Arch}
	if info.Python != "" && len(info.Python) <= 32 {
		e.Runtime = "Python " + info.Python
	}
	return e
}

// jupyterVersion keeps a version only in the form the protocol accepts.
func jupyterVersion(v string) string {
	if len(v) > 32 || !strings.ContainsRune(v, '.') {
		return ""
	}
	for _, r := range v {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || strings.ContainsRune(".+-", r)) {
			return ""
		}
	}
	if v[0] < '0' || v[0] > '9' {
		return ""
	}
	return v
}
