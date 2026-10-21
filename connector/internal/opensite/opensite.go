// Package opensite is the connector's open mode (docs/design/open-site.md §14): a loopback HTTP
// and WebSocket service through which a page of a level 0 site, on an origin the person allowed
// in this terminal, runs a notebook on this computer. Each session is a Jupyter server the
// connector starts in a folder of its own below the workspace, reached only through the
// allowlist of docs/design/connector.md §7; the Jupyter token never leaves the connector, and
// the service dials nothing but those servers and the site's own notebook files.
package opensite

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/redact"
	"parallax/connector/internal/target"
)

// DefaultPort is where a level 0 page looks for the connector.
const DefaultPort = 47821

// API is the version of this service's requests, reported by GET /v1/hello.
const API = 1

// Limits of the service.
const (
	// MaxSessions is how many notebooks may run at once.
	MaxSessions = 3
	// maxKernels is how many kernels one session may hold at once.
	maxKernels = 2
	// maxKeys bounds the keys handed out in one run.
	maxKeys = 256
	// maxRequestBody bounds the JSON body of a page's request.
	maxRequestBody = 64 << 10
	// PairWait is how long a question waits for its answer in the terminal.
	PairWait = 2 * time.Minute
	// DefaultIdleStop stops a session no page has used or held a channel to for this long.
	DefaultIdleStop = 30 * time.Minute
	// sessionDeadline bounds one kernel request to Jupyter.
	sessionDeadline = 30 * time.Second
)

// Answer is the person's answer to a site that asks to run notebooks here.
type Answer int

// Answers.
const (
	NoAnswer Answer = iota
	Yes
	No
)

// Asker asks the person, in the terminal, whether origin may run notebooks on this computer;
// code is what the asking page shows, so the person can tell which page asks.
type Asker func(ctx context.Context, origin, code string) Answer

// Config is one run of the open mode.
type Config struct {
	// Port is the loopback port the service listens on; a request must name it in Host.
	Port int
	// Root is the workspace: the resolved folder below which each site's notebooks get folders.
	Root string
	// Python is the interpreter to start Jupyter with; empty runs `jupyter server` from PATH.
	Python string
	// Allow are origins allowed without asking (canonical, from CanonicalOrigin).
	Allow []string
	// Ask is nil when there is no terminal to ask in: then only Allow's origins are served.
	Ask Asker
	// Open starts a session's Jupyter server (target.Local.Open).
	Open func(ctx context.Context, req *protocol.OpenSession) (*target.Runtime, error)
	// Files downloads a notebook's files; nil uses NewFilesClient.
	Files *http.Client
	// Log receives one line for each thing the person should know about.
	Log io.Writer
	Now func() time.Time
	// IdleStop defaults to DefaultIdleStop, checked every SweepEvery (default a minute).
	IdleStop   time.Duration
	SweepEvery time.Duration
}

// Service is the open mode's HTTP handler and its sessions.
type Service struct {
	cfg  Config
	ctx  context.Context
	stop context.CancelFunc
	mux  *http.ServeMux

	mu       sync.Mutex
	closed   bool
	allowed  map[string]bool // origins of --allow: a page of one gets a key without a question
	refused  map[string]bool
	asking   bool
	keys     map[string]string // key → origin
	sessions map[string]*session
	starting int
	wg       sync.WaitGroup
}

type session struct {
	id     string
	key    string
	origin string
	folder string
	rt     *target.Runtime

	kernels jupyter.Kernels

	mu       sync.Mutex
	channels int
	lastUse  time.Time
	stopping bool
}

