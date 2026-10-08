// Package link is the connector's one outbound WebSocket to the server (docs/design/connector.md
// §4): the challenge/auth/auth_ok/hello handshake, the dispatcher by message type, the stream
// table with credit-based flow control, the heartbeat, and reconnecting with backoff according
// to the close codes of §4.6.
package link

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"parallax/connector/internal/identity"
	"parallax/connector/internal/pairing"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/redact"
	"parallax/connector/internal/safetext"
)

// Path is the link endpoint under the server origin.
const Path = "/api/connector/v1/link"

// DefaultLimits apply until auth_ok sets the link's limits (design §4.5).
var DefaultLimits = protocol.Limits{MaxStreams: 32, MaxPayload: 65536, InitialWindow: 262144, MaxControl: 65536, MaxSessions: 4}

const (
	dialTimeout      = 30 * time.Second
	handshakeTimeout = 10 // protocol seconds to answer each handshake step
	maxMissedAcks    = 3
)

// Event is a change of link state, for `run` to print and record.
type Event struct {
	State State
	// Message tells the person what is happening; empty for routine transitions.
	Message string
	// Retry is the wait before the next attempt, for Down and Pending.
	Retry time.Duration
}

// Handler serves the server's requests. Its methods run on the link's read loop, in arrival
// order, and must not block: long work belongs in a goroutine bound to ctx, which ends with the
// link.
type Handler interface {
	// Request receives test_connection and open_session (already checked with
	// protocol.ValidateRequest), close_session, presence, activity and error.
	Request(ctx context.Context, l *Link, m protocol.Message)
	// Stream receives http and ws_open with the stream the link accepted for it.
	Stream(ctx context.Context, l *Link, m protocol.Message, s *Stream)
}

// Watcher is implemented by a Handler that needs to know when a link is live: LinkUp runs once
// hello and the first heartbeat (seq 0) have been sent, before any request is read, and
// LinkDown runs when that link has ended. Neither may block for long.
type Watcher interface {
	LinkUp(ctx context.Context, l *Link)
	LinkDown(l *Link)
}

// Config is what one connector needs to keep its link.
type Config struct {
	// Origin is the normalised server origin from config.json; the connector signs this one,
	// never the origin a challenge names.
	Origin      string
	ConnectorID string
	Identity    *identity.Identity
	Hello       protocol.Hello
	// HTTPClient dials the WebSocket; nil uses a client that honours HTTPS_PROXY.
	HTTPClient *http.Client
	// Handler serves requests; nil refuses every request.
	Handler Handler
	// Sessions lists the held sessions for each heartbeat; nil reports none.
	Sessions func() []protocol.HeartbeatSession
	// OnEvent is told of every state change.
	OnEvent func(Event)
	Now     func() time.Time
	// Unit is the length of one protocol second (heartbeats, retries, backoff); tests shorten it.
	Unit time.Duration
	// Rand returns a uniformly random int64 in [0, n), for the backoff's jitter.
	Rand func(n int64) int64
}

// StopError ends Run: the server refused this connector in a way retrying cannot fix.
type StopError struct {
	State State
	Msg   string
}

func (e *StopError) Error() string { return e.Msg }

