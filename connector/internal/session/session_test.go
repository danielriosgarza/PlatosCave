package session

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net"
	"net/http/httptest"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"parallax/connector/internal/identity"
	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/jupyter/jupytertest"
	"parallax/connector/internal/link"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/target"
	"parallax/connector/internal/testserver"
)

func TestMain(m *testing.M) {
	jupytertest.RunIfStub()
	os.Exit(m.Run())
}

const (
	sessionA = "7b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
	sessionB = "8c2e3f40-5b6c-4d7e-8f80-a1b2c3d4e5f6"
	reqA     = "c0ffee00-1111-4222-8333-444455556666"
	reqB     = "c0ffee00-1111-4222-8333-444455556667"
	reqC     = "c0ffee00-1111-4222-8333-444455556668"
)

// syncBuffer is a log safe to read while the manager writes it.
type syncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuffer) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

// env runs a manager behind a real link to the test server.
type env struct {
	t    *testing.T
	srv  *testserver.Server
	l    *testserver.Link
	mgr  *Manager
	log  *syncBuffer
	all  []protocol.Message
	next uint32
}

func newEnv(t *testing.T, mutate func(*Config), limits protocol.Limits) *env {
	t.Helper()
	return newEnvOn(t, mutate, func(srv *testserver.Server) {
		if limits != (protocol.Limits{}) {
			srv.LinkOptions.Limits = limits
		}
	})
}

// newEnvOn is newEnv with the test server's link options set by setup before the first link.
func newEnvOn(t *testing.T, mutate func(*Config), setup func(*testserver.Server)) *env {
	t.Helper()
	srv := testserver.New()
	t.Cleanup(srv.Close)
	srv.LinkOptions.HeartbeatSeconds = 30
	if setup != nil {
		setup(srv)
	}
	id, err := identity.Generate()
	if err != nil {
		t.Fatal(err)
	}
	connectorID := srv.AddConnector(id.PublicKey(), testserver.StatusActive)
	log := &syncBuffer{}
	cfg := Config{
		Targets:   map[string]target.Target{protocol.TargetLocal: &target.Local{OS: "linux", Arch: "amd64"}},
		Log:       log,
		StopTimes: jupyter.StopTimes{Shutdown: 2 * time.Second, Terminate: time.Second},
	}
	if mutate != nil {
		mutate(&cfg)
	}
	ctx, cancel := context.WithCancel(context.Background())
	mgr := New(ctx, cfg)
	done := make(chan struct{})
	go func() {
		defer close(done)
		link.Run(ctx, link.Config{
			Origin: srv.Origin, ConnectorID: connectorID, Identity: id,
			Hello: protocol.Hello{Version: "0.0.0-dev", OS: "linux", Arch: "amd64", Mode: "personal",
				Targets: []string{"local", "ssh"}, NetworkScope: protocol.NetworkScope{CIDRs: []string{}, Hosts: []string{}}},
			HTTPClient: srv.Client(), Handler: mgr, Sessions: mgr.Sessions,
		})
	}()
	t.Cleanup(func() {
		mgr.Close(context.Background())
		cancel()
		<-done
	})
	lctx, lcancel := context.WithTimeout(ctx, 10*time.Second)
	defer lcancel()
	l, err := srv.NextLink(lctx)
	if err != nil {
		t.Fatalf("no link: %v", err)
	}
	return &env{t: t, srv: srv, l: l, mgr: mgr, log: log, next: 1}
}

func (e *env) send(m protocol.Message) {
	e.t.Helper()
	if err := e.l.Send(m); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) recv() testserver.Received {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r, err := e.l.Next(ctx)
	if err != nil {
		e.t.Fatalf("waiting for the connector: %v", err)
	}
	if r.Message != nil {
		e.all = append(e.all, r.Message)
	}
	return r
}