// New returns the service; its sessions live until Close or ctx ends.
func New(ctx context.Context, cfg Config) *Service {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.IdleStop <= 0 {
		cfg.IdleStop = DefaultIdleStop
	}
	if cfg.SweepEvery <= 0 {
		cfg.SweepEvery = time.Minute
	}
	if cfg.Files == nil {
		cfg.Files = NewFilesClient()
	}
	if cfg.Log == nil {
		cfg.Log = io.Discard
	}
	sctx, stop := context.WithCancel(ctx)
	s := &Service{
		cfg: cfg, ctx: sctx, stop: stop,
		allowed: map[string]bool{}, refused: map[string]bool{},
		keys: map[string]string{}, sessions: map[string]*session{},
	}
	for _, o := range cfg.Allow {
		s.allowed[o] = true
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/hello", s.hello)
	mux.HandleFunc("POST /v1/pair", s.pair)
	mux.HandleFunc("POST /v1/sessions", s.authed(s.open))
	mux.HandleFunc("GET /v1/sessions/{session}", s.authed(s.withSession(s.state)))
	mux.HandleFunc("DELETE /v1/sessions/{session}", s.authed(s.withSession(s.close)))
	mux.HandleFunc("POST /v1/sessions/{session}/kernels", s.authed(s.withSession(s.startKernel)))
	mux.HandleFunc("GET /v1/sessions/{session}/kernels/{kernel}", s.authed(s.withSession(s.kernel)))
	mux.HandleFunc("DELETE /v1/sessions/{session}/kernels/{kernel}", s.authed(s.withSession(s.kernel)))
	mux.HandleFunc("POST /v1/sessions/{session}/kernels/{kernel}/{action}", s.authed(s.withSession(s.kernel)))
	mux.HandleFunc("GET /v1/sessions/{session}/kernels/{kernel}/channels", s.authed(s.withSession(s.channel)))
	s.mux = mux
	s.wg.Add(1)
	go s.sweep()
	return s
}

// Close stops every session's Jupyter server and returns once they are gone or ctx ends.
func (s *Service) Close(ctx context.Context) {
	s.mu.Lock()
	s.closed = true
	all := make([]*session, 0, len(s.sessions))
	for _, ss := range s.sessions {
		all = append(all, ss)
	}
	s.mu.Unlock()
	var wg sync.WaitGroup
	for _, ss := range all {
		wg.Add(1)
		go func() { defer wg.Done(); s.end(ctx, ss, "the connector stopped") }()
	}
	wg.Wait()
	s.stop()
	s.wg.Wait()
}

// Sessions is how many sessions are open.
func (s *Service) Sessions() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sessions)
}

func (s *Service) logf(format string, args ...any) {
	fmt.Fprintf(s.cfg.Log, format+"\n", args...)
}

// ── Origins ───────────────────────────────────────────────────────────────────────────────

var reHost = regexp.MustCompile(`^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`)

func loopbackHost(h string) bool { return h == "127.0.0.1" || h == "localhost" || h == "[::1]" }

// CanonicalOrigin returns an origin a page may have, as a browser sends it: https with a host
// name or address, or http only on this computer (a site previewed or tested here). Anything
// else, `null` and file pages among them, is refused.
func CanonicalOrigin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Opaque != "" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" {
		return "", fmt.Errorf("%q is not an origin", raw)
	}
	scheme := strings.ToLower(u.Scheme)
	host := strings.ToLower(u.Hostname())
	if strings.Contains(u.Host, "[") {
		host = "[" + host + "]"
	}
	if scheme != "https" && !(scheme == "http" && loopbackHost(host)) {
		return "", fmt.Errorf("%q is not an https origin", raw)
	}
	if !loopbackHost(host) && !reHost.MatchString(host) {
		return "", fmt.Errorf("%q has no host name", raw)
	}
	out := scheme + "://" + host
	if p := u.Port(); p != "" {
		n, err := strconv.Atoi(p)
		if err != nil || n < 1 || n > 65535 {
			return "", fmt.Errorf("%q has no valid port", raw)
		}
		if !(scheme == "https" && n == 443 || scheme == "http" && n == 80) {
			out += ":" + strconv.Itoa(n)
		}
	}
	return out, nil
}

