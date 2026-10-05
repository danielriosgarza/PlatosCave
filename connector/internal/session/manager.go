// Package session holds the connector's sessions (docs/design/connector.md §6, §7, §9) and
// serves the link's requests: test_connection, open_session, close_session, presence, activity,
// and the `http` and `ws_open` streams of a session, each checked against the Jupyter allowlist.
// Every refusal is answered with a catalogue code. lease.go enforces the leases of §9 and keeps
// sessions.json; loss.go reports a lost session with its cause (§5.5).
package session

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"sync"
	"time"

	"parallax/connector/internal/cause"
	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/link"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/redact"
	"parallax/connector/internal/state"
	"parallax/connector/internal/target"
)

// Session states (design §4.3).
const (
	StateStarting     = "starting"
	StateReady        = "ready"
	StateDisconnected = "disconnected"
	StateFailed       = "failed"
	StateStopping     = "stopping"
	StateStopped      = "stopped"
)

// Lease phases (design §9).
const (
	PhaseAttached = "attached"
	PhaseDetached = "detached"
)

// Deadlines of design §4.5 and §5.1.
const (
	testDeadline     = 300 * time.Second
	sessionDeadline  = 30 * time.Second
	contentsDeadline = 120 * time.Second
	confirmDeadline  = 120 * time.Second
	stopDeadline     = 30 * time.Second
)

// Confirm asks the person at this computer whether to go ahead; it returns false when they
// decline or do not answer before ctx ends.
type Confirm func(ctx context.Context, question string) bool

// Config is what the manager needs.
type Config struct {
	// Targets serves each target kind; a kind without one is unsupported_target.
	Targets map[string]target.Target
	// Confirm, when set (run --confirm-sessions), is asked before every open_session.
	Confirm Confirm
	// Log receives one line per session event: who asked, where, and what happened.
	Log io.Writer
	Now func() time.Time
	// StopTimes are the waits when stopping an owned server.
	StopTimes jupyter.StopTimes
	// Store holds sessions.json; nil keeps the sessions in memory only.
	Store *state.Store
	// OS is the connector's operating system, for the loss causes' interface rules.
	OS string
	// ManualTicks turns off the 1 s lease ticker; the caller drives tick (tests).
	ManualTicks bool
	// PollEvery is how often the kernels of a ready session are polled (default 15 s, the
	// heartbeat interval).
	PollEvery time.Duration
	// PollKernels reads the session's kernels from Jupyter; nil uses GET /api/kernels.
	PollKernels func(ctx context.Context, rt *target.Runtime, ids []string) ([]protocol.Kernel, error)
	// Processes inspects and signals processes for the orphan sweep; nil uses the system's.
	Processes Processes
	// SweepRemote stops an orphaned remote process (P3-05a); nil leaves remote orphans in
	// sessions.json as possibly orphaned.
	SweepRemote func(ctx context.Context, rec Record) error
}

// Manager holds the sessions in memory. It implements link.Handler.
type Manager struct {
	cfg  Config
	base context.Context

	mu       sync.Mutex
	sessions map[string]*Session
	// stopped are terminal records not yet reported on a live link (design §9).
	stopped map[string]*Record
	// orphans are records the start-up sweep could not resolve, kept for `doctor` until their
	// hard deadline.
	orphans map[string]*Record
	link    *link.Link
	sleep   cause.SleepDetector
	logMu   sync.Mutex

	writeMu   sync.Mutex
	dirty     bool
	lastWrite time.Time
}

// Session is one held session.
type Session struct {
	ID     string
	Target protocol.Target
	Owned  bool

	ctx    context.Context
	cancel context.CancelFunc

	mu            sync.Mutex
	state         string
	runtime       *target.Runtime
	kernels       jupyter.Kernels
	stopRequested string // the close_session requestId that asked to stop while starting
	cause         string // the cause of a disconnected session

	// The lease (design §9).
	lease          protocol.Lease
	phase          string
	startedAt      time.Time
	lastActivityAt time.Time
	detachedAt     time.Time
	hardDeadline   time.Time
	process        *ProcessRecord
	retryStopAt    time.Time // after a lease stop failed, when to try again
	// Evidence for the heartbeat and the loss causes.
	kernelStates []protocol.Kernel
	lastHealthy  time.Time
	lastPoll     time.Time
	polling      bool
	reconnecting bool
}

