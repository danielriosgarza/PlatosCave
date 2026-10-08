//go:build !windows

package session

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"testing"
	"time"

	"parallax/connector/internal/identity"
	"parallax/connector/internal/jupyter/jupytertest"
	"parallax/connector/internal/link"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/state"
)

// spawn runs a shell loop whose command line ends with args, and returns it with a channel
// closed when it has exited (the test reaps it, as init would reap a real orphan).
func spawn(t *testing.T, args ...string) (*exec.Cmd, <-chan struct{}) {
	t.Helper()
	cmd := exec.Command("sh", append([]string{"-c", "while :; do sleep 1; done", "sh"}, args...)...)
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { cmd.Wait(); close(done) }()
	t.Cleanup(func() { cmd.Process.Kill(); <-done })
	return cmd, done
}

func running(done <-chan struct{}) bool {
	select {
	case <-done:
		return false
	default:
		return true
	}
}

func ownedRecord(id string, pid int, where string) Record {
	return Record{
		SessionID: id, Owned: true, State: StateReady,
		Target:  protocol.Target{Kind: "local", Workspace: "/home/a/parallax"},
		Process: &ProcessRecord{Where: where, PID: pid, Port: 41873, StartedAt: stamp(leaseT0)},
		Lease:   protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5}, Phase: PhaseAttached,
		LastActivityAt: stamp(leaseT0), ExpiresAt: stamp(leaseT0.Add(30 * time.Minute)), HardDeadline: stamp(leaseT0.Add(12 * time.Hour)),
	}
}

func newRestoredManager(t *testing.T, store *state.Store, now time.Time) *Manager {
	t.Helper()
	clk := &clock{t: now}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	log := &syncBuffer{}
	t.Cleanup(func() { t.Log(log.String()) })
	mgr := New(ctx, Config{Store: store, Now: clk.Now, ManualTicks: true, Log: log, StopTimes: jupyterStopTimes})
	mgr.Restore(ctx)
	return mgr
}

// The start-up sweep kills an orphaned process only when it is the recorded pid and carries the
// session's marker; a recorded pid now used by another process, and a marked process at
// another pid, are left alone.
func TestOrphanSweepKillsOnlyMarkedProcess(t *testing.T) {
	const (
		idA = "11111111-2222-4333-8444-555555555551" // owned, recorded pid carries its marker
		idB = "11111111-2222-4333-8444-555555555552" // owned, recorded pid reused by another program
		idC = "11111111-2222-4333-8444-555555555553" // attached: nothing to kill
		idD = "11111111-2222-4333-8444-555555555554" // stopped while offline, not yet reported
		idE = "11111111-2222-4333-8444-555555555555" // owned remote: cannot be reached here
	)
	marked, markedDone := spawn(t, marker(idA))
	reused, reusedDone := spawn(t, "--some-other-program")
	_, strayDone := spawn(t, marker(idA)) // the marker, but not the recorded pid

	store := state.Open(t.TempDir())
	attached := ownedRecord(idC, 1, "local")
	attached.Owned, attached.Process = false, nil
	stopped := ownedRecord(idD, 1, "local")
	stopped.State, stopped.Cause, stopped.StoppedAt, stopped.Process = StateStopped, "sleep", stamp(leaseT0), nil
	f := &File{V: 1, Sessions: []Record{
		ownedRecord(idA, marked.Process.Pid, "local"),
		ownedRecord(idB, reused.Process.Pid, "local"),
		attached, stopped,
		ownedRecord(idE, 31337, "remote"),
	}}
	if err := writeFile(store, f); err != nil {
		t.Fatal(err)
	}

	mgr := newRestoredManager(t, store, leaseT0.Add(time.Minute))
	select {
	case <-markedDone:
	case <-time.After(10 * time.Second):
		t.Fatal("the marked orphan was not stopped")
	}
	if !running(reusedDone) {
		t.Error("a process at a recorded pid without the marker was signalled")
	}
	if !running(strayDone) {
		t.Error("a marked process at a pid that was not recorded was signalled")
	}

	got := map[string]protocol.HeartbeatSession{}
	for _, hs := range mgr.Sessions() {
		got[hs.SessionID] = hs
	}
	for id, want := range map[string]string{idA: "connector_restarted", idB: "connector_restarted", idC: "connector_restarted", idD: "sleep"} {
		if hs := got[id]; hs.State != StateStopped || hs.Cause != want {
			t.Errorf("%s: %+v, want stopped with %s", id, hs, want)
		}
	}
	if _, listed := got[idE]; listed {
		t.Error("a remote orphan the sweep could not reach is reported as stopped")
	}
	byID := map[string]Record{}
	for _, r := range readOrFail(t, store).Sessions {
		byID[r.SessionID] = r
	}
	if r, ok := byID[idE]; !ok || r.State != StateReady || r.Process == nil {
		t.Errorf("the possibly orphaned record is not kept: %+v", r)
	}
	if r := byID[idA]; r.State != StateStopped || r.Process != nil {
		t.Errorf("the swept record: %+v", r)
	}
}

