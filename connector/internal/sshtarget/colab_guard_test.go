//go:build !windows

package sshtarget

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
	"unicode"

	"golang.org/x/sys/unix"

	"parallax/connector/internal/cause"
	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/jupyter/jupytertest"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/sshtest"
)

// Guards of the colab program (design §5.7), built only where the connector offers the target.

func (h *remoteHost) colab() protocol.Target {
	return protocol.Target{Kind: protocol.TargetColab, User: "student", Auth: keyAuth(h.key), Workspace: h.ws}
}

const blocked = " ssh_auth=skipped workspace=skipped forwarding=skipped"

// groupGone waits until no process is left in the process group a run of the program led.
func groupGone(t *testing.T, pid int) {
	t.Helper()
	for deadline := time.Now().Add(10 * time.Second); syscall.Kill(-pid, 0) == nil; time.Sleep(20 * time.Millisecond) {
		if time.Now().After(deadline) {
			t.Fatalf("a process of the group of the colab program %d is still running", pid)
		}
	}
}

// leaked returns what holds a byte of the program's output or a control character.
func leaked(said []string) []string {
	var out []string
	for _, s := range said {
		if strings.ContainsFunc(s, unicode.IsControl) || slices.ContainsFunc(append(colabSecrets, "colab-noise", "SECRET", "QX7K", `\u00`),
			func(x string) bool { return strings.Contains(s, x) }) {
			out = append(out, s)
		}
	}
	return out
}

func encoded(v any) string {
	data, _ := json.Marshal(v)
	return string(data)
}