func (c *Config) defaults() {
	if c.HTTPClient == nil {
		c.HTTPClient = pairing.NewHTTPClient()
	}
	if c.Handler == nil {
		c.Handler = Refuse{}
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Unit <= 0 {
		c.Unit = time.Second
	}
	if c.Rand == nil {
		c.Rand = cryptoRand
	}
	if c.OnEvent == nil {
		c.OnEvent = func(Event) {}
	}
}

func cryptoRand(n int64) int64 {
	if n <= 0 {
		return 0
	}
	v, err := rand.Int(rand.Reader, big.NewInt(n))
	if err != nil {
		return n / 2
	}
	return v.Int64()
}

// URL returns the link's WebSocket address for a server origin. Plain http is accepted only for
// loopback hosts, as when pairing.
func URL(origin string) (string, error) {
	u, err := url.Parse(origin)
	if err != nil {
		return "", err
	}
	switch {
	case u.Scheme == "https":
	case u.Scheme == "http" && pairing.IsLoopbackHost(u.Hostname()):
	default:
		return "", fmt.Errorf("the server %s is not https; plain http is allowed only for this computer (localhost)", origin)
	}
	return origin + Path, nil
}

// Run keeps the link up until ctx ends (it then returns nil) or the server refuses the connector
// for good (it returns a *StopError).
func Run(ctx context.Context, cfg Config) error {
	cfg.defaults()
	u, err := URL(cfg.Origin)
	if err != nil {
		return &StopError{State: Rejected, Msg: err.Error()}
	}
	backoff := &Backoff{Base: backoffBase * cfg.Unit, Cap: backoffCap * cfg.Unit, Rand: cfg.Rand}
	for {
		cfg.OnEvent(Event{State: Connecting})
		out := runOnce(ctx, &cfg, u)
		if ctx.Err() != nil {
			return nil
		}
		if out.stop != nil {
			cfg.OnEvent(Event{State: out.stop.State, Message: out.stop.Msg})
			return out.stop
		}
		act := decide(out.code, out.reason, out.minVersion)
		if act.stop {
			cfg.OnEvent(Event{State: act.state, Message: act.msg})
			return &StopError{State: act.state, Msg: act.msg}
		}
		if out.up >= stableAfter*cfg.Unit || act.state == Pending {
			backoff.Reset()
		}
		wait := time.Duration(act.wait) * cfg.Unit
		if act.wait == 0 {
			wait = backoff.Next()
		}
		msg := act.msg
		if out.err != nil && out.code == -1 {
			msg = fmt.Sprintf("%s (%s)", msg, redact.Redact(out.err.Error()))
		}
		cfg.OnEvent(Event{State: act.state, Message: msg, Retry: wait})
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return nil
		case <-t.C:
		}
	}
}

// outcome is how one link attempt ended.
type outcome struct {
	code       int // close code, -1 without one
	reason     string
	err        error
	stop       *StopError
	up         time.Duration // how long the link was up (0 if it never was)
	minVersion string
}

// closeCause is a close the connector itself decided on.
type closeCause struct {
	code   int
	reason string
	err    error
}

func (c *closeCause) Error() string { return fmt.Sprintf("%s: %v", c.reason, c.err) }

// Link is one authenticated link. Handlers use it to answer requests.
type Link struct {
	cfg        *Config
	conn       *websocket.Conn
	limits     protocol.Limits
	minVersion string
	hbSeconds  int
	ctx        context.Context
	cancel     context.CancelCauseFunc

	mu      sync.Mutex
	streams map[uint32]*Stream
	used    map[uint32]bool

	sentSeq  atomic.Int64
	ackedSeq atomic.Int64
	upAt     atomic.Int64 // unix nanoseconds of the first heartbeat_ack, 0 before
}

// Limits returns the limits auth_ok set.
func (l *Link) Limits() protocol.Limits { return l.limits }

// Send encodes and sends one control message.
func (l *Link) Send(ctx context.Context, m protocol.Message) error {
	data, err := protocol.Encode(m)
	if err != nil {
		return err
	}
	if len(data) > l.limits.MaxControl {
		return fmt.Errorf("%s message of %d bytes exceeds maxControl", m.Type(), len(data))
	}
	wctx, cancel := context.WithTimeout(ctx, l.writeTimeout())
	defer cancel()
	return l.conn.Write(wctx, websocket.MessageText, data)
}

func (l *Link) sendFrame(ctx context.Context, f protocol.Frame) error {
	data, err := protocol.EncodeFrame(f, l.limits.MaxPayload)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, l.writeTimeout())
	defer cancel()
	return l.conn.Write(wctx, websocket.MessageBinary, data)
}

