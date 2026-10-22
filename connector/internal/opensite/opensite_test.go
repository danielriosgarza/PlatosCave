package opensite

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"parallax/connector/internal/jupyter/jupytertest"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/target"
)

func TestMain(m *testing.M) {
	jupytertest.RunIfStub()
	os.Exit(m.Run())
}

const site = "https://course.example.org"

// rig is a service on a loopback port, as `open` serves it, with the stub Jupyter on PATH.
type rig struct {
	t    *testing.T
	svc  *Service
	base string
	root string
	stub string
	mu   sync.Mutex
	// asked records each question; answer is what the next question gets.
	asked  []string
	answer Answer
	log    bytes.Buffer
}

func newRig(t *testing.T, tweak func(*Config)) *rig {
	t.Helper()
	r := &rig{t: t, root: t.TempDir(), answer: Yes}
	r.stub = jupytertest.Install(t, "")
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	root, _ := filepath.EvalSymlinks(r.root)
	r.root = root
	cfg := Config{
		Port: port, Root: root,
		Ask: func(ctx context.Context, origin, code string) Answer {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.asked = append(r.asked, origin+" "+code)
			return r.answer
		},
		Python: jupytertest.Python(r.stub),
		Open:   (&target.Local{OS: runtime.GOOS, Arch: runtime.GOARCH}).Open,
		Log:    &syncWriter{w: &r.log},
	}
	if tweak != nil {
		tweak(&cfg)
	}
	ctx, cancel := context.WithCancel(context.Background())
	r.svc = New(ctx, cfg)
	srv := &http.Server{Handler: r.svc}
	go srv.Serve(ln)
	t.Cleanup(func() {
		cctx, ccancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer ccancel()
		r.svc.Close(cctx)
		srv.Close()
		cancel()
	})
	r.base = fmt.Sprintf("http://127.0.0.1:%d", port)
	return r
}

type syncWriter struct {
	mu sync.Mutex
	w  io.Writer
}

func (s *syncWriter) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.w.Write(p)
}

// do sends one request as a page on origin with key, and returns the status and JSON answer.
func (r *rig) do(method, path, origin, key string, body any) (int, map[string]any) {
	r.t.Helper()
	var rd io.Reader
	if body != nil {
		data, _ := json.Marshal(body)
		rd = bytes.NewReader(data)
	}
	req, _ := http.NewRequest(method, r.base+path, rd)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		r.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(data, &out)
	if out == nil {
		out = map[string]any{"raw": string(data)}
	}
	return resp.StatusCode, out
}

func (r *rig) pair(origin string) string {
	r.t.Helper()
	status, out := r.do("POST", "/v1/pair", origin, "", map[string]string{"code": "4821-7730"})
	if status != 200 {
		r.t.Fatalf("pair %s: %d %v", origin, status, out)
	}
	return out["key"].(string)
}

func (r *rig) openSession(origin, key string, files *string) map[string]any {
	r.t.Helper()
	status, out := r.do("POST", "/v1/sessions", origin, key, map[string]any{"folder": []string{"statistics", "means", "demo"}, "files": files})
	if status != 201 {
		r.t.Fatalf("open: %d %v", status, out)
	}
	return out
}

func (r *rig) startKernel(origin, key, session string) string {
	r.t.Helper()
	status, out := r.do("POST", "/v1/sessions/"+session+"/kernels", origin, key, map[string]string{"name": "python3"})
	if status != 201 {
		r.t.Fatalf("start kernel: %d %v", status, out)
	}
	return out["id"].(string)
}

