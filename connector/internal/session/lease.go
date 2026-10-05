package session

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"time"

	"parallax/connector/internal/cause"
	"parallax/connector/internal/link"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/target"
)

// Lease constants of design §9 and §6.
const (
	tickEvery     = time.Second      // deadlines are checked every second
	pollEvery     = 15 * time.Second // kernels are polled every heartbeat
	pollTimeout   = 5 * time.Second
	maxLifetime   = 12 * time.Hour  // hardDeadline, cause max_lifetime
	writeEvery    = 5 * time.Second // sessions.json at most this often between transitions
	stopRetry     = 30 * time.Second
	maxKernelList = 1 << 20
)

// deadlineLocked is the session's lease deadline and the cause a stop at it carries: in the
// attached phase lastActivityAt + idleTimeout (lease_idle), in the detached phase detachedAt +
// gracePeriod (lease_grace), which nothing but a new presence moves. s.mu must be held.
func (s *Session) deadlineLocked() (time.Time, string) {
	if s.phase == PhaseDetached {
		return s.detachedAt.Add(time.Duration(s.lease.GracePeriodMin) * time.Minute), cause.LeaseGrace
	}
	return s.lastActivityAt.Add(time.Duration(s.lease.IdleTimeoutMin) * time.Minute), cause.LeaseIdle
}

// leaseExpiresLocked is when the session will end if nothing changes: its lease deadline, or
// for an owned session the hard deadline if that comes first. s.mu must be held.
func (s *Session) leaseExpiresLocked() time.Time {
	d, _ := s.deadlineLocked()
	if s.Owned && s.hardDeadline.Before(d) {
		return s.hardDeadline
	}
	return d
}

func (m *Manager) tickLoop() {
	t := time.NewTicker(tickEvery)
	defer t.Stop()
	for {
		select {
		case <-m.base.Done():
			return
		case <-t.C:
			m.tick()
		}
	}
}

// tick is one tick of the 1 s ticker: it feeds the sleep detector, stops every session whose
// deadline has passed, starts kernel polls that are due and writes sessions.json if it is due.
func (m *Manager) tick() {
	now := m.cfg.Now()
	m.mu.Lock()
	woke := m.sleep.Tick(now)
	m.mu.Unlock()
	if woke {
		m.logf("This computer was asleep; checking every session's deadline.")
	}
	for _, s := range m.list() {
		m.checkLease(s, now, woke)
		m.maybePoll(s, now)
	}
	m.dropOrphans(now)
	m.persistIfDue(now)
}

// checkLease stops a session whose deadline has passed. At a wake-up the cause is sleep, so a
// sleeping laptop gets its own true cause; otherwise it is the lease's (design §9).
func (m *Manager) checkLease(s *Session, now time.Time, woke bool) {
	s.mu.Lock()
	if (s.state != StateReady && s.state != StateDisconnected) || now.Before(s.retryStopAt) {
		s.mu.Unlock()
		return
	}
	why := ""
	if deadline, leaseCause := s.deadlineLocked(); !now.Before(deadline) {
		why = leaseCause
	}
	if s.Owned && !now.Before(s.hardDeadline) {
		why = cause.MaxLifetime
	}
	if why == "" {
		s.mu.Unlock()
		return
	}
	if woke {
		why = cause.Sleep
	}
	prev := s.state
	if s.Owned {
		s.state = StateStopping
		s.mu.Unlock()
		m.persist()
		go m.stop(s, "", why, prev)
		return
	}
	// An attached session is never stopped: its tunnel closes and the session is forgotten,
	// leaving the person's server running (design §9).
	s.state = StateStopped
	s.mu.Unlock()
	m.logf("Session %s ended %s; the attached Jupyter server keeps running.", s.ID, stopReason[why])
	m.finish(s, "", why)
}

// presence applies the server's presence: attached starts the idle clock afresh, detached
// starts the grace period. A change of presence counts as activity; a repeated detached
// presence does not move the grace deadline.
func (m *Manager) presence(s *Session, attached bool) {
	now := m.cfg.Now()
	s.mu.Lock()
	want := PhaseDetached
	if attached {
		want = PhaseAttached
	}
	changed := s.phase != want
	if changed {
		s.phase, s.lastActivityAt = want, now
		if attached {
			s.detachedAt = time.Time{}
		} else {
			s.detachedAt = now
		}
	}
	s.mu.Unlock()
	if changed {
		m.persist()
	}
}

// activity resets the idle clock. In the detached phase it does not move the grace deadline.
func (m *Manager) activity(s *Session) {
	s.mu.Lock()
	s.lastActivityAt = m.cfg.Now()
	s.mu.Unlock()
	m.markDirty()
}

// LinkUp makes the link the one messages go to and sends a state notice for every session
// after hello and the first heartbeat (design §4.2): the stopped ones not yet reported are
// forgotten once their notice is written. Phases stay detached until the relay's presence.
func (m *Manager) LinkUp(_ context.Context, l *link.Link) {
	m.setLink(l)
	m.mu.Lock()
	var pending []*Record
	for _, r := range m.stopped {
		pending = append(pending, r)
	}
	m.mu.Unlock()
	for _, r := range pending {
		st := &protocol.SessionState{SessionID: r.SessionID, State: StateStopped, Owned: r.Owned, Cause: r.Cause, TS: m.cfg.Now().Unix()}
		if m.send(st) {
			m.reported(r.SessionID)
		}
	}
	for _, s := range m.list() {
		if st := m.stateMsg(s, ""); st.State != StateStopped && st.State != StateFailed {
			m.send(st)
		}
	}
}