// expect returns the next control message, which must be a T.
func expect[T protocol.Message](e *env) T {
	e.t.Helper()
	for {
		r := e.recv()
		if r.Message == nil {
			e.t.Fatalf("got a frame for stream %d, want %T", r.Frame.StreamID, *new(T))
		}
		if m, ok := r.Message.(T); ok {
			return m
		}
		e.t.Fatalf("got %T %+v, want %T", r.Message, r.Message, *new(T))
	}
}

func (e *env) state(want string) *protocol.SessionState {
	e.t.Helper()
	st := expect[*protocol.SessionState](e)
	if st.State != want {
		e.t.Fatalf("session_state %s (%s %s), want %s", st.State, st.Code, st.Detail, want)
	}
	return st
}

func lease() protocol.Lease { return protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5} }

func (e *env) openLocal(sessionID, requestID, ws string, rt protocol.Runtime) *protocol.SessionState {
	e.t.Helper()
	e.send(&protocol.OpenSession{RequestID: requestID, SessionID: sessionID, Target: protocol.Target{Kind: "local", Workspace: ws}, Runtime: rt, Lease: lease()})
	if st := e.state(StateStarting); st.RequestID != requestID {
		e.t.Fatalf("starting carries request %q", st.RequestID)
	}
	return e.state(StateReady)
}

// call makes one `http` request and returns the head, the body and any reset.
func (e *env) call(sessionID, purpose, method, path string, body []byte) (*protocol.HTTPHead, []byte, *protocol.StreamReset) {
	e.t.Helper()
	id := e.next
	e.next++
	m := &protocol.HTTP{StreamID: id, SessionID: sessionID, Purpose: purpose, Method: method, Path: path,
		Headers: protocol.Headers{"accept": "application/json"}, Body: "none"}
	if body != nil {
		n := int64(len(body))
		m.Body, m.ContentLength = "stream", &n
		m.Headers["content-type"] = "application/json"
	}
	e.send(m)
	if body != nil {
		if err := e.l.SendFrame(protocol.Frame{StreamID: id, Flags: protocol.FlagEnd, Payload: body}); err != nil {
			e.t.Fatal(err)
		}
	}
	var head *protocol.HTTPHead
	var out []byte
	for {
		r := e.recv()
		switch {
		case r.Frame != nil && r.Frame.StreamID == id:
			out = append(out, r.Frame.Payload...)
			if r.Frame.End() {
				return head, out, nil
			}
		case r.Message != nil:
			switch m := r.Message.(type) {
			case *protocol.HTTPHead:
				if m.StreamID != id {
					continue
				}
				head = m
				if m.Body == "none" {
					return head, nil, nil
				}
			case *protocol.StreamReset:
				if m.StreamID == id {
					return head, out, m
				}
			case *protocol.Window:
			default:
				e.t.Fatalf("unexpected %T during a call", m)
			}
		}
	}
}

func (e *env) mustCall(sessionID, purpose, method, path string, body []byte) (*protocol.HTTPHead, []byte) {
	e.t.Helper()
	head, out, reset := e.call(sessionID, purpose, method, path, body)
	if reset != nil {
		e.t.Fatalf("%s %s reset: %s %s", method, path, reset.Code, reset.Detail)
	}
	return head, out
}

func (e *env) refused(sessionID, purpose, method, path string, body []byte, code protocol.Code) {
	e.t.Helper()
	head, _, reset := e.call(sessionID, purpose, method, path, body)
	if reset == nil || reset.Code != code || head != nil {
		e.t.Fatalf("%s %s: head %+v reset %+v, want a reset with %s", method, path, head, reset, code)
	}
}

func (e *env) startKernel(sessionID string) string {
	e.t.Helper()
	head, body := e.mustCall(sessionID, "session", "POST", "/api/kernels", []byte(`{"name":"python3"}`))
	if head.Status != 201 {
		e.t.Fatalf("kernel start status %d", head.Status)
	}
	id, err := jupyter.KernelID(body)
	if err != nil {
		e.t.Fatal(err)
	}
	return id
}

