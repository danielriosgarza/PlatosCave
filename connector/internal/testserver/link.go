package testserver

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"parallax/connector/internal/identity"
	"parallax/connector/internal/protocol"
)

// LinkPath is the link endpoint (design §4.1).
const LinkPath = "/api/connector/v1/link"

// LinkOptions script the server side of the link. Set them before the first link.
type LinkOptions struct {
	// Origin is sent in the challenge (default: the server's own Origin).
	Origin string
	// HeartbeatSeconds and Limits are sent in auth_ok (default 5 and the design's limits).
	HeartbeatSeconds int
	Limits           protocol.Limits
	MinVersion       string
	// Refuse, when set, is asked after a valid signature; a non-zero code closes the link with
	// that code and reason instead of accepting it. attempt counts links from 1.
	Refuse func(attempt int) (code int, reason string)
	// Ack decides whether a heartbeat is acknowledged (default: all are).
	Ack func(l *Link, seq int64) bool
}

// Received is one message or frame the connector sent after hello, other than heartbeats.
type Received struct {
	Message protocol.Message
	Frame   *protocol.Frame
}

// Link is the server's side of one accepted link.
type Link struct {
	ConnectorID string
	Hello       *protocol.Hello
	Limits      protocol.Limits

	conn     *websocket.Conn
	received chan Received
	done     chan struct{}

	mu         sync.Mutex
	heartbeats []*protocol.Heartbeat
	closeErr   error
}

// linkState is the part of Server that serves links.
type linkState struct {
	LinkOptions LinkOptions

	linkMu   sync.Mutex
	attempts []time.Time
	links    chan *Link
}

// LinkAttempts returns the time of every link attempt (each WebSocket upgrade), in order.
func (s *Server) LinkAttempts() []time.Time {
	s.linkMu.Lock()
	defer s.linkMu.Unlock()
	return append([]time.Time(nil), s.attempts...)
}

// NextLink waits for the next link that completes hello.
func (s *Server) NextLink(ctx context.Context) (*Link, error) {
	select {
	case l := <-s.linkChan():
		return l, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (s *Server) linkChan() chan *Link {
	s.linkMu.Lock()
	defer s.linkMu.Unlock()
	if s.links == nil {
		s.links = make(chan *Link, 64)
	}
	return s.links
}

func (s *Server) link(w http.ResponseWriter, r *http.Request) {
	s.linkMu.Lock()
	s.attempts = append(s.attempts, time.Now())
	attempt := len(s.attempts)
	s.linkMu.Unlock()
	opts := s.LinkOptions

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{protocol.Subprotocol}})
	if err != nil {
		return
	}
	defer conn.CloseNow()
	if conn.Subprotocol() != protocol.Subprotocol {
		conn.Close(4400, "protocol_error")
		return
	}
	ctx := r.Context()
	origin := opts.Origin
	if origin == "" {
		origin = s.Origin
	}
	var nonce [32]byte
	rand.Read(nonce[:])
	if err := send(ctx, conn, &protocol.Challenge{Nonce: base64.RawURLEncoding.EncodeToString(nonce[:]), Origin: origin, TS: s.now().Unix()}); err != nil {
		return
	}
	m, err := readMessage(ctx, conn, 10*time.Second)
	auth, ok := m.(*protocol.Auth)
	if err != nil || !ok {
		conn.Close(4400, "protocol_error")
		return
	}
	if code, reason := s.verifyLink(auth, nonce[:]); code != 0 {
		conn.Close(websocket.StatusCode(code), reason)
		return
	}
	if opts.Refuse != nil {
		if code, reason := opts.Refuse(attempt); code != 0 {
			conn.Close(websocket.StatusCode(code), reason)
			return
		}
	}
	limits := opts.Limits
	if limits == (protocol.Limits{}) {
		limits = protocol.Limits{MaxStreams: 32, MaxPayload: 65536, InitialWindow: 262144, MaxControl: 65536, MaxSessions: 4}
	}
	hb := opts.HeartbeatSeconds
	if hb == 0 {
		hb = 5
	}
	if err := send(ctx, conn, &protocol.AuthOK{HeartbeatSeconds: hb, Limits: limits, MinVersion: opts.MinVersion}); err != nil {
		return
	}
	conn.SetReadLimit(int64(max(limits.MaxControl, limits.MaxPayload+protocol.FrameHeaderSize)))
	m, err = readMessage(ctx, conn, 10*time.Second)
	hello, ok := m.(*protocol.Hello)
	if err != nil || !ok {
		conn.Close(4400, "protocol_error")
		return
	}
	l := &Link{ConnectorID: auth.ConnectorID, Hello: hello, Limits: limits, conn: conn,
		received: make(chan Received, 1024), done: make(chan struct{})}
	s.linkChan() <- l
	l.serve(ctx, opts)
}

