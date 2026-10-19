//go:build !windows

package sshtarget

import (
	"encoding/json"
	"path/filepath"
	"slices"
	"strings"
	"syscall"
	"testing"
	"time"
	"unicode"

	"golang.org/x/sys/unix"

	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/protocol"
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

// TestColabProgramMissing: with no colab program on PATH, reachability fails with colab_missing
// and the later stages are blocked.
func TestColabProgramMissing(t *testing.T) {
	f := newFixture(t)
	f.tg.Colab = &Colab{}
	t.Setenv("PATH", t.TempDir())
	req := &protocol.TestConnection{RequestID: requestID, Runtime: protocol.Runtime{Mode: protocol.RuntimeStart},
		Target: protocol.Target{Kind: protocol.TargetColab, User: "student", Auth: &protocol.AuthRef{Method: protocol.AuthAgent}, Workspace: "/home/student"}}
	if got := f.check(req).statuses(); got != "reachability=failed:colab_missing host_identity=skipped"+blocked {
		t.Errorf("stages %s", got)
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