// executeOverChannel opens the kernel channel and runs code; it returns the stdout text and
// the execute_reply status.
func (e *env) executeOverChannel(sessionID, kernelID, code string) (string, string) {
	e.t.Helper()
	id := e.next
	e.next++
	e.send(&protocol.WSOpen{StreamID: id, SessionID: sessionID, Path: "/api/kernels/" + kernelID + "/channels?session_id=" + sessionID})
	if m := expect[*protocol.WSOpened](e); m.StreamID != id {
		e.t.Fatalf("ws_opened for %d", m.StreamID)
	}
	req, _ := json.Marshal(map[string]any{
		"header":        map[string]any{"msg_id": "m1", "msg_type": "execute_request", "session": sessionID, "username": "", "version": "5.3"},
		"parent_header": map[string]any{}, "metadata": map[string]any{}, "channel": "shell",
		"content": map[string]any{"code": code, "silent": false, "store_history": true, "user_expressions": map[string]any{}, "allow_stdin": false, "stop_on_error": true},
	})
	if err := e.l.SendFrame(protocol.Frame{StreamID: id, Flags: protocol.FlagEnd | protocol.FlagText, Payload: req}); err != nil {
		e.t.Fatal(err)
	}
	var stdout, status string
	var msg []byte
	idle := false
	for status == "" || !idle {
		r := e.recv()
		if r.Frame == nil {
			if _, ok := r.Message.(*protocol.Window); ok {
				continue
			}
			e.t.Fatalf("unexpected %T on the channel", r.Message)
		}
		if r.Frame.StreamID != id || !r.Frame.Text() {
			e.t.Fatalf("frame %+v", r.Frame)
		}
		msg = append(msg, r.Frame.Payload...)
		if !r.Frame.End() {
			continue
		}
		var m struct {
			Header       map[string]any `json:"header"`
			ParentHeader map[string]any `json:"parent_header"`
			Content      map[string]any `json:"content"`
		}
		if err := json.Unmarshal(msg, &m); err != nil {
			e.t.Fatal(err)
		}
		msg = nil
		if m.ParentHeader["msg_id"] != "m1" {
			e.t.Errorf("output with parent %v", m.ParentHeader["msg_id"])
		}
		switch m.Header["msg_type"] {
		case "stream":
			stdout += m.Content["text"].(string)
		case "execute_reply":
			status = m.Content["status"].(string)
		case "status":
			idle = m.Content["execution_state"] == "idle"
		}
	}
	e.send(&protocol.WSClose{StreamID: id, Code: 1000})
	return stdout, status
}

// A27 (local half): the connector starts Jupyter on this computer, a cell runs there and its
// output returns over the link, and nothing listens on an address other than loopback.
func TestA27_LocalRunsCellThroughProxy(t *testing.T) {
	dir := jupytertest.Install(t, "")
	e := newEnv(t, nil, protocol.Limits{})
	ws := t.TempDir()
	ready := e.openLocal(sessionA, reqA, ws, protocol.Runtime{Mode: "start", KernelName: "python3"})
	if !ready.Owned || ready.RequestID != reqA || ready.JupyterVersion != jupytertest.Version || !jupyter.HasKernel(ready.Kernelspecs, "python3") {
		t.Errorf("ready = %+v", ready)
	}
	if ready.Environment == nil || ready.Environment.OS != "linux" {
		t.Errorf("environment %+v", ready.Environment)
	}

	head, body := e.mustCall(sessionA, "session", "GET", "/api/status", nil)
	if head.Status != 200 || !strings.Contains(string(body), "started") {
		t.Errorf("status %d %s", head.Status, body)
	}
	kernel := e.startKernel(sessionA)
	stdout, status := e.executeOverChannel(sessionA, kernel, "print(2 + 2)")
	if stdout != "4\n" || status != "ok" {
		t.Errorf("cell output %q, status %q; want \"4\\n\", ok", stdout, status)
	}

	// The connector's path needs no listening port off loopback: neither the connector process
	// nor the Jupyter server it started listens on anything but loopback.
	recs := jupytertest.Records(t, dir)
	if len(recs) != 1 {
		t.Fatalf("%d servers started", len(recs))
	}
	if host, _, _ := net.SplitHostPort(recs[0].Listen); host != "127.0.0.1" {
		t.Errorf("Jupyter listens on %s", recs[0].Listen)
	}
	for _, f := range []string{"--ServerApp.ip=127.0.0.1", "--ServerApp.allow_remote_access=False", "--ServerApp.open_browser=False"} {
		if !strings.Contains(strings.Join(recs[0].Argv, " "), f) {
			t.Errorf("argv lacks %s", f)
		}
	}
	if runtime.GOOS == "linux" {
		for _, pid := range []int{os.Getpid(), recs[0].PID} {
			for _, a := range listeningAddrs(t, pid) {
				if !a.Addr().IsLoopback() {
					t.Errorf("process %d listens on %s", pid, a)
				}
			}
		}
	}

	e.send(&protocol.CloseSession{RequestID: reqB, SessionID: sessionA, Stop: true})
	e.state(StateStopping)
	stopped := e.state(StateStopped)
	if stopped.Cause != "user_stop" || stopped.RequestID != reqB || !stopped.Owned {
		t.Errorf("stopped = %+v", stopped)
	}
	if processAlive(recs[0].PID) {
		t.Error("stopped was sent while the Jupyter process still runs")
	}
	if !strings.Contains(e.log.String(), "Session "+sessionA+" requested by Parallax on this computer in "+ws) {
		t.Errorf("no session log line:\n%s", e.log)
	}
}

