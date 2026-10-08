// Package jupytertest is a fake Jupyter Server for tests: the allowlisted REST API and a kernel
// channel WebSocket whose kernel answers `print(2 + 2)` with `4`, and a stub `jupyter` and
// `python` program (the test binary itself) that serves it on the flags the connector passes.
// Nothing here is linked into the connector binary.
package jupytertest

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Version is the Jupyter Server version the fake reports.
const Version = "2.21.1"

// Request is one request the fake received.
type Request struct {
	Method string
	URI    string
	Header http.Header
	Body   string
	// ContentLength and TransferEncoding are as the request arrived (-1 and chunked when the
	// sender did not know the length).
	ContentLength    int64
	TransferEncoding []string
}

// Server is the fake's state.
type Server struct {
	Token string
	// OnShutdown is called after POST /api/shutdown is answered.
	OnShutdown func()

	mu       sync.Mutex
	requests []Request
	kernels  map[string]string // id → name
	order    []string
}

// New returns a fake that accepts token.
func New(token string) *Server {
	return &Server{Token: token, kernels: map[string]string{}}
}

// Requests returns every request received so far.
func (s *Server) Requests() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Request(nil), s.requests...)
}

// AddKernel adds a kernel the connector did not start (another person's, on a shared server).
func (s *Server) AddKernel(name string) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	id := newUUID()
	s.kernels[id] = name
	s.order = append(s.order, id)
	return id
}

func newUUID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b[:])
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Server", "TornadoServer/6.4")
	w.Header().Set("X-Jupyter-Fake", "1")
	w.Header().Set("Set-Cookie", "_xsrf=abc; Path=/")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

// ServeHTTP serves the fake API. Every request needs `Authorization: token <t>`; like Jupyter
// with token authentication, no XSRF check applies to it.
func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	var body []byte
	if r.Body != nil && r.Header.Get("Upgrade") == "" {
		body = make([]byte, 0, 512)
		buf := make([]byte, 4096)
		for {
			n, err := r.Body.Read(buf)
			body = append(body, buf[:n]...)
			if err != nil {
				break
			}
		}
	}
	s.mu.Lock()
	s.requests = append(s.requests, Request{Method: r.Method, URI: r.URL.RequestURI(), Header: r.Header.Clone(), Body: string(body),
		ContentLength: r.ContentLength, TransferEncoding: r.TransferEncoding})
	s.mu.Unlock()

	if r.URL.Path == "/api" && r.Method == "GET" {
		writeJSON(w, 200, map[string]string{"version": Version})
		return
	}
	if r.Header.Get("Authorization") != "token "+s.Token || r.URL.Query().Has("token") {
		writeJSON(w, 403, map[string]string{"message": "Forbidden"})
		return
	}
	path := r.URL.Path
	segs := strings.Split(strings.TrimPrefix(path, "/"), "/")
	switch {
	case path == "/api/status" && r.Method == "GET":
		writeJSON(w, 200, map[string]any{"started": time.Now().UTC().Format(time.RFC3339), "connections": 0, "kernels": len(s.kernels)})
	case path == "/api/kernelspecs" && r.Method == "GET":
		writeJSON(w, 200, map[string]any{"default": "python3", "kernelspecs": map[string]any{
			"python3": map[string]any{"name": "python3", "spec": map[string]any{"display_name": "Python 3 (ipykernel)", "language": "python"}},
			"ir":      map[string]any{"name": "ir", "spec": map[string]any{"display_name": "R", "language": "R"}},
		}})
	case path == "/api/shutdown" && r.Method == "POST":
		writeJSON(w, 200, map[string]any{})
		if s.OnShutdown != nil {
			go s.OnShutdown()
		}
	case path == "/api/redirect":
		w.Header().Set("Location", "http://169.254.169.254/latest/meta-data/")
		w.WriteHeader(http.StatusFound)
	case path == "/api/kernels" && r.Method == "GET":
		s.mu.Lock()
		list := []map[string]any{}
		for _, id := range s.order {
			if name, ok := s.kernels[id]; ok {
				list = append(list, map[string]any{"id": id, "name": name, "execution_state": "idle", "connections": 0})
			}
		}
		s.mu.Unlock()
		writeJSON(w, 200, list)
	case path == "/api/kernels" && r.Method == "POST":
		var req struct {
			Name string `json:"name"`
		}
		if json.Unmarshal(body, &req) != nil || req.Name == "" {
			writeJSON(w, 400, map[string]string{"message": "bad body"})
			return
		}
		id := s.AddKernel(req.Name)
		writeJSON(w, 201, map[string]any{"id": id, "name": req.Name, "execution_state": "starting", "connections": 0})
	case len(segs) >= 3 && segs[1] == "kernels":
		s.mu.Lock()
		name, ok := s.kernels[segs[2]]
		s.mu.Unlock()
		if !ok {
			writeJSON(w, 404, map[string]string{"message": "no such kernel"})
			return
		}
		switch {
		case len(segs) == 3 && r.Method == "GET":
			writeJSON(w, 200, map[string]any{"id": segs[2], "name": name, "execution_state": "idle"})
		case len(segs) == 3 && r.Method == "DELETE":
			s.mu.Lock()
			delete(s.kernels, segs[2])
			s.mu.Unlock()
			w.WriteHeader(204)
		case len(segs) == 4 && r.Method == "POST" && (segs[3] == "interrupt" || segs[3] == "restart"):
			writeJSON(w, 200, map[string]any{"id": segs[2], "name": name})
		case len(segs) == 4 && segs[3] == "channels":
			s.channel(w, r)
		default:
			writeJSON(w, 404, map[string]string{"message": "not found"})
		}
	case strings.HasPrefix(path, "/api/contents"):
		rel := strings.TrimPrefix(strings.TrimPrefix(path, "/api/contents"), "/")
		switch r.Method {
		case "GET":
			writeJSON(w, 200, map[string]any{"name": rel, "path": rel, "type": "file", "format": "text", "content": "a,b\n1,2\n"})
		case "PUT", "POST":
			writeJSON(w, 201, map[string]any{"name": rel, "path": rel, "type": "file"})
		case "DELETE":
			w.WriteHeader(204)
		}
	default:
		writeJSON(w, 404, map[string]string{"message": "not found"})
	}
}

