package sshtarget

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"

	"parallax/connector/internal/netscope"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/target"
)

// Hop names, as data.hop reports them.
const (
	hopJump   = "jump"
	hopTarget = "target"
)

// hop is one SSH endpoint of a route: the jump host, then the target.
type hop struct {
	name string
	host string
	port int
	user string
	auth protocol.AuthRef
}

// route returns the hops of a target, jump host first. The jump host uses the target's auth
// reference when it names none.
func route(t protocol.Target) []hop {
	var auth protocol.AuthRef
	if t.Auth != nil {
		auth = *t.Auth
	}
	var hops []hop
	if j := t.Jump; j != nil {
		ja := auth
		if j.Auth != nil {
			ja = *j.Auth
		}
		hops = append(hops, hop{name: hopJump, host: j.Host, port: j.Port, user: j.User, auth: ja})
	}
	return append(hops, hop{name: hopTarget, host: t.Host, port: t.Port, user: t.User, auth: auth})
}

func (h hop) label() string { return h.user + "@" + endpointName(h.host, h.port) }

// endpointName is host:port for messages, with an IPv6 literal in brackets.
func endpointName(host string, port int) string {
	return net.JoinHostPort(host, strconv.Itoa(port))
}

// sameEndpoint compares two host:port pairs: names without regard to case, address literals in
// canonical form.
func sameEndpoint(h1 string, p1 int, h2 string, p2 int) bool {
	if p1 != p2 {
		return false
	}
	a1, e1 := netip.ParseAddr(h1)
	a2, e2 := netip.ParseAddr(h2)
	if e1 == nil && e2 == nil {
		return a1.Unmap() == a2.Unmap()
	}
	return e1 != nil && e2 != nil && strings.EqualFold(h1, h2)
}

// budget is a stage's deadline shared by every hop it runs (design §5.1): each step of the stage
// spends from it, so two hops together stay within one deadline.
type budget struct {
	name string

	mu      sync.Mutex
	limit   time.Duration
	used    time.Duration
	changed chan struct{}
}

func newBudget(name string, limit time.Duration) *budget {
	return &budget{name: name, limit: limit, changed: make(chan struct{})}
}

// extend raises the limit to at least limit (ssh_auth once a terminal prompt starts).
func (b *budget) extend(limit time.Duration) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if limit > b.limit {
		b.limit = limit
		close(b.changed)
		b.changed = make(chan struct{})
	}
}

func (b *budget) spent() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.used
}

func (b *budget) current() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.limit
}

// step runs fn with a context that ends when the stage's budget runs out, and charges the time
// fn took to the budget. It reports whether the budget ran out.
func (b *budget) step(ctx context.Context, fn func(ctx context.Context) error) (error, bool) {
	sctx, cancel := context.WithCancel(ctx)
	defer cancel()
	start := time.Now()
	var expired atomic.Bool
	done := make(chan struct{})
	watched := make(chan struct{})
	go func() {
		defer close(watched)
		for {
			b.mu.Lock()
			rem := b.limit - b.used - time.Since(start)
			changed := b.changed
			b.mu.Unlock()
			if rem <= 0 {
				expired.Store(true)
				cancel()
				return
			}
			t := time.NewTimer(rem)
			select {
			case <-done:
				t.Stop()
				return
			case <-changed:
				t.Stop()
			case <-t.C:
			}
		}
	}()
	err := fn(sctx)
	close(done)
	<-watched
	b.mu.Lock()
	b.used += time.Since(start)
	b.mu.Unlock()
	return err, expired.Load() && ctx.Err() == nil
}

// maxBanner bounds what is read while waiting for the SSH version line.
const maxBanner = 8 << 10

// bannerConn replays the bytes read while checking the banner, then reads the connection.
type bannerConn struct {
	net.Conn
	r io.Reader
}

func (c *bannerConn) Read(p []byte) (int, error) { return c.r.Read(p) }

// readBanner reads lines until the SSH version line (RFC 4253 §4.2 lets a server send other lines
// first) and returns a connection that replays them to the SSH client.
func readBanner(ctx context.Context, conn net.Conn) (net.Conn, string, error) {
	// A channel of the jump host's connection has no read deadline, so the end of ctx closes it.
	stop := context.AfterFunc(ctx, func() { conn.Close() })
	defer stop()
	var buf []byte
	start := 0
	one := make([]byte, 1)
	for len(buf) < maxBanner {
		n, err := conn.Read(one)
		if n == 0 {
			if ctx.Err() != nil {
				return nil, "", ctx.Err()
			}
			if err == nil {
				continue
			}
			return nil, "", fmt.Errorf("the connection closed before an SSH banner: %w", err)
		}
		buf = append(buf, one[0])
		if one[0] != '\n' {
			continue
		}
		line := strings.TrimRight(string(buf[start:]), "\r\n")
		start = len(buf)
		if !strings.HasPrefix(line, "SSH-") {
			continue
		}
		if !strings.HasPrefix(line, "SSH-2.0-") && !strings.HasPrefix(line, "SSH-1.99-") {
			return nil, "", fmt.Errorf("the server speaks %q, not SSH 2", clipText(line, 40))
		}
		if !stop() {
			return nil, "", ctx.Err()
		}
		return &bannerConn{Conn: conn, r: io.MultiReader(bytes.NewReader(buf), conn)}, line, nil
	}
	return nil, "", errors.New("no SSH banner in the first 8 KiB")
}

