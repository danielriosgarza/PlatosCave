// Package session holds the connector's sessions (docs/design/connector.md §6, §7, §9) and
// serves the link's requests: test_connection, open_session, close_session, and the `http` and
// `ws_open` streams of a session, each checked against the Jupyter allowlist. Every refusal is
// answered with a catalogue code. Leases and the sessions file arrive in P3-04a.
package session

import (
	"context"
	"errors"
	"fmt"
	"io"
	"sort"
	"sync"
	"time"

	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/link"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/redact"
	"parallax/connector/internal/target"
)

// Session states (design §4.3). `disconnected` arrives with P3-04a's causes.
const (
	StateStarting = "starting"
	StateReady    = "ready"
	StateFailed   = "failed"
	StateStopping = "stopping"
	StateStopped  = "stopped"
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
}

// Manager holds the sessions in memory. It implements link.Handler.
type Manager struct {
	cfg  Config
	base context.Context

	mu       sync.Mutex
	sessions map[string]*Session
	link     *link.Link
	logMu    sync.Mutex
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
	return &Manager{cfg: cfg, base: ctx, sessions: map[string]*Session{}}
}

var _ link.Handler = (*Manager)(nil)

func (m *Manager) logf(format string, args ...any) {
	m.logMu.Lock()
	defer m.logMu.Unlock()
	fmt.Fprintf(m.cfg.Log, "%s %s\n", m.cfg.Now().UTC().Format(time.RFC3339), redact.Redact(fmt.Sprintf(format, args...)))
}

// send sends on the current link; a message for a link that has gone is dropped (the next
// heartbeat lists the session's state).
func (m *Manager) send(msg protocol.Message) {
	m.mu.Lock()
	l := m.link
	m.mu.Unlock()
	if l == nil {
		return
	}
	if err := l.Send(m.base, msg); err != nil {
		m.logf("could not send %s: %v", msg.Type(), err)
	}
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
		if m.get(msg.SessionID) == nil {
			m.refuse(&protocol.Error{SessionID: msg.SessionID, Code: protocol.CodeUnknownSession})
		}
		// The lease phase it drives arrives in P3-04a.
	case *protocol.Activity:
		if m.get(msg.SessionID) == nil {
			m.refuse(&protocol.Error{SessionID: msg.SessionID, Code: protocol.CodeUnknownSession})
		}
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
	return &protocol.SessionState{SessionID: s.ID, RequestID: requestID, State: s.state, Owned: s.Owned, TS: m.cfg.Now().Unix()}
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
	s := &Session{ID: req.SessionID, Target: req.Target, Owned: req.Runtime.Mode == protocol.RuntimeStart,
		ctx: ctx, cancel: cancel, state: StateStarting}
	m.sessions[s.ID] = s
	m.mu.Unlock()
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
		s.mu.Unlock()
		st := m.stateMsg(s, req.RequestID)
		st.Code, st.Detail = f.Code, clip(redact.Redact(f.Detail))
		m.remove(s)
		m.send(st)
		return
	}
	s.mu.Lock()
	s.runtime = rt
	pendingStop := s.stopRequested
	if pendingStop == "" {
		s.state = StateReady
	}
	s.mu.Unlock()
	if pendingStop != "" {
		m.stop(s, pendingStop)
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

// watch reports an owned process that ended on its own (cause process_exited).
func (m *Manager) watch(s *Session, exited <-chan struct{}) {
	select {
	case <-exited:
	case <-s.ctx.Done():
		return
	}
	s.mu.Lock()
	if s.state != StateReady {
		s.mu.Unlock()
		return
	}
	s.state = StateStopped
	s.mu.Unlock()
	m.logf("Session %s: Jupyter exited on its own.", s.ID)
	st := m.stateMsg(s, "")
	st.Cause = "process_exited"
	m.remove(s)
	m.send(st)
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
	case StateStopping:
		s.mu.Unlock()
		m.send(m.stateMsg(s, req.RequestID))
		return
	}
	s.mu.Unlock()
	go m.stop(s, req.RequestID)
}

// stop stops an owned session's process and reports `stopped` only once it is gone.
func (m *Manager) stop(s *Session, requestID string) {
	s.mu.Lock()
	prev := s.state
	s.state = StateStopping
	rt := s.runtime
	s.mu.Unlock()
	m.logf("Session %s stopping at Parallax's request.", s.ID)
	m.send(m.stateMsg(s, requestID))
	if rt != nil && rt.Process != nil {
		ctx, cancel := context.WithTimeout(m.base, stopDeadline)
		err := rt.Process.Stop(ctx, m.cfg.StopTimes)
		cancel()
		if err != nil {
			m.logf("Session %s could not be stopped: %v", s.ID, err)
			s.mu.Lock()
			s.state = prev
			s.mu.Unlock()
			m.refuse(&protocol.Error{RequestID: requestID, SessionID: s.ID, Code: protocol.CodeInternal, Detail: "the Jupyter process did not end"})
			return
		}
	}
	s.mu.Lock()
	s.state = StateStopped
	s.mu.Unlock()
	m.logf("Session %s stopped.", s.ID)
	st := m.stateMsg(s, requestID)
	st.Cause = "user_stop"
	m.remove(s)
	m.send(st)
}

// Sessions lists the held sessions for the heartbeat.
func (m *Manager) Sessions() []protocol.HeartbeatSession {
	m.mu.Lock()
	list := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.mu.Unlock()
	sort.Slice(list, func(i, j int) bool { return list[i].ID < list[j].ID })
	out := make([]protocol.HeartbeatSession, 0, len(list))
	for _, s := range list {
		out = append(out, protocol.HeartbeatSession{SessionID: s.ID, State: s.State()})
	}
	return out
}

// Close stops every owned session, for when the connector exits.
func (m *Manager) Close(ctx context.Context) {
	m.mu.Lock()
	list := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		list = append(list, s)
	}
	m.mu.Unlock()
	var wg sync.WaitGroup
	for _, s := range list {
		s.mu.Lock()
		rt := s.runtime
		s.mu.Unlock()
		wg.Add(1)
		go func() {
			defer wg.Done()
			if rt != nil && rt.Process != nil {
				rt.Process.Stop(ctx, m.cfg.StopTimes)
				m.logf("Session %s stopped because the connector is exiting.", s.ID)
			}
			if rt != nil {
				rt.Client.CloseIdle()
			}
			m.remove(s)
		}()
	}
	wg.Wait()
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
