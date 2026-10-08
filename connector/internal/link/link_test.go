package link

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"parallax/connector/internal/identity"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/testserver"
)

const unit = 10 * time.Millisecond

// harness runs one connector's link against the test server.
type harness struct {
	t   *testing.T
	srv *testserver.Server
	id  *identity.Identity
	cfg Config

	mu     sync.Mutex
	events []Event
	done   chan error
	cancel context.CancelFunc
}

func newHarness(t *testing.T, status string) *harness {
	t.Helper()
	srv := testserver.New()
	t.Cleanup(srv.Close)
	id, err := identity.Generate()
	if err != nil {
		t.Fatal(err)
	}
	connectorID := srv.AddConnector(id.PublicKey(), status)
	// Heartbeats every 30 protocol seconds keep slow test machines from missing acknowledgements;
	// TestHeartbeatMissCloses shortens them.
	srv.LinkOptions.HeartbeatSeconds = 30
	h := &harness{t: t, srv: srv, id: id}
	h.cfg = Config{
		Origin:      srv.Origin,
		ConnectorID: connectorID,
		Identity:    id,
		Hello: protocol.Hello{Version: "0.0.0-dev", OS: "linux", Arch: "amd64", Mode: "personal",
			Targets: []string{"local", "ssh"}, NetworkScope: protocol.NetworkScope{CIDRs: []string{}, Hosts: []string{}}},
		HTTPClient: srv.Client(),
		Unit:       unit,
		OnEvent: func(e Event) {
			h.mu.Lock()
			h.events = append(h.events, e)
			h.mu.Unlock()
		},
	}
	return h
}

func (h *harness) start() {
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	h.done = make(chan error, 1)
	cfg := h.cfg
	go func() { h.done <- Run(ctx, cfg) }()
	h.t.Cleanup(func() {
		cancel()
		select {
		case <-h.done:
		case <-time.After(10 * time.Second):
			h.t.Error("Run did not return after cancel")
		}
	})
}

// wait returns Run's result.
func (h *harness) wait(d time.Duration) error {
	h.t.Helper()
	select {
	case err := <-h.done:
		h.done <- err
		return err
	case <-time.After(d):
		h.t.Fatal("Run is still running")
		return nil
	}
}

func (h *harness) nextLink() *testserver.Link {
	h.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	l, err := h.srv.NextLink(ctx)
	if err != nil {
		h.t.Fatalf("no link: %v", err)
	}
	return l
}

func (h *harness) states() []State {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []State
	for _, e := range h.events {
		out = append(out, e.State)
	}
	return out
}

func (h *harness) eventsOf(s State) []Event {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []Event
	for _, e := range h.events {
		if e.State == s {
			out = append(out, e)
		}
	}
	return out
}

// eventually polls cond until it holds.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func next(t *testing.T, l *testserver.Link) testserver.Received {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	r, err := l.Next(ctx)
	if err != nil {
		t.Fatalf("waiting for the connector: %v", err)
	}
	return r
}

func nextMessage[T protocol.Message](t *testing.T, l *testserver.Link) T {
	t.Helper()
	r := next(t, l)
	m, ok := r.Message.(T)
	if !ok {
		t.Fatalf("got %+v, want %T", r, *new(T))
	}
	return m
}