func TestA57_CanonicalOrigin(t *testing.T) {
	ok := map[string]string{
		"https://Course.Example.org":      "https://course.example.org",
		"https://course.example.org:443":  "https://course.example.org",
		"https://course.example.org:8443": "https://course.example.org:8443",
		"https://course.example.org/":     "https://course.example.org",
		"http://127.0.0.1:4173":           "http://127.0.0.1:4173",
		"http://localhost:8080":           "http://localhost:8080",
		"http://[::1]:5000":               "http://[::1]:5000",
		"https://203.0.113.9":             "https://203.0.113.9",
	}
	for in, want := range ok {
		if got, err := CanonicalOrigin(in); err != nil || got != want {
			t.Errorf("CanonicalOrigin(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{
		"", "null", "file://", "http://course.example.org", "https://user@course.example.org",
		"https://course.example.org/notebooks", "https://course.example.org?x=1", "ws://127.0.0.1:1",
		"https://course_example.org", "https://course.example.org:99999", "chrome-extension://abc",
		"https://", "https:course.example.org", "https://cour\nse.example.org",
	} {
		if got, err := CanonicalOrigin(in); err == nil {
			t.Errorf("CanonicalOrigin(%q) = %q, want a refusal", in, got)
		}
	}
}

func TestA57_RefusesOtherHostsAndOrigins(t *testing.T) {
	r := newRig(t, nil)
	// A DNS name rebound to 127.0.0.1 names itself in Host; nothing is served to it.
	req, _ := http.NewRequest("GET", r.base+"/v1/hello", nil)
	req.Host = "attacker.example:1"
	req.Header.Set("Origin", site)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 403 || resp.Header.Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("another Host: %d, CORS %q", resp.StatusCode, resp.Header.Get("Access-Control-Allow-Origin"))
	}
	for _, origin := range []string{"", "null", "http://course.example.org", "file://"} {
		if status, out := r.do("POST", "/v1/pair", origin, "", map[string]string{"code": "1111-2222"}); status != 403 || out["code"] != "origin_refused" {
			t.Errorf("origin %q: %d %v", origin, status, out)
		}
	}
	if len(r.asked) != 0 {
		t.Errorf("asked %v", r.asked)
	}
	if status, out := r.do("GET", "/v1/hello", site, "", nil); status != 200 || out["api"] != float64(API) {
		t.Errorf("hello: %d %v", status, out)
	}
}

func TestA57_Preflight(t *testing.T) {
	r := newRig(t, nil)
	req, _ := http.NewRequest("OPTIONS", r.base+"/v1/sessions", nil)
	req.Header.Set("Origin", site)
	req.Header.Set("Access-Control-Request-Method", "POST")
	req.Header.Set("Access-Control-Request-Headers", "authorization, content-type")
	req.Header.Set("Access-Control-Request-Private-Network", "true")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	h := resp.Header
	if resp.StatusCode != 204 || h.Get("Access-Control-Allow-Origin") != site || h.Get("Access-Control-Allow-Private-Network") != "true" ||
		!strings.Contains(h.Get("Access-Control-Allow-Headers"), "Authorization") || h.Get("Access-Control-Allow-Credentials") != "" {
		t.Errorf("preflight %d %v", resp.StatusCode, h)
	}
}

func TestA57_EachPageIsAskedAndItsKeyIsBoundToTheOrigin(t *testing.T) {
	r := newRig(t, nil)
	key := r.pair(site)
	if len(key) != 64 || len(r.asked) != 1 || r.asked[0] != site+" 4821-7730" {
		t.Fatalf("key %q, asked %v", key, r.asked)
	}
	// Another page of the same site is asked about too: any program on this computer can send
	// the site's Origin, so an earlier yes is not a yes to it. It gets a key of its own.
	key2 := r.pair(site)
	if key2 == key || len(r.asked) != 2 {
		t.Errorf("second pairing: key reused %v, asked %v", key2 == key, r.asked)
	}
	if !strings.Contains(r.log.String(), "Allowed a page of "+site+" (code 4821-7730).") {
		t.Errorf("log %q", r.log.String())
	}
	// A key works only for the origin it was given to.
	other := "https://other.example.org"
	if status, out := r.do("POST", "/v1/sessions", other, key, map[string]any{"folder": []string{"x"}}); status != 401 || out["code"] != "not_paired" {
		t.Errorf("key from another origin: %d %v", status, out)
	}
	if status, _ := r.do("POST", "/v1/sessions", site, "", map[string]any{"folder": []string{"x"}}); status != 401 {
		t.Errorf("no key: %d", status)
	}
	if status, _ := r.do("POST", "/v1/sessions", site, strings.Repeat("0", 64), map[string]any{"folder": []string{"x"}}); status != 401 {
		t.Errorf("a guessed key: %d", status)
	}
	if status, out := r.do("POST", "/v1/pair", site, "", map[string]string{"code": "48217730"}); status != 400 {
		t.Errorf("a code of another form: %d %v", status, out)
	}
}

func TestA57_RefusedSiteCannotAskAgain(t *testing.T) {
	r := newRig(t, nil)
	r.answer = No
	if status, out := r.do("POST", "/v1/pair", site, "", map[string]string{"code": "1111-2222"}); status != 403 || out["code"] != "refused" {
		t.Fatalf("refused: %d %v", status, out)
	}
	r.answer = Yes
	if status, out := r.do("POST", "/v1/pair", site, "", map[string]string{"code": "1111-2222"}); status != 403 || out["code"] != "refused" {
		t.Errorf("asked again: %d %v", status, out)
	}
	if len(r.asked) != 1 {
		t.Errorf("asked %v", r.asked)
	}
}

func TestA57_NoAnswerCanAskAgain(t *testing.T) {
	r := newRig(t, nil)
	r.answer = NoAnswer
	if status, out := r.do("POST", "/v1/pair", site, "", map[string]string{"code": "1111-2222"}); status != 408 || out["code"] != "no_answer" {
		t.Fatalf("no answer: %d %v", status, out)
	}
	r.answer = Yes
	r.pair(site)
	if len(r.asked) != 2 {
		t.Errorf("asked %v", r.asked)
	}
}

func TestA57_OneQuestionAtATime(t *testing.T) {
	release := make(chan struct{})
	asking := make(chan struct{})
	r := newRig(t, func(c *Config) {
		c.Ask = func(ctx context.Context, origin, code string) Answer {
			close(asking)
			<-release
			return Yes
		}
	})
	done := make(chan int)
	go func() {
		status, _ := r.do("POST", "/v1/pair", site, "", map[string]string{"code": "1111-2222"})
		done <- status
	}()
	<-asking
	if status, out := r.do("POST", "/v1/pair", "https://other.example.org", "", map[string]string{"code": "3333-4444"}); status != 409 || out["code"] != "busy" {
		t.Errorf("a second question: %d %v", status, out)
	}
	close(release)
	if status := <-done; status != 200 {
		t.Errorf("first pairing: %d", status)
	}
}

func TestA57_AnAllowedSiteIsNotAsked(t *testing.T) {
	r := newRig(t, func(c *Config) { c.Allow = []string{site} })
	r.pair(site)
	r.pair(site)
	if len(r.asked) != 0 || !strings.Contains(r.log.String(), "allowed by --allow") {
		t.Errorf("asked %v, log %q", r.asked, r.log.String())
	}
}

func TestA57_WithoutATerminalOnlyAllowedSites(t *testing.T) {
	r := newRig(t, func(c *Config) {
		c.Ask = nil
		c.Allow = []string{site}
	})
	r.pair(site)
	if status, out := r.do("POST", "/v1/pair", "https://other.example.org", "", map[string]string{"code": "1111-2222"}); status != 403 || out["code"] != "cannot_ask" {
		t.Errorf("not allowed: %d %v", status, out)
	}
}

// channelRun sends one execute_request on the kernel's channel and returns the stdout it got.
func channelRun(t *testing.T, r *rig, origin, key, session, kernel, code string) string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	u := strings.Replace(r.base, "http://", "ws://", 1) + "/v1/sessions/" + session + "/kernels/" + kernel +
		"/channels?session_id=0f0f0f0f-1111-4222-8333-444455556666&key=" + key
	conn, resp, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {origin}}})
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		t.Fatalf("channel: %v (%d)", err, status)
	}
	defer conn.CloseNow()
	msg, _ := json.Marshal(map[string]any{
		"header":        map[string]any{"msg_id": "e1", "msg_type": "execute_request", "session": "s", "username": "", "version": "5.3"},
		"parent_header": map[string]any{}, "metadata": map[string]any{}, "channel": "shell",
		"content": map[string]any{"code": code, "silent": false, "store_history": true, "user_expressions": map[string]any{}, "allow_stdin": true, "stop_on_error": true},
	})
	if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("channel read: %v", err)
		}
		var m struct {
			Header  map[string]any `json:"header"`
			Parent  map[string]any `json:"parent_header"`
			Content map[string]any `json:"content"`
		}
		json.Unmarshal(data, &m)
		if m.Parent["msg_id"] != "e1" {
			continue
		}
		switch m.Header["msg_type"] {
		case "stream":
			out.WriteString(m.Content["text"].(string))
		case "execute_reply":
			return out.String()
		}
	}
}

