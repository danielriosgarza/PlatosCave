//go:build !windows

package cli

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/signal"
	"syscall"
	"testing"
	"time"

	"parallax/connector/internal/jupyter/jupytertest"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/session"
	"parallax/connector/internal/testserver"
)

func TestMain(m *testing.M) {
	jupytertest.RunIfStub()
	os.Exit(m.Run())
}

const (
	leaseSession = "7b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
	leaseRequest = "c0ffee00-1111-4222-8333-444455556666"
)

func gone(pid int) bool { return errors.Is(syscall.Kill(pid, 0), syscall.ESRCH) }

// startRun runs `run` until ctx ends and opens one owned local session on its link; it returns
// the link, the Jupyter pid and run's exit code channel.
func startRun(t *testing.T, ctx context.Context, h *harness, srv *testserver.Server, dir string) (*testserver.Link, int, <-chan int) {
	t.Helper()
	h.env.Stdout, h.env.Stderr = &syncBuffer{}, &syncBuffer{}
	done := make(chan int, 1)
	go func() { done <- Main(ctx, []string{"run"}, h.env) }()
	lctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	l, err := srv.NextLink(lctx)
	if err != nil {
		t.Fatalf("no link: %v (%s)", err, h.env.Stderr)
	}
	if err := l.Send(&protocol.OpenSession{RequestID: leaseRequest, SessionID: leaseSession,
		Target: protocol.Target{Kind: "local", Workspace: t.TempDir()}, Runtime: protocol.Runtime{Mode: "start"},
		Lease: protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5}}); err != nil {
		t.Fatal(err)
	}
	for {
		r, err := l.Next(lctx)
		if err != nil {
			t.Fatalf("waiting for ready: %v", err)
		}
		if st, ok := r.Message.(*protocol.SessionState); ok && st.State == "ready" {
			break
		} else if ok && st.State != "starting" {
			t.Fatalf("session_state %+v", st)
		}
	}
	recs := jupytertest.Records(t, dir)
	if len(recs) != 1 {
		t.Fatalf("%d servers", len(recs))
	}
	return l, recs[0].PID, done
}

// stoppedRecord reads sessions.json and returns the session's record, which must be a stopped
// one with cause connector_exit: the link was going away, so the stop waits for the next run.
func stoppedRecord(t *testing.T, h *harness) {
	t.Helper()
	data, err := h.store().ReadFile("sessions.json")
	if err != nil {
		t.Fatal(err)
	}
	var f session.File
	if err := json.Unmarshal(data, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Sessions) != 1 || f.Sessions[0].SessionID != leaseSession || f.Sessions[0].State != "stopped" || f.Sessions[0].Cause != "connector_exit" {
		t.Fatalf("sessions.json after exit: %s", data)
	}
}

// SIGTERM (and Ctrl-C, the same path) stops every owned session before `run` exits, with
// cause connector_exit, which the next run reports in its first heartbeat.
func TestRunStopsOwnedSessionsOnSIGTERM(t *testing.T) {
	h, srv, _ := pairedHarness(t)
	dir := jupytertest.Install(t, "")
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM)
	defer stop()
	_, pid, done := startRun(t, ctx, h, srv, dir)
	if err := syscall.Kill(os.Getpid(), syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	select {
	case code := <-done:
		if code != ExitOK {
			t.Fatalf("run exit %d after SIGTERM: %s", code, h.env.Stderr)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("run did not stop on SIGTERM")
	}
	if !gone(pid) {
		t.Fatal("run exited while the session's Jupyter still runs")
	}
	stoppedRecord(t, h)

	// The next run tells the server how the session ended.
	ctx2, cancel := context.WithCancel(context.Background())
	done2 := make(chan int, 1)
	go func() { done2 <- Main(ctx2, []string{"run"}, h.env) }()
	defer func() { cancel(); <-done2 }()
	lctx, lcancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer lcancel()
	l, err := srv.NextLink(lctx)
	if err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the first heartbeat", func() bool { return len(l.Heartbeats()) > 0 })
	hb := l.Heartbeats()[0]
	if len(hb.Sessions) != 1 || hb.Sessions[0].State != "stopped" || hb.Sessions[0].Cause != "connector_exit" {
		t.Errorf("first heartbeat of the next run: %+v", hb.Sessions)
	}
}

// A revoked link ends `run`, and the sessions it owned are stopped first.
func TestRevokedLinkStopsOwnedSessions(t *testing.T) {
	h, srv, connectorID := pairedHarness(t)
	dir := jupytertest.Install(t, "")
	l, pid, done := startRun(t, context.Background(), h, srv, dir)
	srv.Revoke(connectorID)
	l.Close(4403, "revoked")
	select {
	case code := <-done:
		if code != ExitError {
			t.Fatalf("run exit %d after revocation", code)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("run did not stop when revoked")
	}
	if !gone(pid) {
		t.Fatal("run exited while the session's Jupyter still runs")
	}
	stoppedRecord(t, h)
}
