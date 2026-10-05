package sshtarget

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"time"

	"parallax/connector/internal/cause"
	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/target"
)

// The session's transport (design §5.3, §5.5): a keepalive@openssh.com request every 15 s; a
// transport that closes, or a keepalive unanswered for 45 s, is a loss. Each loss is reported
// once on Losses with the evidence the cause rules need (the network now and at the last healthy
// check, the route to the first hop, expectedEnd, whether the host still accepts a connection);
// the session manager classifies it, adds the sleep rule from its own ticker and calls Reconnect
// on its schedule for as long as the lease is valid.

// request is the session's target as a test_connection, for a reconnect.
func (rr *remoteRuntime) request() *protocol.TestConnection {
	return &protocol.TestConnection{RequestID: rr.sessionID, Target: rr.target, Runtime: rr.runtime}
}

// replace makes c the session's connection. The exec channel the server was started in belonged
// to the old one, so the server's end is learned from ps and /api/status from now on.
func (rr *remoteRuntime) replace(c *Conn) {
	rr.mu.Lock()
	old := rr.conn
	rr.conn, rr.execDone = c, nil
	rr.mu.Unlock()
	if old != nil && old != c {
		old.Close()
	}
	if rr.client != nil {
		rr.client.CloseIdle()
	}
}

// Reconnect re-establishes the SSH connection (non-interactively when the connector has no
// terminal, as at the first connect) and checks /api/status with the token through the new
// tunnel. On success the session is healthy again and watched. When SSH answers but the owned
// server is proved gone, the loss is reported as stopped with service_stopped.
func (rr *remoteRuntime) Reconnect(ctx context.Context) error {
	select {
	case <-rr.closed:
		return errors.New("the session is closed")
	default:
	}
	c, err := rr.r.SSH.Connect(ctx, rr.request())
	if err != nil {
		return err
	}
	rr.replace(c)
	if err := rr.client.Status(ctx); err != nil {
		rr.serviceLost(ctx)
		return err
	}
	rr.watch()
	return nil
}

// serviceLost reports an owned server that is proved gone while SSH answers.
func (rr *remoteRuntime) serviceLost(ctx context.Context) bool {
	pid, _ := rr.pidAndClient()
	c := rr.current()
	if !rr.owned || c == nil || !validPID(pid) {
		return false
	}
	alive, mine, err := inspect(ctx, c.Client, pid, rr.sessionID)
	if err != nil || (alive && mine) {
		return false
	}
	rr.report(target.Loss{Gone: true, Evidence: cause.Evidence{Now: time.Now(), TransportHealthy: true, ProcessExited: true}})
	return true
}

// report delivers a loss unless the session closed.
func (rr *remoteRuntime) report(l target.Loss) {
	select {
	case rr.losses <- l:
	case <-rr.closed:
	}
}

