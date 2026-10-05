package sshtarget

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/coder/websocket"
	"golang.org/x/crypto/ssh"

	"parallax/connector/internal/cause"
	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/jupyter/jupytertest"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/sshtest"
	"parallax/connector/internal/target"
)

func TestMain(m *testing.M) {
	jupytertest.RunIfStub()
	os.Exit(m.Run())
}

const sessionID = "7b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"

// loopbackOnly is the network snapshot the remote tests run with: only loopback, unchanged.
func loopbackOnly() (cause.Snapshot, error) {
	return cause.Snapshot{Interfaces: []cause.Interface{{Name: "lo", Addrs: []string{"127.0.0.1/8"}}}}, nil
}

// remoteHost is an in-process SSH server whose commands run under /bin/sh with a stub `jupyter`
// and `python` first on PATH, and a Remote that trusts it.
type remoteHost struct {
	t    *testing.T
	f    *fixture
	srv  *sshtest.Server
	key  *clientKey
	stub string
	ws   string
	r    *Remote
	logs *lines
}

// lines collects log lines safely.
type lines struct {
	mu sync.Mutex
	l  []string
}

func (l *lines) add(s string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.l = append(l.l, s)
}

func (l *lines) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.l...)
}

func newRemoteHost(t *testing.T, mode string, edit ...func(*sshtest.Options)) *remoteHost {
	t.Helper()
	skipWithoutShell(t)
	stub := jupytertest.Install(t, mode)
	key := newClientKey(t, "")
	hostKey := sshtest.NewSigner(t)
	opts := sshtest.Options{HostKeys: []ssh.Signer{hostKey}, AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}, Exec: sshtest.POSIXHost(stub)}
	for _, e := range edit {
		e(&opts)
	}
	srv := sshtest.New(t, opts)
	f := newFixture(t)
	f.trust(srv.Host, srv.Port, hostKey.PublicKey())
	logs := &lines{}
	h := &remoteHost{t: t, f: f, srv: srv, key: key, stub: stub, ws: t.TempDir(), logs: logs,
		r: &Remote{SSH: f.tg, Log: logs.add, ReadyTimeout: 10 * time.Second, PollInterval: 50 * time.Millisecond,
			Keepalive: 50 * time.Millisecond, KeepaliveLoss: time.Second, Interfaces: loopbackOnly}}
	// Whatever a test leaves serving is killed when it ends.
	t.Cleanup(func() {
		for _, rec := range jupytertest.Records(t, stub) {
			syscall.Kill(rec.PID, syscall.SIGKILL)
		}
	})
	return h
}

func (h *remoteHost) target() protocol.Target {
	return protocol.Target{Kind: protocol.TargetSSH, Host: h.srv.Host, Port: h.srv.Port, User: "student", Auth: keyAuth(h.key), Workspace: h.ws}
}

func (h *remoteHost) start() protocol.Runtime {
	return protocol.Runtime{Mode: protocol.RuntimeStart, Python: jupytertest.Python(h.stub), KernelName: "python3"}
}

func (h *remoteHost) test(rt protocol.Runtime) (*protocol.TestResult, []protocol.Stage) {
	h.t.Helper()
	var progress []protocol.Stage
	var mu sync.Mutex
	res := h.r.Test(context.Background(), &protocol.TestConnection{RequestID: requestID, Target: h.target(), Runtime: rt},
		func(st protocol.Stage) {
			mu.Lock()
			defer mu.Unlock()
			progress = append(progress, st)
		})
	if _, err := protocol.Encode(res); err != nil {
		h.t.Fatalf("invalid test_result: %v\n%+v", err, res)
	}
	for _, st := range progress {
		validProgress(h.t, st)
	}
	return res, progress
}

func (h *remoteHost) open(rt protocol.Runtime) (*target.Runtime, error) {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	out, err := h.r.Open(ctx, &protocol.OpenSession{RequestID: requestID, SessionID: sessionID, Target: h.target(), Runtime: rt,
		Lease: protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5}})
	if out != nil {
		h.t.Cleanup(out.Remote.Close)
	}
	return out, err
}