func TestA57_RunsACellOnThisComputer(t *testing.T) {
	r := newRig(t, nil)
	key := r.pair(site)
	opened := r.openSession(site, key, nil)
	var keys []string
	for k := range opened {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	// What the page learns: no token, no port, no absolute path.
	if strings.Join(keys, ",") != "folder,jupyter,kernelspecs,runtime,session" {
		t.Errorf("open answered %v", opened)
	}
	if opened["folder"] != "course.example.org/statistics/means/demo" || opened["runtime"] != "Python 3.12.8" {
		t.Errorf("open answered %v", opened)
	}
	session := opened["session"].(string)
	dir := filepath.Join(r.root, "course.example.org", "statistics", "means", "demo")
	recs := jupytertest.Records(t, r.stub)
	if len(recs) != 1 || recs[0].Dir != dir || !recs[0].TokenInEnv || !strings.HasPrefix(recs[0].Listen, "127.0.0.1:") {
		t.Fatalf("Jupyter records %+v", recs)
	}
	for _, a := range recs[0].Argv {
		if strings.Contains(strings.ToLower(a), "token=") {
			t.Errorf("the token is on the command line: %q", a)
		}
	}

	kernel := r.startKernel(site, key, session)
	if got := channelRun(t, r, site, key, session, kernel, "print(2 + 2)"); got != "4\n" {
		t.Errorf("the cell printed %q", got)
	}
	if status, out := r.do("GET", "/v1/sessions/"+session+"/kernels/"+kernel, site, key, nil); status != 200 || out["id"] != kernel {
		t.Errorf("kernel state: %d %v", status, out)
	}
	if status, _ := r.do("POST", "/v1/sessions/"+session+"/kernels/"+kernel+"/interrupt", site, key, nil); status != 200 {
		t.Errorf("interrupt: %d", status)
	}
	if status, _ := r.do("POST", "/v1/sessions/"+session+"/kernels/"+kernel+"/restart", site, key, nil); status != 200 {
		t.Errorf("restart: %d", status)
	}
	if status, _ := r.do("DELETE", "/v1/sessions/"+session+"/kernels/"+kernel, site, key, nil); status != 204 {
		t.Errorf("shut down the kernel: %d", status)
	}
	if status, _ := r.do("GET", "/v1/sessions/"+session+"/kernels/"+kernel, site, key, nil); status != 403 {
		t.Errorf("a kernel shut down is still reachable: %d", status)
	}
	if status, _ := r.do("DELETE", "/v1/sessions/"+session, site, key, nil); status != 204 {
		t.Errorf("stop: %d", status)
	}
	if r.svc.Sessions() != 0 {
		t.Errorf("%d sessions after stop", r.svc.Sessions())
	}
	if status, _ := r.do("GET", "/v1/sessions/"+session, site, key, nil); status != 404 {
		t.Errorf("a stopped session answers %d", status)
	}
	if !processGone(recs[0].PID) {
		t.Errorf("Jupyter %d still runs after Stop", recs[0].PID)
	}
}

func processGone(pid int) bool {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !pidAlive(pid) {
			return true
		}
		time.Sleep(50 * time.Millisecond)
	}
	return false
}