// siteFolder is the folder an origin's notebooks get below the workspace.
func siteFolder(origin string) string {
	rest := origin[strings.Index(origin, "://")+3:]
	rest = strings.NewReplacer("[", "", "]", "", ":", "-").Replace(rest)
	if strings.HasPrefix(origin, "http://") {
		rest = "local-" + rest
	}
	return rest
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────

// ServeHTTP answers only requests that name this computer's loopback service in Host (so a
// rebound DNS name reaches nothing) and come from a page with an origin of CanonicalOrigin's
// form; their responses carry CORS for that origin.
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.hostOK(r.Host) {
		writeError(w, http.StatusForbidden, "wrong_host", "this service answers only on 127.0.0.1")
		return
	}
	origin, err := CanonicalOrigin(r.Header.Get("Origin"))
	if err != nil {
		writeError(w, http.StatusForbidden, "origin_refused", "only a page on an https site can ask")
		return
	}
	h := w.Header()
	h.Set("Access-Control-Allow-Origin", r.Header.Get("Origin"))
	h.Add("Vary", "Origin")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	if r.Method == http.MethodOptions {
		h.Set("Access-Control-Allow-Methods", "GET, POST, DELETE")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		h.Set("Access-Control-Max-Age", "600")
		if r.Header.Get("Access-Control-Request-Private-Network") == "true" {
			h.Set("Access-Control-Allow-Private-Network", "true")
		}
		w.WriteHeader(http.StatusNoContent)
		return
	}
	r = r.WithContext(context.WithValue(r.Context(), originKey{}, origin))
	s.mux.ServeHTTP(w, r)
}

type originKey struct{}

func originOf(r *http.Request) string { return r.Context().Value(originKey{}).(string) }

func (s *Service) hostOK(host string) bool {
	p := strconv.Itoa(s.cfg.Port)
	return host == "127.0.0.1:"+p || host == "localhost:"+p
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, code, detail string) {
	writeJSON(w, status, map[string]string{"code": code, "detail": redact.Redact(detail)})
}

func readJSON(r *http.Request, v any) error {
	body, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBody+1))
	if err != nil || len(body) > maxRequestBody {
		return errors.New("the request body is too large")
	}
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(v); err != nil {
		return errors.New("the request body is not what this service reads")
	}
	return nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

func newUUID() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	h := hex.EncodeToString(b)
	return h[:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:]
}

// hello tells a page that a connector listens here, before anything is asked.
func (s *Service) hello(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"service": "parallax-connector", "api": API})
}

var rePairCode = regexp.MustCompile(`^[0-9]{4}-[0-9]{4}$`)

// pair asks the person whether the page may run notebooks here, and answers with a key for that
// page. Each page is asked about, since any program on this computer can send a site's Origin:
// only an origin of --allow gets a key without a question. An origin the person refused is
// refused without asking until the connector restarts, so a site cannot keep asking.
func (s *Service) pair(w http.ResponseWriter, r *http.Request) {
	origin := originOf(r)
	var body struct {
		Code string `json:"code"`
	}
	if err := readJSON(r, &body); err != nil || !rePairCode.MatchString(body.Code) {
		writeError(w, http.StatusBadRequest, "bad_request", "a pairing names a code of the form 1234-5678")
		return
	}
	s.mu.Lock()
	switch {
	case s.closed:
		s.mu.Unlock()
		writeError(w, http.StatusServiceUnavailable, "stopping", "the connector is stopping")
		return
	case s.refused[origin]:
		s.mu.Unlock()
		writeError(w, http.StatusForbidden, "refused", "this site was refused in the connector's terminal")
		return
	case len(s.keys) >= maxKeys:
		s.mu.Unlock()
		writeError(w, http.StatusTooManyRequests, "too_many_pairings", "restart the connector to connect more pages")
		return
	case s.allowed[origin]:
		key := s.issue(origin)
		s.mu.Unlock()
		s.logf("%s connected (code %s), allowed by --allow.", origin, body.Code)
		writeJSON(w, http.StatusOK, map[string]string{"key": key})
		return
	case s.cfg.Ask == nil:
		s.mu.Unlock()
		writeError(w, http.StatusForbidden, "cannot_ask", "the connector has no terminal to ask in; start it in a terminal, or with --allow "+origin)
		return
	case s.asking:
		s.mu.Unlock()
		writeError(w, http.StatusConflict, "busy", "the connector is answering another page; try again")
		return
	}
	s.asking = true
	s.mu.Unlock()

	ctx, cancel := context.WithTimeout(r.Context(), PairWait)
	answer := s.cfg.Ask(ctx, origin, body.Code)
	cancel()

	s.mu.Lock()
	s.asking = false
	switch answer {
	case Yes:
		key := s.issue(origin)
		s.mu.Unlock()
		s.logf("Allowed a page of %s (code %s).", origin, body.Code)
		writeJSON(w, http.StatusOK, map[string]string{"key": key})
	case No:
		s.refused[origin] = true
		s.mu.Unlock()
		s.logf("Refused %s; it cannot ask again until the connector restarts.", origin)
		writeError(w, http.StatusForbidden, "refused", "this site was refused in the connector's terminal")
	default:
		s.mu.Unlock()
		writeError(w, http.StatusRequestTimeout, "no_answer", "nobody answered in the connector's terminal")
	}
}