// New returns a manager whose sessions live until ctx ends.
func New(ctx context.Context, cfg Config) *Manager {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Log == nil {
		cfg.Log = io.Discard
	}
	if cfg.StopTimes == (jupyter.StopTimes{}) {
		cfg.StopTimes = jupyter.DefaultStopTimes
	}
	if cfg.PollEvery <= 0 {
		cfg.PollEvery = pollEvery
	}
	if cfg.PollKernels == nil {
		cfg.PollKernels = pollKernels
	}
	if cfg.Processes == nil {
		cfg.Processes = systemProcesses{}
	}
	m := &Manager{cfg: cfg, base: ctx, sessions: map[string]*Session{}, stopped: map[string]*Record{}, orphans: map[string]*Record{}}
	if !cfg.ManualTicks {
		go m.tickLoop()
	}
	return m
}

var _ link.Handler = (*Manager)(nil)

func (m *Manager) logf(format string, args ...any) {
	m.logMu.Lock()
	defer m.logMu.Unlock()
	fmt.Fprintf(m.cfg.Log, "%s %s\n", m.cfg.Now().UTC().Format(time.RFC3339), redact.Redact(fmt.Sprintf(format, args...)))
}

// send sends on the current link and reports whether it was written; a message for a link that
// has gone is dropped (the next heartbeat lists the session's state).
func (m *Manager) send(msg protocol.Message) bool {
	m.mu.Lock()
	l := m.link
	m.mu.Unlock()
	if l == nil {
		return false
	}
	if err := l.Send(m.base, msg); err != nil {
		m.logf("could not send %s: %v", msg.Type(), err)
		return false
	}
	return true
}

func (m *Manager) setLink(l *link.Link) {
	m.mu.Lock()
	m.link = l
	m.mu.Unlock()
}

func (m *Manager) refuse(e *protocol.Error) {
	e.Detail = clip(e.Detail)
	m.send(e)
}

// Request serves test_connection, open_session, close_session, presence and activity.
func (m *Manager) Request(_ context.Context, l *link.Link, msg protocol.Message) {
	m.setLink(l)
	switch msg := msg.(type) {
	case *protocol.TestConnection:
		t := m.cfg.Targets[msg.Target.Kind]
		if t == nil {
			m.refuse(&protocol.Error{RequestID: msg.RequestID, Code: protocol.CodeUnsupportedTarget, Detail: "this connector cannot test " + msg.Target.Kind + " targets"})
			return
		}
		go m.test(t, msg)
	case *protocol.OpenSession:
		m.open(l, msg)
	case *protocol.CloseSession:
		m.close(msg)
	case *protocol.Presence:
		s := m.get(msg.SessionID)
		if s == nil {
			m.refuse(&protocol.Error{SessionID: msg.SessionID, Code: protocol.CodeUnknownSession})
			return
		}
		m.presence(s, msg.Attached)
	case *protocol.Activity:
		s := m.get(msg.SessionID)
		if s == nil {
			m.refuse(&protocol.Error{SessionID: msg.SessionID, Code: protocol.CodeUnknownSession})
			return
		}
		m.activity(s)
	}
}

func (m *Manager) test(t target.Target, req *protocol.TestConnection) {
	ctx, cancel := context.WithTimeout(m.base, testDeadline)
	defer cancel()
	res := t.Test(ctx, req, func(st protocol.Stage) {
		m.send(&protocol.TestProgress{RequestID: req.RequestID, Stage: redactStage(st)})
	})
	for i := range res.Stages {
		res.Stages[i] = redactStage(res.Stages[i])
	}
	if _, err := protocol.Encode(res); err != nil {
		m.logf("test %s produced an invalid result: %v", req.RequestID, err)
		m.refuse(&protocol.Error{RequestID: req.RequestID, Code: protocol.CodeInternal, Detail: "the connector could not report the test"})
		return
	}
	m.send(res)
}

func redactStage(st protocol.Stage) protocol.Stage {
	st.Detail = clip(redact.Redact(st.Detail))
	return st
}

func (m *Manager) get(id string) *Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.sessions[id]
}

func (m *Manager) remove(s *Session) {
	m.mu.Lock()
	if m.sessions[s.ID] == s {
		delete(m.sessions, s.ID)
	}
	m.mu.Unlock()
	s.cancel()
}

func (s *Session) State() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

func (m *Manager) stateMsg(s *Session, requestID string) *protocol.SessionState {
	s.mu.Lock()
	defer s.mu.Unlock()
	st := &protocol.SessionState{SessionID: s.ID, RequestID: requestID, State: s.state, Owned: s.Owned, TS: m.cfg.Now().Unix()}
	if s.state != StateStopped && s.state != StateFailed {
		st.Phase = s.phase
		st.LeaseExpiresAt = stamp(s.leaseExpiresLocked())
	}
	if s.state == StateDisconnected {
		st.Cause = s.cause
	}
	return st
}