// listeningAddrs returns the TCP addresses a Linux process listens on, from /proc.
func listeningAddrs(t *testing.T, pid int) []netip.AddrPort {
	t.Helper()
	fds, err := os.ReadDir(fmt.Sprintf("/proc/%d/fd", pid))
	if err != nil {
		t.Fatalf("reading fds of %d: %v", pid, err)
	}
	inodes := map[string]bool{}
	for _, fd := range fds {
		target, err := os.Readlink(fmt.Sprintf("/proc/%d/fd/%s", pid, fd.Name()))
		if err == nil && strings.HasPrefix(target, "socket:[") {
			inodes[strings.TrimSuffix(strings.TrimPrefix(target, "socket:["), "]")] = true
		}
	}
	var out []netip.AddrPort
	for _, file := range []string{"tcp", "tcp6"} {
		f, err := os.Open(fmt.Sprintf("/proc/%d/net/%s", pid, file))
		if err != nil {
			continue
		}
		sc := bufio.NewScanner(f)
		sc.Scan() // header
		for sc.Scan() {
			fields := strings.Fields(sc.Text())
			if len(fields) < 10 || fields[3] != "0A" || !inodes[fields[9]] {
				continue
			}
			out = append(out, parseProcAddr(t, fields[1]))
		}
		f.Close()
	}
	return out
}

// parseProcAddr parses /proc/net/tcp's hex address: little-endian 32-bit words.
func parseProcAddr(t *testing.T, s string) netip.AddrPort {
	hexAddr, hexPort, _ := strings.Cut(s, ":")
	raw, err := hex.DecodeString(hexAddr)
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i+4 <= len(raw); i += 4 {
		raw[i], raw[i+1], raw[i+2], raw[i+3] = raw[i+3], raw[i+2], raw[i+1], raw[i]
	}
	port, _ := strconv.ParseUint(hexPort, 16, 16)
	a, _ := netip.AddrFromSlice(raw)
	return netip.AddrPortFrom(a.Unmap(), uint16(port))
}

func processAlive(pid int) bool {
	if runtime.GOOS != "linux" {
		return false
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return false
	}
	// A zombie has exited.
	fields := strings.Fields(string(data))
	return len(fields) > 2 && fields[2] != "Z"
}