func clipText(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// dialHop opens the TCP connection of a hop and reads its banner: directly through the network
// scope for the first hop, or as a direct-tcpip channel of the jump host's connection for the
// target. It returns the address dialled when the connector knows it.
func (c *checker) dialHop(ctx context.Context, h hop, via *ssh.Client) (net.Conn, string, error) {
	var conn net.Conn
	var address string
	dest := endpointName(h.host, h.port)
	if via == nil {
		nc, err := c.t.Dialer.DialContext(ctx, h.host, h.port)
		if err != nil {
			return nil, "", reachFailure(err)
		}
		conn = nc
		if ta, ok := nc.RemoteAddr().(*net.TCPAddr); ok {
			if ap := ta.AddrPort(); ap.IsValid() {
				address = ap.Addr().Unmap().String()
			}
		}
	} else {
		// The onward hop is dialled by the jump host: the connector classifies it only when it is
		// an address literal (design §8, step 4).
		scope := c.t.Dialer.Scope
		if !scope.AllowsPort(h.port) {
			return nil, "", &target.Failure{Code: protocol.CodeNetworkScopeDenied, Detail: fmt.Sprintf("port %d is not in %s", h.port, netscope.EnvAllowPorts)}
		}
		if ok, why := scope.AllowsOnward(h.host); !ok {
			if a, err := netip.ParseAddr(h.host); err == nil {
				why = a.String() + " " + why
			}
			return nil, "", &target.Failure{Code: protocol.CodeNetworkScopeDenied, Detail: why}
		}
		if a, err := netip.ParseAddr(h.host); err == nil {
			address = a.Unmap().String()
		}
		nc, err := via.DialContext(ctx, "tcp", dest)
		if err != nil {
			var oe *ssh.OpenChannelError
			switch {
			case ctx.Err() != nil:
				return nil, "", ctx.Err()
			case errors.As(err, &oe) && oe.Reason == ssh.Prohibited:
				return nil, "", &target.Failure{Code: protocol.CodeConnectionRefused,
					Detail: fmt.Sprintf("the jump host refused to forward to %s (%s)", dest, sanitize(oe.Message))}
			case errors.As(err, &oe):
				return nil, "", &target.Failure{Code: protocol.CodeConnectionRefused,
					Detail: fmt.Sprintf("the jump host could not connect to %s (%s)", dest, sanitize(oe.Message))}
			}
			return nil, "", &target.Failure{Code: protocol.CodeConnectionRefused, Detail: fmt.Sprintf("the jump host could not connect to %s: %v", dest, err)}
		}
		conn = nc
	}
	bc, _, err := readBanner(ctx, conn)
	if err != nil {
		conn.Close()
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		return nil, "", &target.Failure{Code: protocol.CodeConnectionRefused, Detail: fmt.Sprintf("%s did not answer as an SSH server: %v", dest, err)}
	}
	return bc, address, nil
}

// reachFailure turns a netscope dial error into the reachability stage's failure.
func reachFailure(err error) error {
	var ne *netscope.Error
	if errors.As(err, &ne) {
		return &target.Failure{Code: ne.Code, Detail: ne.Detail}
	}
	return err
}

// handshake is x/crypto's client handshake (key exchange, then authentication) running in the
// background, so each part can be charged to its own stage.
type handshake struct {
	nc    net.Conn
	done  chan struct{}
	conn  ssh.Conn
	chans <-chan ssh.NewChannel
	reqs  <-chan *ssh.Request
	err   error
}

func startHandshake(nc net.Conn, addr string, cfg *ssh.ClientConfig) *handshake {
	hs := &handshake{nc: nc, done: make(chan struct{})}
	go func() {
		defer close(hs.done)
		hs.conn, hs.chans, hs.reqs, hs.err = ssh.NewClientConn(nc, addr, cfg)
	}()
	return hs
}

// abort closes the connection and waits for the handshake to end.
func (hs *handshake) abort() {
	hs.nc.Close()
	<-hs.done
	if hs.conn != nil {
		hs.conn.Close()
	}
}

// isHostKeyNegotiation reports whether a handshake failed because the host offers none of the
// key types recorded for it.
func isHostKeyNegotiation(err error) bool {
	var ne *ssh.AlgorithmNegotiationError
	return errors.As(err, &ne) && ne.What == "host key"
}