func TestLinkAuthHandshake(t *testing.T) {
	h := newHarness(t, testserver.StatusActive)
	h.start()
	l := h.nextLink()
	if l.ConnectorID != h.cfg.ConnectorID {
		t.Errorf("server authenticated %s, want %s", l.ConnectorID, h.cfg.ConnectorID)
	}
	if l.Hello.Mode != "personal" || l.Hello.Version != "0.0.0-dev" || len(l.Hello.Targets) != 2 {
		t.Errorf("hello = %+v", l.Hello)
	}
	eventually(t, "heartbeat seq 0 after hello", func() bool { return len(l.Heartbeats()) > 0 })
	if hb := l.Heartbeats()[0]; hb.Seq != 0 || hb.Sessions == nil {
		t.Errorf("first heartbeat = %+v, want seq 0 with a session list", hb)
	}
	eventually(t, "link up", func() bool { return len(h.eventsOf(Up)) == 1 })
	got := h.states()
	want := []State{Connecting, Authenticating, Up}
	if len(got) < 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Errorf("states %v, want %v", got, want)
	}
	// Heartbeats continue every heartbeatSeconds and are acknowledged; the link stays up.
	eventually(t, "more heartbeats", func() bool {
		if len(l.Heartbeats()) >= 3 {
			return true
		}
		select {
		case <-l.Done():
			t.Fatalf("the link ended with %d after %d heartbeats; states %v", l.CloseStatus(), len(l.Heartbeats()), h.states())
		default:
		}
		return false
	})
	for i, hb := range l.Heartbeats() {
		if hb.Seq != int64(i) {
			t.Fatalf("heartbeat %d has seq %d", i, hb.Seq)
		}
	}
	if len(h.srv.LinkAttempts()) != 1 {
		t.Errorf("%d link attempts, want 1", len(h.srv.LinkAttempts()))
	}
	h.cancel()
	if err := h.wait(5 * time.Second); err != nil {
		t.Errorf("Run after cancel = %v", err)
	}
	<-l.Done()
	if code := l.CloseStatus(); code != CloseGoingAway {
		t.Errorf("connector closed with %d, want %d", code, CloseGoingAway)
	}
}

func TestOriginMismatchStops(t *testing.T) {
	h := newHarness(t, testserver.StatusActive)
	h.srv.LinkOptions.Origin = "https://other.example.org"
	h.start()
	err := h.wait(5 * time.Second)
	var stop *StopError
	if !errors.As(err, &stop) || stop.State != Rejected {
		t.Fatalf("Run = %v, want a StopError", err)
	}
	if !strings.Contains(stop.Msg, h.srv.Origin) || !strings.Contains(stop.Msg, "https://other.example.org") {
		t.Errorf("message does not name both origins: %s", stop.Msg)
	}
	time.Sleep(20 * unit)
	if n := len(h.srv.LinkAttempts()); n != 1 {
		t.Errorf("%d attempts after an origin mismatch, want 1", n)
	}
}

func TestRevokedStopsRetrying(t *testing.T) {
	for _, tc := range []struct {
		status string
		state  State
	}{{testserver.StatusRevoked, Revoked}, {testserver.StatusRejected, Revoked}} {
		h := newHarness(t, tc.status)
		h.start()
		err := h.wait(5 * time.Second)
		var stop *StopError
		if !errors.As(err, &stop) || stop.State != tc.state {
			t.Fatalf("%s: Run = %v, want a StopError with state %s", tc.status, err, tc.state)
		}
		if !strings.Contains(stop.Msg, "revoked") {
			t.Errorf("%s: message %q does not explain the revocation", tc.status, stop.Msg)
		}
		time.Sleep(20 * unit)
		if n := len(h.srv.LinkAttempts()); n != 1 {
			t.Errorf("%s: %d attempts, want 1", tc.status, n)
		}
	}
}

func TestBadSignatureStopsRetrying(t *testing.T) {
	h := newHarness(t, testserver.StatusActive)
	other, _ := identity.Generate()
	h.cfg.Identity = other // signs with a key the server does not know for this id
	h.start()
	err := h.wait(5 * time.Second)
	var stop *StopError
	if !errors.As(err, &stop) || stop.State != Rejected || !strings.Contains(stop.Msg, "doctor") {
		t.Fatalf("Run = %v, want a StopError pointing at doctor", err)
	}
	if n := len(h.srv.LinkAttempts()); n != 1 {
		t.Errorf("%d attempts, want 1", n)
	}
}

func TestPendingRetriesEvery10s(t *testing.T) {
	h := newHarness(t, testserver.StatusPending)
	h.cfg.Rand = func(n int64) int64 { return 0 } // a backoff would redial at once
	h.start()
	eventually(t, "three attempts", func() bool { return len(h.srv.LinkAttempts()) >= 3 })
	h.srv.Approve(h.cfg.ConnectorID)
	h.nextLink()
	eventually(t, "link up", func() bool { return len(h.eventsOf(Up)) == 1 })
	attempts := h.srv.LinkAttempts()
	for i := 1; i < len(attempts); i++ {
		if gap := attempts[i].Sub(attempts[i-1]); gap < 10*unit {
			t.Errorf("attempt %d came %v after the previous one, want at least %v", i+1, gap, 10*unit)
		}
	}
	pending := h.eventsOf(Pending)
	if len(pending) < 2 {
		t.Fatalf("%d pending events", len(pending))
	}
	for _, e := range pending {
		if e.Retry != 10*unit || !strings.Contains(e.Message, "approved") {
			t.Errorf("pending event %+v, want a 10 s retry that mentions approval", e)
		}
	}
}

