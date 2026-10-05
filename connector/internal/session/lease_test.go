package session

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"

	"parallax/connector/internal/cause"
	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/jupyter/jupytertest"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/state"
	"parallax/connector/internal/target"
	"parallax/connector/internal/testserver"
	schemas "parallax/connector/protocol"
)

// clock is a fake wall clock the tests move by hand.
type clock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *clock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

var leaseT0 = time.Date(2026, 10, 3, 9, 30, 0, 0, time.UTC)

// lenv is env with a fake clock, a manually driven ticker, a state directory and a switch that
// keeps the link down.
type lenv struct {
	*env
	clk   *clock
	store *state.Store
	down  *atomic.Bool
}

func newLeaseEnv(t *testing.T, mutate func(*Config)) *lenv {
	t.Helper()
	clk := &clock{t: leaseT0}
	store := state.Open(t.TempDir())
	down := &atomic.Bool{}
	e := newEnvOn(t, func(c *Config) {
		c.Now, c.ManualTicks, c.Store, c.OS = clk.Now, true, store, "linux"
		c.StopTimes = jupyterStopTimes
		if mutate != nil {
			mutate(c)
		}
	}, func(srv *testserver.Server) {
		srv.LinkOptions.Refuse = func(int) (int, string) {
			if down.Load() {
				return 4500, "server_error"
			}
			return 0, ""
		}
	})
	return &lenv{env: e, clk: clk, store: store, down: down}
}

// advance moves the clock by d one second at a time, ticking after each second, as the 1 s
// ticker of an awake computer does.
func (e *lenv) advance(d time.Duration) {
	for range int(d / time.Second) {
		e.clk.add(time.Second)
		e.mgr.tick()
	}
}

// jump moves the clock by d at once and ticks: the next tick after a sleep.
func (e *lenv) jump(d time.Duration) {
	e.clk.add(d)
	e.mgr.tick()
}

// quiet fails if the connector sends anything other than a heartbeat within a short wait.
func (e *lenv) quiet() {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	if r, err := e.l.Next(ctx); err == nil {
		e.t.Fatalf("unexpected %T %+v", r.Message, r.Message)
	}
}

// phase sends a detach (close_session stop:false), which the connector answers with the
// session's state; the answer also proves every earlier message was handled.
func (e *lenv) phase(sessionID string) *protocol.SessionState {
	e.t.Helper()
	e.send(&protocol.CloseSession{RequestID: reqC, SessionID: sessionID, Stop: false})
	return expect[*protocol.SessionState](e.env)
}

func (e *lenv) presence(sessionID string, attached bool) {
	e.t.Helper()
	e.send(&protocol.Presence{SessionID: sessionID, Attached: attached})
	want := PhaseDetached
	if attached {
		want = PhaseAttached
	}
	if st := e.phase(sessionID); st.Phase != want {
		e.t.Fatalf("phase %s after presence attached=%v", st.Phase, attached)
	}
}

// dropLink closes the link from the server's side and waits until the manager saw it go.
func (e *lenv) dropLink() {
	e.t.Helper()
	e.l.Close(4500, "server_error")
	waitUntil(e.t, "the manager to see the link go", func() bool {
		e.mgr.mu.Lock()
		defer e.mgr.mu.Unlock()
		return e.mgr.link == nil
	})
}

// relink lets the connector back in and returns its first heartbeat on the new link.
func (e *lenv) relink() *protocol.Heartbeat {
	e.t.Helper()
	e.down.Store(false)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	l, err := e.srv.NextLink(ctx)
	if err != nil {
		e.t.Fatalf("no new link: %v", err)
	}
	e.l = l
	waitUntil(e.t, "the first heartbeat", func() bool { return len(l.Heartbeats()) > 0 })
	hb := l.Heartbeats()[0]
	if hb.Seq != 0 {
		e.t.Fatalf("first heartbeat has seq %d", hb.Seq)
	}
	return hb
}

func (e *lenv) file() *File {
	e.t.Helper()
	f, err := readFile(e.store)
	if err != nil {
		e.t.Fatalf("sessions.json: %v", err)
	}
	return f
}

