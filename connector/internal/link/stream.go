package link

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"parallax/connector/internal/protocol"
)

// ErrStreamClosed is returned by a stream that was reset, closed or lost with its link.
var ErrStreamClosed = errors.New("stream closed")

// ResetError is a stream the server reset.
type ResetError struct {
	Code   protocol.Code
	Detail string
}

func (e *ResetError) Error() string { return fmt.Sprintf("stream reset by the server: %s", e.Code) }

// maxCredit bounds the credit one window message may carry (link.schema.json).
const maxCredit = 16777216

// Stream is one server-allocated stream (design §4.5). The server opens it with `http` or
// `ws_open`; data flows as frames under credit-based flow control in both directions.
type Stream struct {
	ID        uint32
	SessionID string

	l      *Link
	mu     sync.Mutex
	notify chan struct{} // closed and replaced whenever the state below changes

	sendCredit int64 // bytes we may still send
	recvWindow int64 // bytes the server may still send
	queue      []protocol.Frame
	err        error
}

func newStream(l *Link, id uint32, sessionID string, window int64) *Stream {
	return &Stream{ID: id, SessionID: sessionID, l: l, notify: make(chan struct{}), sendCredit: window, recvWindow: window}
}

// wake tells waiters the state changed. Call with s.mu held.
func (s *Stream) wake() {
	close(s.notify)
	s.notify = make(chan struct{})
}

// Send sends a control message that belongs to this stream (http_head, ws_opened, ws_close).
func (s *Stream) Send(ctx context.Context, m protocol.Message) error {
	return s.l.Send(ctx, m)
}

// Write sends p as frames of at most maxPayload bytes, waiting for credit as needed. flags is
// set on every frame except FlagEnd, which only the last frame carries. An empty p with FlagEnd
// sends one empty END frame.
func (s *Stream) Write(ctx context.Context, p []byte, flags byte) error {
	maxPayload := s.l.limits.MaxPayload
	for first := true; first || len(p) > 0; first = false {
		n, err := s.reserve(ctx, len(p), maxPayload)
		if err != nil {
			return err
		}
		f := protocol.Frame{StreamID: s.ID, Flags: flags &^ protocol.FlagEnd, Payload: p[:n]}
		if n == len(p) {
			f.Flags = flags
		}
		if err := s.l.sendFrame(ctx, f); err != nil {
			return err
		}
		p = p[n:]
	}
	return nil
}

// reserve waits until some credit is available and takes up to want bytes of it (capped at
// maxPayload). A zero-length want reserves nothing and does not wait.
func (s *Stream) reserve(ctx context.Context, want, maxPayload int) (int, error) {
	for {
		s.mu.Lock()
		if s.err != nil {
			err := s.err
			s.mu.Unlock()
			return 0, err
		}
		if want == 0 {
			s.mu.Unlock()
			return 0, nil
		}
		if s.sendCredit > 0 {
			n := int64(min(want, maxPayload))
			n = min(n, s.sendCredit)
			s.sendCredit -= n
			s.mu.Unlock()
			return int(n), nil
		}
		ch := s.notify
		s.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return 0, ctx.Err()
		}
	}
}

// Recv returns the next data frame. After the server closes a WebSocket stream it returns a
// *WSCloseError; after a reset, a *ResetError.
func (s *Stream) Recv(ctx context.Context) (protocol.Frame, error) {
	for {
		s.mu.Lock()
		if len(s.queue) > 0 {
			f := s.queue[0]
			s.queue = s.queue[1:]
			s.mu.Unlock()
			return f, nil
		}
		if s.err != nil {
			err := s.err
			s.mu.Unlock()
			return protocol.Frame{}, err
		}
		ch := s.notify
		s.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return protocol.Frame{}, ctx.Err()
		}
	}
}

// Grant gives the server n more bytes of window, once data has been handed on.
func (s *Stream) Grant(ctx context.Context, n int) error {
	for n > 0 {
		c := min(n, maxCredit)
		s.mu.Lock()
		if s.err != nil {
			s.mu.Unlock()
			return s.err
		}
		s.recvWindow += int64(c)
		s.mu.Unlock()
		if err := s.l.Send(ctx, &protocol.Window{StreamID: s.ID, Credit: int64(c)}); err != nil {
			return err
		}
		n -= c
	}
	return nil
}

// Reset aborts the stream with a catalogue code and tells the server.
func (s *Stream) Reset(ctx context.Context, code protocol.Code, detail string) error {
	s.finish(ErrStreamClosed)
	return s.l.Send(ctx, &protocol.StreamReset{StreamID: s.ID, Code: code, Detail: detail})
}

// Close forgets the stream locally once its exchange is complete (END sent and received, or
// ws_close exchanged).
func (s *Stream) Close() { s.finish(ErrStreamClosed) }

// finish ends the stream with err and removes it from the link's table.
func (s *Stream) finish(err error) {
	s.mu.Lock()
	if s.err == nil {
		s.err = err
		s.wake()
	}
	s.mu.Unlock()
	s.l.removeStream(s.ID)
}

// deliver queues a frame from the server. It returns false when the frame exceeds the window
// the connector granted.
func (s *Stream) deliver(f protocol.Frame) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return true // late frame for a stream ending locally; dropped
	}
	n := int64(len(f.Payload))
	if n > s.recvWindow {
		return false
	}
	s.recvWindow -= n
	f.Payload = append([]byte(nil), f.Payload...)
	s.queue = append(s.queue, f)
	s.wake()
	return true
}

// credit adds send credit from a window message. It returns false when the total would exceed
// what a sender can sensibly hold (a misbehaving peer).
func (s *Stream) credit(n int64) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sendCredit+n > 1<<31 {
		return false
	}
	s.sendCredit += n
	s.wake()
	return true
}

// remoteClose records a ws_close from the server; frames already queued are still returned.
func (s *Stream) remoteClose(m *protocol.WSClose) {
	s.mu.Lock()
	if s.err == nil {
		s.err = &WSCloseError{Code: m.Code, Reason: m.Reason}
		s.wake()
	}
	s.mu.Unlock()
	s.l.removeStream(s.ID)
}

func (s *Stream) remoteReset(m *protocol.StreamReset) {
	s.mu.Lock()
	if s.err == nil {
		s.err = &ResetError{Code: m.Code, Detail: m.Detail}
		s.wake()
	}
	s.mu.Unlock()
	s.l.removeStream(s.ID)
}

// WSCloseError is a WebSocket stream the server closed.
type WSCloseError struct {
	Code   int
	Reason string
}

func (e *WSCloseError) Error() string {
	return fmt.Sprintf("websocket stream closed by the server (%d)", e.Code)
}
