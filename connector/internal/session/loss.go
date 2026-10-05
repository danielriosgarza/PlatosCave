package session

import (
	"context"
	"time"

	"parallax/connector/internal/cause"
	"parallax/connector/internal/target"
)

// Reconnector re-establishes a lost session's transport; the SSH runtime (target.Remote)
// implements it.
type Reconnector interface {
	Reconnect(ctx context.Context) error
}

// Lost reports that a session's transport or process disappeared without the connector
// confirming the process is gone: the session becomes `disconnected` with the cause of the
// first rule of design §5.5 that the evidence satisfies (the manager adds rule 1 from its own
// ticker). With r set, reconnecting runs on the schedule of §5.5 for as long as the lease is
// valid; a reconnect that succeeds returns the session to ready.
func (m *Manager) Lost(sessionID string, ev cause.Evidence, r Reconnector) {
	s := m.get(sessionID)
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.state != StateReady && s.state != StateDisconnected {
		s.mu.Unlock()
		return
	}
	healthy := s.lastHealthy
	s.mu.Unlock()
	m.mu.Lock()
	ev.Slept = ev.Slept || m.sleep.SleptSince(healthy)
	m.mu.Unlock()
	if ev.Now.IsZero() {
		ev.Now = m.cfg.Now()
	}
	if ev.OS == "" {
		ev.OS = m.cfg.OS
	}
	why := cause.Classify(ev)
	s.mu.Lock()
	if s.state != StateReady && s.state != StateDisconnected {
		s.mu.Unlock()
		return
	}
	s.state, s.cause = StateDisconnected, why
	start := r != nil && !s.reconnecting
	if start {
		s.reconnecting = true
	}
	s.mu.Unlock()
	m.logf("Session %s disconnected (%s).", s.ID, why)
	m.persist()
	m.send(m.stateMsg(s, ""))
	if start {
		go m.reconnect(s, r)
	}
}

// Recovered returns a disconnected session to ready once its transport is back and the notebook
// service answered with the token.
func (m *Manager) Recovered(sessionID string) {
	s := m.get(sessionID)
	if s == nil {
		return
	}
	s.mu.Lock()
	if s.state != StateDisconnected {
		s.mu.Unlock()
		return
	}
	s.state, s.cause, s.lastHealthy = StateReady, "", m.cfg.Now()
	s.mu.Unlock()
	m.logf("Session %s is ready again.", s.ID)
	m.persist()
	m.send(m.stateMsg(s, ""))
}

// reconnect tries r on the schedule of design §5.5 while the session stays disconnected and its
// lease is valid (the lease ends it otherwise).
func (m *Manager) reconnect(s *Session, r Reconnector) {
	defer func() {
		s.mu.Lock()
		s.reconnecting = false
		s.mu.Unlock()
	}()
	lostAt := time.Now()
	for n := 0; ; n++ {
		wait, ok := cause.NextReconnect(n, time.Since(lostAt))
		if !ok {
			m.logf("Session %s: reconnecting gave up after %s.", s.ID, cause.ReconnectFor)
			return
		}
		select {
		case <-s.ctx.Done():
			return
		case <-time.After(wait):
		}
		if s.State() != StateDisconnected {
			return
		}
		ctx, cancel := context.WithTimeout(s.ctx, sessionDeadline)
		err := r.Reconnect(ctx)
		cancel()
		if err == nil {
			m.Recovered(s.ID)
			return
		}
	}
}

// watchRemote reports the losses of a remote session's transport or service (design §5.5): a
// loss whose process the runtime proved gone stops the session with its cause; any other makes
// it disconnected and starts reconnecting.
func (m *Manager) watchRemote(s *Session, rem target.Remote) {
	for {
		select {
		case <-s.ctx.Done():
			return
		case l := <-rem.Losses():
			if !l.Gone {
				m.Lost(s.ID, l.Evidence, rem)
				continue
			}
			s.mu.Lock()
			if s.state != StateReady && s.state != StateDisconnected {
				s.mu.Unlock()
				continue
			}
			s.state = StateStopped
			healthy := s.lastHealthy
			s.mu.Unlock()
			ev := l.Evidence
			m.mu.Lock()
			ev.Slept = ev.Slept || m.sleep.SleptSince(healthy)
			m.mu.Unlock()
			ev.OS, ev.Now = m.cfg.OS, m.cfg.Now()
			why := cause.Classify(ev)
			m.logf("Session %s: the Jupyter server on %s ended (%s).", s.ID, s.Target.Host, why)
			m.finish(s, "", why)
			return
		}
	}
}