func waitUntil(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// stoppedWith reads stopping (owned only) and then stopped, which must carry the cause.
func (e *lenv) stoppedWith(owned bool, why string) *protocol.SessionState {
	e.t.Helper()
	if owned {
		e.state(StateStopping)
	}
	st := e.state(StateStopped)
	if st.Cause != why || st.Owned != owned {
		e.t.Fatalf("stopped = %+v, want cause %s, owned %v", st, why, owned)
	}
	return st
}

func onlyPID(t *testing.T, dir string) int {
	t.Helper()
	recs := jupytertest.Records(t, dir)
	if len(recs) != 1 {
		t.Fatalf("%d servers started", len(recs))
	}
	return recs[0].PID
}

var jupyterStopTimes = jupyterTimes(2*time.Second, time.Second)

// A32: closing the tab keeps an owned kernel for exactly the grace period, then the connector
// stops it with cause lease_grace.
func TestA32_DisconnectKeepsOwnedUntilGrace(t *testing.T) {
	dir := jupytertest.Install(t, "")
	e := newLeaseEnv(t, nil)
	e.openLocal(sessionA, reqA, t.TempDir(), protocol.Runtime{Mode: "start"})
	pid := onlyPID(t, dir)
	e.presence(sessionA, true)
	e.presence(sessionA, false)
	st := e.phase(sessionA)
	if want := stamp(leaseT0.Add(5 * time.Minute)); st.LeaseExpiresAt != want || st.State != StateReady {
		t.Errorf("after disconnect: %+v, want ready until %s", st, want)
	}
	e.advance(5*time.Minute - time.Second)
	e.quiet()
	if !processAlive(pid) {
		t.Fatal("the kernel's server was stopped before the grace period ended")
	}
	e.advance(time.Second)
	e.stoppedWith(true, "lease_grace")
	if processAlive(pid) {
		t.Error("stopped was sent while the process still runs")
	}
}

// A32: an open notebook with no activity stops after the idle timeout; activity resets it.
func TestA32_IdleStopsAfterTimeout(t *testing.T) {
	dir := jupytertest.Install(t, "")
	e := newLeaseEnv(t, nil)
	e.openLocal(sessionA, reqA, t.TempDir(), protocol.Runtime{Mode: "start"})
	pid := onlyPID(t, dir)
	e.presence(sessionA, true)
	e.advance(10 * time.Minute)
	e.send(&protocol.Activity{SessionID: sessionA})
	if st := e.phase(sessionA); st.LeaseExpiresAt != stamp(leaseT0.Add(40*time.Minute)) {
		t.Errorf("after activity the lease expires at %s", st.LeaseExpiresAt)
	}
	e.advance(30*time.Minute - time.Second)
	e.quiet()
	if !processAlive(pid) {
		t.Fatal("stopped before the idle timeout")
	}
	e.advance(time.Second)
	e.stoppedWith(true, "lease_idle")
	if processAlive(pid) {
		t.Error("stopped was sent while the process still runs")
	}
}

// A32: Stop session confirms termination: `stopped` comes only after the process is gone, even
// when Jupyter ignores the shutdown request and SIGTERM; the same holds for a lease stop.
func TestA32_StopConfirmsTermination(t *testing.T) {
	dir := jupytertest.Install(t, "stubborn")
	e := newLeaseEnv(t, func(c *Config) { c.StopTimes = jupyterTimes(300*time.Millisecond, 300*time.Millisecond) })
	e.openLocal(sessionA, reqA, t.TempDir(), protocol.Runtime{Mode: "start"})
	pid := onlyPID(t, dir)
	began := time.Now()
	e.send(&protocol.CloseSession{RequestID: reqB, SessionID: sessionA, Stop: true})
	e.state(StateStopping)
	st := e.state(StateStopped)
	if processAlive(pid) {
		t.Fatal("stopped was sent while the process still runs")
	}
	if took := time.Since(began); took < 600*time.Millisecond {
		t.Errorf("stopped after %s, before the shutdown and SIGTERM waits ran out", took)
	}
	if st.Cause != "user_stop" || st.RequestID != reqB || !st.Owned {
		t.Errorf("stopped = %+v", st)
	}

	e.openLocal(sessionB, reqA, t.TempDir(), protocol.Runtime{Mode: "start"})
	recs := jupytertest.Records(t, dir)
	pidB := recs[len(recs)-1].PID
	e.presence(sessionB, false)
	e.advance(5 * time.Minute)
	e.state(StateStopping)
	st = e.state(StateStopped)
	if processAlive(pidB) || st.Cause != "lease_grace" {
		t.Errorf("lease stop: alive %v, %+v", processAlive(pidB), st)
	}
}

// A32: a runtime attached from outside Parallax is never stopped. When its lease ends the
// connector closes the tunnel and forgets the session (stopped, lease_grace, owned false), and
// the person's server keeps running.
func TestA32_AttachedRuntimeIsNeverStopped(t *testing.T) {
	ws, port, fake := attachFixture(t)
	e := newLeaseEnv(t, nil)
	e.openLocal(sessionA, reqA, ws, protocol.Runtime{Mode: "attach", Port: port})
	e.send(&protocol.CloseSession{RequestID: reqB, SessionID: sessionA, Stop: true})
	if er := expect[*protocol.Error](e.env); er.Code != protocol.CodeNotOwned {
		t.Fatalf("stop of an attached session: %+v", er)
	}
	e.presence(sessionA, false)
	e.advance(5 * time.Minute)
	e.stoppedWith(false, "lease_grace")
	for _, r := range fake.Requests() {
		if r.URI == "/api/shutdown" {
			t.Error("the connector asked an attached server to shut down")
		}
	}
	if len(e.mgr.Sessions()) != 0 {
		t.Errorf("the session is still held: %+v", e.mgr.Sessions())
	}
	e.refused(sessionA, "session", "GET", "/api/status", nil, protocol.CodeUnknownSession)
}

// A32: losing the link counts as a detach: the grace period starts when the link goes, the
// session is reported detached on the next link, and it stops when the grace period ends.
func TestA32_LinkLossCountsAsDetach(t *testing.T) {
	dir := jupytertest.Install(t, "")
	e := newLeaseEnv(t, nil)
	e.openLocal(sessionA, reqA, t.TempDir(), protocol.Runtime{Mode: "start"})
	pid := onlyPID(t, dir)
	e.presence(sessionA, true)
	e.advance(time.Minute)
	lostAt := e.clk.Now()
	e.dropLink()
	hb := e.relink()
	want := stamp(lostAt.Add(5 * time.Minute))
	if len(hb.Sessions) != 1 || hb.Sessions[0].Phase != PhaseDetached || hb.Sessions[0].LeaseExpiresAt != want {
		t.Fatalf("first heartbeat after the link loss: %+v, want detached until %s", hb.Sessions, want)
	}
	if st := e.state(StateReady); st.Phase != PhaseDetached {
		t.Errorf("state notice after hello: %+v", st)
	}
	e.advance(5*time.Minute - time.Second)
	e.quiet()
	if !processAlive(pid) {
		t.Fatal("stopped before the grace period after the link loss")
	}
	e.advance(time.Second)
	e.stoppedWith(true, "lease_grace")
}

// A busy kernel is activity, but in the detached phase it does not move the grace deadline.
func TestBusyKernelDoesNotExtendDetachedGrace(t *testing.T) {
	ws, port, _ := attachFixture(t)
	var polls atomic.Int32
	e := newLeaseEnv(t, func(c *Config) {
		c.PollKernels = func(context.Context, *target.Runtime, []string) ([]protocol.Kernel, error) {
			polls.Add(1)
			return []protocol.Kernel{{ID: "9d3c0a52-6f1e-4c0b-8d57-1a2b3c4d5e6f", ExecutionState: "busy"}}, nil
		}
	})
	e.openLocal(sessionA, reqA, ws, protocol.Runtime{Mode: "attach", Port: port})
	e.presence(sessionA, false)
	e.advance(5*time.Minute - time.Second)
	waitUntil(t, "a kernel poll", func() bool { return polls.Load() > 0 })
	waitUntil(t, "the busy kernel in the heartbeat", func() bool {
		hs := e.mgr.Sessions()
		return len(hs) == 1 && len(hs[0].Kernels) == 1 && hs[0].Kernels[0].ExecutionState == "busy"
	})
	if hs := e.mgr.Sessions(); hs[0].LeaseExpiresAt != stamp(leaseT0.Add(5*time.Minute)) {
		t.Errorf("a busy kernel moved the grace deadline to %s", hs[0].LeaseExpiresAt)
	}
	e.quiet()
	e.advance(time.Second)
	e.stoppedWith(false, "lease_grace")
}

// A36: a deadline that passed while the computer was asleep stops the session at wake-up with
// cause sleep, not the lease's cause.
func TestA36_SleepResumePastDeadlineStops(t *testing.T) {
	dir := jupytertest.Install(t, "")
	e := newLeaseEnv(t, nil)
	e.openLocal(sessionA, reqA, t.TempDir(), protocol.Runtime{Mode: "start"})
	pid := onlyPID(t, dir)
	e.presence(sessionA, false)
	e.advance(10 * time.Second)
	e.jump(40 * time.Minute) // the first tick after the lid opens
	e.stoppedWith(true, "sleep")
	if processAlive(pid) {
		t.Error("stopped was sent while the process still runs")
	}
}

// A deadline passing while the computer is awake carries the lease's cause; so does the hard
// deadline (max_lifetime), which no activity extends.
func TestDeadlinePassedWithoutSleepUsesLeaseCause(t *testing.T) {
	t.Run("grace", func(t *testing.T) {
		ws, port, _ := attachFixture(t)
		e := newLeaseEnv(t, nil)
		e.openLocal(sessionA, reqA, ws, protocol.Runtime{Mode: "attach", Port: port})
		e.presence(sessionA, false)
		e.advance(10 * time.Minute)
		e.stoppedWith(false, "lease_grace")
	})
	t.Run("max_lifetime", func(t *testing.T) {
		jupytertest.Install(t, "")
		e := newLeaseEnv(t, func(c *Config) {
			c.Store = nil // twelve hours of activity writes are not what this test is about
			c.PollKernels = func(context.Context, *target.Runtime, []string) ([]protocol.Kernel, error) {
				return []protocol.Kernel{{ID: "9d3c0a52-6f1e-4c0b-8d57-1a2b3c4d5e6f", ExecutionState: "busy"}}, nil
			}
		})
		e.openLocal(sessionA, reqA, t.TempDir(), protocol.Runtime{Mode: "start"})
		e.presence(sessionA, true)
		// The busy kernel keeps the idle clock from running out; only the hard deadline ends it.
		for range 12 * 60 {
			e.advance(time.Minute)
			waitUntil(t, "the poll", func() bool {
				s := e.mgr.get(sessionA)
				if s == nil {
					return true
				}
				s.mu.Lock()
				defer s.mu.Unlock()
				return !s.polling
			})
		}
		e.stoppedWith(true, "max_lifetime")
	})
}

// A session stopped while the link was down stays in sessions.json with its cause until a
// `session_state stopped` is sent on a live link, and the server then learns that cause.
func TestStoppedWhileOfflineIsReportedWithItsCause(t *testing.T) {
	ws, port, _ := attachFixture(t)
	e := newLeaseEnv(t, nil)
	e.openLocal(sessionA, reqA, ws, protocol.Runtime{Mode: "attach", Port: port})
	e.presence(sessionA, true)
	e.down.Store(true)
	e.dropLink()
	e.advance(5 * time.Minute)
	f := e.file()
	if len(f.Sessions) != 1 || f.Sessions[0].State != StateStopped || f.Sessions[0].Cause != "lease_grace" || f.Sessions[0].StoppedAt != stamp(leaseT0.Add(5*time.Minute)) {
		t.Fatalf("sessions.json while offline: %+v", f.Sessions)
	}
	hb := e.relink()
	if len(hb.Sessions) != 1 || hb.Sessions[0].State != StateStopped || hb.Sessions[0].Cause != "lease_grace" {
		t.Errorf("first heartbeat: %+v", hb.Sessions)
	}
	st := e.state(StateStopped)
	if st.SessionID != sessionA || st.Cause != "lease_grace" || st.Owned {
		t.Errorf("stopped notice: %+v", st)
	}
	waitUntil(t, "the reported record to leave sessions.json", func() bool { return len(e.file().Sessions) == 0 })
	if len(e.mgr.Sessions()) != 0 {
		t.Errorf("still listed after being reported: %+v", e.mgr.Sessions())
	}
}

// The first heartbeat after hello lists every session: live ones with phase and lease expiry,
// stopped ones not yet reported with their cause.
func TestFirstHeartbeatListsEverySessionIncludingStopped(t *testing.T) {
	ws, port, _ := attachFixture(t)
	e := newLeaseEnv(t, nil)
	e.openLocal(sessionA, reqA, ws, protocol.Runtime{Mode: "attach", Port: port})
	e.send(&protocol.OpenSession{RequestID: reqB, SessionID: sessionB, Target: protocol.Target{Kind: "local", Workspace: ws},
		Runtime: protocol.Runtime{Mode: "attach", Port: port}, Lease: protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 10}})
	e.state(StateStarting)
	e.state(StateReady)
	e.down.Store(true)
	e.dropLink()
	e.advance(5 * time.Minute)
	hb := e.relink()
	if len(hb.Sessions) != 2 {
		t.Fatalf("first heartbeat lists %d sessions: %+v", len(hb.Sessions), hb.Sessions)
	}
	a, b := hb.Sessions[0], hb.Sessions[1]
	if a.SessionID != sessionA || a.State != StateStopped || a.Cause != "lease_grace" || a.Phase != "" {
		t.Errorf("stopped entry: %+v", a)
	}
	if b.SessionID != sessionB || b.State != StateReady || b.Phase != PhaseDetached || b.LeaseExpiresAt != stamp(leaseT0.Add(10*time.Minute)) {
		t.Errorf("live entry: %+v", b)
	}
	if _, err := protocol.Encode(hb); err != nil {
		t.Errorf("the heartbeat fails the protocol: %v", err)
	}
}