// verifyLink checks an auth answer as the relay does (design §4.2): the connector is known and
// active, ts is inside the window and the signature over this challenge and the server's own
// origin verifies. It returns the close code and reason of a refusal, or 0.
func (s *Server) verifyLink(auth *protocol.Auth, nonce []byte) (int, string) {
	s.mu.Lock()
	c, known := s.connectors[auth.ConnectorID]
	var conn Connector
	if known {
		conn = *c
	}
	s.mu.Unlock()
	skew := s.now().Sub(time.Unix(auth.TS, 0))
	if skew > SignatureWindow || skew < -SignatureWindow {
		return 4401, "clock_skew"
	}
	msg, err := identity.LinkMessage(nonce, auth.ConnectorID, auth.TS, s.Origin)
	if err != nil || !known || !identity.Verify(conn.PublicKey, msg, auth.Sig) {
		return 4401, "bad_signature"
	}
	switch conn.Status {
	case StatusActive:
		return 0, ""
	case StatusPending:
		return 4403, "pending"
	}
	return 4403, "revoked"
}

func (l *Link) serve(ctx context.Context, opts LinkOptions) {
	defer close(l.done)
	defer close(l.received)
	for {
		typ, data, err := l.conn.Read(ctx)
		if err != nil {
			l.mu.Lock()
			l.closeErr = err
			l.mu.Unlock()
			return
		}
		if typ == websocket.MessageBinary {
			f, err := protocol.DecodeFrame(data, l.Limits.MaxPayload)
			if err != nil {
				l.conn.Close(4400, "protocol_error")
				continue
			}
			f.Payload = append([]byte(nil), f.Payload...)
			l.received <- Received{Frame: &f}
			continue
		}
		m, err := protocol.Decode(data)
		if err == nil {
			if dir, _ := protocol.Sender(m.Type()); dir&protocol.FromConnector == 0 {
				err = fmt.Errorf("the connector sent %s", m.Type())
			}
		}
		if err != nil {
			l.conn.Close(4400, "protocol_error")
			continue
		}
		if hb, ok := m.(*protocol.Heartbeat); ok {
			l.mu.Lock()
			l.heartbeats = append(l.heartbeats, hb)
			l.mu.Unlock()
			if opts.Ack == nil || opts.Ack(l, hb.Seq) {
				if err := l.Send(&protocol.HeartbeatAck{Seq: hb.Seq}); err != nil {
					return
				}
			}
			continue
		}
		l.received <- Received{Message: m}
	}
}

// Send sends a control message to the connector.
func (l *Link) Send(m protocol.Message) error {
	return send(context.Background(), l.conn, m)
}

// SendText sends raw text, valid or not.
func (l *Link) SendText(text string) error {
	return l.conn.Write(context.Background(), websocket.MessageText, []byte(text))
}

// SendFrame sends a binary frame.
func (l *Link) SendFrame(f protocol.Frame) error {
	data, err := protocol.EncodeFrame(f, l.Limits.MaxPayload)
	if err != nil {
		return err
	}
	return l.conn.Write(context.Background(), websocket.MessageBinary, data)
}

// Next returns the next message or frame from the connector, other than heartbeats.
func (l *Link) Next(ctx context.Context) (Received, error) {
	select {
	case r, ok := <-l.received:
		if !ok {
			return Received{}, errors.New("link closed")
		}
		return r, nil
	case <-ctx.Done():
		return Received{}, ctx.Err()
	}
}

// Heartbeats returns the heartbeats received so far.
func (l *Link) Heartbeats() []*protocol.Heartbeat {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]*protocol.Heartbeat(nil), l.heartbeats...)
}

// Close closes the link with a code and reason.
func (l *Link) Close(code int, reason string) {
	l.conn.Close(websocket.StatusCode(code), reason)
}

// Done is closed when the link has ended.
func (l *Link) Done() <-chan struct{} { return l.done }

// CloseStatus returns the close code the connector sent, or -1.
func (l *Link) CloseStatus() int {
	l.mu.Lock()
	defer l.mu.Unlock()
	return int(websocket.CloseStatus(l.closeErr))
}

func send(ctx context.Context, conn *websocket.Conn, m protocol.Message) error {
	data, err := protocol.Encode(m)
	if err != nil {
		return err
	}
	return conn.Write(ctx, websocket.MessageText, data)
}

func readMessage(ctx context.Context, conn *websocket.Conn, d time.Duration) (protocol.Message, error) {
	rctx, cancel := context.WithTimeout(ctx, d)
	defer cancel()
	typ, data, err := conn.Read(rctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageText {
		return nil, errors.New("expected a control message")
	}
	return protocol.Decode(data)
}

// AddConnector registers a device with a public key and status, as if it had paired, and
// returns its id.
func (s *Server) AddConnector(pub []byte, status string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := &Connector{ID: newUUID(), Name: "test", OS: "linux", Arch: "amd64", Version: "0.0.0-dev",
		Fingerprint: identity.Fingerprint(pub), PublicKey: pub, Status: status, ApproveBy: s.now().Add(ApprovalWindow)}
	s.connectors[c.ID] = c
	return c.ID
}