// issue returns a new key for origin; s.mu is held.
func (s *Service) issue(origin string) string {
	key := randomHex(32)
	s.keys[key] = origin
	return key
}

// authed passes on a request whose key was issued to the request's origin: in the
// Authorization header, or, for a WebSocket (which cannot send one), in the `key` query.
func (s *Service) authed(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		key, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok && strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
			key = r.URL.Query().Get("key")
		}
		s.mu.Lock()
		owner, known := s.keys[key]
		s.mu.Unlock()
		if key == "" || !known || owner != originOf(r) {
			writeError(w, http.StatusUnauthorized, "not_paired", "connect this page in the connector's terminal first")
			return
		}
		r = r.WithContext(context.WithValue(r.Context(), keyKey{}, key))
		next(w, r)
	}
}

type keyKey struct{}

func keyOf(r *http.Request) string { return r.Context().Value(keyKey{}).(string) }

type sessionHandler func(w http.ResponseWriter, r *http.Request, ss *session)

// withSession finds the session the path names, among the caller key's own.
func (s *Service) withSession(next sessionHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		ss := s.sessions[r.PathValue("session")]
		s.mu.Unlock()
		if ss == nil || ss.key != keyOf(r) {
			writeError(w, http.StatusNotFound, "unknown_session", "this notebook is not running on this computer")
			return
		}
		ss.touch(s.cfg.Now())
		next(w, r, ss)
	}
}

func (ss *session) touch(now time.Time) {
	ss.mu.Lock()
	ss.lastUse = now
	ss.mu.Unlock()
}

// ── Sessions ──────────────────────────────────────────────────────────────────────────────

// openRequest names the notebook's folder below its site's (its course and its title, as the page
// names them) and, when it declares data files, the address of its files' zip.
type openRequest struct {
	Folder []string `json:"folder"`
	Files  *string  `json:"files"`
}

var reSegmentKeep = regexp.MustCompile(`[^A-Za-z0-9._-]+`)

// folderName is one folder name made of what a page sent: letters, digits, `.`, `_` and `-`,
// never starting with a dot.
func folderName(seg string) (string, bool) {
	clean := strings.TrimLeft(reSegmentKeep.ReplaceAllString(seg, "-"), ".-")
	if len(clean) > 64 {
		clean = clean[:64]
	}
	clean = strings.TrimRight(clean, ".")
	return clean, clean != ""
}