func TestTestConnectionOverTheLink(t *testing.T) {
	jupytertest.Install(t, "")
	e := newEnv(t, nil, protocol.Limits{})
	e.send(&protocol.TestConnection{RequestID: reqA, Target: protocol.Target{Kind: "local", Workspace: t.TempDir()}, Runtime: protocol.Runtime{Mode: "start"}})
	var names []string
	for range 4 {
		p := expect[*protocol.TestProgress](e)
		if p.RequestID != reqA {
			t.Errorf("progress for %s", p.RequestID)
		}
		names = append(names, p.Stage.Name)
	}
	if got := strings.Join(names, ","); got != "workspace,runtime,notebook_auth,kernels" {
		t.Errorf("progress %s", got)
	}
	res := expect[*protocol.TestResult](e)
	if res.Outcome != "ready_to_start" || res.RequestID != reqA {
		t.Errorf("result %+v", res)
	}
	// An ssh target is not served by this connector yet.
	e.send(&protocol.TestConnection{RequestID: reqB, Target: protocol.Target{Kind: "ssh", Host: "example.org", Port: 22, User: "a",
		Auth: &protocol.AuthRef{Method: "agent"}, Workspace: "/home/a"}, Runtime: protocol.Runtime{Mode: "start"}})
	if er := expect[*protocol.Error](e); er.Code != protocol.CodeUnsupportedTarget || er.RequestID != reqB {
		t.Errorf("ssh test: %+v", er)
	}
}

func TestRefusedRequestsNeverReachJupyter(t *testing.T) {
	ws, port, fake := attachFixture(t)
	e := newEnv(t, nil, protocol.Limits{})
	e.openLocal(sessionA, reqA, ws, protocol.Runtime{Mode: "attach", Port: port})
	before := len(fake.Requests())
	for _, c := range []struct {
		purpose, method, path string
		body                  []byte
		code                  protocol.Code
	}{
		{"session", "GET", "/api/sessions", nil, protocol.CodePathNotAllowed},
		{"session", "POST", "/api/shutdown", nil, protocol.CodePathNotAllowed},
		{"session", "GET", "/api/terminals", nil, protocol.CodePathNotAllowed},
		{"session", "GET", "/api/status?token=abc", nil, protocol.CodePathNotAllowed},
		{"contents", "GET", "/api/contents/parallax/../../etc/passwd", nil, protocol.CodePathNotAllowed},
		{"contents", "GET", "/api/contents/parallax/%252e%252e/x", nil, protocol.CodePathNotAllowed},
		{"contents", "GET", "/api/contents/other/a.csv", nil, protocol.CodePathNotAllowed},
		{"contents", "GET", "/api/contents/parallax-private/a.csv", nil, protocol.CodePathNotAllowed},
		{"contents", "GET", "/api/contents/parallax/.ssh/id_rsa", nil, protocol.CodePathNotAllowed},
		{"contents", "POST", "/api/contents/parallax", []byte(`{"copy_from":"/etc/passwd"}`), protocol.CodePathNotAllowed},
		{"session", "POST", "/api/kernels", []byte(`{"name":"python3","env":{"X":"1"}}`), protocol.CodePathNotAllowed},
		{"session", "POST", "/api/kernels", nil, protocol.CodePathNotAllowed},
		{"session", "POST", "/api/kernels", []byte(`{"name":"` + strings.Repeat("a", 2000) + `"}`), protocol.CodeBodyTooLarge},
	} {
		e.refused(sessionA, c.purpose, c.method, c.path, c.body, c.code)
	}
	if after := len(fake.Requests()); after != before {
		t.Errorf("%d refused requests reached Jupyter: %+v", after-before, fake.Requests()[before:])
	}
	// The contents calls that are allowed reach Jupyter inside the workspace.
	head, _ := e.mustCall(sessionA, "contents", "GET", "/api/contents/parallax/a.csv?content=1", nil)
	if head.Status != 200 {
		t.Errorf("contents get %d", head.Status)
	}
	head, _ = e.mustCall(sessionA, "contents", "POST", "/api/contents/parallax", []byte(`{"type":"file","ext":".csv"}`))
	if head.Status != 201 {
		t.Errorf("contents post %d", head.Status)
	}
	if _, ok := head.Headers["set-cookie"]; ok || head.Headers["content-type"] != "application/json" {
		t.Errorf("response headers %v", head.Headers)
	}
	last := fake.Requests()[len(fake.Requests())-1]
	if last.URI != "/api/contents/parallax" || last.Header.Get("Authorization") != "token "+fake.Token || last.Header.Get("Cookie") != "" {
		t.Errorf("request as Jupyter saw it: %+v", last)
	}
	// Unknown sessions and stream ids of other sessions.
	e.refused(sessionB, "session", "GET", "/api/status", nil, protocol.CodeUnknownSession)
}

