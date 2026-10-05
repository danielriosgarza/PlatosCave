package cli

import (
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"parallax/connector/internal/protocol"
	"parallax/connector/internal/state"
	"parallax/connector/internal/testserver"
)

// syncBuffer is a bytes.Buffer safe to read while `run` writes it.
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

// pairedHarness pairs a connector with a test server that also serves the link.
func pairedHarness(t *testing.T) (*harness, *testserver.Server, string) {
	t.Helper()
	srv := testserver.New()
	t.Cleanup(srv.Close)
	srv.LinkOptions.HeartbeatSeconds = 60
	srv.AddCode("AAAA-BBBB")
	srv.OnPoll = approveOnPoll(1)
	h := newHarness(t, srv.Client())
	if code := h.run("pair", "--server", srv.URL, "--code", "AAAA-BBBB"); code != ExitOK {
		t.Fatalf("pair exit %d: %s", code, h.stderr)
	}
	cfg, err := h.store().ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	return h, srv, cfg.ConnectorID
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestRunWritesRuntimeJSON(t *testing.T) {
	h, srv, connectorID := pairedHarness(t)
	out := &syncBuffer{}
	h.env.Stdout = out
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan int, 1)
	go func() {
		done <- Main(ctx, []string{"run", "--allow-net", "10.20.30.40/16", "--allow-net", "fd00::1/8"}, h.env)
	}()

	lctx, lcancel := context.WithTimeout(ctx, 10*time.Second)
	l, err := srv.NextLink(lctx)
	lcancel()
	if err != nil {
		t.Fatalf("no link: %v (stdout %s, stderr %s)", err, out, h.stderr)
	}
	if l.ConnectorID != connectorID {
		t.Errorf("link authenticated %s, want %s", l.ConnectorID, connectorID)
	}
	if got := strings.Join(l.Hello.NetworkScope.CIDRs, " "); got != "10.20.0.0/16 fd00::/8" {
		t.Errorf("hello.networkScope.cidrs = %q", got)
	}
	if l.Hello.Mode != "personal" || l.Hello.OS != "linux" || l.Hello.Arch != "amd64" {
		t.Errorf("hello = %+v", l.Hello)
	}

	var rt *state.Runtime
	waitFor(t, "runtime.json with the link up", func() bool {
		rt, err = h.store().ReadRuntime()
		return err == nil && rt.Link == "up"
	})
	if rt.PID != os.Getpid() || rt.LastError != "" || rt.Sessions != 0 {
		t.Errorf("runtime.json = %+v", rt)
	}
	waitFor(t, "the connected line", func() bool { return strings.Contains(out.String(), "Connected to "+srv.Origin) })

	h.stdout.Reset()
	if code := Main(context.Background(), []string{"status"}, h.env); code != ExitOK {
		t.Fatalf("status exit %d", code)
	}
	if !strings.Contains(out.String(), "Running. Link up since "+rt.Since+"; 0 session(s).") {
		t.Errorf("status while running:\n%s", out)
	}

	// A second run on the same state directory is refused.
	if code := Main(context.Background(), []string{"run"}, h.env); code != ExitError ||
		!strings.Contains(h.stderr.String(), "another parallax-connector process") {
		t.Errorf("second run exit %d: %s", code, h.stderr)
	}

	cancel()
	select {
	case code := <-done:
		if code != ExitOK {
			t.Errorf("run exit %d after Ctrl+C: %s", code, h.stderr)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("run did not stop")
	}
	if !strings.Contains(out.String(), "Stopped.") {
		t.Errorf("stdout:\n%s", out)
	}
	if h.exists(state.RuntimeFile) {
		t.Error("runtime.json outlived run")
	}
	<-l.Done()
	if code := l.CloseStatus(); code != 1001 {
		t.Errorf("run closed the link with %d, want 1001", code)
	}
}

func TestRunStopsWhenRevoked(t *testing.T) {
	h, srv, connectorID := pairedHarness(t)
	srv.Revoke(connectorID)
	code := h.run("run")
	if code != ExitError {
		t.Fatalf("run exit %d, want %d", code, ExitError)
	}
	if !strings.Contains(h.stderr.String(), "revoked") {
		t.Errorf("stderr does not explain the revocation: %s", h.stderr)
	}
	if n := len(srv.LinkAttempts()); n != 1 {
		t.Errorf("%d link attempts, want 1", n)
	}
	if h.exists(state.RuntimeFile) {
		t.Error("runtime.json outlived run")
	}
}

func TestRunNeedsPairing(t *testing.T) {
	h := newHarness(t, nil)
	if code := h.run("run"); code != ExitError || !strings.Contains(h.stderr.String(), "not paired") {
		t.Fatalf("run exit %d: %s", code, h.stderr)
	}
	if code := h.run("run", "--allow-net", "10.0.0.0"); code != ExitUsage {
		t.Fatalf("run with a bad --allow-net exit %d: %s", code, h.stderr)
	}
}

func TestRunUsesStateDirFlag(t *testing.T) {
	h, srv, _ := pairedHarness(t)
	h.env.StateDir = func() (string, error) { return t.TempDir(), nil } // not the paired one
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() { done <- Main(ctx, []string{"run", "--state-dir", h.dir}, h.env) }()
	lctx, lcancel := context.WithTimeout(ctx, 10*time.Second)
	defer lcancel()
	if _, err := srv.NextLink(lctx); err != nil {
		t.Fatalf("no link: %v", err)
	}
	cancel()
	if code := <-done; code != ExitOK {
		t.Errorf("run exit %d: %s", code, h.stderr)
	}
}

func TestStatusWhileAnotherCommandHoldsTheLock(t *testing.T) {
	h, _, _ := pairedHarness(t)
	// A stale runtime.json from a crashed run, then pair or unpair holding the lock.
	rt := `{"v":1,"pid":4711,"startedAt":"2026-10-03T09:30:00Z","link":"up","since":"2026-10-03T09:31:00Z","sessions":0}`
	if err := h.store().WritePrivate(state.RuntimeFile, []byte(rt)); err != nil {
		t.Fatal(err)
	}
	lock, err := lockStore(h.store())
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if h.exists(state.RuntimeFile) {
		t.Fatal("taking the lock kept a stale runtime.json")
	}
	h.run("status")
	if out := h.stdout.String(); strings.Contains(out, "Running") || !strings.Contains(out, "another parallax-connector command") {
		t.Fatalf("status:\n%s", out)
	}
}

func TestRuntimePIDAcceptsWindowsRange(t *testing.T) {
	rt := state.Runtime{V: 1, PID: 4194305 * 4, StartedAt: "2026-10-03T09:30:00Z", Link: "up", Since: "2026-10-03T09:30:00Z"}
	if err := rt.Validate(); err != nil {
		t.Fatalf("a Windows process id above the Linux limit: %v", err)
	}
}

func TestConfirmSessionsAsksFirst(t *testing.T) {
	h, srv, _ := pairedHarness(t)
	if code := h.run("run", "--confirm-sessions"); code != ExitUsage || !strings.Contains(h.stderr.String(), "needs a terminal") {
		t.Fatalf("--confirm-sessions without a terminal: exit %d: %s", code, h.stderr)
	}

	h.tty = true
	pr, pw := io.Pipe()
	defer pw.Close()
	h.env.Stdin = pr
	out := &syncBuffer{}
	h.env.Stdout = out
	h.env.Getenv = func(k string) string {
		if k == "PARALLAX_ALLOW_NET" {
			return "192.168.10.0/24"
		}
		return ""
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan int, 1)
	go func() { done <- Main(ctx, []string{"run", "--confirm-sessions", "--allow-net", "10.1.0.0/16"}, h.env) }()
	lctx, lcancel := context.WithTimeout(ctx, 10*time.Second)
	l, err := srv.NextLink(lctx)
	lcancel()
	if err != nil {
		t.Fatalf("no link: %v (%s)", err, h.stderr)
	}
	if got := strings.Join(l.Hello.NetworkScope.CIDRs, " "); got != "10.1.0.0/16 192.168.10.0/24" {
		t.Errorf("hello.networkScope.cidrs = %q, want the flag and PARALLAX_ALLOW_NET", got)
	}

	ws := t.TempDir()
	const sessionID, requestID = "7b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", "c0ffee00-1111-4222-8333-444455556666"
	if err := l.Send(&protocol.OpenSession{RequestID: requestID, SessionID: sessionID,
		Target:  protocol.Target{Kind: "local", Workspace: ws},
		Runtime: protocol.Runtime{Mode: "start", KernelName: "python3"},
		Lease:   protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5}}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the question", func() bool { return strings.Contains(out.String(), "Allow? [y/N]") })
	if !strings.Contains(out.String(), "Session "+sessionID+" requested by Parallax on this computer in "+ws+": start Jupyter, kernel python3.") {
		t.Errorf("no session log line before the question:\n%s", out)
	}
	// Nothing was answered yet, so nothing was sent about the session.
	rctx, rcancel := context.WithTimeout(ctx, 200*time.Millisecond)
	if r, err := l.Next(rctx); err == nil {
		t.Errorf("the connector sent %+v before the person answered", r)
	}
	rcancel()
	io.WriteString(pw, "n\n")
	nctx, ncancel := context.WithTimeout(ctx, 10*time.Second)
	r, err := l.Next(nctx)
	ncancel()
	if err != nil {
		t.Fatal(err)
	}
	if e, ok := r.Message.(*protocol.Error); !ok || e.Code != protocol.CodePathNotAllowed || e.SessionID != sessionID {
		t.Errorf("after declining: %+v", r)
	}
	cancel()
	if code := <-done; code != ExitOK {
		t.Errorf("run exit %d: %s", code, h.stderr)
	}
}