// describe is the session log line's "where": target, workspace and what will run.
func describe(req *protocol.OpenSession) string {
	where := "this computer"
	if req.Target.Kind == protocol.TargetSSH {
		where = fmt.Sprintf("%s@%s:%d", req.Target.User, req.Target.Host, req.Target.Port)
	}
	what := "start Jupyter"
	if req.Runtime.Mode == protocol.RuntimeAttach {
		what = fmt.Sprintf("attach to the Jupyter server on port %d", req.Runtime.Port)
	}
	if req.Runtime.KernelName != "" {
		what += ", kernel " + req.Runtime.KernelName
	}
	return fmt.Sprintf("on %s in %s: %s", where, req.Target.Workspace, what)
}

func (m *Manager) open(l *link.Link, req *protocol.OpenSession) {
	t := m.cfg.Targets[req.Target.Kind]
	if t == nil {
		m.refuse(&protocol.Error{RequestID: req.RequestID, SessionID: req.SessionID, Code: protocol.CodeUnsupportedTarget,
			Detail: "this connector cannot open " + req.Target.Kind + " targets"})
		return
	}
	m.mu.Lock()
	if s := m.sessions[req.SessionID]; s != nil {
		m.mu.Unlock()
		m.send(m.stateMsg(s, req.RequestID)) // a repeated request is answered with the current state
		return
	}
	if limit := l.Limits().MaxSessions; limit > 0 && len(m.sessions) >= limit {
		m.mu.Unlock()
		m.refuse(&protocol.Error{RequestID: req.RequestID, SessionID: req.SessionID, Code: protocol.CodeLimitExceeded,
			Detail: fmt.Sprintf("this connector already holds %d sessions", limit)})
		return
	}
	ctx, cancel := context.WithCancel(m.base)
	now := m.cfg.Now()
	// open_session is a person's request through a live link, so the session starts attached
	// with its idle clock running (design §9).
	s := &Session{ID: req.SessionID, Target: req.Target, Owned: req.Runtime.Mode == protocol.RuntimeStart,
		ctx: ctx, cancel: cancel, state: StateStarting,
		lease: req.Lease, phase: PhaseAttached, startedAt: now, lastActivityAt: now, lastHealthy: now,
		hardDeadline: now.Add(maxLifetime)}
	m.sessions[s.ID] = s
	m.mu.Unlock()
	m.persist()
	go m.start(t, s, req)
}

func (m *Manager) start(t target.Target, s *Session, req *protocol.OpenSession) {
	m.logf("Session %s requested by Parallax %s.", s.ID, describe(req))
	if m.cfg.Confirm != nil {
		cctx, cancel := context.WithTimeout(s.ctx, confirmDeadline)
		ok := m.cfg.Confirm(cctx, fmt.Sprintf("Parallax asks to open a session %s. Allow?", describe(req)))
		cancel()
		if !ok {
			m.logf("Session %s declined at this computer.", s.ID)
			m.remove(s)
			m.persist()
			m.refuse(&protocol.Error{RequestID: req.RequestID, SessionID: s.ID, Code: protocol.CodePathNotAllowed,
				Detail: "the person at the connector's computer declined this session"})
			return
		}
	}
	m.send(m.stateMsg(s, req.RequestID))
	rt, err := t.Open(s.ctx, req)
	if err != nil {
		f := asFailure(err)
		m.logf("Session %s failed: %s %s", s.ID, f.Code, f.Detail)
		s.mu.Lock()
		s.state = StateFailed
		pendingStop := s.stopRequested
		s.mu.Unlock()
		m.remove(s)
		m.persist()
		// Both the open request and a stop that arrived while starting get a terminal answer.
		for _, id := range []string{req.RequestID, pendingStop} {
			if id == "" {
				continue
			}
			st := m.stateMsg(s, id)
			st.Code, st.Detail = f.Code, clip(redact.Redact(f.Detail))
			m.send(st)
		}
		return
	}
	s.mu.Lock()
	s.runtime = rt
	s.lastHealthy = m.cfg.Now()
	if rt.Process != nil {
		s.process = &ProcessRecord{Where: "local", PID: rt.Process.PID, Port: rt.Process.Port, StartedAt: stamp(m.cfg.Now())}
	}
	pendingStop := s.stopRequested
	if pendingStop == "" {
		s.state = StateReady
	} else {
		s.state = StateStopping
	}
	s.mu.Unlock()
	m.persist()
	if pendingStop != "" {
		m.stop(s, pendingStop, cause.UserStop, StateReady)
		return
	}
	m.logf("Session %s ready (%s, Jupyter %s).", s.ID, ownedWord(s.Owned), rt.JupyterVersion)
	st := m.stateMsg(s, req.RequestID)
	st.JupyterVersion, st.Kernelspecs, st.Environment = rt.JupyterVersion, rt.Kernelspecs, rt.Environment
	m.send(st)
	if exited := rt.Exited(); exited != nil {
		go m.watch(s, exited)
	}
}