func (l *Link) writeTimeout() time.Duration {
	return time.Duration(maxMissedAcks*15) * l.cfg.Unit
}

func (l *Link) removeStream(id uint32) {
	l.mu.Lock()
	delete(l.streams, id)
	l.mu.Unlock()
}

func (l *Link) stream(id uint32) *Stream {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.streams[id]
}

// fail ends the link with a close the connector decided on.
func (l *Link) fail(code int, reason string, err error) {
	l.cancel(&closeCause{code: code, reason: reason, err: err})
}

func runOnce(ctx context.Context, cfg *Config, u string) outcome {
	dctx, cancel := context.WithTimeout(ctx, dialTimeout)
	conn, resp, err := websocket.Dial(dctx, u, &websocket.DialOptions{
		HTTPClient:   cfg.HTTPClient,
		Subprotocols: []string{protocol.Subprotocol},
	})
	cancel()
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusTooManyRequests {
			return outcome{code: CloseRateLimited, err: err}
		}
		return outcome{code: -1, err: err}
	}
	defer conn.CloseNow()
	if conn.Subprotocol() != protocol.Subprotocol {
		conn.Close(CloseProtocolError, "protocol_error")
		return outcome{code: -1, err: errors.New("the server does not speak " + protocol.Subprotocol)}
	}
	l := &Link{cfg: cfg, conn: conn, limits: DefaultLimits, streams: map[uint32]*Stream{}, used: map[uint32]bool{}}
	conn.SetReadLimit(int64(DefaultLimits.MaxControl))

	cfg.OnEvent(Event{State: Authenticating})
	if out, ok := l.handshake(ctx); !ok {
		return out
	}

	lctx, lcancel := context.WithCancelCause(ctx)
	defer lcancel(nil)
	l.ctx, l.cancel = lctx, lcancel
	l.sentSeq.Store(-1)
	l.ackedSeq.Store(-1)
	if err := l.Send(lctx, &cfg.Hello); err != nil {
		return l.ended(ctx, err)
	}
	if err := l.heartbeat(lctx); err != nil {
		return l.ended(ctx, err)
	}
	if w, ok := cfg.Handler.(Watcher); ok {
		w.LinkUp(lctx, l)
		defer w.LinkDown(l)
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); l.readLoop(lctx) }()
	go func() { defer wg.Done(); l.heartbeatLoop(lctx) }()
	<-lctx.Done()
	out := l.ended(ctx, context.Cause(lctx))
	wg.Wait()
	return out
}

// handshake runs challenge → auth → auth_ok. It returns ok false with the outcome when the link
// did not come up.
func (l *Link) handshake(ctx context.Context) (outcome, bool) {
	cfg := l.cfg
	m, err := l.readHandshake(ctx)
	if err != nil {
		return l.handshakeFailed(err), false
	}
	ch, ok := m.(*protocol.Challenge)
	if !ok {
		return l.handshakeFailed(&closeCause{CloseProtocolError, "protocol_error", fmt.Errorf("expected challenge, got %s", m.Type())}), false
	}
	if ch.Origin != cfg.Origin {
		l.conn.Close(CloseNormal, "origin mismatch")
		return outcome{stop: &StopError{State: Rejected, Msg: fmt.Sprintf(
			"This connector was paired with %s, but the server it reached calls itself %s. "+
				"Check the address, or pair again with the right --server", cfg.Origin, ch.Origin)}}, false
	}
	nonce, err := base64.RawURLEncoding.DecodeString(ch.Nonce)
	if err != nil {
		return l.handshakeFailed(&closeCause{CloseProtocolError, "protocol_error", err}), false
	}
	ts := cfg.Now().Unix()
	sig, err := cfg.Identity.SignLink(nonce, cfg.ConnectorID, ts, cfg.Origin)
	if err != nil {
		return l.handshakeFailed(&closeCause{CloseProtocolError, "protocol_error", err}), false
	}
	if err := l.Send(ctx, &protocol.Auth{ConnectorID: cfg.ConnectorID, TS: ts, Sig: sig}); err != nil {
		return l.handshakeFailed(err), false
	}
	m, err = l.readHandshake(ctx)
	if err != nil {
		return l.handshakeFailed(err), false
	}
	ok2, isOK := m.(*protocol.AuthOK)
	if !isOK {
		return l.handshakeFailed(&closeCause{CloseProtocolError, "protocol_error", fmt.Errorf("expected auth_ok, got %s", m.Type())}), false
	}
	l.limits, l.minVersion, l.hbSeconds = ok2.Limits, ok2.MinVersion, ok2.HeartbeatSeconds
	l.conn.SetReadLimit(int64(max(l.limits.MaxControl, l.limits.MaxPayload+protocol.FrameHeaderSize)))
	return outcome{}, true
}