// open starts a notebook's session: its folder, its files, and a Jupyter server there.
func (s *Service) open(w http.ResponseWriter, r *http.Request) {
	var req openRequest
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if len(req.Folder) < 1 || len(req.Folder) > 6 {
		writeError(w, http.StatusBadRequest, "bad_request", "a notebook's folder has one to six names")
		return
	}
	origin := originOf(r)
	parts := []string{s.cfg.Root, siteFolder(origin)}
	for _, seg := range req.Folder {
		name, ok := folderName(seg)
		if !ok {
			writeError(w, http.StatusBadRequest, "bad_request", "a folder name has no letters or digits")
			return
		}
		parts = append(parts, name)
	}
	var files *FilesURL
	if req.Files != nil {
		u, err := ParseFilesURL(*req.Files)
		if err != nil {
			writeError(w, http.StatusBadRequest, "bad_request", err.Error())
			return
		}
		files = u
	}

	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		writeError(w, http.StatusServiceUnavailable, "stopping", "the connector is stopping")
		return
	}
	if len(s.sessions)+s.starting >= MaxSessions {
		s.mu.Unlock()
		writeError(w, http.StatusTooManyRequests, "too_many_sessions", fmt.Sprintf("%d notebooks already run on this computer; stop one first", MaxSessions))
		return
	}
	s.starting++
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.starting--
		s.mu.Unlock()
	}()

	dir := filepath.Join(parts...)
	if err := makeFolder(s.cfg.Root, dir); err != nil {
		writeError(w, http.StatusInternalServerError, "workspace_not_writable", err.Error())
		return
	}
	rel, _ := filepath.Rel(s.cfg.Root, dir)
	result := map[string]any{"folder": filepath.ToSlash(rel)}
	if files != nil {
		data, err := Download(r.Context(), s.cfg.Files, files)
		if err != nil {
			writeError(w, http.StatusBadGateway, "files_unavailable", err.Error())
			return
		}
		written, kept, err := Extract(data, dir)
		if err != nil {
			writeError(w, http.StatusBadGateway, "files_unavailable", err.Error())
			return
		}
		result["files"] = map[string][]string{"written": written, "kept": kept}
		if len(kept) > 0 {
			s.logf("Kept %d of your files in %s that differ from the site's: %s", len(kept), dir, strings.Join(kept, ", "))
		}
	}

	id := newUUID()
	rt, err := s.cfg.Open(r.Context(), &protocol.OpenSession{
		SessionID: id,
		Target:    protocol.Target{Kind: "local", Workspace: dir},
		Runtime:   protocol.Runtime{Mode: protocol.RuntimeStart, Python: s.cfg.Python},
	})
	if err != nil {
		var f *target.Failure
		if errors.As(err, &f) {
			writeError(w, http.StatusBadGateway, string(f.Code), f.Detail)
		} else {
			writeError(w, http.StatusBadGateway, string(protocol.CodeJupyterStartFailed), err.Error())
		}
		return
	}
	ss := &session{id: id, key: keyOf(r), origin: origin, folder: dir, rt: rt, lastUse: s.cfg.Now()}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		stopRuntime(context.WithoutCancel(r.Context()), rt)
		writeError(w, http.StatusServiceUnavailable, "stopping", "the connector is stopping")
		return
	}
	s.sessions[id] = ss
	s.mu.Unlock()
	s.wg.Add(1)
	go s.watch(ss)
	s.logf("Started Jupyter for %s in %s.", origin, dir)

	result["session"] = id
	result["jupyter"] = rt.JupyterVersion
	result["kernelspecs"] = rt.Kernelspecs
	if rt.Environment != nil {
		result["runtime"] = rt.Environment.Runtime
	}
	writeJSON(w, http.StatusCreated, result)
}

// makeFolder creates dir below root and checks it did not end up elsewhere through a link.
func makeFolder(root, dir string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("the folder %s cannot be created", dir)
	}
	rr, err1 := filepath.EvalSymlinks(root)
	rd, err2 := filepath.EvalSymlinks(dir)
	if err1 != nil || err2 != nil || !within(rr, rd) {
		return fmt.Errorf("the folder %s is not inside %s", dir, root)
	}
	return nil
}

func within(root, p string) bool {
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// watch removes a session whose Jupyter server ended by itself.
func (s *Service) watch(ss *session) {
	defer s.wg.Done()
	exited := ss.rt.Exited()
	if exited == nil {
		return
	}
	select {
	case <-exited:
		ss.mu.Lock()
		stopping := ss.stopping
		ss.mu.Unlock()
		if !stopping {
			s.end(s.ctx, ss, "Jupyter exited")
		}
	case <-s.ctx.Done():
	}
}

// sweep stops sessions that no page has used for IdleStop.
func (s *Service) sweep() {
	defer s.wg.Done()
	tick := time.NewTicker(s.cfg.SweepEvery)
	defer tick.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-tick.C:
		}
		now := s.cfg.Now()
		s.mu.Lock()
		var idle []*session
		for _, ss := range s.sessions {
			ss.mu.Lock()
			if ss.channels == 0 && now.Sub(ss.lastUse) >= s.cfg.IdleStop {
				idle = append(idle, ss)
			}
			ss.mu.Unlock()
		}
		s.mu.Unlock()
		for _, ss := range idle {
			s.end(s.ctx, ss, "no page used it for "+s.cfg.IdleStop.String())
		}
	}
}