func compileSessionsSchema(t *testing.T) *jsonschema.Schema {
	t.Helper()
	data, err := schemas.V1.ReadFile("v1/state.schema.json")
	if err != nil {
		t.Fatal(err)
	}
	doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	c := jsonschema.NewCompiler()
	const base = "https://parallax.invalid/connector/v1/state.schema.json"
	if err := c.AddResource(base, doc); err != nil {
		t.Fatal(err)
	}
	sch, err := c.Compile(base + "#/$defs/Sessions")
	if err != nil {
		t.Fatal(err)
	}
	return sch
}

func validSessionsFile(t *testing.T, sch *jsonschema.Schema, data []byte) {
	t.Helper()
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("sessions.json is not JSON: %v\n%s", err, data)
	}
	if err := sch.Validate(inst); err != nil {
		t.Fatalf("sessions.json fails state.schema.json#/$defs/Sessions: %v\n%s", err, data)
	}
}

// sessions.json is replaced atomically with mode 0600 and matches its schema; a reader never
// sees a partial file. It is written at once on a phase change and at most every 5 s for
// activity.
func TestSessionsJSONAtomicAndPrivate(t *testing.T) {
	ws, port, _ := attachFixture(t)
	e := newLeaseEnv(t, nil)
	sch := compileSessionsSchema(t)
	e.openLocal(sessionA, reqA, ws, protocol.Runtime{Mode: "attach", Port: port})
	data, err := e.store.ReadFile(state.SessionsFile)
	if err != nil {
		t.Fatal(err)
	}
	validSessionsFile(t, sch, data)
	if err := e.store.CheckPrivate(state.SessionsFile); err != nil {
		t.Errorf("sessions.json is not private: %v", err)
	}
	if runtime.GOOS != "windows" {
		if info, _ := os.Stat(e.store.Path(state.SessionsFile)); info.Mode().Perm() != 0o600 {
			t.Errorf("mode %v", info.Mode().Perm())
		}
	}

	// Activity is written within 5 s, not at once; a phase change is written at once.
	e.advance(time.Second)
	e.send(&protocol.Activity{SessionID: sessionA})
	e.phase(sessionA)
	if got := e.file().Sessions[0].LastActivityAt; got != stamp(leaseT0) {
		t.Errorf("activity written at once: %s", got)
	}
	e.advance(5 * time.Second)
	if got := e.file().Sessions[0].LastActivityAt; got != stamp(leaseT0.Add(time.Second)) {
		t.Errorf("activity not written within 5 s: %s", got)
	}
	e.send(&protocol.Presence{SessionID: sessionA, Attached: false})
	e.phase(sessionA)
	if r := e.file().Sessions[0]; r.Phase != PhaseDetached || r.DetachedAt != stamp(e.clk.Now()) {
		t.Errorf("phase change not written at once: %+v", r)
	}

	// Concurrent writes never show a reader a partial or invalid file.
	var stop atomic.Bool
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for !stop.Load() {
			data, err := e.store.ReadFile(state.SessionsFile)
			if err != nil {
				t.Errorf("read during writes: %v", err)
				return
			}
			var f File
			if err := json.Unmarshal(data, &f); err != nil || f.validate() != nil {
				t.Errorf("a reader saw a partial file: %v %s", err, data)
				return
			}
		}
	}()
	for range 200 {
		e.mgr.persist()
	}
	stop.Store(true)
	wg.Wait()
	entries, _ := os.ReadDir(e.store.Dir)
	for _, en := range entries {
		if strings.Contains(en.Name(), ".tmp") {
			t.Errorf("temporary file left behind: %s", en.Name())
		}
	}
}