// LinkDown counts the loss of the link as a detach: without the relay no browser can be
// attached, so every attached session's grace period starts now (design §9).
func (m *Manager) LinkDown(l *link.Link) {
	m.mu.Lock()
	if m.link == l {
		m.link = nil
	}
	m.mu.Unlock()
	now := m.cfg.Now()
	changed := false
	for _, s := range m.list() {
		s.mu.Lock()
		if s.phase == PhaseAttached {
			s.phase, s.detachedAt = PhaseDetached, now
			changed = true
		}
		s.mu.Unlock()
	}
	if changed {
		m.persist()
	}
}

var _ link.Watcher = (*Manager)(nil)

// maybePoll starts a kernel poll for a ready session when one is due.
func (m *Manager) maybePoll(s *Session, now time.Time) {
	s.mu.Lock()
	rt := s.runtime
	due := s.state == StateReady && rt != nil && !s.polling && now.Sub(s.lastPoll) >= m.cfg.PollEvery
	if due {
		s.polling, s.lastPoll = true, now
	}
	ids := s.kernels.IDs()
	s.mu.Unlock()
	if due {
		go m.poll(s, rt, ids)
	}
}

// poll reads the session's kernels. A busy kernel is activity, which resets the idle clock but
// not the grace deadline; a successful poll is a healthy check for the loss causes.
func (m *Manager) poll(s *Session, rt *target.Runtime, ids []string) {
	ctx, cancel := context.WithTimeout(s.ctx, pollTimeout)
	kernels, err := m.cfg.PollKernels(ctx, rt, ids)
	cancel()
	now := m.cfg.Now()
	s.mu.Lock()
	s.polling = false
	busy := false
	if err == nil {
		s.kernelStates, s.lastHealthy = kernels, now
		for _, k := range kernels {
			busy = busy || k.ExecutionState == "busy"
		}
		if busy {
			s.lastActivityAt = now
		}
	}
	s.mu.Unlock()
	if busy {
		m.markDirty()
	}
}

// pollKernels is GET /api/kernels, kept to the session's own kernels.
func pollKernels(ctx context.Context, rt *target.Runtime, ids []string) ([]protocol.Kernel, error) {
	resp, err := rt.Client.Do(ctx, http.MethodGet, "/api/kernels", "", nil, nil, 0)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET /api/kernels answered %d", resp.StatusCode)
	}
	var list []struct {
		ID             string `json:"id"`
		ExecutionState string `json:"execution_state"`
		LastActivity   string `json:"last_activity"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, maxKernelList)).Decode(&list); err != nil {
		return nil, fmt.Errorf("the kernel list is not JSON: %w", err)
	}
	mine := map[string]bool{}
	for _, id := range ids {
		mine[id] = true
	}
	out := []protocol.Kernel{}
	for _, k := range list {
		if !mine[k.ID] || len(out) == 16 {
			continue
		}
		pk := protocol.Kernel{ID: k.ID, ExecutionState: "unknown"}
		switch k.ExecutionState {
		case "starting", "idle", "busy":
			pk.ExecutionState = k.ExecutionState
		}
		if t, err := time.Parse(time.RFC3339Nano, k.LastActivity); err == nil {
			pk.LastActivity = t.UTC().Format(time.RFC3339Nano)
		}
		out = append(out, pk)
	}
	return out, nil
}

// record is a session's sessions.json record.
func (m *Manager) record(s *Session) Record {
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.state
	if state == StateFailed {
		state = StateStopped
	}
	r := Record{
		SessionID: s.ID, Owned: s.Owned, State: state, Target: s.Target,
		KernelIDs: s.kernels.IDs(), StartedAt: stamp(s.startedAt), Lease: s.lease, Phase: s.phase,
		LastActivityAt: stamp(s.lastActivityAt), ExpiresAt: stamp(s.leaseExpiresLocked()), HardDeadline: stamp(s.hardDeadline),
	}
	if state == StateDisconnected {
		r.Cause = s.cause
	}
	if !s.detachedAt.IsZero() {
		r.DetachedAt = stamp(s.detachedAt)
	}
	if s.process != nil {
		p := *s.process
		r.Process = &p
	}
	sort.Strings(r.KernelIDs)
	if len(r.KernelIDs) > 16 {
		r.KernelIDs = r.KernelIDs[:16]
	}
	return r
}

// persist writes sessions.json now: on every state or phase change.
func (m *Manager) persist() {
	if m.cfg.Store == nil {
		return
	}
	m.writeMu.Lock()
	defer m.writeMu.Unlock()
	f := &File{V: 1, Sessions: []Record{}}
	for _, s := range m.list() {
		if st := s.State(); st == StateFailed {
			continue
		}
		f.Sessions = append(f.Sessions, m.record(s))
	}
	m.mu.Lock()
	for _, r := range m.stopped {
		f.Sessions = append(f.Sessions, *r)
	}
	for _, r := range m.orphans {
		f.Sessions = append(f.Sessions, *r)
	}
	m.dirty, m.lastWrite = false, m.cfg.Now()
	m.mu.Unlock()
	if len(f.Sessions) > maxRecords {
		f.Sessions = f.Sessions[:maxRecords]
	}
	if err := writeFile(m.cfg.Store, f); err != nil {
		m.logf("could not write sessions.json: %v", err)
	}
}

// markDirty records a change that is written within 5 s (activity), not at once.
func (m *Manager) markDirty() {
	m.mu.Lock()
	m.dirty = true
	m.mu.Unlock()
}

func (m *Manager) persistIfDue(now time.Time) {
	m.mu.Lock()
	due := m.dirty && now.Sub(m.lastWrite) >= writeEvery
	m.mu.Unlock()
	if due {
		m.persist()
	}
}