func (l *Link) readHandshake(ctx context.Context) (protocol.Message, error) {
	rctx, cancel := context.WithTimeout(ctx, handshakeTimeout*l.cfg.Unit)
	defer cancel()
	typ, data, err := l.conn.Read(rctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageText || len(data) > l.limits.MaxControl {
		return nil, &closeCause{CloseProtocolError, "protocol_error", errors.New("expected a control message")}
	}
	m, err := protocol.Decode(data)
	if err == nil {
		if dir, _ := protocol.Sender(m.Type()); dir&protocol.FromServer == 0 {
			err = fmt.Errorf("the server sent %s", m.Type())
		}
	}
	if err != nil {
		return nil, &closeCause{CloseProtocolError, "protocol_error", err}
	}
	return m, nil
}

func (l *Link) handshakeFailed(err error) outcome {
	var cc *closeCause
	if errors.As(err, &cc) {
		l.conn.Close(websocket.StatusCode(cc.code), cc.reason)
		return outcome{code: cc.code, reason: cc.reason, err: cc.err, minVersion: l.minVersion}
	}
	return closeOutcome(err, l.minVersion)
}

// closeOutcome reads the close code and reason the server sent, if any.
func closeOutcome(err error, minVersion string) outcome {
	var ce websocket.CloseError
	if errors.As(err, &ce) {
		return outcome{code: int(ce.Code), reason: ce.Reason, err: err, minVersion: minVersion}
	}
	return outcome{code: -1, err: err, minVersion: minVersion}
}

// ended closes the link if the connector decided to, and reports how long it was up.
func (l *Link) ended(ctx context.Context, cause error) outcome {
	var out outcome
	var cc *closeCause
	switch {
	case ctx.Err() != nil:
		l.conn.Close(CloseGoingAway, "connector stopping")
		out = outcome{code: CloseGoingAway, err: ctx.Err()}
	case errors.As(cause, &cc):
		l.conn.Close(websocket.StatusCode(cc.code), cc.reason)
		out = outcome{code: cc.code, reason: cc.reason, err: cc.err}
	default:
		out = closeOutcome(cause, l.minVersion)
	}
	out.minVersion = l.minVersion
	if at := l.upAt.Load(); at != 0 {
		out.up = l.cfg.Now().Sub(time.Unix(0, at))
	}
	l.mu.Lock()
	streams := l.streams
	l.streams = map[uint32]*Stream{}
	l.mu.Unlock()
	for _, s := range streams {
		s.mu.Lock()
		if s.err == nil {
			s.err = ErrStreamClosed
			s.wake()
		}
		s.mu.Unlock()
	}
	return out
}

// heartbeat sends the next heartbeat. The first (seq 0) follows hello at once.
func (l *Link) heartbeat(ctx context.Context) error {
	sessions := []protocol.HeartbeatSession{}
	if l.cfg.Sessions != nil {
		if s := l.cfg.Sessions(); s != nil {
			sessions = s
		}
	}
	// Counted before sending, so an acknowledgement that overtakes the write is not refused.
	seq := l.sentSeq.Add(1)
	return l.Send(ctx, &protocol.Heartbeat{Seq: seq, TS: l.cfg.Now().Unix(), Sessions: sessions})
}

// heartbeatLoop sends a heartbeat every heartbeatSeconds and ends the link when three in a row
// went unacknowledged.
func (l *Link) heartbeatLoop(ctx context.Context) {
	t := time.NewTicker(time.Duration(l.hbSeconds) * l.cfg.Unit)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
		if l.sentSeq.Load()-l.ackedSeq.Load() >= maxMissedAcks {
			l.fail(CloseHeartbeatTimeout, "heartbeat_timeout", errors.New("three heartbeats went unacknowledged"))
			return
		}
		if err := l.heartbeat(ctx); err != nil {
			l.cancel(err)
			return
		}
	}
}