func TestKernelIdsConfinedToSessionOverTheLink(t *testing.T) {
	ws, port, fake := attachFixture(t)
	others := fake.AddKernel("python3") // another person's kernel on the same server
	e := newEnv(t, nil, protocol.Limits{})
	e.openLocal(sessionA, reqA, ws, protocol.Runtime{Mode: "attach", Port: port})
	mine := e.startKernel(sessionA)

	_, body := e.mustCall(sessionA, "session", "GET", "/api/kernels", nil)
	if strings.Contains(string(body), others) || !strings.Contains(string(body), mine) {
		t.Errorf("kernel list %s", body)
	}
	for _, p := range []string{"/api/kernels/" + others, "/api/kernels/" + others + "/interrupt", "/api/kernels/" + others + "/restart"} {
		method := "GET"
		if strings.HasSuffix(p, "t") && p != "/api/kernels/"+others {
			method = "POST"
		}
		e.refused(sessionA, "session", method, p, nil, protocol.CodePathNotAllowed)
	}
	e.refused(sessionA, "session", "DELETE", "/api/kernels/"+others, nil, protocol.CodePathNotAllowed)
	id := e.next
	e.next++
	e.send(&protocol.WSOpen{StreamID: id, SessionID: sessionA, Path: "/api/kernels/" + others + "/channels?session_id=" + sessionA})
	if r := expect[*protocol.StreamReset](e); r.StreamID != id || r.Code != protocol.CodePathNotAllowed {
		t.Errorf("channel to another kernel: %+v", r)
	}
	// The session's own kernel is reachable, and after DELETE it is not.
	if head, _ := e.mustCall(sessionA, "session", "GET", "/api/kernels/"+mine, nil); head.Status != 200 {
		t.Errorf("own kernel %d", head.Status)
	}
	if head, _ := e.mustCall(sessionA, "session", "DELETE", "/api/kernels/"+mine, nil); head.Status != 204 {
		t.Errorf("delete %d", head.Status)
	}
	e.refused(sessionA, "session", "GET", "/api/kernels/"+mine, nil, protocol.CodePathNotAllowed)
	for _, r := range fake.Requests() {
		if strings.Contains(r.URI, others) {
			t.Errorf("a request for another person's kernel reached Jupyter: %s %s", r.Method, r.URI)
		}
	}
}

func TestAttachedSessionStopIsNotOwned(t *testing.T) {
	ws, port, fake := attachFixture(t)
	e := newEnv(t, nil, protocol.Limits{})
	ready := e.openLocal(sessionA, reqA, ws, protocol.Runtime{Mode: "attach", Port: port})
	if ready.Owned {
		t.Fatal("an attached session is reported as owned")
	}
	e.send(&protocol.CloseSession{RequestID: reqB, SessionID: sessionA, Stop: true})
	er := expect[*protocol.Error](e)
	if er.Code != protocol.CodeNotOwned || er.RequestID != reqB || er.SessionID != sessionA {
		t.Errorf("stop of an attached session: %+v", er)
	}
	// Detaching is answered with the session's state, which stays ready.
	e.send(&protocol.CloseSession{RequestID: reqC, SessionID: sessionA, Stop: false})
	if st := e.state(StateReady); st.RequestID != reqC || st.Owned {
		t.Errorf("detach = %+v", st)
	}
	for _, r := range fake.Requests() {
		if r.URI == "/api/shutdown" {
			t.Error("the connector asked an attached server to shut down")
		}
	}
	if head, _ := e.mustCall(sessionA, "session", "GET", "/api/status", nil); head.Status != 200 {
		t.Errorf("the session stopped working after a refused stop: %d", head.Status)
	}
}