// end stops a session's Jupyter server and forgets the session; only its first call acts.
func (s *Service) end(ctx context.Context, ss *session, why string) {
	ss.mu.Lock()
	if ss.stopping {
		ss.mu.Unlock()
		return
	}
	ss.stopping = true
	ss.mu.Unlock()
	stopRuntime(context.WithoutCancel(ctx), ss.rt)
	s.mu.Lock()
	delete(s.sessions, ss.id)
	s.mu.Unlock()
	s.logf("Stopped Jupyter for %s in %s: %s.", ss.origin, ss.folder, why)
}

func stopRuntime(ctx context.Context, rt *target.Runtime) {
	if rt.Process != nil {
		_ = rt.Process.Stop(ctx, jupyter.DefaultStopTimes)
	}
	rt.Release()
}

func (s *Service) state(w http.ResponseWriter, r *http.Request, ss *session) {
	writeJSON(w, http.StatusOK, map[string]any{"session": ss.id, "kernels": ss.kernels.IDs()})
}

func (s *Service) close(w http.ResponseWriter, r *http.Request, ss *session) {
	s.end(r.Context(), ss, "the page stopped it")
	w.WriteHeader(http.StatusNoContent)
}

// ── Kernels ───────────────────────────────────────────────────────────────────────────────

func (ss *session) scope() jupyter.Scope { return jupyter.Scope{Kernels: &ss.kernels} }

func refuse(w http.ResponseWriter, err error) {
	var ref *jupyter.Refusal
	if errors.As(err, &ref) {
		writeError(w, http.StatusForbidden, string(ref.Code), ref.Detail)
		return
	}
	writeError(w, http.StatusForbidden, string(protocol.CodePathNotAllowed), "not served")
}

// startKernel is POST /api/kernels with a body that names only a kernel.
func (s *Service) startKernel(w http.ResponseWriter, r *http.Request, ss *session) {
	body, err := io.ReadAll(io.LimitReader(r.Body, jupyter.MaxKernelStartBody+1))
	if err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", "the body could not be read")
		return
	}
	if _, err := jupyter.CheckKernelStart(body); err != nil {
		refuse(w, err)
		return
	}
	req, err := jupyter.CheckHTTP(jupyter.PurposeSession, http.MethodPost, "/api/kernels", ss.scope())
	if err != nil {
		refuse(w, err)
		return
	}
	if len(ss.kernels.IDs()) >= maxKernels {
		writeError(w, http.StatusTooManyRequests, string(protocol.CodeLimitExceeded), "stop this notebook's other kernel first")
		return
	}
	status, answer, ok := s.forward(w, r, ss, req, body)
	if !ok {
		return
	}
	if status/100 == 2 {
		id, err := jupyter.KernelID(answer)
		if err != nil {
			writeError(w, http.StatusBadGateway, string(protocol.CodeKernelStartFailed), err.Error())
			return
		}
		ss.kernels.Add(id)
	}
	writeRaw(w, status, answer)
}

// kernel is a kernel's state, its shutdown, an interrupt or a restart.
func (s *Service) kernel(w http.ResponseWriter, r *http.Request, ss *session) {
	path := "/api/kernels/" + url.PathEscape(r.PathValue("kernel"))
	if action := r.PathValue("action"); action != "" {
		path += "/" + url.PathEscape(action)
	}
	req, err := jupyter.CheckHTTP(jupyter.PurposeSession, r.Method, path, ss.scope())
	if err != nil {
		refuse(w, err)
		return
	}
	status, answer, ok := s.forward(w, r, ss, req, nil)
	if !ok {
		return
	}
	if req.Op == jupyter.OpDeleteKernel && (status/100 == 2 || status == http.StatusNotFound) {
		ss.kernels.Remove(req.KernelID)
	}
	writeRaw(w, status, answer)
}

