package managed

import (
	"context"
	"errors"

	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/netscope"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/sshtarget"
	"parallax/connector/internal/target"
)

// stageNames are the stages of a test, in order.
var stageNames = append(append([]string{}, sshtarget.Stages...), "runtime", "notebook_auth", "kernels")

// NewSSH is the SSH half of a managed connector: dials inside the managed scope, host keys only
// from the pinned file, keys only from the key store, no agent and no terminal.
func NewSSH(cfg *Config, log func(string)) *sshtarget.Target {
	return &sshtarget.Target{
		Dialer:     &netscope.Dialer{Scope: cfg.Scope},
		KnownHosts: &sshtarget.KnownHosts{Path: cfg.KnownHostsFile},
		Pinned:     true,
		ManagedKey: cfg.Keys.Read,
		Log:        log,
	}
}

// Target serves `managed` targets: each request is resolved to the operator's `ssh` target for
// its targetId and subject and run by Remote, whose SSH must be a managed one (NewSSH).
type Target struct {
	Targets *Targets
	Remote  *sshtarget.Remote
}

// Test resolves the target and runs the eight stages on the resolved one. The request's
// confirmations are dropped (host keys are pinned) and no attachable server is reported: on a
// shared host those would be other people's.
func (m *Target) Test(ctx context.Context, req *protocol.TestConnection, progress target.Progress) *protocol.TestResult {
	tg, rt, err := m.Targets.Resolve(req.Target, req.Runtime)
	if err != nil {
		return refused(req.RequestID, err, progress)
	}
	r := &protocol.TestConnection{RequestID: req.RequestID, Target: tg, Runtime: rt}
	res := m.Remote.Test(ctx, r, progress)
	res.Attachable = nil
	return res
}

// Open resolves the target and starts Jupyter there.
func (m *Target) Open(ctx context.Context, req *protocol.OpenSession) (*target.Runtime, error) {
	tg, rt, err := m.Targets.Resolve(req.Target, req.Runtime)
	if err != nil {
		return nil, err
	}
	r := *req
	r.Target, r.Runtime = tg, rt
	return m.Remote.Open(ctx, &r)
}

// SweepOrphan stops a server an earlier run left on a managed target (sessions.json records the
// `managed` target, never the resolved host or account).
func (m *Target) SweepOrphan(ctx context.Context, t protocol.Target, sessionID string, pid int) error {
	tg, _, err := m.Targets.Resolve(t, protocol.Runtime{Mode: protocol.RuntimeStart})
	if err != nil {
		return err
	}
	return m.Remote.SweepOrphan(ctx, tg, sessionID, pid, jupyter.DefaultStopTimes)
}

// refused is a test that stopped before reaching anything: the first stage fails with the
// refusal and every later one is blocked.
func refused(requestID string, err error, progress target.Progress) *protocol.TestResult {
	var f *target.Failure
	if !errors.As(err, &f) {
		f = &target.Failure{Code: protocol.CodeInternal, Detail: err.Error()}
	}
	s := &target.Stages{Progress: progress}
	s.Finish(stageNames[0], 0, nil, f)
	for _, name := range stageNames[1:] {
		s.Finish(name, 0, nil, nil)
	}
	return &protocol.TestResult{RequestID: requestID, Stages: s.List, Outcome: s.Outcome()}
}