// TestColabProgramMissing: a program not on PATH, or only through a relative entry, is never run
// and is colab_missing; without Colab the target is unsupported.
func TestColabProgramMissing(t *testing.T) {
	f := newFixture(t)
	req := &protocol.TestConnection{RequestID: requestID, Runtime: protocol.Runtime{Mode: protocol.RuntimeStart},
		Target: protocol.Target{Kind: protocol.TargetColab, User: "student", Auth: &protocol.AuthRef{Method: protocol.AuthAgent}, Workspace: "/home/student"}}
	if got := f.check(req).statuses(); got != "reachability=failed:unsupported_target host_identity=skipped"+blocked {
		t.Errorf("a connector without Colab: %s", got)
	}
	f.tg.Colab = &Colab{}
	t.Chdir(t.TempDir())
	scripts := []string{"colab", "bin/colab", "~/bin/colab"}
	for _, p := range scripts {
		if err := errors.Join(os.MkdirAll(filepath.Dir(p), 0o755), os.WriteFile(p, []byte("#!/bin/sh\ntouch \"$0.ran\"\n"), 0o755)); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range []string{t.TempDir(), ".", "", "bin", "~/bin"} {
		t.Setenv("PATH", path)
		if got := f.check(req).statuses(); got != "reachability=failed:colab_missing host_identity=skipped"+blocked {
			t.Errorf("PATH %q: %s", path, got)
		}
	}
	for _, p := range scripts {
		if _, err := os.Stat(p + ".ran"); err == nil {
			t.Errorf("%s ran", p)
		}
	}
}

// TestColabProgramEndsBeforeABanner: a program that floods standard error and exits 3 is
// colab_proxy_failed, and the only line about the run is the connector's own.
func TestColabProgramEndsBeforeABanner(t *testing.T) {
	h, _, records := newColabHost(t, "exit")
	run := &lines{}
	h.f.tg.Colab.Log = run.add
	var progress []protocol.Stage // what test_progress messages carry
	res := h.r.Test(t.Context(), &protocol.TestConnection{RequestID: requestID, Target: h.colab(), Runtime: h.start()},
		func(st protocol.Stage) { progress = append(progress, st) })
	line := "the colab program ended with exit status 3 before a Colab runtime answered"
	if st := stageOf(t, res.Stages, "reachability"); st.Code != protocol.CodeColabProxyFailed || st.Detail != line {
		t.Errorf("reachability %+v", st)
	}
	logged := append(append(h.logs.all(), *h.f.logs...), run.all()...)
	if !slices.Equal(logged, []string{line}) {
		t.Errorf("logged %q, want only %q", logged, line)
	}
	if got := leaked(append(logged, encoded(progress), encoded(res))); len(got) != 0 {
		t.Errorf("the program's output reached %q", got)
	}
	groupGone(t, colabRuns(t, records)[0].PID)
}

// TestColabProgramThatNeverAnswersIsEnded: no banner within the stage's deadline is
// connection_timeout, and the program and what it started are ended.
func TestColabProgramThatNeverAnswersIsEnded(t *testing.T) {
	h, _, records := newColabHost(t, "hang")
	h.f.tg.Deadlines = map[string]time.Duration{"reachability": time.Second}
	res := h.r.Test(t.Context(), &protocol.TestConnection{RequestID: requestID, Target: h.colab(), Runtime: h.start()}, func(protocol.Stage) {})
	if st := stageOf(t, res.Stages, "reachability"); st.Code != protocol.CodeConnectionTimeout {
		t.Errorf("reachability %+v", st)
	}
	groupGone(t, colabRuns(t, records)[0].PID)
}

// TestColabChangedKeyIsAHardStop: another key for colab.invalid is host_key_changed and changes
// nothing; the confirmation that replaces it keeps the old line as a comment.
func TestColabChangedKeyIsAHardStop(t *testing.T) {
	h, hostKey, _ := newColabHost(t, "")
	old := sshtest.NewSigner(t)
	os.Remove(h.f.tg.KnownHosts.Path)
	h.f.trust(protocol.ColabHost, protocol.ColabPort, old.PublicKey())
	before := h.f.knownHosts()
	req := &protocol.TestConnection{RequestID: requestID, Target: h.colab(), Runtime: h.start()}
	if got := h.f.check(req).statuses(); got != "reachability=ok host_identity=failed:host_key_changed"+blocked || h.f.knownHosts() != before {
		t.Fatalf("another key: %s\n%s", got, h.f.knownHosts())
	}
	req.Confirmations = []protocol.Confirmation{{Host: protocol.ColabHost, Port: protocol.ColabPort, SHA256: fingerprint(hostKey), Replacing: fingerprint(old)}}
	if res := h.f.check(req); res.conn == nil || !strings.Contains(h.f.knownHosts(), " "+fingerprint(old)+" colab.invalid ") {
		t.Fatalf("replaced: %s\n%s", res.statuses(), h.f.knownHosts())
	}
}

// TestColabProgramRunsAloneAndEndsWithItsConnection: it leads its session and group, gets only
// colabEnv, and nothing of its group, a child included, outlives its connection.
func TestColabProgramRunsAloneAndEndsWithItsConnection(t *testing.T) {
	h, _, records := newColabHost(t, "noisy")
	res := h.f.check(&protocol.TestConnection{RequestID: requestID, Target: h.colab(), Runtime: h.start()})
	runs := colabRuns(t, records)
	if res.conn == nil || len(runs) != 1 {
		t.Fatalf("%s, %d runs", res.statuses(), len(runs))
	}
	pid := runs[0].PID
	pgid, _ := syscall.Getpgid(pid)
	if sid, _ := unix.Getsid(pid); pgid != pid || sid != pid {
		t.Errorf("the program %d is in group %d and session %d", pid, pgid, sid)
	}
	for _, kv := range runs[0].Env {
		if name, _, _ := strings.Cut(kv, "="); !slices.Contains(colabEnv[:], name) {
			t.Errorf("the program received %s", name)
		}
	}
	res.conn.Close()
	groupGone(t, pid)
}

// TestColabProgramEndsWithTheSession: the program ends after a failed test, the reuse window,
// Stop and Close, and what it prints reaches no log line, message or detail.
func TestColabProgramEndsWithTheSession(t *testing.T) {
	h, _, records := newColabHost(t, "noisy")
	h.r.ReuseFor = 100 * time.Millisecond
	_, port := h.attachTo("tok-attached", "tok-attached", filepath.Dir(h.ws))
	var said []string
	ended := func() {
		for _, r := range colabRuns(t, records) {
			groupGone(t, r.PID)
		}
	}
	test := func(rt protocol.Runtime) string {
		res := h.r.Test(t.Context(), &protocol.TestConnection{RequestID: requestID, Target: h.colab(), Runtime: rt}, func(protocol.Stage) {})
		said = append(said, encoded(res))
		return res.Outcome
	}
	failing := h.start()
	failing.KernelName = "missing"
	if got := test(failing); got != "failed" {
		t.Fatalf("a test that does not pass: %s", got)
	}
	ended()
	if got := test(h.start()); got != "ready_to_start" {
		t.Fatalf("a test that passes: %s", got)
	}
	ended()
	// Stop of an owned session, then Close of an attached one.
	for _, rt := range []protocol.Runtime{h.start(), h.attach(port)} {
		out, err := h.r.Open(t.Context(), &protocol.OpenSession{RequestID: requestID, SessionID: sessionID, Target: h.colab(), Runtime: rt,
			Lease: protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5}})
		if err == nil && rt.Mode == protocol.RuntimeStart {
			err = out.Remote.Stop(t.Context(), jupyter.StopTimes{Shutdown: 5 * time.Second, Terminate: time.Second})
		} else if err == nil {
			out.Remote.Close()
		}
		if err != nil {
			t.Fatal(err)
		}
		ended()
	}
	if got := leaked(append(append(said, h.logs.all()...), *h.f.logs...)); len(got) != 0 {
		t.Errorf("the program's output reached %q", got)
	}
}