func TestConfirmSessionsAsksFirst(t *testing.T) {
	dir := jupytertest.Install(t, "")
	var mu sync.Mutex
	var questions []string
	answer := false
	var e *env
	e = newEnv(t, func(c *Config) {
		c.Confirm = func(_ context.Context, q string) bool {
			mu.Lock()
			defer mu.Unlock()
			questions = append(questions, q)
			// Nothing about this session has been sent or started before the question.
			if n := len(jupytertest.Records(t, dir)); n != 0 {
				t.Errorf("%d servers started before the person answered", n)
			}
			return answer
		}
	}, protocol.Limits{})
	ws := t.TempDir()
	e.send(&protocol.OpenSession{RequestID: reqA, SessionID: sessionA, Target: protocol.Target{Kind: "local", Workspace: ws},
		Runtime: protocol.Runtime{Mode: "start", KernelName: "python3"}, Lease: lease()})
	er := expect[*protocol.Error](e)
	if er.Code != protocol.CodePathNotAllowed || er.SessionID != sessionA || er.RequestID != reqA {
		t.Errorf("declined session: %+v", er)
	}
	if n := len(jupytertest.Records(t, dir)); n != 0 {
		t.Errorf("a declined session started %d servers", n)
	}
	mu.Lock()
	if len(questions) != 1 || !strings.Contains(questions[0], ws) || !strings.Contains(questions[0], "start Jupyter") {
		t.Errorf("questions %q", questions)
	}
	answer = true
	mu.Unlock()
	if len(e.mgr.Sessions()) != 0 {
		t.Error("a declined session is still held")
	}
	e.openLocal(sessionB, reqB, ws, protocol.Runtime{Mode: "start", KernelName: "python3"})
	mu.Lock()
	if len(questions) != 2 {
		t.Errorf("the second open was not asked about: %q", questions)
	}
	mu.Unlock()
}

func TestOpenSessionRefusals(t *testing.T) {
	ws, port, _ := attachFixture(t)
	e := newEnv(t, nil, protocol.Limits{MaxStreams: 32, MaxPayload: 65536, InitialWindow: 262144, MaxControl: 65536, MaxSessions: 1})
	e.openLocal(sessionA, reqA, ws, protocol.Runtime{Mode: "attach", Port: port})
	// A repeated open_session is answered with the current state.
	e.send(&protocol.OpenSession{RequestID: reqB, SessionID: sessionA, Target: protocol.Target{Kind: "local", Workspace: ws}, Runtime: protocol.Runtime{Mode: "attach", Port: port}, Lease: lease()})
	if st := e.state(StateReady); st.RequestID != reqB {
		t.Errorf("repeat = %+v", st)
	}
	// The connector's session limit.
	e.send(&protocol.OpenSession{RequestID: reqC, SessionID: sessionB, Target: protocol.Target{Kind: "local", Workspace: ws}, Runtime: protocol.Runtime{Mode: "attach", Port: port}, Lease: lease()})
	if er := expect[*protocol.Error](e); er.Code != protocol.CodeLimitExceeded || er.SessionID != sessionB {
		t.Errorf("over the limit: %+v", er)
	}
	// A target this connector does not serve.
	e.send(&protocol.OpenSession{RequestID: reqC, SessionID: sessionB, Target: protocol.Target{Kind: "ssh", Host: "example.org", Port: 22, User: "a",
		Auth: &protocol.AuthRef{Method: "agent"}, Workspace: "/home/a"}, Runtime: protocol.Runtime{Mode: "start"}, Lease: lease()})
	if er := expect[*protocol.Error](e); er.Code != protocol.CodeUnsupportedTarget {
		t.Errorf("ssh open: %+v", er)
	}
	// Unknown sessions.
	e.send(&protocol.CloseSession{RequestID: reqC, SessionID: sessionB, Stop: true})
	if er := expect[*protocol.Error](e); er.Code != protocol.CodeUnknownSession {
		t.Errorf("close unknown: %+v", er)
	}
	e.send(&protocol.Presence{SessionID: sessionB, Attached: true})
	if er := expect[*protocol.Error](e); er.Code != protocol.CodeUnknownSession {
		t.Errorf("presence unknown: %+v", er)
	}
	// A failed open is reported with the stage's code and forgotten.
	e2 := newEnv(t, nil, protocol.Limits{})
	e2.send(&protocol.OpenSession{RequestID: reqA, SessionID: sessionB, Target: protocol.Target{Kind: "local", Workspace: filepath.Join(ws, "missing")}, Runtime: protocol.Runtime{Mode: "start"}, Lease: lease()})
	e2.state(StateStarting)
	if st := e2.state(StateFailed); st.Code != protocol.CodeWorkspaceMissing || st.RequestID != reqA {
		t.Errorf("failed = %+v", st)
	}
	if len(e2.mgr.Sessions()) != 0 {
		t.Error("a failed session is still held")
	}
}

