// Package target is where code runs (docs/design/connector.md §5.1, §6): the stages of Test
// connection and opening a session's runtime. P3-04 serves the `local` target; package sshtarget
// runs the SSH stages of the `ssh` target on the same Stages.
package target

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/protocol"
)

// Progress receives each finished stage as soon as it finishes.
type Progress func(protocol.Stage)

// Target tests and opens one kind of target.
type Target interface {
	// Test runs the stages of design §5.1 and returns the final result. It has no side effects:
	// it starts no server, runs no cell and writes no file.
	Test(ctx context.Context, req *protocol.TestConnection, progress Progress) *protocol.TestResult
	// Open starts or attaches the runtime of a session. A refusal or failure is a *Failure.
	Open(ctx context.Context, req *protocol.OpenSession) (*Runtime, error)
}

// Runtime is an open session's Jupyter server.
type Runtime struct {
	Client *jupyter.Client
	// Owned is true only when the connector started the server for this session.
	Owned bool
	// ContentRoot is the workspace relative to the server's root_dir ("" when they are equal).
	ContentRoot    string
	JupyterVersion string
	Kernelspecs    []protocol.Kernelspec
	Environment    *protocol.Environment
	// Process is the owned server process, nil when attached.
	Process *jupyter.Process
}

// Exited is closed when an owned process ends; nil (never ready) for an attached server.
func (r *Runtime) Exited() <-chan struct{} {
	if r.Process == nil {
		return nil
	}
	return r.Process.Exited()
}

// Failure is a stage that failed or needs action, with its catalogue code.
type Failure struct {
	Code   protocol.Code
	Detail string
	// NeedsAction marks a failure the person can resolve by confirming something.
	NeedsAction bool
}

func (f *Failure) Error() string { return fmt.Sprintf("%s: %s", f.Code, f.Detail) }

func fail(code protocol.Code, format string, args ...any) *Failure {
	return &Failure{Code: code, Detail: fmt.Sprintf(format, args...)}
}

// asFailure turns any error into a *Failure; a jupyter.Failure keeps its code.
func asFailure(err error, fallback protocol.Code) *Failure {
	var f *Failure
	if errors.As(err, &f) {
		return f
	}
	var jf *jupyter.Failure
	if errors.As(err, &jf) {
		return &Failure{Code: jf.Code, Detail: jf.Detail}
	}
	return &Failure{Code: fallback, Detail: err.Error()}
}

// skip marks a stage that is skipped for a reason of its own (not because an earlier one
// failed), such as notebook_auth before a server runs.
type skip struct{ reason string }

func (s *skip) Error() string { return "skipped: " + s.reason }

// Stage deadlines of design §5.1, and the code a stage reports when it reaches its deadline.
// ssh_auth's deadline rises to PromptDeadline once a terminal prompt starts, and its code is then
// mfa_failed; sshtarget applies both.
var (
	stageDeadline = map[string]time.Duration{
		"reachability":  20 * time.Second,
		"host_identity": 20 * time.Second,
		"ssh_auth":      60 * time.Second,
		"workspace":     20 * time.Second,
		"forwarding":    20 * time.Second,
		"runtime":       45 * time.Second,
		"notebook_auth": 20 * time.Second,
		"kernels":       20 * time.Second,
	}
	deadlineCode = map[string]protocol.Code{
		"reachability":  protocol.CodeConnectionTimeout,
		"host_identity": protocol.CodeConnectionTimeout,
		"ssh_auth":      protocol.CodeConnectionTimeout,
		"workspace":     protocol.CodeConnectionTimeout,
		"forwarding":    protocol.CodeTunnelUnavailable,
		"runtime":       protocol.CodeJupyterStartTimeout,
		"notebook_auth": protocol.CodeNotebookServiceUnreachable,
		"kernels":       protocol.CodeInternal,
	}
)

// PromptDeadline is ssh_auth's deadline once a terminal prompt has started (design §5.1).
const PromptDeadline = 120 * time.Second

// DeadlineFailure is the failure a stage reports when it reaches its deadline.
func DeadlineFailure(name string, limit time.Duration) *Failure {
	return &Failure{Code: deadlineCode[name], Detail: fmt.Sprintf("the %s stage did not finish within %s", name, limit)}
}