func TestA57_OnlyTheAllowlistReachesJupyter(t *testing.T) {
	r := newRig(t, nil)
	key := r.pair(site)
	session := r.openSession(site, key, nil)["session"].(string)
	base := "/v1/sessions/" + session
	// A body naming more than the kernel (a path, an environment) is refused.
	for _, body := range []any{
		map[string]any{"name": "python3", "path": "/etc"},
		map[string]any{"name": "python3", "env": map[string]string{"PATH": "/tmp"}},
		map[string]any{"name": "../python3"},
	} {
		if status, out := r.do("POST", base+"/kernels", site, key, body); status != 403 || out["code"] != string(protocol.CodePathNotAllowed) {
			t.Errorf("kernel start %v: %d %v", body, status, out)
		}
	}
	// A kernel this session did not start, and an action the allowlist does not serve.
	guessed := "0f0f0f0f-1111-4222-8333-444455556666"
	if status, _ := r.do("POST", base+"/kernels/"+guessed+"/interrupt", site, key, nil); status != 403 {
		t.Errorf("another kernel: %d", status)
	}
	kernel := r.startKernel(site, key, session)
	if status, _ := r.do("POST", base+"/kernels/"+kernel+"/channels", site, key, nil); status != 403 {
		t.Errorf("POST channels: %d", status)
	}
	// Another page of the same site, with its own key, cannot reach this page's session.
	key2 := r.pair(site)
	if status, _ := r.do("GET", base, site, key2, nil); status != 404 {
		t.Errorf("another page's key: %d", status)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ws := strings.Replace(r.base, "http://", "ws://", 1) + base + "/kernels/" + kernel + "/channels?session_id=0f0f0f0f-1111-4222-8333-444455556666&key="
	if _, resp, err := websocket.Dial(ctx, ws+key2, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {site}}}); err == nil || resp == nil || resp.StatusCode != 404 {
		t.Errorf("channel with another page's key: %v", err)
	}
	if _, resp, err := websocket.Dial(ctx, ws+key, &websocket.DialOptions{HTTPHeader: http.Header{"Origin": {"https://other.example.org"}}}); err == nil || resp == nil || resp.StatusCode != 401 {
		t.Errorf("channel from another origin: %v", err)
	}
	if _, resp, err := websocket.Dial(ctx, strings.Replace(ws, "session_id=0f0f0f0f-1111-4222-8333-444455556666", "session_id=x", 1)+key,
		&websocket.DialOptions{HTTPHeader: http.Header{"Origin": {site}}}); err == nil || resp == nil || resp.StatusCode != 403 {
		t.Errorf("channel without a session id: %v", err)
	}
	// Two kernels at most.
	r.startKernel(site, key, session)
	if status, _ := r.do("POST", base+"/kernels", site, key, map[string]string{"name": "python3"}); status != 429 {
		t.Errorf("a third kernel: %d", status)
	}
}