func ownedWord(owned bool) string {
	if owned {
		return "started by the connector"
	}
	return "attached"
}

// watch reports an owned process that ended on its own: `stopped` with process_exited, or sleep
// when the computer slept since the session's last healthy check (design §5.5).
func (m *Manager) watch(s *Session, exited <-chan struct{}) {
	select {
	case <-exited:
	case <-s.ctx.Done():
		return
	}
	s.mu.Lock()
	if s.state != StateReady && s.state != StateDisconnected {
		s.mu.Unlock()
		return
	}
	s.state = StateStopped
	healthy := s.lastHealthy
	s.mu.Unlock()
	m.mu.Lock()
	slept := m.sleep.SleptSince(healthy)
	m.mu.Unlock()
	why := cause.Classify(cause.Evidence{OS: m.cfg.OS, Local: s.Target.Kind == protocol.TargetLocal, Now: m.cfg.Now(),
		Slept: slept, ProcessExited: true})
	m.logf("Session %s: Jupyter exited on its own.", s.ID)
	m.finish(s, "", why)
}

func (m *Manager) close(req *protocol.CloseSession) {
	s := m.get(req.SessionID)
	if s == nil {
		m.refuse(&protocol.Error{RequestID: req.RequestID, SessionID: req.SessionID, Code: protocol.CodeUnknownSession})
		return
	}
	if !req.Stop {
		// Detach: the browser leaves; the session stays as it is.
		m.send(m.stateMsg(s, req.RequestID))
		return
	}
	if !s.Owned {
		m.refuse(&protocol.Error{RequestID: req.RequestID, SessionID: s.ID, Code: protocol.CodeNotOwned,
			Detail: "this Jupyter server was not started by Parallax; it can only be disconnected"})
		return
	}
	s.mu.Lock()
	switch s.state {
	case StateStarting:
		s.stopRequested = req.RequestID
		s.mu.Unlock()
		m.send(m.stateMsg(s, req.RequestID))
		return
	case StateReady, StateDisconnected:
		// Checked and changed under one lock, so two stop requests cannot both start a stop.
		prev := s.state
		s.state = StateStopping
		s.mu.Unlock()
		m.persist()
		go m.stop(s, req.RequestID, cause.UserStop, prev)
		return
	}
	s.mu.Unlock()
	m.send(m.stateMsg(s, req.RequestID)) // already stopping or ending
}

// stopReason is the log line's words for why a session stops.
var stopReason = map[string]string{
	cause.UserStop:      "at Parallax's request",
	cause.LeaseIdle:     "after the idle timeout",
	cause.LeaseGrace:    "after the grace period with no browser attached",
	cause.MaxLifetime:   "at the maximum session lifetime",
	cause.Sleep:         "because a deadline passed while this computer was asleep",
	cause.ConnectorExit: "because the connector is exiting",
}

// stop stops an owned session's process, whose state the caller already set to stopping, and
// reports `stopped` with why only once it is gone; a failed stop returns the session to prev.
func (m *Manager) stop(s *Session, requestID, why, prev string) {
	m.stopWithin(m.base, s, requestID, why, prev)
}

func (m *Manager) stopWithin(ctx context.Context, s *Session, requestID, why, prev string) {
	s.mu.Lock()
	rt := s.runtime
	s.mu.Unlock()
	m.logf("Session %s stopping %s.", s.ID, stopReason[why])
	m.send(m.stateMsg(s, requestID))
	if rt != nil && rt.Process != nil {
		sctx, cancel := context.WithTimeout(ctx, stopDeadline)
		err := rt.Process.Stop(sctx, m.cfg.StopTimes)
		cancel()
		if err != nil {
			m.logf("Session %s could not be stopped: %v", s.ID, err)
			s.mu.Lock()
			s.state = prev
			s.retryStopAt = m.cfg.Now().Add(stopRetry)
			s.mu.Unlock()
			m.persist()
			if requestID != "" {
				m.refuse(&protocol.Error{RequestID: requestID, SessionID: s.ID, Code: protocol.CodeInternal, Detail: "the Jupyter process did not end"})
			} else {
				m.send(m.stateMsg(s, ""))
			}
			return
		}
	}
	s.mu.Lock()
	s.state = StateStopped
	s.mu.Unlock()
	m.logf("Session %s stopped.", s.ID)
	m.finish(s, requestID, why)
}