func TestOwnedProcessExitIsReported(t *testing.T) {
	dir := jupytertest.Install(t, "")
	e := newEnv(t, nil, protocol.Limits{})
	e.openLocal(sessionA, reqA, t.TempDir(), protocol.Runtime{Mode: "start"})
	recs := jupytertest.Records(t, dir)
	if len(recs) != 1 {
		t.Fatalf("%d servers", len(recs))
	}
	p, err := os.FindProcess(recs[0].PID)
	if err != nil {
		t.Fatal(err)
	}
	p.Kill()
	st := e.state(StateStopped)
	if st.Cause != "process_exited" || !st.Owned {
		t.Errorf("stopped = %+v", st)
	}
	e.refused(sessionA, "session", "GET", "/api/status", nil, protocol.CodeUnknownSession)
}

// attachFixture runs a fake Jupyter on loopback and lists it for `jupyter server list`, with
// root_dir the parent of the returned workspace (content root "parallax").
func attachFixture(t *testing.T) (string, int, *jupytertest.Server) {
	t.Helper()
	jupytertest.Install(t, "")
	fake := jupytertest.New("attach-token-0123456789")
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	port := srv.Listener.Addr().(*net.TCPAddr).Port
	root := t.TempDir()
	ws := filepath.Join(root, "parallax")
	os.Mkdir(ws, 0o700)
	t.Setenv(jupytertest.EnvList, fmt.Sprintf(`{"hostname": "127.0.0.1", "port": %d, "pid": %d, "root_dir": %q, "token": %q, "url": "http://127.0.0.1:%d/", "version": "2.21.1"}`,
		port, os.Getpid(), root, fake.Token, port))
	return ws, port, fake
}

func TestDoubleStopStopsOnce(t *testing.T) {
	jupytertest.Install(t, "")
	e := newEnv(t, nil, protocol.Limits{})
	e.openLocal(sessionA, reqA, t.TempDir(), protocol.Runtime{Mode: "start"})
	e.send(&protocol.CloseSession{RequestID: reqB, SessionID: sessionA, Stop: true})
	e.send(&protocol.CloseSession{RequestID: reqC, SessionID: sessionA, Stop: true})
	answered := map[string]bool{}
	stopped := 0
	for stopped == 0 || len(answered) < 2 {
		st := expect[*protocol.SessionState](e)
		answered[st.RequestID] = true
		switch st.State {
		case StateStopped:
			stopped++
			if st.RequestID != reqB || st.Cause != "user_stop" {
				t.Errorf("stopped = %+v", st)
			}
		case StateStopping:
		default:
			t.Fatalf("state %s during a stop", st.State)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if r, err := e.l.Next(ctx); err == nil {
		t.Errorf("after the stop: %+v", r)
	}
	if stopped != 1 || !answered[reqC] {
		t.Errorf("%d stopped, answers %v", stopped, answered)
	}
}
