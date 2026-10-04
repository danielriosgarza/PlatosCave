// Package testserver is an httptest server implementing the three pairing endpoints of
// docs/design/connector.md §3 and the server side of the link handshake of §4.2 (link.go) with
// the real signature checks, for the connector's tests and those of later items. It holds its
// state in memory; nothing about it is used by the binary.
package testserver

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"sync"
	"time"

	"parallax/connector/internal/identity"
	"parallax/connector/internal/pairing"
)

// Connector statuses. A pending device that the owner rejects becomes Rejected; an active one
// that is revoked or unpaired becomes Revoked.
const (
	StatusPending  = "pending"
	StatusActive   = "active"
	StatusRejected = "rejected"
	StatusRevoked  = "revoked"
)

// ApprovalWindow is how long a pending device may wait for approval.
const ApprovalWindow = 15 * time.Minute

// SignatureWindow is the accepted difference between a signed ts and the server clock.
const SignatureWindow = 120 * time.Second

// Connector is one paired device as the server sees it.
type Connector struct {
	ID          string
	Name        string
	OS          string
	Arch        string
	Version     string
	Fingerprint string
	PublicKey   ed25519.PublicKey
	Status      string
	ApproveBy   time.Time
	Polls       int
	Unpaired    bool
}

// Server is the fake. Set its exported fields before the first request.
type Server struct {
	*httptest.Server
	linkState

	// Origin is the normalised origin that signatures must name.
	Origin string
	// PollAfterSeconds is returned in PairResponse and pending PollResponses (default 2).
	PollAfterSeconds int
	// Now is the server clock (default time.Now).
	Now func() time.Time
	// OnPoll, when set, runs after every authenticated poll with the connector id and the
	// number of polls so far, before the answer is built; tests use it to approve or reject.
	OnPoll func(s *Server, connectorID string, polls int)

	mu         sync.Mutex
	codes      map[string]bool
	connectors map[string]*Connector
	requests   []string
}

// New starts a plain-HTTP server on loopback.
func New() *Server {
	s := newServer()
	s.Server = httptest.NewServer(s.handler())
	s.setOrigin()
	return s
}

// NewTLS starts an HTTPS server on loopback; use its Client() to trust its certificate.
func NewTLS() *Server {
	s := newServer()
	s.Server = httptest.NewTLSServer(s.handler())
	s.setOrigin()
	return s
}

func newServer() *Server {
	return &Server{PollAfterSeconds: 2, codes: map[string]bool{}, connectors: map[string]*Connector{}}
}