// Stages runs stages in order: the first that fails or needs action makes every later one
// skipped with reason blocked.
type Stages struct {
	Progress Progress
	List     []protocol.Stage
	// Limit shortens every deadline, for tests; zero keeps design §5.1's.
	Limit     time.Duration
	blockedBy string
}

// Deadline is the deadline a stage runs under.
func (s *Stages) Deadline(name string) time.Duration {
	if s.Limit > 0 {
		return s.Limit
	}
	return stageDeadline[name]
}

// BlockedBy names the stage that stopped the run, or "".
func (s *Stages) BlockedBy() string { return s.blockedBy }

// Run runs one stage under its deadline and reports whether later stages may build on it. A
// blocked stage is reported skipped without running check.
func (s *Stages) Run(ctx context.Context, name string, check func(ctx context.Context) (*protocol.StageData, error)) bool {
	if s.blockedBy != "" {
		return s.Finish(name, 0, nil, nil)
	}
	limit := s.Deadline(name)
	sctx, cancel := context.WithTimeout(ctx, limit)
	start := time.Now()
	data, err := check(sctx)
	timedOut := sctx.Err() != nil && ctx.Err() == nil
	cancel()
	if err != nil && timedOut {
		var sk *skip
		if !errors.As(err, &sk) {
			err = DeadlineFailure(name, limit)
		}
	}
	return s.Finish(name, time.Since(start), data, err)
}

// Finish reports a stage that ran for elapsed and ended with data and err: ok when err is nil,
// skipped for a skip, needs_action or failed for a *Failure (any other error is internal). When
// an earlier stage stopped the run, the stage is skipped as blocked whatever it returned. It
// reports whether later stages may build on it.
func (s *Stages) Finish(name string, elapsed time.Duration, data *protocol.StageData, err error) bool {
	st := protocol.Stage{Name: name}
	if s.blockedBy != "" {
		st.Status = "skipped"
		st.Data = &protocol.StageData{Reason: "blocked", BlockedBy: s.blockedBy}
		s.report(st)
		return false
	}
	ms := elapsed.Milliseconds()
	st.MS = &ms
	var sk *skip
	switch {
	case err == nil:
		st.Status, st.Data = "ok", data
	case errors.As(err, &sk):
		st.Status, st.Data, st.MS = "skipped", &protocol.StageData{Reason: sk.reason}, nil
	default:
		f := asFailure(err, protocol.CodeInternal)
		st.Status, st.Code, st.Detail, st.Data = "failed", f.Code, clipDetail(f.Detail), data
		if f.NeedsAction {
			st.Status = "needs_action"
		}
		s.blockedBy = name
	}
	s.report(st)
	return st.Status == "ok"
}

// Running reports, through progress only, that a stage is waiting on the person (design §5.1:
// ssh_auth waiting on the connector's terminal). It never appears in the result.
func (s *Stages) Running(name string, data *protocol.StageData) {
	if s.Progress != nil {
		s.Progress(protocol.Stage{Name: name, Status: "running", Data: data})
	}
}

func (s *Stages) report(st protocol.Stage) {
	s.List = append(s.List, st)
	if s.Progress != nil {
		s.Progress(st)
	}
}

// Outcome applies design §5.1: needs_action or failed from the first stage that stopped,
// ready_to_start when only notebook_auth was skipped because nothing runs yet, else ready.
func (s *Stages) Outcome() string {
	notStarted := false
	for _, st := range s.List {
		switch st.Status {
		case "needs_action":
			return "needs_action"
		case "failed":
			return "failed"
		case "skipped":
			if st.Data != nil && st.Data.Reason == "not_started" {
				notStarted = true
			}
		}
	}
	if notStarted {
		return "ready_to_start"
	}
	return "ready"
}

// clipDetail keeps a detail within the 512 characters a message allows, without control
// characters other than tabs and newlines.
func clipDetail(s string) string {
	r := []rune(strings.Map(func(c rune) rune {
		if c < 0x20 && c != '\t' && c != '\n' || c == 0x7f {
			return -1
		}
		return c
	}, s))
	if len(r) <= 512 {
		return string(r)
	}
	return string(r[:511]) + "…"
}