// finish ends a session whose state is already stopped: it becomes a terminal record, kept in
// sessions.json until a `session_state stopped` with its cause has been sent on a live link.
func (m *Manager) finish(s *Session, requestID, why string) {
	st := m.stateMsg(s, requestID)
	st.Cause = why
	rec := m.record(s)
	rec.State, rec.Cause, rec.StoppedAt, rec.Process = StateStopped, why, stamp(m.cfg.Now()), nil
	s.mu.Lock()
	rt := s.runtime
	s.mu.Unlock()
	if rt != nil {
		rt.Client.CloseIdle() // the tunnel of an attached session ends here
	}
	m.mu.Lock()
	m.stopped[s.ID] = &rec
	m.mu.Unlock()
	m.remove(s)
	m.persist()
	if m.send(st) {
		m.reported(s.ID)
	}
}

// reported forgets a terminal record once its stop was sent on a live link.
func (m *Manager) reported(id string) {
	m.mu.Lock()
	_, ok := m.stopped[id]
	delete(m.stopped, id)
	m.mu.Unlock()
	if ok {
		m.persist()
	}
}

// list returns the live sessions in id order.
func (m *Manager) list() []*Session {
	m.mu.Lock()
	list := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.mu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	return list
}

// Sessions lists every session for the heartbeat: the live ones with their phase, lease expiry
// and kernel states, and the stopped ones not yet reported, with their cause (design §4.2, §9).
func (m *Manager) Sessions() []protocol.HeartbeatSession {
	list := m.list()
	m.mu.Lock()
	out := make([]protocol.HeartbeatSession, 0, len(list)+len(m.stopped))
	for _, r := range m.stopped {
		out = append(out, protocol.HeartbeatSession{SessionID: r.SessionID, State: StateStopped, Cause: r.Cause})
	}
	m.mu.Unlock()
	for _, s := range list {
		s.mu.Lock()
		hs := protocol.HeartbeatSession{SessionID: s.ID, State: s.state, Phase: s.phase}
		switch s.state {
		case StateReady, StateDisconnected, StateStarting, StateStopping:
			hs.LeaseExpiresAt = stamp(s.leaseExpiresLocked())
		}
		if s.state == StateDisconnected {
			hs.Cause = s.cause
		}
		if len(s.kernelStates) > 0 {
			hs.Kernels = append([]protocol.Kernel(nil), s.kernelStates...)
		}
		s.mu.Unlock()
		out = append(out, hs)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].SessionID < out[j].SessionID })
	if len(out) > maxRecords {
		out = out[:maxRecords]
	}
	return out
}

// Close stops every owned session with cause connector_exit and ends every attached one, for
// when the connector exits (SIGINT, SIGTERM, a revoked link). What cannot be reported on the
// link that is going away stays in sessions.json for the next run's first heartbeat.
func (m *Manager) Close(ctx context.Context) {
	var wg sync.WaitGroup
	for _, s := range m.list() {
		s.mu.Lock()
		prev := s.state
		switch prev {
		case StateReady, StateDisconnected:
			s.state = StateStopping
		case StateStarting:
			s.mu.Unlock()
			s.cancel() // the start gives up, kills what it began, and reports failed
			continue
		default:
			s.mu.Unlock()
			continue // already stopping or ending
		}
		owned := s.Owned
		s.mu.Unlock()
		wg.Add(1)
		go func() {
			defer wg.Done()
			if owned {
				m.stopWithin(ctx, s, "", cause.ConnectorExit, prev)
				return
			}
			s.mu.Lock()
			s.state = StateStopped
			s.mu.Unlock()
			m.finish(s, "", cause.ConnectorExit)
		}()
	}
	wg.Wait()
	m.persist()
}

func asFailure(err error) *target.Failure {
	var f *target.Failure
	if errors.As(err, &f) {
		return f
	}
	var jf *jupyter.Failure
	if errors.As(err, &jf) {
		return &target.Failure{Code: jf.Code, Detail: jf.Detail}
	}
	return &target.Failure{Code: protocol.CodeInternal, Detail: err.Error()}
}

// clip keeps a detail within 512 characters without control characters other than tab and
// newline.
func clip(s string) string {
	r := make([]rune, 0, len(s))
	for _, c := range s {
		if c < 0x20 && c != '\t' && c != '\n' || c == 0x7f {
			continue
		}
		r = append(r, c)
	}
	if len(r) > 512 {
		r = append(r[:511], '…')
	}
	return string(r)
}