func TestBackoffFullJitter(t *testing.T) {
	var asked []int64
	b := &Backoff{Base: time.Second, Cap: 60 * time.Second, Rand: func(n int64) int64 { asked = append(asked, n); return n - 1 }}
	want := []time.Duration{1, 2, 4, 8, 16, 32, 60, 60, 60}
	for i, w := range want {
		if got := b.Next(); got != w*time.Second {
			t.Errorf("attempt %d: %v, want %v", i, got, w*time.Second)
		}
		if asked[i] != int64(w*time.Second)+1 {
			t.Errorf("attempt %d: jitter drawn from [0, %d), want [0, %d]", i, asked[i], w*time.Second)
		}
	}
	b.Reset()
	if got := b.Ceiling(); got != time.Second {
		t.Errorf("after Reset the ceiling is %v", got)
	}
	b.Rand = cryptoRand
	for i := 0; i < 200; i++ {
		ceiling := b.Ceiling()
		if d := b.Next(); d < 0 || d > ceiling {
			t.Fatalf("wait %v outside [0, %v]", d, ceiling)
		}
	}
}

func TestReconnectBackoffWithJitter(t *testing.T) {
	h := newHarness(t, testserver.StatusActive)
	h.cfg.Rand = func(n int64) int64 { return n - 1 } // the jitter's upper bound
	h.srv.LinkOptions.Refuse = func(attempt int) (int, string) {
		if attempt <= 3 {
			return CloseServerError, "server_error"
		}
		return 0, ""
	}
	h.start()
	l := h.nextLink()
	eventually(t, "link up", func() bool { return len(h.eventsOf(Up)) == 1 })
	var retries []time.Duration
	for _, e := range h.eventsOf(Down) {
		retries = append(retries, e.Retry)
	}
	if want := []time.Duration{1 * unit, 2 * unit, 4 * unit}; !equalDurations(retries, want) {
		t.Errorf("retries %v, want %v (doubling from 1 s)", retries, want)
	}
	// A link that stayed up for 60 s resets the backoff; the next wait is 1 s again, not 8 s.
	time.Sleep(65 * unit)
	l.Close(CloseGoingAway, "")
	h.nextLink()
	if n := len(h.srv.LinkAttempts()); n != 5 {
		t.Fatalf("%d link attempts, want 5", n)
	}
	downs := h.eventsOf(Down)
	if last := downs[len(downs)-1].Retry; last != unit {
		t.Errorf("after a stable link the retry is %v, want %v", last, unit)
	}
}

func equalDurations(a, b []time.Duration) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestHeartbeatMissCloses(t *testing.T) {
	h := newHarness(t, testserver.StatusActive)
	h.srv.LinkOptions.HeartbeatSeconds = 5
	var mu sync.Mutex
	var first *testserver.Link
	h.srv.LinkOptions.Ack = func(l *testserver.Link, seq int64) bool {
		mu.Lock()
		defer mu.Unlock()
		if first == nil {
			first = l
		}
		return l != first || seq == 0 // the first link acknowledges only seq 0
	}
	h.start()
	l1 := h.nextLink()
	start := time.Now()
	<-l1.Done()
	if code := l1.CloseStatus(); code != CloseHeartbeatTimeout {
		t.Errorf("connector closed with %d, want %d", code, CloseHeartbeatTimeout)
	}
	hb := 5 * unit
	if elapsed := time.Since(start); elapsed < 3*hb {
		t.Errorf("closed after %v, before three missed acknowledgements (%v)", elapsed, 3*hb)
	}
	if n := len(l1.Heartbeats()); n < 3 {
		t.Errorf("only %d heartbeats before closing", n)
	}
	h.nextLink() // and redials
}

