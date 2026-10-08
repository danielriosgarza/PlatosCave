package session

import (
	"bytes"
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"time"

	"parallax/connector/internal/cause"
	"parallax/connector/internal/state"
)

// Processes inspects and signals the processes a sweep finds in sessions.json.
type Processes interface {
	// Inspect returns a process's command line and whether it still runs.
	Inspect(pid int) (args string, alive bool, err error)
	// Find returns the pids of this user's live processes whose command line has field as one of
	// its arguments.
	Find(field string) ([]int, error)
	// Signal asks a process to end (SIGTERM), or kills it when kill is set.
	Signal(pid int, kill bool) error
}

// Restore reads sessions.json when `run` starts (design §6, §9). Stopped records not yet
// reported are kept for the first heartbeat. Every other record belongs to a connector that
// ended without stopping it: an owned local process is killed after its marker proves it is the
// session's own (a recorded pid that no longer carries the marker is another process, and the
// session's own is gone); an owned remote one goes to SweepRemote. Each becomes a stopped record
// whose cause is the lease's when its deadline passed while the connector was not running, else
// connector_restarted. A record the sweep cannot resolve stays in the file as possibly orphaned
// until its hard deadline, and is not reported as stopped. An unreadable file is salvaged
// (salvage) before it is replaced.
func (m *Manager) Restore(ctx context.Context) {
	if m.cfg.Store == nil {
		return
	}
	f, err := readFile(m.cfg.Store)
	if err != nil {
		m.logf("sessions.json is unreadable (%v); sweeping what it names before replacing it.", err)
		f = m.salvage(ctx)
	}
	now := m.cfg.Now()
	for _, r := range f.Sessions {
		rec := r
		if rec.State == StateStopped {
			m.mu.Lock()
			m.stopped[rec.SessionID] = &rec
			m.mu.Unlock()
			continue
		}
		gone := !rec.Owned // an attached session's tunnel ended with the old process
		if rec.Owned && rec.Process != nil {
			switch rec.Process.Where {
			case "local":
				gone = m.sweepLocal(ctx, rec)
			case "remote":
				if m.cfg.SweepRemote != nil {
					sctx, cancel := context.WithTimeout(ctx, remoteSweepTimeout)
					gone = m.cfg.SweepRemote(sctx, rec) == nil
					cancel()
				}
			}
		}
		if !gone {
			m.logf("Session %s may still be running (%s); it is listed as possibly orphaned.", rec.SessionID, where(rec))
			m.mu.Lock()
			m.orphans[rec.SessionID] = &rec
			m.mu.Unlock()
			continue
		}
		rec.Cause = restartCause(rec, now)
		rec.State, rec.StoppedAt, rec.Process = StateStopped, stamp(now), nil
		m.logf("Session %s from an earlier run is stopped (%s).", rec.SessionID, rec.Cause)
		m.mu.Lock()
		m.stopped[rec.SessionID] = &rec
		m.mu.Unlock()
	}
	m.persist()
}

// remoteSweepTimeout bounds a non-interactive connection to a remote orphan (design §6).
const remoteSweepTimeout = 20 * time.Second

// restartCause is the cause of an orphan the sweep stopped: the lease's when a deadline had
// already passed, so the server learns the true cause, else connector_restarted.
func restartCause(rec Record, now time.Time) string {
	if rec.Owned && !now.Before(parseStamp(rec.HardDeadline)) {
		return cause.MaxLifetime
	}
	if !now.Before(parseStamp(rec.ExpiresAt)) {
		if rec.Phase == PhaseDetached {
			return cause.LeaseGrace
		}
		return cause.LeaseIdle
	}
	return cause.ConnectorRestarted
}

func where(rec Record) string {
	if rec.Process != nil && rec.Process.Where == "remote" {
		return "on " + rec.Target.Host
	}
	if rec.Process == nil {
		return "no process was recorded"
	}
	return "on this computer"
}

// marker is the argument that proves a process is a session's own Jupyter server (design §6).
func marker(sessionID string) string { return "--ParallaxMarker.session=" + sessionID }