// watch starts the monitor for the current connection, recording the network as healthy now.
func (rr *remoteRuntime) watch() {
	select {
	case <-rr.closed:
		return
	default:
	}
	snap := rr.r.interfaces()
	rr.mu.Lock()
	if rr.monitor != nil {
		rr.monitor()
	}
	c := rr.conn
	if c == nil {
		rr.mu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	rr.monitor = cancel
	rr.before, rr.route = snap, routeOf(snap, c.first().LocalAddr())
	done := rr.execDone
	rr.mu.Unlock()
	go rr.run(ctx, c, done)
}

// stopMonitor stops the running monitor and reports whether one was running.
func (rr *remoteRuntime) stopMonitor() bool {
	rr.mu.Lock()
	defer rr.mu.Unlock()
	if rr.monitor == nil {
		return false
	}
	rr.monitor()
	rr.monitor = nil
	return true
}

// run is the monitor of one connection: keepalive, the transport's end, and the end of the exec
// channel the owned server runs in.
func (rr *remoteRuntime) run(ctx context.Context, c *Conn, execDone <-chan struct{}) {
	ended := make(chan struct{})
	go func() {
		c.Client.Wait()
		close(ended)
	}()
	tick := time.NewTicker(rr.r.keepalive())
	defer tick.Stop()
	lastOK := time.Now()
	type answer struct {
		ok bool
		at time.Time
	}
	answers := make(chan answer, 1)
	pending := false
	for {
		select {
		case <-ctx.Done():
			return
		case <-ended:
			rr.lost(ctx, c, cause.Evidence{TransportEnded: true})
			return
		case <-execDone:
			execDone = nil
			// The channel ends when the server exits, and also when the transport goes; only a
			// transport that still answers proves the process ended.
			if keepaliveOK(ctx, c.Client, min(5*time.Second, rr.r.keepaliveLoss())) {
				if ctx.Err() == nil {
					rr.stopMonitorIf(ctx)
					rr.report(target.Loss{Gone: true, Evidence: cause.Evidence{Now: time.Now(), TransportHealthy: true, ProcessExited: true}})
				}
				return
			}
		case a := <-answers:
			pending = false
			if a.ok {
				lastOK = a.at
				if !rr.owned || rr.execGone() {
					// No exec channel to watch: an attached server, or an owned one after a
					// reconnect. A server that stops answering while SSH answers is lost.
					if rr.checkService(ctx, c) {
						return
					}
				}
			}
		case <-tick.C:
			if time.Since(lastOK) >= rr.r.keepaliveLoss() {
				rr.lost(ctx, c, cause.Evidence{KeepaliveLost: true})
				return
			}
			if !pending {
				pending = true
				go func() {
					ok := keepaliveOK(ctx, c.Client, rr.r.keepaliveLoss())
					answers <- answer{ok: ok, at: time.Now()}
				}()
			}
		}
	}
}

// execGone reports that the server's exec channel is no longer watched (after a reconnect).
func (rr *remoteRuntime) execGone() bool {
	rr.mu.Lock()
	defer rr.mu.Unlock()
	return rr.execDone == nil
}

// stopMonitorIf forgets the monitor whose context is ctx.
func (rr *remoteRuntime) stopMonitorIf(ctx context.Context) {
	rr.mu.Lock()
	defer rr.mu.Unlock()
	if rr.monitor != nil && ctx.Err() == nil {
		rr.monitor()
		rr.monitor = nil
	}
}

// checkService asks /api/status while SSH answers; a server that does not answer is lost with
// service_stopped (stopped when an owned server is proved gone). It reports whether it was lost.
func (rr *remoteRuntime) checkService(ctx context.Context, c *Conn) bool {
	sctx, cancel := context.WithTimeout(ctx, min(5*time.Second, rr.r.keepaliveLoss()))
	err := rr.client.Status(sctx)
	cancel()
	var jf *jupyter.Failure
	if err == nil || ctx.Err() != nil {
		return false
	}
	if errors.As(err, &jf) && jf.Code == protocol.CodeTokenRejected {
		// Something answers on the port but refuses the token: the session's own server answers
		// with it, so an owned server whose process is proved gone was replaced by another.
		if rr.serviceLost(ctx) {
			rr.stopMonitorIf(ctx)
			return true
		}
		return false
	}
	rr.stopMonitorIf(ctx)
	if rr.serviceLost(ctx) {
		return true
	}
	rr.report(target.Loss{Evidence: cause.Evidence{Now: time.Now(), TransportHealthy: true, ServiceUnanswered: true}})
	return true
}

// lost reports a lost transport with its evidence and closes the dead connection.
func (rr *remoteRuntime) lost(ctx context.Context, c *Conn, ev cause.Evidence) {
	if ctx.Err() != nil {
		return
	}
	rr.stopMonitorIf(ctx)
	rr.mu.Lock()
	before, route := rr.before, rr.route
	rr.mu.Unlock()
	remote := c.first().RemoteAddr()
	c.Close()
	after := rr.r.interfaces()
	ev.Now = time.Now()
	ev.Before, ev.After = before, after
	ev.RouteBefore, ev.RouteAfter = route, routeTo(after, remote)
	ev.WasReachable = true
	ev.DialsFail = !rr.reachable(remote)
	if t, err := time.Parse(time.RFC3339Nano, rr.target.ExpectedEnd); err == nil {
		ev.ExpectedEnd = t
	}
	rr.report(target.Loss{Evidence: ev})
}

// reachable reports whether the first hop still accepts a TCP connection, through the network
// scope like every dial.
func (rr *remoteRuntime) reachable(remote net.Addr) bool {
	ap, err := netip.ParseAddrPort(remote.String())
	if err != nil || rr.r.SSH.Dialer == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, err := rr.r.SSH.Dialer.DialContext(ctx, ap.Addr().Unmap().String(), int(ap.Port()))
	if err != nil {
		return false
	}
	conn.Close()
	return true
}

// routeOf is the interface that holds a connection's local address.
func routeOf(s cause.Snapshot, local net.Addr) string {
	ap, err := netip.ParseAddrPort(local.String())
	if err != nil {
		return ""
	}
	return cause.RouteInterface(s, ap.Addr())
}

// routeTo is the interface that would carry a connection to remote now: a UDP socket connected
// to it learns the local address the system would use, and sends nothing.
func routeTo(s cause.Snapshot, remote net.Addr) string {
	ap, err := netip.ParseAddrPort(remote.String())
	if err != nil {
		return ""
	}
	conn, err := net.DialUDP("udp", nil, net.UDPAddrFromAddrPort(ap))
	if err != nil {
		return ""
	}
	defer conn.Close()
	return routeOf(s, conn.LocalAddr())
}