func (s *Server) setOrigin() {
	origin, err := pairing.NormaliseServer(s.URL)
	if err != nil {
		panic(err)
	}
	s.Origin = origin
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

// AddCode makes a pairing code live. It accepts the displayed form (K7M2-Q9XD).
func (s *Server) AddCode(code string) {
	normal, err := pairing.NormaliseCode(code)
	if err != nil {
		panic(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.codes[normal] = true
}

func (s *Server) setStatus(id, from, to string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.connectors[id]
	if !ok || c.Status != from {
		return false
	}
	c.Status = to
	return true
}

// Approve turns a pending device active, as the Approve button does.
func (s *Server) Approve(id string) bool { return s.setStatus(id, StatusPending, StatusActive) }

// Reject refuses a pending device.
func (s *Server) Reject(id string) bool { return s.setStatus(id, StatusPending, StatusRejected) }

// Revoke revokes an active device.
func (s *Server) Revoke(id string) bool { return s.setStatus(id, StatusActive, StatusRevoked) }

// Connector returns a copy of one device.
func (s *Server) Connector(id string) (Connector, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.connectors[id]
	if !ok {
		return Connector{}, false
	}
	return *c, true
}

// Connectors returns copies of every device, ordered by id.
func (s *Server) Connectors() []Connector {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Connector, 0, len(s.connectors))
	for _, c := range s.connectors {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Requests returns "METHOD path status" for every request served, in order.
func (s *Server) Requests() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.requests...)
}

func (s *Server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST "+pairing.PairPath, s.pair)
	mux.HandleFunc("POST "+pairing.PollPath, s.poll)
	mux.HandleFunc("POST "+pairing.UnpairPath, s.unpair)
	mux.HandleFunc("GET "+LinkPath, s.link)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		mux.ServeHTTP(rec, r)
		s.mu.Lock()
		s.requests = append(s.requests, r.Method+" "+r.URL.Path+" "+http.StatusText(rec.status))
		s.mu.Unlock()
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status int
}

// Unwrap lets the WebSocket upgrade reach the connection underneath.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (r *statusRecorder) WriteHeader(code int) {
	r.status = code
	r.ResponseWriter.WriteHeader(code)
}

func (s *Server) pair(w http.ResponseWriter, r *http.Request) {
	var req pairing.PairRequest
	if !decode(w, r, &req) || req.Validate() != nil {
		refuse(w, http.StatusBadRequest, "invalid request")
		return
	}
	pub, err := base64.RawURLEncoding.DecodeString(req.PublicKey)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		refuse(w, http.StatusBadRequest, "invalid request")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.codes[req.Code] {
		refuse(w, http.StatusNotFound, "not found")
		return
	}
	delete(s.codes, req.Code) // single use
	c := &Connector{
		ID:          newUUID(),
		Name:        req.Name,
		OS:          req.OS,
		Arch:        req.Arch,
		Version:     req.Version,
		Fingerprint: identity.Fingerprint(pub),
		PublicKey:   pub,
		Status:      StatusPending,
		ApproveBy:   s.now().Add(ApprovalWindow).UTC().Truncate(time.Second),
	}
	s.connectors[c.ID] = c
	writeJSON(w, http.StatusCreated, pairing.PairResponse{
		ConnectorID:      c.ID,
		Fingerprint:      c.Fingerprint,
		Status:           StatusPending,
		PollAfterSeconds: s.PollAfterSeconds,
		ApproveBy:        c.ApproveBy.Format(time.RFC3339),
	})
}

// authenticate checks a SignedRequest: the connector exists, ts is inside the window and the
// signature over the label's layout verifies with the stored key. An unknown id and a bad
// signature get the same answer, so ids cannot be probed.
func (s *Server) authenticate(w http.ResponseWriter, r *http.Request, build func(string, int64, string) ([]byte, error)) *Connector {
	var req pairing.SignedRequest
	if !decode(w, r, &req) || req.Validate() != nil {
		refuse(w, http.StatusBadRequest, "invalid request")
		return nil
	}
	skew := s.now().Sub(time.Unix(req.TS, 0))
	if skew > SignatureWindow || skew < -SignatureWindow {
		refuse(w, http.StatusUnauthorized, "clock skew")
		return nil
	}
	msg, err := build(req.ConnectorID, req.TS, s.Origin)
	if err != nil {
		refuse(w, http.StatusBadRequest, "invalid request")
		return nil
	}
	c, ok := s.connectors[req.ConnectorID]
	if !ok || !identity.Verify(c.PublicKey, msg, req.Sig) {
		refuse(w, http.StatusUnauthorized, "bad signature")
		return nil
	}
	return c
}

func (s *Server) poll(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	c := s.authenticate(w, r, identity.PollMessage)
	if c == nil {
		s.mu.Unlock()
		return
	}
	c.Polls++
	id, polls := c.ID, c.Polls
	s.mu.Unlock()
	if s.OnPoll != nil {
		s.OnPoll(s, id, polls)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch c.Status {
	case StatusPending:
		if !s.now().Before(c.ApproveBy) {
			writeJSON(w, http.StatusOK, pairing.PollResponse{Status: "expired"})
			return
		}
		writeJSON(w, http.StatusOK, pairing.PollResponse{Status: StatusPending, PollAfterSeconds: s.PollAfterSeconds})
	case StatusActive:
		writeJSON(w, http.StatusOK, pairing.PollResponse{Status: StatusActive})
	case StatusRejected:
		writeJSON(w, http.StatusOK, pairing.PollResponse{Status: StatusRejected})
	default:
		refuse(w, http.StatusUnauthorized, "bad signature")
	}
}

func (s *Server) unpair(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.authenticate(w, r, identity.UnpairMessage)
	if c == nil {
		return
	}
	if c.Status == StatusRevoked || c.Status == StatusRejected {
		refuse(w, http.StatusUnauthorized, "bad signature")
		return
	}
	c.Status = StatusRevoked
	c.Unpaired = true
	w.WriteHeader(http.StatusNoContent)
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64<<10))
	if err != nil {
		return false
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return false
	}
	_, err = dec.Token()
	return errors.Is(err, io.EOF)
}

func refuse(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, pairing.ErrorBody{Error: msg})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func newUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}