// streams is a handler that accepts every stream and hands it to the test.
type streams struct {
	ch chan *Stream
	Refuse
}

func (h streams) Stream(_ context.Context, _ *Link, _ protocol.Message, s *Stream) { h.ch <- s }

func takeStream(t *testing.T, ch chan *Stream) *Stream {
	t.Helper()
	select {
	case s := <-ch:
		return s
	case <-time.After(10 * time.Second):
		t.Fatal("no stream")
		return nil
	}
}

const sessionID = "7b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"

func TestWindowEnforced(t *testing.T) {
	h := newHarness(t, testserver.StatusActive)
	limits := protocol.Limits{MaxStreams: 4, MaxPayload: 1024, InitialWindow: 4096, MaxControl: 65536, MaxSessions: 4}
	h.srv.LinkOptions.Limits = limits
	ch := make(chan *Stream, 4)
	h.cfg.Handler = streams{ch: ch}
	h.start()
	l := h.nextLink()
	n := int64(8192)
	open := func(id uint32) *Stream {
		if err := l.Send(&protocol.HTTP{StreamID: id, SessionID: sessionID, Purpose: "contents", Method: "PUT",
			Path: "/api/contents/a.txt", Body: "stream", ContentLength: &n}); err != nil {
			t.Fatal(err)
		}
		return takeStream(t, ch)
	}

	// Server → connector: data beyond the granted window resets the stream.
	open(1)
	chunk := bytes.Repeat([]byte("a"), 1024)
	for i := 0; i < 4; i++ {
		if err := l.SendFrame(protocol.Frame{StreamID: 1, Payload: chunk}); err != nil {
			t.Fatal(err)
		}
	}
	if err := l.SendFrame(protocol.Frame{StreamID: 1, Payload: []byte("b")}); err != nil {
		t.Fatal(err)
	}
	reset := nextMessage[*protocol.StreamReset](t, l)
	if reset.StreamID != 1 || reset.Code != protocol.CodeLimitExceeded {
		t.Errorf("reset = %+v, want limit_exceeded on stream 1", reset)
	}

	// Within the window, and after a grant, data is delivered and the link stays up.
	s := open(2)
	for i := 0; i < 4; i++ {
		l.SendFrame(protocol.Frame{StreamID: 2, Payload: chunk})
	}
	for i := 0; i < 4; i++ {
		f, err := s.Recv(context.Background())
		if err != nil || len(f.Payload) != 1024 {
			t.Fatalf("frame %d: %v %v", i, f, err)
		}
	}
	if err := s.Grant(context.Background(), 1024); err != nil {
		t.Fatal(err)
	}
	if w := nextMessage[*protocol.Window](t, l); w.StreamID != 2 || w.Credit != 1024 {
		t.Errorf("window = %+v", w)
	}
	l.SendFrame(protocol.Frame{StreamID: 2, Flags: protocol.FlagEnd, Payload: chunk})
	if f, err := s.Recv(context.Background()); err != nil || !f.End() {
		t.Fatalf("last frame %v %v", f, err)
	}

	// Connector → server: the writer stops at the window and resumes on credit.
	writeDone := make(chan error, 1)
	go func() {
		writeDone <- s.Write(context.Background(), bytes.Repeat([]byte("c"), 3*4096), protocol.FlagEnd)
	}()
	received := 0
	for received < 4096 {
		r := next(t, l)
		if r.Frame == nil || r.Frame.StreamID != 2 || r.Frame.End() {
			t.Fatalf("got %+v", r)
		}
		received += len(r.Frame.Payload)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*unit)
	if r, err := l.Next(ctx); err == nil {
		t.Fatalf("the connector sent %+v beyond its window", r)
	}
	cancel()
	l.Send(&protocol.Window{StreamID: 2, Credit: 8192})
	for received < 3*4096 {
		r := next(t, l)
		if r.Frame == nil {
			t.Fatalf("got %+v", r)
		}
		received += len(r.Frame.Payload)
		if received == 3*4096 && !r.Frame.End() {
			t.Error("the last frame does not carry END")
		}
	}
	if err := <-writeDone; err != nil {
		t.Fatal(err)
	}
}