func TestA57_SessionsAreCapped(t *testing.T) {
	r := newRig(t, nil)
	key := r.pair(site)
	for i := 0; i < MaxSessions; i++ {
		r.openSession(site, key, nil)
	}
	if status, out := r.do("POST", "/v1/sessions", site, key, map[string]any{"folder": []string{"x"}}); status != 429 || out["code"] != "too_many_sessions" {
		t.Errorf("one more: %d %v", status, out)
	}
}

func TestA57_FolderNamesStayInsideTheWorkspace(t *testing.T) {
	r := newRig(t, nil)
	key := r.pair(site)
	status, out := r.do("POST", "/v1/sessions", site, key, map[string]any{"folder": []string{"..", "../../etc", "a/b", ".hidden"}})
	if status != 400 {
		// ".." has no letters; refused before anything is made.
		t.Fatalf("dots: %d %v", status, out)
	}
	status, out = r.do("POST", "/v1/sessions", site, key, map[string]any{"folder": []string{"../../etc", "a/b", ".hidden", "Means & Medians"}})
	if status != 201 || out["folder"] != "course.example.org/etc/a-b/hidden/Means-Medians" {
		t.Errorf("sanitised: %d %v", status, out)
	}
	if status, _ := r.do("POST", "/v1/sessions", site, key, map[string]any{"folder": []string{}}); status != 400 {
		t.Errorf("no folder: %d", status)
	}
	if status, _ := r.do("POST", "/v1/sessions", site, key, map[string]any{"folder": []string{"a"}, "workspace": "/"}); status != 400 {
		t.Errorf("an unknown field: %d", status)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(r.root), "etc")); err == nil {
		t.Errorf("a folder was made outside the workspace")
	}
}