// sweepLocal kills the recorded process of an owned local session if its command line carries
// the session's marker, and reports whether the session's process is now gone.
func (m *Manager) sweepLocal(ctx context.Context, rec Record) bool {
	args, alive, err := m.cfg.Processes.Inspect(rec.Process.PID)
	if err != nil {
		return false
	}
	if !alive || !hasField(args, marker(rec.SessionID)) {
		return true // gone, or the pid now belongs to another process
	}
	return m.kill(ctx, rec.Process.PID, rec.SessionID)
}

// kill ends a process whose marker was just proved: SIGTERM, then SIGKILL, each followed by up
// to the terminate time for it to go. It reports whether the process is gone.
func (m *Manager) kill(ctx context.Context, pid int, sessionID string) bool {
	procs := m.cfg.Processes
	m.logf("Stopping process %d left by session %s.", pid, sessionID)
	for _, kill := range []bool{false, true} {
		if err := procs.Signal(pid, kill); err != nil {
			return false
		}
		deadline := time.Now().Add(m.cfg.StopTimes.Terminate)
		for time.Now().Before(deadline) {
			if _, alive, err := procs.Inspect(pid); err == nil && !alive {
				return true
			}
			select {
			case <-ctx.Done():
				return false
			case <-time.After(50 * time.Millisecond):
			}
		}
	}
	_, alive, err := procs.Inspect(pid)
	return err == nil && !alive
}

// maxSalvagedIDs bounds the session ids taken from an unreadable sessions.json.
const maxSalvagedIDs = 4 * maxRecords

// reAnyUUID finds session ids anywhere in an unreadable file.
var reAnyUUID = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}`)

// salvage recovers what it can from a sessions.json that readFile refused, so that replacing
// the file does not leave a Jupyter server running unseen (design §6). Every record that is
// valid on its own is returned for the normal sweep. For every other session id the file
// mentions, a local process of this user whose command line carries that id's marker is killed:
// the marker proves the process is a session's own, and the id coming from this state directory
// proves the session was this connector's, though its pid could not be read. A remote process
// of an unreadable record cannot be reached without its target and is only logged.
func (m *Manager) salvage(ctx context.Context) *File {
	f := &File{V: 1}
	data, err := m.cfg.Store.ReadFile(state.SessionsFile)
	if err != nil {
		m.logf("sessions.json cannot be read at all (%v); no process it names can be swept.", err)
		return f
	}
	var loose struct {
		Sessions []json.RawMessage `json:"sessions"`
	}
	known := map[string]bool{}
	if json.Unmarshal(data, &loose) == nil {
		for _, raw := range loose.Sessions {
			var rec Record
			dec := json.NewDecoder(bytes.NewReader(raw))
			dec.DisallowUnknownFields()
			if dec.Decode(&rec) != nil || rec.validate() != nil || known[rec.SessionID] || len(f.Sessions) == maxRecords {
				continue
			}
			known[rec.SessionID] = true
			f.Sessions = append(f.Sessions, rec)
		}
	}
	var ids []string
	for _, id := range reAnyUUID.FindAllString(string(data), -1) {
		if !known[id] && len(ids) < maxSalvagedIDs {
			known[id] = true
			ids = append(ids, id)
		}
	}
	for _, id := range ids {
		pids, err := m.cfg.Processes.Find(marker(id))
		if err != nil {
			m.logf("Session %s from the unreadable sessions.json may still be running (%v).", id, err)
			continue
		}
		for _, pid := range pids {
			if !m.kill(ctx, pid, id) {
				m.logf("Process %d of session %s from the unreadable sessions.json could not be stopped.", pid, id)
			}
		}
	}
	return f
}

func hasField(args, field string) bool {
	for _, f := range strings.Fields(args) {
		if f == field {
			return true
		}
	}
	return false
}

// dropOrphans forgets possibly orphaned records whose hard deadline has passed.
func (m *Manager) dropOrphans(now time.Time) {
	m.mu.Lock()
	dropped := false
	for id, r := range m.orphans {
		if !now.Before(parseStamp(r.HardDeadline)) {
			delete(m.orphans, id)
			dropped = true
		}
	}
	m.mu.Unlock()
	if dropped {
		m.persist()
	}
}