// sessions.json never holds a token, key, passphrase or password: neither the token the
// connector gave the Jupyter it started nor the token it read for an attached server.
func TestSessionsFileNeverHoldsSecrets(t *testing.T) {
	ws, port, fake := attachFixture(t)
	dir := jupytertest.Install(t, "")
	e := newLeaseEnv(t, nil)
	sch := compileSessionsSchema(t)
	e.openLocal(sessionA, reqA, ws, protocol.Runtime{Mode: "attach", Port: port})
	e.openLocal(sessionB, reqB, t.TempDir(), protocol.Runtime{Mode: "start"})
	e.startKernel(sessionA)
	e.presence(sessionB, false)
	data, err := e.store.ReadFile(state.SessionsFile)
	if err != nil {
		t.Fatal(err)
	}
	validSessionsFile(t, sch, data)
	secrets := []string{fake.Token}
	if runtime.GOOS == "linux" {
		env, err := os.ReadFile(filepath.Join("/proc", strconv.Itoa(onlyPID(t, dir)), "environ"))
		if err != nil {
			t.Fatal(err)
		}
		for _, kv := range strings.Split(string(env), "\x00") {
			if v, ok := strings.CutPrefix(kv, "JUPYTER_TOKEN="); ok {
				secrets = append(secrets, v)
			}
		}
		if len(secrets) != 2 {
			t.Fatal("the started Jupyter has no JUPYTER_TOKEN")
		}
	}
	for _, s := range secrets {
		if bytes.Contains(data, []byte(s)) {
			t.Errorf("sessions.json holds a token:\n%s", data)
		}
	}
	var doc any
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatal(err)
	}
	for _, key := range jsonKeys(doc) {
		for _, word := range []string{"token", "password", "passphrase", "secret"} {
			if strings.Contains(strings.ToLower(key), word) {
				t.Errorf("sessions.json has a field %q", key)
			}
		}
	}
	if !bytes.Contains(data, []byte(`"pid"`)) || !bytes.Contains(data, []byte(`"kernelIds"`)) {
		t.Errorf("sessions.json lacks what the sweep needs:\n%s", data)
	}
}