// zipOf builds a zip as a level 0 build does: one folder named as the notebook.
func zipOf(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	slices.Sort(names)
	for _, n := range names {
		w, err := zw.Create(n)
		if err != nil {
			t.Fatal(err)
		}
		w.Write([]byte(files[n]))
	}
	zw.Close()
	return buf.Bytes()
}

func objectName(data []byte) string {
	sum := sha256.Sum256(data)
	return "/content/o/" + hex.EncodeToString(sum[:]) + ".zip"
}

func TestA57_TheNotebooksFilesAreCopiedAndTheVisitorsKept(t *testing.T) {
	data := zipOf(t, map[string]string{
		"demo/demo.ipynb":       `{"cells": []}`,
		"demo/data/heights.csv": "h\n170\n",
		"demo/data/weights.csv": "w\n70\n",
	})
	var hits int
	files := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		hits++
		switch req.URL.Path {
		case objectName(data):
			w.Write(data)
		case "/content/o/" + strings.Repeat("a", 64) + ".zip":
			w.Write(data) // bytes that are not the ones the name promises
		default:
			http.Redirect(w, req, objectName(data), http.StatusFound)
		}
	}))
	defer files.Close()
	r := newRig(t, nil)
	key := r.pair(site)
	dir := filepath.Join(r.root, "course.example.org", "statistics", "means", "demo")
	os.MkdirAll(filepath.Join(dir, "data"), 0o755)
	// The visitor changed one file already; it is theirs and stays.
	os.WriteFile(filepath.Join(dir, "data", "weights.csv"), []byte("mine\n"), 0o644)

	url := files.URL + objectName(data)
	out := r.openSession(site, key, &url)
	got := out["files"].(map[string]any)
	if fmt.Sprint(got["written"]) != "[data/heights.csv demo.ipynb]" || fmt.Sprint(got["kept"]) != "[data/weights.csv]" {
		t.Errorf("files %v", got)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "data", "heights.csv")); string(b) != "h\n170\n" {
		t.Errorf("heights.csv = %q", b)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "data", "weights.csv")); string(b) != "mine\n" {
		t.Errorf("the visitor's weights.csv became %q", b)
	}
	// Connecting again writes nothing new: the same files are left as they are.
	out = r.openSession(site, key, &url)
	if got := out["files"].(map[string]any); fmt.Sprint(got["written"]) != "[]" {
		t.Errorf("second connect wrote %v", got)
	}
	for _, bad := range []string{
		files.URL + "/content/o/" + strings.Repeat("a", 64) + ".zip", // wrong bytes
		files.URL + "/content/o/" + strings.Repeat("b", 64) + ".zip", // a redirect, not followed
	} {
		status, out := r.do("POST", "/v1/sessions", site, key, map[string]any{"folder": []string{"other"}, "files": bad})
		if status != 502 || out["code"] != "files_unavailable" {
			t.Errorf("%s: %d %v", bad, status, out)
		}
	}
	for _, bad := range []string{
		"https://course.example.org/content/demo.zip", "http://course.example.org" + objectName(data),
		"file:///etc/passwd", "https://user:pw@course.example.org" + objectName(data), files.URL + objectName(data) + "?x=1",
	} {
		if status, _ := r.do("POST", "/v1/sessions", site, key, map[string]any{"folder": []string{"other"}, "files": bad}); status != 400 {
			t.Errorf("%s: %d", bad, status)
		}
	}
}