func readOrFail(t *testing.T, store *state.Store) *File {
	t.Helper()
	f, err := readFile(store)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// A lease outlives the connector process: after a crash the next run stops the owned process it
// finds in sessions.json, and a deadline that passed meanwhile gives the stop the lease's cause;
// the restarted connector's first heartbeat tells the server so.
func TestLeaseSurvivesRestart(t *testing.T) {
	ws, port, _ := attachFixture(t)
	dir := jupytertest.Install(t, "")
	e := newLeaseEnv(t, nil)
	e.openLocal(sessionA, reqA, t.TempDir(), protocol.Runtime{Mode: "start"})
	pid := onlyPID(t, dir)
	e.openLocal(sessionB, reqB, ws, protocol.Runtime{Mode: "attach", Port: port})
	e.presence(sessionA, false) // grace until t0+5m; B stays attached until t0+30m

	// The connector crashes: its sessions.json is all the next run has.
	data, err := e.store.ReadFile(state.SessionsFile)
	if err != nil {
		t.Fatal(err)
	}
	next := state.Open(t.TempDir())
	if err := next.WritePrivate(state.SessionsFile, data); err != nil {
		t.Fatal(err)
	}
	mgr := newRestoredManager(t, next, leaseT0.Add(6*time.Minute))
	waitUntil(t, "the orphaned Jupyter to end", func() bool { return !processAlive(pid) })

	id, err := identity.Generate()
	if err != nil {
		t.Fatal(err)
	}
	connectorID := e.srv.AddConnector(id.PublicKey(), "active")
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		link.Run(ctx, link.Config{Origin: e.srv.Origin, ConnectorID: connectorID, Identity: id,
			Hello: protocol.Hello{Version: "0.0.0-dev", OS: "linux", Arch: "amd64", Mode: "personal",
				Targets: []string{"local"}, NetworkScope: protocol.NetworkScope{CIDRs: []string{}, Hosts: []string{}}},
			HTTPClient: e.srv.Client(), Handler: mgr, Sessions: mgr.Sessions})
	}()
	defer func() { cancel(); <-done }()
	lctx, lcancel := context.WithTimeout(ctx, 20*time.Second)
	defer lcancel()
	l, err := e.srv.NextLink(lctx)
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, "the first heartbeat", func() bool { return len(l.Heartbeats()) > 0 })
	hb := l.Heartbeats()[0]
	if len(hb.Sessions) != 2 {
		t.Fatalf("first heartbeat after the restart: %+v", hb.Sessions)
	}
	if a := hb.Sessions[0]; a.SessionID != sessionA || a.State != StateStopped || a.Cause != "lease_grace" {
		t.Errorf("owned session past its grace: %+v", a)
	}
	if b := hb.Sessions[1]; b.SessionID != sessionB || b.State != StateStopped || b.Cause != "connector_restarted" {
		t.Errorf("attached session within its lease: %+v", b)
	}
	waitUntil(t, "the stops to be reported and forgotten", func() bool { return len(readOrFail(t, next).Sessions) == 0 })
}