// channel is a kernel that answers execute requests.
func (s *Server) channel(w http.ResponseWriter, r *http.Request) {
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	ctx := r.Context()
	count := 0
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue
		}
		var msg struct {
			Header  map[string]any `json:"header"`
			Content struct {
				Code string `json:"code"`
			} `json:"content"`
			Channel string `json:"channel"`
		}
		if json.Unmarshal(data, &msg) != nil || msg.Header["msg_type"] != "execute_request" {
			continue
		}
		count++
		send := func(channel, msgType string, content map[string]any) {
			out, _ := json.Marshal(map[string]any{
				"header":        map[string]any{"msg_id": newUUID(), "msg_type": msgType, "session": "kernel", "username": "", "version": "5.3", "date": time.Now().UTC().Format(time.RFC3339Nano)},
				"parent_header": msg.Header,
				"metadata":      map[string]any{},
				"content":       content,
				"channel":       channel,
			})
			conn.Write(ctx, websocket.MessageText, out)
		}
		send("iopub", "status", map[string]any{"execution_state": "busy"})
		send("iopub", "execute_input", map[string]any{"code": msg.Content.Code, "execution_count": count})
		send("iopub", "stream", map[string]any{"name": "stdout", "text": evaluate(msg.Content.Code)})
		send("shell", "execute_reply", map[string]any{"status": "ok", "execution_count": count})
		send("iopub", "status", map[string]any{"execution_state": "idle"})
	}
}

// evaluate is the fake kernel's whole language.
func evaluate(code string) string {
	if strings.TrimSpace(code) == "print(2 + 2)" {
		return "4\n"
	}
	return fmt.Sprintf("ran %d characters\n", len(code))
}