// jsonKeys lists every object key in a decoded JSON document.
func jsonKeys(v any) []string {
	var out []string
	switch v := v.(type) {
	case map[string]any:
		for k, c := range v {
			out = append(out, k)
			out = append(out, jsonKeys(c)...)
		}
	case []any:
		for _, c := range v {
			out = append(out, jsonKeys(c)...)
		}
	}
	return out
}

func jupyterTimes(shutdown, terminate time.Duration) jupyter.StopTimes {
	return jupyter.StopTimes{Shutdown: shutdown, Terminate: terminate}
}

type reconnector struct{ calls atomic.Int32 }

func (r *reconnector) Reconnect(context.Context) error {
	r.calls.Add(1)
	return nil
}

// A lost transport makes the session disconnected with the cause of design §5.5, listed in the
// heartbeat; the reconnect hook brings it back to ready on the §5.5 schedule.
func TestLostSessionReportsCauseAndReconnects(t *testing.T) {
	ws, port, _ := attachFixture(t)
	e := newLeaseEnv(t, nil)
	e.openLocal(sessionA, reqA, ws, protocol.Runtime{Mode: "attach", Port: port})
	e.advance(3 * time.Second)
	e.jump(time.Minute) // the computer slept; the loss is found on wake-up
	r := &reconnector{}
	e.mgr.Lost(sessionA, cause.Evidence{KeepaliveLost: true}, r)
	st := e.state(StateDisconnected)
	if st.Cause != "sleep" || st.Owned {
		t.Errorf("disconnected = %+v", st)
	}
	if hs := e.mgr.Sessions(); len(hs) != 1 || hs[0].State != StateDisconnected || hs[0].Cause != "sleep" {
		t.Errorf("heartbeat while disconnected: %+v", hs)
	}
	if st := e.state(StateReady); st.Cause != "" || r.calls.Load() != 1 {
		t.Errorf("after reconnecting: %+v, %d attempts", st, r.calls.Load())
	}
}