// A32: an unreadable sessions.json is not simply replaced. A record that is still valid on its
// own goes through the normal sweep, and a session the file names only in a record that cannot
// be read has its marked process killed; a marked process of a session the file never names,
// and an unmarked process, are left alone.
func TestA32_UnreadableSessionsFileStillSweepsOrphans(t *testing.T) {
	const (
		idA = "11111111-2222-4333-8444-555555555561" // a valid record among invalid ones
		idB = "11111111-2222-4333-8444-555555555562" // an invalid record: its id is all that is left
		idC = "11111111-2222-4333-8444-555555555563" // not in the file (another state directory's)
	)
	a, aDone := spawn(t, marker(idA))
	_, bDone := spawn(t, marker(idB))
	_, cDone := spawn(t, marker(idC))
	_, plainDone := spawn(t, "--some-other-program")

	valid, err := json.Marshal(ownedRecord(idA, a.Process.Pid, "local"))
	if err != nil {
		t.Fatal(err)
	}
	// A record with a field this version does not know makes the whole file unreadable.
	broken := fmt.Sprintf(`{"sessionId": %q, "owned": true, "state": "ready", "fromTheFuture": 1, "process": {"where": "local", "pid": 7}}`, idB)
	store := state.Open(t.TempDir())
	if err := store.WritePrivate(state.SessionsFile, []byte(fmt.Sprintf(`{"v": 1, "sessions": [%s, %s]}`, valid, broken))); err != nil {
		t.Fatal(err)
	}
	if _, err := readFile(store); err == nil {
		t.Fatal("the file under test is readable")
	}

	mgr := newRestoredManager(t, store, leaseT0.Add(time.Minute))
	for name, done := range map[string]<-chan struct{}{"the valid record's process": aDone, "the unreadable record's process": bDone} {
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatalf("%s was not stopped", name)
		}
	}
	if !running(cDone) {
		t.Error("a marked process of a session the file does not name was signalled")
	}
	if !running(plainDone) {
		t.Error("an unmarked process was signalled")
	}
	got := mgr.Sessions()
	if len(got) != 1 || got[0].SessionID != idA || got[0].State != StateStopped || got[0].Cause != "connector_restarted" {
		t.Errorf("sessions after the salvage: %+v", got)
	}
	if f := readOrFail(t, store); len(f.Sessions) != 1 || f.Sessions[0].SessionID != idA {
		t.Errorf("the replaced sessions.json: %+v", f)
	}
}

// A Windows process id is any 32-bit value, so a record of one above Linux's pid_max is written,
// read back and accepted by state.schema.json; one beyond 32 bits is refused.
func TestSessionsFileHoldsWindowsProcessIDs(t *testing.T) {
	const id = "11111111-2222-4333-8444-555555555571"
	store := state.Open(t.TempDir())
	if err := writeFile(store, &File{V: 1, Sessions: []Record{ownedRecord(id, 4294967292, "local")}}); err != nil {
		t.Fatal(err)
	}
	if f := readOrFail(t, store); f.Sessions[0].Process.PID != 4294967292 {
		t.Errorf("pid read back: %d", f.Sessions[0].Process.PID)
	}
	data, err := store.ReadFile(state.SessionsFile)
	if err != nil {
		t.Fatal(err)
	}
	validSessionsFile(t, compileSessionsSchema(t), data)
	if err := writeFile(store, &File{V: 1, Sessions: []Record{ownedRecord(id, 1<<32, "local")}}); err == nil {
		t.Error("a pid beyond 32 bits was written")
	}
}