func TestUnknownMessageIsAnsweredNotFatal(t *testing.T) {
	h := newHarness(t, testserver.StatusActive)
	h.start()
	l := h.nextLink()
	if err := l.SendText(`{"v":1,"t":"ws_event","streamId":1}`); err != nil {
		t.Fatal(err)
	}
	e := nextMessage[*protocol.Error](t, l)
	if e.Code != protocol.CodeUnsupportedMessage {
		t.Errorf("answer = %+v, want unsupported_message", e)
	}
	// A message the server must not send is answered the same way.
	l.SendText(`{"v":1,"t":"hello","version":"1.0.0","os":"linux","arch":"amd64","mode":"personal","targets":["local"],` +
		`"features":{"tty":false,"agent":false,"wsl":false},"networkScope":{"cidrs":[],"hosts":[]}}`)
	if e := nextMessage[*protocol.Error](t, l); e.Code != protocol.CodeUnsupportedMessage {
		t.Errorf("answer = %+v, want unsupported_message", e)
	}
	before := len(l.Heartbeats())
	eventually(t, "heartbeats continue", func() bool { return len(l.Heartbeats()) > before+1 })
	select {
	case <-l.Done():
		t.Fatal("the link closed")
	default:
	}
	if n := len(h.srv.LinkAttempts()); n != 1 {
		t.Errorf("%d link attempts", n)
	}
}

func TestInvalidMessageEndsLinkWith4400(t *testing.T) {
	for name, text := range map[string]string{
		"not JSON":       `{"v":1,`,
		"schema failure": `{"v":1,"t":"window","streamId":1,"credit":0}`,
		"secret field":   `{"v":1,"t":"presence","sessionId":"` + sessionID + `","attached":true,"token":"x"}`,
	} {
		h := newHarness(t, testserver.StatusActive)
		h.start()
		l := h.nextLink()
		l.SendText(text)
		<-l.Done()
		if code := l.CloseStatus(); code != CloseProtocolError {
			t.Errorf("%s: closed with %d, want 4400", name, code)
		}
		h.nextLink() // the connector redials
	}
}

func TestRequestsRefusedUntilSessionsExist(t *testing.T) {
	h := newHarness(t, testserver.StatusActive)
	h.start()
	l := h.nextLink()
	reqID := "c0ffee00-1111-4222-8333-444455556666"
	target := protocol.Target{Kind: "ssh", Host: "2852039166", Port: 22, User: "student",
		Auth: &protocol.AuthRef{Method: "agent"}, Workspace: "/home/student"}
	l.Send(&protocol.TestConnection{RequestID: reqID, Target: target, Runtime: protocol.Runtime{Mode: "start"}})
	if e := nextMessage[*protocol.Error](t, l); e.Code != protocol.CodeInvalidTarget || e.RequestID != reqID {
		t.Errorf("rule 1 host: %+v, want invalid_target", e)
	}
	l.Send(&protocol.OpenSession{RequestID: reqID, SessionID: sessionID, Target: protocol.Target{Kind: "local", Workspace: "/w"},
		Runtime: protocol.Runtime{Mode: "start"}, Lease: protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5}})
	if e := nextMessage[*protocol.Error](t, l); e.Code != protocol.CodeUnsupportedTarget || e.SessionID != sessionID {
		t.Errorf("open_session: %+v, want unsupported_target", e)
	}
	l.Send(&protocol.CloseSession{RequestID: reqID, SessionID: sessionID, Stop: true})
	if e := nextMessage[*protocol.Error](t, l); e.Code != protocol.CodeUnknownSession {
		t.Errorf("close_session: %+v, want unknown_session", e)
	}
	l.Send(&protocol.HTTP{StreamID: 1, SessionID: sessionID, Purpose: "session", Method: "GET", Path: "/api/status", Body: "none"})
	if r := nextMessage[*protocol.StreamReset](t, l); r.StreamID != 1 || r.Code != protocol.CodeUnknownSession {
		t.Errorf("http: %+v, want unknown_session", r)
	}
	l.SendFrame(protocol.Frame{StreamID: 9, Payload: []byte("x")})
	if r := nextMessage[*protocol.StreamReset](t, l); r.StreamID != 9 || r.Code != protocol.CodeUnknownStream {
		t.Errorf("frame: %+v, want unknown_stream", r)
	}
	l.Send(&protocol.HTTP{StreamID: 1, SessionID: sessionID, Purpose: "session", Method: "GET", Path: "/api/status", Body: "none"})
	if r := nextMessage[*protocol.StreamReset](t, l); r.StreamID != 1 || r.Code != protocol.CodeInvalidMessage {
		t.Errorf("reused stream id: %+v, want invalid_message", r)
	}
}