// TestColabCloseAfterTheProgramEndedSignalsNothing: a Close after the program has ended never
// signals its group's id, which another group may by then have taken.
func TestColabCloseAfterTheProgramEndedSignalsNothing(t *testing.T) {
	newColabHost(t, "exit")
	p, err := (&Colab{}).dial(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	<-p.exited
	var hit atomic.Bool
	real := signalGroup
	signalGroup = func(pid int, _ syscall.Signal) { hit.CompareAndSwap(false, pid == p.cmd.Process.Pid) }
	t.Cleanup(func() { signalGroup = real })
	p.Close()
	if time.Sleep(1500 * time.Millisecond); hit.Load() {
		t.Error("Close signalled the group of a program that had ended")
	}
}

// TestColabLossIsHostUnreachable: a program that ends during a session is a lost route,
// host_unreachable; Reconnect starts a new run, after which the session answers again.
func TestColabLossIsHostUnreachable(t *testing.T) {
	h, _, records := newColabHost(t, "")
	rt, err := h.r.Open(t.Context(), &protocol.OpenSession{RequestID: requestID, SessionID: sessionID, Target: h.colab(), Runtime: h.start(),
		Lease: protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(rt.Remote.Close)
	killPID(colabRuns(t, records)[0].PID)
	select {
	case l := <-rt.Remote.Losses():
		if why := cause.Classify(l.Evidence); l.Gone || why != cause.HostUnreachable {
			t.Fatalf("loss %+v: %s", l, why)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the end of the program was not reported")
	}
	if err := rt.Remote.Reconnect(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := rt.Client.Status(t.Context()); err != nil || len(colabRuns(t, records)) != 2 {
		t.Fatalf("after Reconnect: %v, %d runs", err, len(colabRuns(t, records)))
	}
}

// TestColabOrphanSweptThroughTheProgram: SweepOrphan of a colab session stops the marked server
// through a new run of the program, which then ends.
func TestColabOrphanSweptThroughTheProgram(t *testing.T) {
	h, _, records := newColabHost(t, "")
	t.Setenv(jupytertest.EnvMode, "stubborn")
	rt, err := h.r.Open(t.Context(), &protocol.OpenSession{RequestID: requestID, SessionID: sessionID, Target: h.colab(), Runtime: h.start(),
		Lease: protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5}})
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := rt.Remote.Process()
	rt.Remote.Close() // the connector crashes: its run ends, the server keeps running
	if !alive(pid) {
		t.Fatal("closing the connection ended the server")
	}
	times := jupyter.StopTimes{Shutdown: 200 * time.Millisecond, Terminate: 200 * time.Millisecond}
	if err := h.r.SweepOrphan(t.Context(), h.colab(), sessionID, pid, times); err != nil {
		t.Fatal(err)
	}
	waitGone(t, pid)
	runs := colabRuns(t, records)
	if len(runs) != 2 {
		t.Fatalf("%d runs of the program, want the session's and the sweep's", len(runs))
	}
	for _, r := range runs {
		groupGone(t, r.PID)
	}
}