func TestA57_ExtractWritesOnlyPlainFilesInsideTheFolder(t *testing.T) {
	for name, files := range map[string]map[string]string{
		"parent":      {"demo/../escape.txt": "x"},
		"absolute":    {"/etc/x": "x"},
		"backslash":   {"demo\\..\\x": "x"},
		"drive":       {"demo/C:x": "x"},
		"two folders": {"demo/a.csv": "a", "other/b.csv": "b"},
		"top level":   {"a.csv": "a"},
		"dot":         {"demo/./a.csv": "a"},
	} {
		dir := t.TempDir()
		if _, _, err := Extract(zipOf(t, files), dir); err == nil {
			t.Errorf("%s: extracted", name)
		}
		if entries, _ := os.ReadDir(dir); len(entries) != 0 {
			t.Errorf("%s: wrote %v", name, entries)
		}
	}
	// A link entry is refused.
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	h := &zip.FileHeader{Name: "demo/link"}
	h.SetMode(os.ModeSymlink | 0o777)
	w, _ := zw.CreateHeader(h)
	w.Write([]byte("/etc/passwd"))
	zw.Close()
	if _, _, err := Extract(buf.Bytes(), t.TempDir()); err == nil {
		t.Error("a link was extracted")
	}
	if _, _, err := Extract([]byte("not a zip"), t.TempDir()); err == nil {
		t.Error("not a zip was extracted")
	}
	// A link already in the folder is never written through.
	if runtime.GOOS != "windows" {
		dir := t.TempDir()
		outside := filepath.Join(t.TempDir(), "outside.csv")
		os.WriteFile(outside, []byte("keep"), 0o644)
		os.Symlink(outside, filepath.Join(dir, "a.csv"))
		written, kept, err := Extract(zipOf(t, map[string]string{"demo/a.csv": "new"}), dir)
		if err != nil || len(written) != 0 || fmt.Sprint(kept) != "[a.csv]" {
			t.Errorf("through a link: %v %v %v", written, kept, err)
		}
		if b, _ := os.ReadFile(outside); string(b) != "keep" {
			t.Errorf("the link's target became %q", b)
		}
	}
}

func TestA57_IdleSessionsStop(t *testing.T) {
	var mu sync.Mutex
	now := time.Now()
	r := newRig(t, func(c *Config) {
		c.IdleStop = time.Minute
		c.SweepEvery = 20 * time.Millisecond
		c.Now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	})
	key := r.pair(site)
	r.openSession(site, key, nil)
	recs := jupytertest.Records(t, r.stub)
	mu.Lock()
	now = now.Add(2 * time.Minute)
	mu.Unlock()
	deadline := time.Now().Add(15 * time.Second)
	for r.svc.Sessions() != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if r.svc.Sessions() != 0 || !processGone(recs[0].PID) {
		t.Errorf("an idle session still runs")
	}
}

func TestA57_CloseStopsEverySession(t *testing.T) {
	r := newRig(t, nil)
	key := r.pair(site)
	r.openSession(site, key, nil)
	r.openSession(site, key, nil)
	recs := jupytertest.Records(t, r.stub)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	r.svc.Close(ctx)
	for _, rec := range recs {
		if !processGone(rec.PID) {
			t.Errorf("Jupyter %d still runs after Close", rec.PID)
		}
	}
	if status, out := r.do("POST", "/v1/pair", site, "", map[string]string{"code": "1111-2222"}); status != 503 {
		t.Errorf("pair after Close: %d %v", status, out)
	}
}