// readLoop reads and dispatches every message until the link ends.
func (l *Link) readLoop(ctx context.Context) {
	// Cancelling a Read's context drops the connection without a close frame, so reads do not
	// end with the link's context; closing the connection ends them instead.
	rctx := context.WithoutCancel(ctx)
	for {
		typ, data, err := l.conn.Read(rctx)
		if err != nil {
			l.cancel(err)
			return
		}
		if typ == websocket.MessageBinary {
			l.onFrame(ctx, data)
		} else {
			l.onText(ctx, data)
		}
		if ctx.Err() != nil {
			return
		}
	}
}

func (l *Link) onText(ctx context.Context, data []byte) {
	if len(data) > l.limits.MaxControl {
		l.fail(CloseProtocolError, "protocol_error", fmt.Errorf("control message of %d bytes exceeds maxControl", len(data)))
		return
	}
	m, err := protocol.Decode(data)
	var unknown *protocol.UnknownTypeError
	switch {
	case errors.As(err, &unknown):
		l.reply(ctx, &protocol.Error{Code: protocol.CodeUnsupportedMessage, Detail: "unknown message type " + clip(unknown.T)})
		return
	case err != nil:
		l.fail(CloseProtocolError, "protocol_error", err)
		return
	}
	if dir, _ := protocol.Sender(m.Type()); dir&protocol.FromServer == 0 {
		l.reply(ctx, &protocol.Error{Code: protocol.CodeUnsupportedMessage, Detail: "the connector does not accept " + m.Type()})
		return
	}
	switch m := m.(type) {
	case *protocol.Challenge, *protocol.AuthOK:
		l.fail(CloseProtocolError, "protocol_error", fmt.Errorf("%s after the handshake", m.Type()))
	case *protocol.HeartbeatAck:
		if m.Seq > l.sentSeq.Load() {
			l.fail(CloseProtocolError, "protocol_error", fmt.Errorf("heartbeat_ack for seq %d that was never sent", m.Seq))
			return
		}
		if m.Seq > l.ackedSeq.Load() {
			l.ackedSeq.Store(m.Seq)
		}
		if l.upAt.Load() == 0 {
			l.upAt.Store(l.cfg.Now().UnixNano())
			l.cfg.OnEvent(Event{State: Up})
		}
	case *protocol.Window:
		if s := l.stream(m.StreamID); s != nil && !s.credit(m.Credit) {
			s.Reset(ctx, protocol.CodeLimitExceeded, "window credit overflow")
		}
	case *protocol.StreamReset:
		if s := l.stream(m.StreamID); s != nil {
			s.remoteReset(m)
		}
	case *protocol.WSClose:
		if s := l.stream(m.StreamID); s != nil {
			s.remoteClose(m)
		}
	case *protocol.HTTP:
		l.openStream(ctx, m, m.StreamID, m.SessionID)
	case *protocol.WSOpen:
		l.openStream(ctx, m, m.StreamID, m.SessionID)
	case *protocol.TestConnection, *protocol.OpenSession:
		if err := protocol.ValidateRequest(m); err != nil {
			e := &protocol.Error{Code: protocol.CodeInvalidTarget, Detail: clip(err.Error())}
			switch m := m.(type) {
			case *protocol.TestConnection:
				e.RequestID = m.RequestID
			case *protocol.OpenSession:
				e.RequestID, e.SessionID = m.RequestID, m.SessionID
			}
			l.reply(ctx, e)
			return
		}
		l.cfg.Handler.Request(ctx, l, m)
	default:
		l.cfg.Handler.Request(ctx, l, m)
	}
}