func TestStreamLimit(t *testing.T) {
	h := newHarness(t, testserver.StatusActive)
	h.srv.LinkOptions.Limits = protocol.Limits{MaxStreams: 1, MaxPayload: 1024, InitialWindow: 4096, MaxControl: 65536, MaxSessions: 4}
	ch := make(chan *Stream, 4)
	h.cfg.Handler = streams{ch: ch}
	h.start()
	l := h.nextLink()
	open := &protocol.WSOpen{StreamID: 1, SessionID: sessionID, Path: "/api/kernels/k/channels"}
	l.Send(open)
	takeStream(t, ch)
	open.StreamID = 2
	l.Send(open)
	if r := nextMessage[*protocol.StreamReset](t, l); r.StreamID != 2 || r.Code != protocol.CodeLimitExceeded {
		t.Errorf("second stream: %+v, want limit_exceeded", r)
	}
}

// TestA27_LapsedApprovalIsNotRevoked (A27): a paired computer nobody approved within the
// window is told its pairing lapsed and to pair again, not that it was revoked.
func TestA27_LapsedApprovalIsNotRevoked(t *testing.T) {
	a := decide(CloseForbidden, ReasonApprovalExpired, "")
	if !a.stop || a.state == Revoked || strings.Contains(strings.ToLower(a.msg), "revoked") || !strings.Contains(a.msg, "pair --force") {
		t.Errorf("approval_expired: %+v", a)
	}
}

func TestCloseCodeReactions(t *testing.T) {
	cases := []struct {
		code   int
		reason string
		stop   bool
		state  State
		wait   int
	}{
		{CloseNormal, "", false, Down, 0},
		{CloseGoingAway, "", false, Down, 0},
		{CloseProtocolError, "protocol_error", false, Down, 0},
		{CloseUnauthorized, ReasonBadSignature, true, Rejected, 0},
		{CloseUnauthorized, ReasonClockSkew, false, Down, 30},
		{CloseForbidden, ReasonPending, false, Pending, 10},
		{CloseForbidden, ReasonApprovalExpired, true, Rejected, 0},
		{CloseForbidden, ReasonRevoked, true, Revoked, 0},
		{CloseForbidden, ReasonModeMismatch, true, Rejected, 0},
		{CloseHeartbeatTimeout, "heartbeat_timeout", false, Down, 0},
		{CloseReplaced, "replaced", false, Down, 60},
		{CloseUpgradeRequired, "upgrade_required", true, Rejected, 0},
		{CloseRateLimited, "rate_limited", false, Down, 0},
		{CloseServerError, "server_error", false, Down, 0},
		{-1, "", false, Down, 0},
	}
	for _, c := range cases {
		a := decide(c.code, c.reason, "1.2.0")
		if a.stop != c.stop || a.state != c.state || a.wait != c.wait || a.msg == "" {
			t.Errorf("%d %s: %+v", c.code, c.reason, a)
		}
	}
	if a := decide(CloseUpgradeRequired, "upgrade_required", "1.2.0"); !strings.Contains(a.msg, "1.2.0") {
		t.Errorf("upgrade message does not name the version: %s", a.msg)
	}
}

func TestURLRequiresTLSExceptLoopback(t *testing.T) {
	for origin, ok := range map[string]bool{
		"https://parallax.example.org": true,
		"http://127.0.0.1:3000":        true,
		"http://localhost:3000":        true,
		"http://[::1]:3000":            true,
		"http://parallax.example.org":  false,
	} {
		_, err := URL(origin)
		if (err == nil) != ok {
			t.Errorf("%s: %v", origin, err)
		}
	}
}
