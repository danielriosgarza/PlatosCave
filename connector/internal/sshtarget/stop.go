package sshtarget

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"

	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/redact"
)

// marker is the argument that proves a process is a session's own Jupyter server (design §6).
func marker(sessionID string) string { return "--ParallaxMarker.session=" + sessionID }

// errNotOwned refuses to stop a server the connector did not start.
var errNotOwned = errors.New("this Jupyter server was not started by Parallax; it is never signalled")

// Stop stops the owned server (design §6): POST /api/shutdown through the tunnel, wait for the
// exec channel to end, then SIGTERM to the recorded pid once `ps` shows the session's marker in
// its command line, and SIGKILL after the terminate wait. It returns nil only once the process is
// gone (a pid that no longer carries the marker is another process: the session's own is gone),
// and then closes the tunnel and the connection. An attached server is never signalled.
func (rr *remoteRuntime) Stop(ctx context.Context, times jupyter.StopTimes) error {
	if !rr.owned {
		return errNotOwned
	}
	conn, err := rr.live(ctx)
	if err != nil {
		return fmt.Errorf("the host cannot be reached to stop Jupyter: %w", err)
	}
	rr.stopMonitor()
	if err := stopProcess(ctx, conn.Client, rr, times); err != nil {
		rr.watch()
		return err
	}
	rr.Close()
	return nil
}

// live returns a connection that answers, reconnecting once when the current one does not (a
// stop asked while the session is disconnected). A monitor that was watching the old connection
// is started again when the reconnect fails, so the loss is still reported.
func (rr *remoteRuntime) live(ctx context.Context) (*Conn, error) {
	if c := rr.current(); c != nil && keepaliveOK(ctx, c.Client, min(5*time.Second, rr.r.keepaliveLoss())) {
		return c, nil
	}
	watching := rr.stopMonitor()
	c, err := rr.r.SSH.Connect(ctx, rr.request())
	if err != nil {
		if watching {
			rr.watch()
		}
		return nil, err
	}
	rr.replace(c)
	return c, nil
}

// processView is what a stop knows about the server process.
type processView interface {
	// gone reports that the exec channel the server ran in has ended over a live transport.
	gone() bool
	pidAndClient() (int, *jupyter.Client)
	session() string
}

func (rr *remoteRuntime) gone() bool {
	rr.mu.Lock()
	done := rr.execDone
	rr.mu.Unlock()
	if done == nil {
		return false
	}
	select {
	case <-done:
		return true
	default:
		return false
	}
}

func (rr *remoteRuntime) pidAndClient() (int, *jupyter.Client) {
	rr.mu.Lock()
	defer rr.mu.Unlock()
	return rr.pid, rr.client
}

func (rr *remoteRuntime) session() string { return rr.sessionID }

// stopProcess is the stop sequence over a live connection.
func stopProcess(ctx context.Context, client *ssh.Client, p processView, times jupyter.StopTimes) error {
	pid, jc := p.pidAndClient()
	ended := func() (bool, error) {
		if p.gone() {
			return true, nil
		}
		if !validPID(pid) {
			return false, nil
		}
		alive, mine, err := inspect(ctx, client, pid, p.session())
		return err == nil && (!alive || !mine), err
	}
	wait := func(limit time.Duration) bool {
		deadline := time.Now().Add(limit)
		for {
			if done, _ := ended(); done {
				return true
			}
			if !time.Now().Before(deadline) || ctx.Err() != nil {
				return false
			}
			select {
			case <-ctx.Done():
			case <-time.After(min(250*time.Millisecond, limit)):
			}
		}
	}
	if jc != nil {
		sctx, cancel := context.WithTimeout(ctx, times.Shutdown)
		_ = jc.Shutdown(sctx)
		cancel()
		if wait(times.Shutdown) {
			jc.CloseIdle()
			return nil
		}
		jc.CloseIdle()
	}
	if !validPID(pid) {
		return errors.New("the Jupyter process did not end and its pid is not known")
	}
	for _, kill := range []bool{false, true} {
		alive, mine, err := inspect(ctx, client, pid, p.session())
		switch {
		case err != nil:
			return err
		case !alive || !mine:
			return nil
		}
		if _, err := runCommand(ctx, client, killCommand(pid, kill), ""); err != nil {
			return fmt.Errorf("the host refused to signal process %d: %w", pid, err)
		}
		limit := times.Terminate
		if kill {
			limit = max(times.Terminate, time.Second)
		}
		if wait(limit) {
			return nil
		}
	}
	return fmt.Errorf("the Jupyter process %d did not end", pid)
}

// inspect reads a process's command line with ps: alive is false when there is no such process,
// mine is true when its command line carries the session's marker.
func inspect(ctx context.Context, client *ssh.Client, pid int, sessionID string) (alive, mine bool, err error) {
	res, err := runCommand(ctx, client, psCommand(pid), "")
	if err != nil {
		return false, false, fmt.Errorf("the host refused to list process %d: %w", pid, err)
	}
	args := strings.TrimSpace(res.stdout)
	if res.status != 0 || args == "" {
		return false, false, nil
	}
	for _, f := range strings.Fields(args) {
		if f == marker(sessionID) {
			return true, true, nil
		}
	}
	return true, false, nil
}

// orphan is a process left by an earlier run: its pid and session, with no Jupyter client (the
// token died with that run).
type orphan struct {
	pid int
	id  string
}

func (o orphan) gone() bool                           { return false }
func (o orphan) pidAndClient() (int, *jupyter.Client) { return o.pid, nil }
func (o orphan) session() string                      { return o.id }

// SweepOrphan stops the remote server an earlier run of the connector left (design §6): a
// non-interactive connection (agent or unencrypted key; nothing is asked in a terminal), then
// SIGTERM and SIGKILL to the recorded pid only once its marker proves it is the session's own.
// nil means the process is gone.
func (r *Remote) SweepOrphan(ctx context.Context, t protocol.Target, sessionID string, pid int, times jupyter.StopTimes) error {
	if !validPID(pid) {
		return errors.New("no valid pid was recorded")
	}
	quiet := *r.SSH
	quiet.TTY, quiet.Terminal = false, nil
	quiet.Log = nil
	conn, err := quiet.Connect(ctx, &protocol.TestConnection{RequestID: sessionID, Target: t, Runtime: protocol.Runtime{Mode: protocol.RuntimeStart}})
	if err != nil {
		return err
	}
	defer conn.Close()
	return stopProcess(ctx, conn.Client, orphan{pid: pid, id: sessionID}, times)
}

// Close closes the tunnel and the SSH connection and stops reporting losses. It never signals
// the server: an attached server keeps running (A32).
func (rr *remoteRuntime) Close() {
	rr.closeOnce.Do(func() {
		close(rr.closed)
		rr.stopMonitor()
		rr.mu.Lock()
		c := rr.conn
		rr.conn = nil
		rr.mu.Unlock()
		if rr.client != nil {
			rr.client.CloseIdle()
		}
		if c != nil {
			c.Close()
		}
		if rr.token != "" {
			redact.Forget(rr.token)
		}
	})
}