// openStream accepts a stream the server opened with http or ws_open.
func (l *Link) openStream(ctx context.Context, m protocol.Message, id uint32, sessionID string) {
	l.mu.Lock()
	var code protocol.Code
	var detail string
	switch {
	case l.used[id]:
		code, detail = protocol.CodeInvalidMessage, "stream id reused"
	case len(l.streams) >= l.limits.MaxStreams:
		code, detail = protocol.CodeLimitExceeded, "too many concurrent streams"
	}
	l.used[id] = true
	var s *Stream
	if code == "" {
		s = newStream(l, id, sessionID, int64(l.limits.InitialWindow))
		l.streams[id] = s
	}
	l.mu.Unlock()
	if code != "" {
		l.reply(ctx, &protocol.StreamReset{StreamID: id, Code: code, Detail: detail})
		return
	}
	l.cfg.Handler.Stream(ctx, l, m, s)
}

func (l *Link) onFrame(ctx context.Context, data []byte) {
	f, err := protocol.DecodeFrame(data, l.limits.MaxPayload)
	if err != nil {
		l.fail(CloseProtocolError, "protocol_error", err)
		return
	}
	s := l.stream(f.StreamID)
	if s == nil {
		l.mu.Lock()
		used := l.used[f.StreamID]
		l.mu.Unlock()
		if !used {
			l.reply(ctx, &protocol.StreamReset{StreamID: f.StreamID, Code: protocol.CodeUnknownStream})
		}
		return // late frames of a stream that already ended are dropped
	}
	if !s.deliver(f) {
		s.Reset(ctx, protocol.CodeLimitExceeded, "data beyond the granted window")
	}
}

// reply sends an answer from the read loop; a failure to write ends the link.
func (l *Link) reply(ctx context.Context, m protocol.Message) {
	if err := l.Send(ctx, m); err != nil {
		l.cancel(err)
	}
}

// clip keeps a detail of a refusal short.
func clip(s string) string { return safetext.Clip(s, 200) }

// Refuse is the handler until sessions exist (P3-04): every request is answered with an error,
// never left unanswered.
type Refuse struct{}

// Request answers test_connection and open_session with unsupported_target, and session
// messages with unknown_session.
func (Refuse) Request(ctx context.Context, l *Link, m protocol.Message) {
	var e *protocol.Error
	switch m := m.(type) {
	case *protocol.TestConnection:
		e = &protocol.Error{RequestID: m.RequestID, Code: protocol.CodeUnsupportedTarget, Detail: "this connector version cannot open " + m.Target.Kind + " targets"}
	case *protocol.OpenSession:
		e = &protocol.Error{RequestID: m.RequestID, SessionID: m.SessionID, Code: protocol.CodeUnsupportedTarget, Detail: "this connector version cannot open " + m.Target.Kind + " targets"}
	case *protocol.CloseSession:
		e = &protocol.Error{RequestID: m.RequestID, SessionID: m.SessionID, Code: protocol.CodeUnknownSession}
	case *protocol.Presence:
		e = &protocol.Error{SessionID: m.SessionID, Code: protocol.CodeUnknownSession}
	case *protocol.Activity:
		e = &protocol.Error{SessionID: m.SessionID, Code: protocol.CodeUnknownSession}
	default:
		return // an error from the server needs no answer
	}
	l.reply(ctx, e)
}

// Stream resets every stream: no session exists to serve it.
func (Refuse) Stream(ctx context.Context, l *Link, m protocol.Message, s *Stream) {
	if err := s.Reset(ctx, protocol.CodeUnknownSession, ""); err != nil {
		l.cancel(err)
	}
}
