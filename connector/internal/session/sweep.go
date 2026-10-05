package session

import (
	"context"
	"strings"
	"time"

	"parallax/connector/internal/cause"
)

// Processes inspects and signals the processes a sweep finds in sessions.json.
type Processes interface {
	// Inspect returns a process's command line and whether it still runs.
	Inspect(pid int) (args string, alive bool, err error)
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
// until its hard deadline, and is not reported as stopped.
func (m *Manager) Restore(ctx context.Context) {
	if m.cfg.Store == nil {
		return
	}
	f, err := readFile(m.cfg.Store)
	if err != nil {
		m.logf("sessions.json is unreadable (%v); starting without it.", err)
		return
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
	procs := m.cfg.Processes
	pid := rec.Process.PID
	args, alive, err := procs.Inspect(pid)
	if err != nil {
		return false
	}
	if !alive || !hasField(args, marker(rec.SessionID)) {
		return true // gone, or the pid now belongs to another process
	}
	m.logf("Stopping process %d left by session %s.", pid, rec.SessionID)
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
	_, alive, err = procs.Inspect(pid)
	return err == nil && !alive
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