func stageOf(t *testing.T, stages []protocol.Stage, name string) protocol.Stage {
	t.Helper()
	for _, st := range stages {
		if st.Name == name {
			return st
		}
	}
	t.Fatalf("no %s stage in %+v", name, stages)
	return protocol.Stage{}
}

func summary(stages []protocol.Stage) string {
	var parts []string
	for _, st := range stages {
		p := st.Name + "=" + st.Status
		if st.Code != "" {
			p += ":" + string(st.Code)
		}
		parts = append(parts, p)
	}
	return strings.Join(parts, " ")
}

func wantCode(t *testing.T, err error, code protocol.Code) {
	t.Helper()
	var f *target.Failure
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("got %v, want %s", err, code)
	}
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func waitGone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for alive(pid) {
		if time.Now().After(deadline) {
			t.Fatalf("process %d is still running", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func execsContaining(srv *sshtest.Server, s string) []string {
	var out []string
	for _, c := range srv.Execs() {
		if strings.Contains(c, s) {
			out = append(out, c)
		}
	}
	return out
}

func TestA28_OwnedSessionReady(t *testing.T) {
	h := newRemoteHost(t, "")
	res, _ := h.test(h.start())
	if res.Outcome != "ready_to_start" {
		t.Fatalf("outcome %s: %s", res.Outcome, summary(res.Stages))
	}
	want := "reachability=ok host_identity=ok ssh_auth=ok workspace=ok forwarding=ok runtime=ok notebook_auth=skipped kernels=ok"
	if got := summary(res.Stages); got != want {
		t.Fatalf("stages %s\nwant   %s", got, want)
	}
	if d := stageOf(t, res.Stages, "notebook_auth").Data; d == nil || d.Reason != "not_started" {
		t.Fatalf("notebook_auth %+v", d)
	}
	if d := stageOf(t, res.Stages, "runtime").Data; d.State != "startable" || d.Version != jupytertest.Version {
		t.Fatalf("runtime %+v", d)
	}
	if d := stageOf(t, res.Stages, "kernels").Data; d.Source != "cli" {
		t.Fatalf("kernels %+v", d)
	}
	if res.JupyterVersion != jupytertest.Version || res.Environment == nil || res.Environment.OS != "linux" || res.Environment.Runtime != "Python 3.12.8" {
		t.Fatalf("version %q environment %+v", res.JupyterVersion, res.Environment)
	}
	if len(jupytertest.Records(t, h.stub)) != 0 {
		t.Fatal("Test connection started a server")
	}

	rt, err := h.open(h.start())
	if err != nil {
		t.Fatal(err)
	}
	if !rt.Owned || rt.ContentRoot != "" || rt.JupyterVersion != jupytertest.Version || !jupyter.HasKernel(rt.Kernelspecs, "python3") {
		t.Fatalf("runtime %+v", rt)
	}
	if err := rt.Client.Status(context.Background()); err != nil {
		t.Fatalf("status through the tunnel: %v", err)
	}
	recs := jupytertest.Records(t, h.stub)
	if len(recs) != 1 {
		t.Fatalf("%d servers started", len(recs))
	}
	rec := recs[0]
	pid, port := rt.Remote.Process()
	if pid != rec.PID || rec.Listen != "127.0.0.1:"+strconv.Itoa(port) || port < portLow || port > portHi {
		t.Fatalf("pid %d port %d, record %+v", pid, port, rec)
	}
	if rec.Dir != h.ws || !slices.Contains(rec.Argv, "--ServerApp.root_dir="+h.ws) || !slices.Contains(rec.Argv, "--ParallaxMarker.session="+sessionID) {
		t.Fatalf("record %+v", rec)
	}
	// A cell runs on the kernel channel through the tunnel.
	resp, err := rt.Client.Do(context.Background(), "POST", "/api/kernels", "", protocol.Headers{"content-type": "application/json"}, strings.NewReader(`{"name":"python3"}`), 18)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	kernel, err := jupyter.KernelID(body)
	if err != nil {
		t.Fatal(err)
	}
	ws, err := rt.Client.DialChannel(context.Background(), "/api/kernels/"+kernel+"/channels", "session_id="+sessionID)
	if err != nil {
		t.Fatal(err)
	}
	req, _ := json.Marshal(map[string]any{"header": map[string]any{"msg_id": "m1", "msg_type": "execute_request"}, "content": map[string]any{"code": "print(2 + 2)"}, "channel": "shell"})
	if err := ws.Write(context.Background(), websocket.MessageText, req); err != nil {
		t.Fatal(err)
	}
	for out := ""; out != "4\n"; {
		_, data, err := ws.Read(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		var msg struct {
			Header struct {
				MsgType string `json:"msg_type"`
			} `json:"header"`
			Content struct{ Text string } `json:"content"`
		}
		json.Unmarshal(data, &msg)
		if msg.Header.MsgType == "stream" {
			out = msg.Content.Text
		}
	}
	ws.CloseNow()

	if err := rt.Remote.Stop(context.Background(), jupyter.StopTimes{Shutdown: 5 * time.Second, Terminate: time.Second}); err != nil {
		t.Fatal(err)
	}
	if alive(rec.PID) {
		t.Fatal("Stop returned before the process ended")
	}

	t.Run("a port in use is retried on another", func(t *testing.T) {
		h := newRemoteHost(t, "")
		busy, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer busy.Close()
		free := freePort(t)
		ports := []int{busy.Addr().(*net.TCPAddr).Port, free}
		h.r.Ports = func() int {
			p := ports[0]
			ports = ports[1:]
			return p
		}
		rt, err := h.open(h.start())
		if err != nil {
			t.Fatal(err)
		}
		if _, port := rt.Remote.Process(); port != free || len(execsContaining(h.srv, "PARALLAX_PID")) != 2 {
			t.Fatalf("port %d after %d attempts, want %d after 2", port, len(execsContaining(h.srv, "PARALLAX_PID")), free)
		}
	})
}

// freePort is a loopback port nothing listens on.
func freePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestRemoteTokenOnStdinOnly(t *testing.T) {
	h := newRemoteHost(t, "")
	rt, err := h.open(h.start())
	if err != nil {
		t.Fatal(err)
	}
	token := rt.Remote.(*remoteRuntime).token
	if len(token) != 64 {
		t.Fatalf("token of %d characters", len(token))
	}
	for _, c := range h.srv.Execs() {
		if strings.Contains(c, token) {
			t.Fatalf("a command line holds the token: %s", c)
		}
	}
	rec := jupytertest.Records(t, h.stub)[0]
	if !rec.TokenInEnv {
		t.Fatal("the server did not get the token from the start script")
	}
	if strings.Contains(strings.Join(rec.Argv, " "), token) {
		t.Fatal("the server's arguments hold the token")
	}
	logged := strings.Join(h.logs.all(), "\n")
	if !strings.Contains(logged, "is running at") {
		t.Fatalf("Jupyter's output was not logged: %q", logged)
	}
	if strings.Contains(logged, token) {
		t.Fatal("the log holds the token")
	}
	// Requests carry it only in the Authorization header.
	resp, err := rt.Client.Do(context.Background(), "GET", "/api/status", "", nil, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.Request.URL.RawQuery != "" || strings.Contains(resp.Request.URL.String(), token) {
		t.Fatalf("the token is in the URL %s", resp.Request.URL)
	}
}

func TestA29_JupyterMissing(t *testing.T) {
	for _, python := range []bool{true, false} {
		t.Run(fmt.Sprintf("interpreter chosen %v", python), func(t *testing.T) {
			h := newRemoteHost(t, "missing")
			rt := h.start()
			if !python {
				rt.Python = ""
			}
			res, _ := h.test(rt)
			want := "reachability=ok host_identity=ok ssh_auth=ok workspace=ok forwarding=ok runtime=failed:jupyter_missing notebook_auth=skipped kernels=skipped"
			if got := summary(res.Stages); got != want || res.Outcome != "failed" {
				t.Fatalf("%s %s\nwant %s", res.Outcome, got, want)
			}
			if d := stageOf(t, res.Stages, "kernels").Data; d.Reason != "blocked" || d.BlockedBy != "runtime" {
				t.Fatalf("kernels %+v", d)
			}
			_, err := h.open(rt)
			wantCode(t, err, protocol.CodeJupyterMissing)
			if len(jupytertest.Records(t, h.stub)) != 0 || len(execsContaining(h.srv, "PARALLAX_PID")) != 0 {
				t.Fatal("a server was started")
			}
		})
	}
}

func TestA29_JupyterTooOld(t *testing.T) {
	h := newRemoteHost(t, "old")
	res, _ := h.test(h.start())
	st := stageOf(t, res.Stages, "runtime")
	if st.Status != "failed" || st.Code != protocol.CodeJupyterIncompatible || res.Outcome != "failed" {
		t.Fatalf("%s: %s", res.Outcome, summary(res.Stages))
	}
	_, err := h.open(h.start())
	wantCode(t, err, protocol.CodeJupyterIncompatible)
	if len(jupytertest.Records(t, h.stub)) != 0 {
		t.Fatal("a server was started")
	}
}

// attachTo serves a fake Jupyter on loopback with token, and makes `jupyter server list` on the
// host list it with listed as its token and root as its root_dir.
func (h *remoteHost) attachTo(token, listed, root string) (*jupytertest.Server, int) {
	h.t.Helper()
	fake := jupytertest.New(token)
	srv := httptest.NewServer(fake)
	h.t.Cleanup(srv.Close)
	port, _ := strconv.Atoi(srv.URL[strings.LastIndexByte(srv.URL, ':')+1:])
	line, _ := json.Marshal(map[string]any{"hostname": "localhost", "port": port, "pid": 4242, "root_dir": root,
		"token": listed, "url": fmt.Sprintf("http://localhost:%d/", port), "version": jupytertest.Version, "secure": false, "sock": ""})
	h.t.Setenv(jupytertest.EnvList, string(line)+"\n")
	return fake, port
}

func (h *remoteHost) attach(port int) protocol.Runtime {
	return protocol.Runtime{Mode: protocol.RuntimeAttach, Port: port, KernelName: "python3"}
}

func TestA29_NotebookAuthRejected(t *testing.T) {
	h := newRemoteHost(t, "")
	_, port := h.attachTo("the-real-token", "a-stale-token", filepath.Dir(h.ws))
	res, _ := h.test(h.attach(port))
	want := "reachability=ok host_identity=ok ssh_auth=ok workspace=ok forwarding=ok runtime=ok notebook_auth=failed:token_rejected kernels=skipped"
	if got := summary(res.Stages); got != want || res.Outcome != "failed" {
		t.Fatalf("%s %s\nwant %s", res.Outcome, got, want)
	}
	if d := stageOf(t, res.Stages, "runtime").Data; d.State != "running" || d.RootDir != filepath.Dir(h.ws) {
		t.Fatalf("runtime %+v", d)
	}
	_, err := h.open(h.attach(port))
	wantCode(t, err, protocol.CodeTokenRejected)
}

func TestA29_RemoteExecDenied(t *testing.T) {
	h := newRemoteHost(t, "", func(o *sshtest.Options) { o.DenyExec = true })
	res, _ := h.test(h.start())
	want := "reachability=ok host_identity=ok ssh_auth=ok workspace=failed:remote_exec_denied forwarding=skipped runtime=skipped notebook_auth=skipped kernels=skipped"
	if got := summary(res.Stages); got != want || res.Outcome != "failed" {
		t.Fatalf("%s %s\nwant %s", res.Outcome, got, want)
	}
	_, err := h.open(h.start())
	wantCode(t, err, protocol.CodeRemoteExecDenied)
}

func TestA28_AttachNeverStops(t *testing.T) {
	h := newRemoteHost(t, "")
	fake, port := h.attachTo("tok-attached", "tok-attached", filepath.Dir(h.ws))
	res, _ := h.test(h.attach(port))
	if res.Outcome != "ready" || stageOf(t, res.Stages, "kernels").Data.Source != "service" {
		t.Fatalf("%s: %s", res.Outcome, summary(res.Stages))
	}
	rt, err := h.open(h.attach(port))
	if err != nil {
		t.Fatal(err)
	}
	if rt.Owned || rt.ContentRoot != filepath.Base(h.ws) {
		t.Fatalf("owned %v content root %q", rt.Owned, rt.ContentRoot)
	}
	if pid, p := rt.Remote.Process(); pid != 0 || p != 0 {
		t.Fatalf("an attached session records process %d on %d", pid, p)
	}
	if err := rt.Remote.Stop(context.Background(), jupyter.DefaultStopTimes); !errors.Is(err, errNotOwned) {
		t.Fatalf("stop of an attached server: %v", err)
	}
	rt.Remote.Close()
	for _, r := range fake.Requests() {
		if r.URI == "/api/shutdown" {
			t.Fatal("the attached server was asked to shut down")
		}
	}
	if len(execsContaining(h.srv, "kill")) != 0 || len(execsContaining(h.srv, "ps ")) != 0 {
		t.Fatalf("the attached server was inspected or signalled: %v", h.srv.Execs())
	}
	// It keeps running after the tunnel closed.
	c := jupyter.NewClient(port, "tok-attached", jupyter.LoopbackDial(port))
	defer c.CloseIdle()
	if err := c.Status(context.Background()); err != nil {
		t.Fatalf("the attached server stopped answering: %v", err)
	}

	t.Run("outside the root, not on loopback, no token", func(t *testing.T) {
		h := newRemoteHost(t, "")
		_, port := h.attachTo("t", "t", "/somewhere/else")
		_, err := h.open(h.attach(port))
		wantCode(t, err, protocol.CodeWorkspaceOutsideRoot)
		_, port = h.attachTo("t", "", filepath.Dir(h.ws))
		_, err = h.open(h.attach(port))
		wantCode(t, err, protocol.CodeTokenUnavailable)
		line := fmt.Sprintf(`{"hostname": "0.0.0.0", "port": %d, "root_dir": %q, "token": "t", "url": "http://0.0.0.0:%d/"}`, port, filepath.Dir(h.ws), port)
		t.Setenv(jupytertest.EnvList, line+"\n")
		_, err = h.open(h.attach(port))
		wantCode(t, err, protocol.CodeAttachNotLoopback)
		t.Setenv(jupytertest.EnvList, "")
		_, err = h.open(h.attach(1024))
		wantCode(t, err, protocol.CodeAttachNoneFound)
	})
}

func TestTunnelDestinationFixed(t *testing.T) {
	h := newRemoteHost(t, "")
	rt, err := h.open(h.start())
	if err != nil {
		t.Fatal(err)
	}
	_, port := rt.Remote.Process()
	// Whatever a request names, the client reaches only the session's port.
	for _, p := range []string{"/api/kernels", "//169.254.169.254/latest", "/api/status"} {
		resp, err := rt.Client.Do(context.Background(), "GET", p, "", protocol.Headers{"host": "169.254.169.254"}, nil, 0)
		if err == nil {
			io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
		}
	}
	allowed := map[string]bool{forwardProbe: true, "127.0.0.1:" + strconv.Itoa(port): true}
	opens := h.srv.Opens()
	if len(opens) < 2 {
		t.Fatalf("opens %v", opens)
	}
	for _, o := range opens {
		if !allowed[o] {
			t.Fatalf("a channel was opened to %s (opens %v)", o, opens)
		}
	}
}

func TestStopShutdownThenKillWithMarker(t *testing.T) {
	h := newRemoteHost(t, "stubborn")
	rt, err := h.open(h.start())
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := rt.Remote.Process()
	before := len(h.srv.Execs())
	if err := rt.Remote.Stop(context.Background(), jupyter.StopTimes{Shutdown: 300 * time.Millisecond, Terminate: 300 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	if alive(pid) {
		t.Fatal("Stop returned while the process runs")
	}
	rec := jupytertest.Records(t, h.stub)[0]
	if !slices.Contains(rec.Requests, "POST /api/shutdown") {
		t.Fatalf("no shutdown request: %v", rec.Requests)
	}
	var order []string
	for _, c := range h.srv.Execs()[before:] {
		switch {
		case strings.HasPrefix(c, "kill -TERM "):
			order = append(order, "TERM")
		case strings.HasPrefix(c, "kill -KILL "):
			order = append(order, "KILL")
		case strings.HasPrefix(c, "ps "):
			if len(order) == 0 || order[len(order)-1] != "ps" {
				order = append(order, "ps")
			}
		}
	}
	if got := strings.Join(order, " "); !strings.HasPrefix(got, "ps TERM ps KILL") {
		t.Fatalf("stop ran %s", got)
	}

	t.Run("a pid without the marker is never signalled", func(t *testing.T) {
		other := exec.Command("/bin/sleep", "30")
		if err := other.Start(); err != nil {
			t.Fatal(err)
		}
		defer other.Process.Kill()
		h := newRemoteHost(t, "")
		conn, err := h.f.tg.Connect(context.Background(), &protocol.TestConnection{RequestID: requestID, Target: h.target(), Runtime: h.start()})
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		if err := stopProcess(context.Background(), conn.Client, orphan{pid: other.Process.Pid, id: sessionID}, jupyter.StopTimes{Shutdown: 100 * time.Millisecond, Terminate: 100 * time.Millisecond}); err != nil {
			t.Fatal(err)
		}
		if !alive(other.Process.Pid) || len(execsContaining(h.srv, "kill")) != 0 {
			t.Fatal("another process was signalled")
		}
	})
}

func TestNonPosixHostUnsupported(t *testing.T) {
	windows := func(o *sshtest.Options) {
		posix := o.Exec
		o.Exec = func(command string, stdin io.Reader, stdout, stderr io.Writer) int {
			if command == unameCommand {
				fmt.Fprintln(stderr, "'uname' is not recognized as an internal or external command,")
				return 1
			}
			return posix(command, stdin, stdout, stderr)
		}
	}
	h := newRemoteHost(t, "", windows)
	_, port := h.attachTo("t", "t", filepath.Dir(h.ws))
	for _, rt := range []protocol.Runtime{h.start(), h.attach(port)} {
		res, _ := h.test(rt)
		if st := stageOf(t, res.Stages, "runtime"); st.Code != protocol.CodeShellUnsupported || res.Outcome != "failed" {
			t.Fatalf("%s: %s", rt.Mode, summary(res.Stages))
		}
		_, err := h.open(rt)
		wantCode(t, err, protocol.CodeShellUnsupported)
	}
	for _, c := range h.srv.Execs() {
		if strings.Contains(c, "jupyter") || strings.Contains(c, "python") {
			t.Fatalf("ran %s on a host without a POSIX shell", c)
		}
	}
	t.Run("MINGW reports itself through uname", func(t *testing.T) {
		h := newRemoteHost(t, "", func(o *sshtest.Options) {
			posix := o.Exec
			o.Exec = func(command string, stdin io.Reader, stdout, stderr io.Writer) int {
				if command == unameCommand {
					fmt.Fprintln(stdout, "MINGW64_NT-10.0-19045")
					return 0
				}
				return posix(command, stdin, stdout, stderr)
			}
		})
		_, err := h.open(h.start())
		wantCode(t, err, protocol.CodeShellUnsupported)
	})
}

func TestTestedConnectionReusedForConnect(t *testing.T) {
	mfa := func(o *sshtest.Options) { o.MFA = &sshtest.MFA{Question: "Verification code: ", Answer: "424242"} }
	h := newRemoteHost(t, "", mfa)
	h.f.term.answers = []string{"424242"}
	if res, _ := h.test(h.start()); res.Outcome != "ready_to_start" {
		t.Fatalf("%s: %s", res.Outcome, summary(res.Stages))
	}
	if _, err := h.open(h.start()); err != nil {
		t.Fatal(err)
	}
	if n, k := h.srv.Connections(), h.srv.KeyboardRounds(); n != 1 || k != 1 {
		t.Fatalf("%d connections and %d second-factor rounds, want 1 and 1", n, k)
	}
	if asked := h.f.term.Asked(); len(asked) != 1 {
		t.Fatalf("asked %v", asked)
	}

	t.Run("not after 120 s", func(t *testing.T) {
		h := newRemoteHost(t, "", mfa)
		h.r.ReuseFor = 100 * time.Millisecond
		h.f.term.answers = []string{"424242", "424242"}
		if res, _ := h.test(h.start()); res.Outcome != "ready_to_start" {
			t.Fatalf("%s: %s", res.Outcome, summary(res.Stages))
		}
		time.Sleep(300 * time.Millisecond)
		if _, err := h.open(h.start()); err != nil {
			t.Fatal(err)
		}
		if n, k := h.srv.Connections(), h.srv.KeyboardRounds(); n != 2 || k != 2 {
			t.Fatalf("%d connections and %d second-factor rounds, want 2 and 2", n, k)
		}
	})
	t.Run("not for another workspace or a failed test", func(t *testing.T) {
		h := newRemoteHost(t, "missing")
		if res, _ := h.test(h.start()); res.Outcome != "failed" {
			t.Fatalf("%s", res.Outcome)
		}
		h.r.mu.Lock()
		n := len(h.r.parked)
		h.r.mu.Unlock()
		if n != 0 {
			t.Fatal("a connection that failed the test was kept")
		}
		other := h.target()
		other.Workspace = "/elsewhere"
		h.r.park(h.target(), &Conn{Client: nil}, h.ws)
		if c, _ := h.r.take(context.Background(), other); c != nil {
			t.Fatal("a connection was reused for another workspace")
		}
	})
}

func TestOrphanRemoteSweepNonInteractive(t *testing.T) {
	h := newRemoteHost(t, "stubborn")
	rt, err := h.open(h.start())
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := rt.Remote.Process()
	// The connector crashes: its connection goes, the server keeps running.
	rt.Remote.Close()
	if !alive(pid) {
		t.Fatal("closing the connection ended the server")
	}
	times := jupyter.StopTimes{Shutdown: 200 * time.Millisecond, Terminate: 200 * time.Millisecond}
	if err := h.r.SweepOrphan(context.Background(), h.target(), sessionID, pid, times); err != nil {
		t.Fatal(err)
	}
	waitGone(t, pid)

	t.Run("an encrypted key is not unlocked in a terminal", func(t *testing.T) {
		h := newRemoteHost(t, "")
		locked := newClientKey(t, "passphrase")
		h.srv.Close()
		srv := sshtest.New(t, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{locked.signer.PublicKey()}, Exec: sshtest.POSIXHost(h.stub)})
		h.f.term.answers = []string{"passphrase"}
		tg := protocol.Target{Kind: protocol.TargetSSH, Host: srv.Host, Port: srv.Port, User: "student", Auth: keyAuth(locked), Workspace: h.ws}
		err := h.r.SweepOrphan(context.Background(), tg, sessionID, 4242, times)
		if len(h.f.term.Asked()) != 0 {
			t.Fatalf("the sweep asked %v", h.f.term.Asked())
		}
		if err == nil || len(srv.Execs()) != 0 {
			t.Fatalf("sweep %v, execs %v", err, srv.Execs())
		}
	})
}