// forward sends an allowed request to the session's Jupyter server and reads its small answer.
func (s *Service) forward(w http.ResponseWriter, r *http.Request, ss *session, req jupyter.Request, body []byte) (int, []byte, bool) {
	ctx, cancel := context.WithTimeout(r.Context(), sessionDeadline)
	defer cancel()
	var rd io.Reader
	var headers protocol.Headers
	if body != nil {
		rd = bytes.NewReader(body)
		headers = protocol.Headers{"content-type": "application/json"}
	}
	resp, err := ss.rt.Client.Do(ctx, r.Method, req.Path, req.RawQuery, headers, rd, int64(len(body)))
	if err != nil {
		writeError(w, http.StatusBadGateway, string(protocol.CodeNotebookServiceUnreachable), "Jupyter did not answer")
		return 0, nil, false
	}
	defer resp.Body.Close()
	answer, err := io.ReadAll(io.LimitReader(resp.Body, jupyter.MaxSessionBody+1))
	if err != nil || len(answer) > jupyter.MaxSessionBody {
		writeError(w, http.StatusBadGateway, string(protocol.CodeBodyTooLarge), "Jupyter's answer is too large")
		return 0, nil, false
	}
	return resp.StatusCode, answer, true
}

func writeRaw(w http.ResponseWriter, status int, body []byte) {
	if len(body) > 0 {
		w.Header().Set("Content-Type", "application/json")
	}
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

// channel bridges the page's WebSocket to the kernel's channel, message by message.
func (s *Service) channel(w http.ResponseWriter, r *http.Request, ss *session) {
	q := url.Values{"session_id": r.URL.Query()["session_id"]}
	path := "/api/kernels/" + url.PathEscape(r.PathValue("kernel")) + "/channels?" + q.Encode()
	req, err := jupyter.CheckWS(path, nil, ss.scope())
	if err != nil {
		refuse(w, err)
		return
	}
	dctx, cancel := context.WithTimeout(r.Context(), sessionDeadline)
	upstream, err := ss.rt.Client.DialChannel(dctx, req.Path, req.RawQuery)
	cancel()
	if err != nil {
		var f *jupyter.Failure
		if errors.As(err, &f) && f.Code == protocol.CodeKernelStartFailed {
			writeError(w, http.StatusNotFound, string(f.Code), f.Detail)
			return
		}
		writeError(w, http.StatusBadGateway, string(protocol.CodeNotebookServiceUnreachable), "the kernel channel could not be opened")
		return
	}
	// The origin was checked against the key's own above; the library's same-host check would
	// refuse every page, whose origin is the site's.
	page, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
	if err != nil {
		upstream.CloseNow()
		return
	}
	page.SetReadLimit(jupyter.MaxChannelMessage)
	ss.mu.Lock()
	ss.channels++
	ss.mu.Unlock()
	defer func() {
		ss.mu.Lock()
		ss.channels--
		ss.lastUse = s.cfg.Now()
		ss.mu.Unlock()
	}()
	bridge(s.ctx, page, upstream)
}

// bridge copies messages both ways until either side closes, then closes both.
func bridge(ctx context.Context, a, b *websocket.Conn) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var wg sync.WaitGroup
	copyTo := func(dst, src *websocket.Conn) {
		defer wg.Done()
		defer cancel()
		for {
			typ, data, err := src.Read(ctx)
			if err != nil {
				return
			}
			if err := dst.Write(ctx, typ, data); err != nil {
				return
			}
		}
	}
	wg.Add(2)
	go copyTo(b, a)
	go copyTo(a, b)
	wg.Wait()
	a.Close(websocket.StatusNormalClosure, "")
	b.CloseNow()
}

// Listen opens the service's loopback port.
func Listen(port int) (net.Listener, error) {
	ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, fmt.Errorf("port %d on 127.0.0.1 is in use or cannot be opened; is another parallax-connector open running?", port)
	}
	return ln, nil
}
