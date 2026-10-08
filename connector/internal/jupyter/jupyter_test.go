package jupyter

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"parallax/connector/internal/jupyter/jupytertest"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/redact"
)

func TestMain(m *testing.M) {
	jupytertest.RunIfStub()
	os.Exit(m.Run())
}

const (
	k1 = "9d3c0a52-6f1e-4c0b-8d57-1a2b3c4d5e6f"
	k2 = "11111111-2222-4333-8444-555555555555"
	s1 = "7b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
)

func ownScope(root string) Scope {
	k := &Kernels{}
	k.Add(k1)
	return Scope{Kernels: k, ContentRoot: root}
}

func refusedWith(t *testing.T, err error, code protocol.Code) {
	t.Helper()
	var r *Refusal
	if !errors.As(err, &r) || r.Code != code {
		t.Fatalf("got %v, want a refusal with %s", err, code)
	}
}

func TestAllowlistAcceptsEveryRow(t *testing.T) {
	s := ownScope("")
	cases := []struct {
		purpose, method, path string
		op                    Op
		uri                   string
	}{
		{"session", "GET", "/api/status", OpStatus, "/api/status"},
		{"session", "GET", "/api/kernelspecs", OpKernelspecs, "/api/kernelspecs"},
		{"session", "GET", "/api/kernels", OpListKernels, "/api/kernels"},
		{"session", "GET", "/api/kernels/" + k1, OpKernelState, "/api/kernels/" + k1},
		{"session", "POST", "/api/kernels", OpStartKernel, "/api/kernels"},
		{"session", "DELETE", "/api/kernels/" + k1, OpDeleteKernel, "/api/kernels/" + k1},
		{"session", "POST", "/api/kernels/" + k1 + "/interrupt", OpInterruptKernel, "/api/kernels/" + k1 + "/interrupt"},
		{"session", "POST", "/api/kernels/" + k1 + "/restart", OpRestartKernel, "/api/kernels/" + k1 + "/restart"},
		{"contents", "GET", "/api/contents/data/a.csv?content=1&type=file&format=text&hash=0", OpContentsGet, "/api/contents/data/a.csv?content=1&format=text&hash=0&type=file"},
		{"contents", "GET", "/api/contents", OpContentsGet, "/api/contents"},
		{"contents", "GET", "/api/contents/", OpContentsGet, "/api/contents/"},
		{"contents", "PUT", "/api/contents/data/a.csv", OpContentsPut, "/api/contents/data/a.csv"},
		{"contents", "PUT", "/api/contents/My%20Notebook.ipynb", OpContentsPut, "/api/contents/My Notebook.ipynb"},
		{"contents", "POST", "/api/contents/data", OpContentsPost, "/api/contents/data"},
		{"contents", "DELETE", "/api/contents/data/a.csv", OpContentsDelete, "/api/contents/data/a.csv"},
	}
	for _, c := range cases {
		r, err := CheckHTTP(c.purpose, c.method, c.path, s)
		if err != nil {
			t.Errorf("%s %s %s refused: %v", c.purpose, c.method, c.path, err)
			continue
		}
		uri := r.Path
		if r.RawQuery != "" {
			uri += "?" + r.RawQuery
		}
		if r.Op != c.op || uri != c.uri {
			t.Errorf("%s %s = %+v, want op %d uri %q", c.method, c.path, r, c.op, c.uri)
		}
	}
	r, err := CheckWS("/api/kernels/"+k1+"/channels?session_id="+s1, nil, s)
	if err != nil || r.Op != OpChannels || r.KernelID != k1 {
		t.Errorf("kernel channel: %+v, %v", r, err)
	}
}

func TestAllowlistRefusesPathTricks(t *testing.T) {
	s := ownScope("")
	paths := []string{
		"/api/contents/../secret",
		"/api/contents/a/../../etc/passwd",
		"/api/contents/%2e%2e/secret",
		"/api/contents/%2E%2E/secret",
		"/api/contents/a%2f..%2fsecret",
		"/api/contents/%252e%252e/secret",
		"/api/contents/a%2520b",
		"/api/contents/./a.csv",
		"/api/contents/.ssh/id_ed25519",
		"/api/contents/data/.env",
		"/api/contents/.ipynb_checkpoints/a.ipynb",
		"/api/contents//etc/passwd",
		"/api/contents/a\\..\\b",
		"/api/contents/a%5c..%5cb",
		"/api/contents/a%00b",
		"/api/contents/a%0ab",
		"/api/contents/a.csv?token=abc",
		"/api/contents/a.csv?TOKEN=abc",
		"/api/contents/a.csv?_xsrf=abc",
		"/api/contents/a.csv?content=1&content=0",
		"/api/contents/a.csv?path=/etc",
		"/api/contents/a.csv?copy_from=/etc/passwd",
		"/api/contents/a.csv?format=../x",
		"/api/contents/a.csv#frag",
		"/api/contents/" + strings.Repeat("a", 1100),
		"/api/contents/a.csv%",
		"/api/contents/a%3Ftoken=x",
		"/api/contents/a%3ftoken=x",
		"/api/contents/a%3F_xsrf=1",
		"/api/contents/a%3Fcontent=1",
		"/api/contents/a%23frag",
		"/api/contents/dir%3F/b.csv",
	}
	for _, p := range paths {
		for _, m := range []string{"GET", "PUT"} {
			if _, err := CheckHTTP("contents", m, p, s); err == nil {
				t.Errorf("%s %q accepted", m, p)
			} else {
				refusedWith(t, err, protocol.CodePathNotAllowed)
			}
		}
	}
}

func TestAllowlistRefusesUnservedPathsAndMethods(t *testing.T) {
	s := ownScope("")
	cases := []struct{ purpose, method, path string }{
		{"session", "GET", "/api/sessions"},
		{"session", "POST", "/api/sessions"},
		{"session", "POST", "/api/shutdown"},
		{"session", "GET", "/api/terminals"},
		{"session", "POST", "/api/terminals"},
		{"session", "GET", "/api/config/notebook"},
		{"session", "GET", "/api/me"},
		{"session", "GET", "/api/nbconvert"},
		{"session", "GET", "/api/events"},
		{"session", "GET", "/api/kernelspecs/python3"},
		{"session", "GET", "/api"},
		{"session", "GET", "/api/status?token=x"},
		{"session", "GET", "/api/status?x=1"},
		{"session", "PUT", "/api/kernels"},
		{"session", "DELETE", "/api/kernels"},
		{"session", "PATCH", "/api/kernels/" + k1},
		{"session", "POST", "/api/kernels/" + k1},
		{"session", "GET", "/api/kernels/" + k1 + "/interrupt"},
		{"session", "POST", "/api/kernels/" + k1 + "/shutdown"},
		{"session", "GET", "/api/kernels/" + k1 + "/channels"},
		{"session", "GET", "/api/contents/a.csv"},
		{"contents", "GET", "/api/kernels"},
		{"contents", "PATCH", "/api/contents/a.csv"},
		{"contents", "POST", "/api/contents/a.csv?type=file"},
		{"contents", "DELETE", "/api/contents/a.csv?hash=1"},
		{"contents", "PUT", "/api/contents"},
		{"contents", "DELETE", "/api/contents/"},
		{"other", "GET", "/api/status"},
	}
	for _, c := range cases {
		_, err := CheckHTTP(c.purpose, c.method, c.path, s)
		if err == nil {
			t.Errorf("%s %s %s accepted", c.purpose, c.method, c.path)
			continue
		}
		refusedWith(t, err, protocol.CodePathNotAllowed)
	}
	for _, p := range []string{
		"/api/kernels/" + k1 + "/channels",
		"/api/kernels/" + k1 + "/channels?session_id=x",
		"/api/kernels/" + k1 + "/channels?session_id=" + s1 + "&token=x",
		"/api/kernels/" + k1 + "/channels?session_id=" + s1 + "&other=1",
		"/api/kernels/" + k2 + "/channels?session_id=" + s1,
		"/api/terminals/websocket/1",
		"/api/events/subscribe",
	} {
		_, err := CheckWS(p, nil, s)
		refusedWith(t, err, protocol.CodePathNotAllowed)
	}
	_, err := CheckWS("/api/kernels/"+k1+"/channels?session_id="+s1, []string{"v1.kernel.websocket.jupyter.org"}, s)
	refusedWith(t, err, protocol.CodePathNotAllowed)
}

func TestKernelIdsConfinedToSession(t *testing.T) {
	k := &Kernels{}
	s := Scope{Kernels: k}
	other := k2
	for _, p := range []string{"/api/kernels/" + other, "/api/kernels/" + other + "/interrupt", "/api/kernels/" + other + "/restart"} {
		for _, m := range []string{"GET", "DELETE", "POST"} {
			if _, err := CheckHTTP("session", m, p, s); err == nil {
				t.Errorf("%s %s accepted for a kernel the session did not create", m, p)
			}
		}
	}
	if _, err := CheckWS("/api/kernels/"+other+"/channels?session_id="+s1, nil, s); err == nil {
		t.Error("channel accepted for a kernel the session did not create")
	}
	// Once the session created the kernel, its id is accepted; once deleted, refused again.
	k.Add(other)
	if _, err := CheckHTTP("session", "GET", "/api/kernels/"+other, s); err != nil {
		t.Errorf("own kernel refused: %v", err)
	}
	k.Remove(other)
	if _, err := CheckHTTP("session", "GET", "/api/kernels/"+other, s); err == nil {
		t.Error("deleted kernel still accepted")
	}
	// Uppercase or malformed ids never match.
	upper := strings.ToUpper(k1)
	k.Add(upper)
	if _, err := CheckHTTP("session", "GET", "/api/kernels/"+upper, s); err == nil {
		t.Error("an uppercase id was accepted")
	}
	k.Remove(upper)

	// The kernel list an attached server answers is filtered to the session's kernels.
	k.Add(k1)
	body := `[{"id":"` + k1 + `","name":"python3"},{"id":"` + k2 + `","name":"python3"}]`
	got, err := FilterKernelList([]byte(body), k)
	if err != nil || strings.Contains(string(got), k2) || !strings.Contains(string(got), k1) {
		t.Errorf("FilterKernelList = %s, %v", got, err)
	}
}

func TestAllowlistContentRootIsSegmentWise(t *testing.T) {
	s := ownScope("parallax")
	for _, p := range []string{"/api/contents/parallax/a.csv", "/api/contents/parallax/sub/b.ipynb"} {
		if _, err := CheckHTTP("contents", "PUT", p, s); err != nil {
			t.Errorf("%s refused: %v", p, err)
		}
	}
	if _, err := CheckHTTP("contents", "GET", "/api/contents/parallax", s); err != nil {
		t.Errorf("listing the workspace refused: %v", err)
	}
	for _, p := range []string{"/api/contents/parallax-private/a.csv", "/api/contents/other/a.csv", "/api/contents/a.csv", "/api/contents", "/api/contents/parallaxx"} {
		if _, err := CheckHTTP("contents", "GET", p, s); err == nil {
			t.Errorf("%s accepted outside the content root", p)
		}
	}
	for _, m := range []string{"PUT", "DELETE"} {
		if _, err := CheckHTTP("contents", m, "/api/contents/parallax", s); err == nil {
			t.Errorf("%s of the workspace itself accepted", m)
		}
	}
}

// P3-09b: only a content root the relay could name in a contents request is reported.
func TestAddressableContentRoot(t *testing.T) {
	for _, root := range []string{"", "parallax", "course/week 1", "data-2026"} {
		if !Addressable(root) {
			t.Errorf("%q not addressable", root)
		}
	}
	for _, root := range []string{".work", "a/.hidden", "a//b", "a/", "/abs", "a/..", "a\\b", "a%41b", "q?x", "h#x", "nul\x00", strings.Repeat("a", 1025)} {
		if Addressable(root) {
			t.Errorf("%q addressable", root)
		}
	}
}

func TestContentsPostBodyRestricted(t *testing.T) {
	for _, ok := range []string{`{}`, `{"type":"file"}`, `{"type":"notebook","ext":".ipynb"}`, `{"type":"directory"}`} {
		if err := CheckContentsPost([]byte(ok)); err != nil {
			t.Errorf("%s refused: %v", ok, err)
		}
	}
	for _, bad := range []string{
		`{"copy_from":"/etc/passwd"}`,
		`{"type":"file","copy_from":"../x"}`,
		`{"type":"file","path":"/etc"}`,
		`{"type":"file","content":"x"}`,
		`{"type":1}`,
		`{"ext":"../../x"}`,
		`[]`,
		`not json`,
	} {
		err := CheckContentsPost([]byte(bad))
		refusedWith(t, err, protocol.CodePathNotAllowed)
	}
	refusedWith(t, CheckContentsPost([]byte(`{"type":"`+strings.Repeat("a", 2000)+`"}`)), protocol.CodeBodyTooLarge)

	if name, err := CheckKernelStart([]byte(`{"name":"python3"}`)); err != nil || name != "python3" {
		t.Errorf("kernel start: %q, %v", name, err)
	}
	for _, bad := range []string{`{"name":"python3","path":"/etc"}`, `{"name":"../x"}`, `{"name":""}`, `{}`, `{"env":{"A":"1"},"name":"python3"}`} {
		if _, err := CheckKernelStart([]byte(bad)); err == nil {
			t.Errorf("kernel start body %s accepted", bad)
		}
	}
}

func fakeJupyter(t *testing.T, token string) (*jupytertest.Server, *Client) {
	t.Helper()
	fake := jupytertest.New(token)
	srv := httptest.NewServer(fake)
	t.Cleanup(srv.Close)
	port := srv.Listener.Addr().(interface{ String() string }).String()
	_, p, _ := strings.Cut(port, ":")
	n := 0
	for _, r := range p {
		n = n*10 + int(r-'0')
	}
	return fake, NewClient(n, token, LoopbackDial(n))
}

// TestURLHasOnlyTheApprovedQuery: what reaches Jupyter is exactly the path and the query the
// allowlist approved; an encoded ? or # cannot start a query of its own.
func TestURLHasOnlyTheApprovedQuery(t *testing.T) {
	fake, c := fakeJupyter(t, "tok-query-0123456789")
	for _, raw := range []string{"/api/contents/a%3Ftoken=x", "/api/contents/a%23x?content=1"} {
		if _, err := CheckHTTP("contents", "GET", raw, ownScope("")); err == nil {
			t.Errorf("%s accepted", raw)
		}
	}
	r, err := CheckHTTP("contents", "GET", "/api/contents/data/My%20File.csv?type=file&content=1", ownScope(""))
	if err != nil {
		t.Fatal(err)
	}
	resp, err := c.Do(context.Background(), "GET", r.Path, r.RawQuery, nil, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	// Even a path holding ? and # (which the allowlist refuses) is escaped, never split.
	resp, err = c.Do(context.Background(), "GET", "/api/contents/a?token=x#y", "", nil, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	got := fake.Requests()
	if len(got) != 2 {
		t.Fatalf("%d requests", len(got))
	}
	if got[0].URI != "/api/contents/data/My%20File.csv?content=1&type=file" {
		t.Errorf("first request %q", got[0].URI)
	}
	if got[1].URI != "/api/contents/a%3Ftoken=x%23y" {
		t.Errorf("second request %q: the path became a query", got[1].URI)
	}
}

func TestHeadersFiltered(t *testing.T) {
	fake, c := fakeJupyter(t, "tok-headers-0123456789")
	resp, err := c.Do(context.Background(), "GET", "/api/kernelspecs", "", protocol.Headers{
		"accept":        "application/json",
		"content-type":  "application/json",
		"cookie":        "session=stolen",
		"authorization": "token relay-chosen",
		"x-forwarded":   "1",
		"origin":        "https://evil.example",
		"host":          "169.254.169.254",
	}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	got := fake.Requests()[0]
	if got.Header.Get("Cookie") != "" || got.Header.Get("X-Forwarded") != "" || got.Header.Get("Origin") != "" {
		t.Errorf("relay headers passed on: %v", got.Header)
	}
	if got.Header.Get("Authorization") != "token tok-headers-0123456789" {
		t.Errorf("Authorization = %q", got.Header.Get("Authorization"))
	}
	if got.Header.Get("Accept") != "application/json" || got.Header.Get("Content-Type") != "application/json" {
		t.Errorf("accept/content-type lost: %v", got.Header)
	}
	h := FilterResponseHeaders(resp.Header)
	if h["content-type"] != "application/json" {
		t.Errorf("content-type dropped: %v", h)
	}
	for k := range h {
		switch k {
		case "content-type", "content-length", "etag", "last-modified", "cache-control":
		default:
			t.Errorf("response header %s passed on", k)
		}
	}
	extra := http.Header{"Set-Cookie": {"a=b"}, "Location": {"http://x"}, "Server": {"T"}, "X-Frame-Options": {"DENY"}, "Etag": {`"1"`}, "Cache-Control": {"no-store\r\nX: y"}}
	h = FilterResponseHeaders(extra)
	if len(h) != 1 || h["etag"] != `"1"` {
		t.Errorf("FilterResponseHeaders = %v", h)
	}
}

func TestNoRedirectsFollowed(t *testing.T) {
	fake, c := fakeJupyter(t, "tok-redirect-0123456789")
	resp, err := c.Do(context.Background(), "GET", "/api/redirect", "", nil, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Errorf("status %d: the redirect was followed", resp.StatusCode)
	}
	if len(fake.Requests()) != 1 {
		t.Errorf("%d requests: the redirect was followed", len(fake.Requests()))
	}
	if _, ok := FilterResponseHeaders(resp.Header)["location"]; ok {
		t.Error("Location passed on")
	}
	// The client dials only the session's server, whatever the URL names, and uses no proxy.
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	req, _ := http.NewRequest("GET", "http://169.254.169.254/api/status", nil)
	req.Header.Set("Authorization", "token tok-redirect-0123456789")
	resp, err = c.hc.Do(req)
	if err != nil {
		t.Fatalf("request with another host: %v", err)
	}
	resp.Body.Close()
	if n := len(fake.Requests()); n != 2 {
		t.Errorf("the request did not reach the session's server (%d requests)", n)
	}
}

// waitExit waits until the process has ended.
func waitExit(t *testing.T, p *Process) {
	t.Helper()
	select {
	case <-p.Exited():
	case <-time.After(10 * time.Second):
		t.Fatal("the process did not exit")
	}
}

type lines struct {
	mu sync.Mutex
	l  []string
}

func (l *lines) add(s string) {
	l.mu.Lock()
	l.l = append(l.l, s)
	l.mu.Unlock()
}

func (l *lines) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.l, "\n")
}

func TestLocalStartAndStatus(t *testing.T) {
	for _, viaPython := range []bool{false, true} {
		name := "jupyter from PATH"
		if viaPython {
			name = "python -m jupyter_server"
		}
		t.Run(name, func(t *testing.T) {
			dir := jupytertest.Install(t, "")
			ws := t.TempDir()
			python := ""
			if viaPython {
				python = jupytertest.Python(dir)
			}
			token, _ := NewToken()
			log := &lines{}
			p, err := Start(context.Background(), StartOptions{SessionID: s1, Workspace: ws, Python: python, Token: token, Log: log.add})
			if err != nil {
				t.Fatal(err)
			}
			if err := p.Client.Status(context.Background()); err != nil {
				t.Errorf("status: %v", err)
			}
			if v, err := p.Client.Version(context.Background()); err != nil || v != jupytertest.Version {
				t.Errorf("version %q, %v", v, err)
			}
			ks, err := p.Client.Kernelspecs(context.Background())
			if err != nil || !HasKernel(ks, "python3") || !HasKernel(ks, "ir") {
				t.Errorf("kernelspecs %v, %v", ks, err)
			}
			recs := jupytertest.Records(t, dir)
			if len(recs) != 1 {
				t.Fatalf("%d servers started", len(recs))
			}
			r := recs[0]
			argv := strings.Join(r.Argv[1:], " ")
			wantFlags := strings.Join(ServerFlags(p.Port, ws, s1), " ")
			if !strings.HasSuffix(argv, wantFlags) {
				t.Errorf("argv %q does not end with the fixed flags %q", argv, wantFlags)
			}
			if viaPython && !strings.HasPrefix(argv, "-m jupyter_server ") || !viaPython && !strings.HasPrefix(argv, "server ") {
				t.Errorf("argv %q", argv)
			}
			if !strings.HasPrefix(r.Listen, "127.0.0.1:") || !r.TokenInEnv {
				t.Errorf("record %+v", r)
			}
			if same, _ := sameDir(r.Dir, ws); !same {
				t.Errorf("working directory %s, want %s", r.Dir, ws)
			}
			st, err := os.Stat(r.RuntimeDir)
			if err != nil || st.Mode().Perm() != 0o700 && os.PathSeparator == '/' {
				t.Errorf("runtime dir %s: %v %v", r.RuntimeDir, st, err)
			}
			if err := p.Stop(context.Background(), DefaultStopTimes); err != nil {
				t.Fatal(err)
			}
			waitExit(t, p)
			if _, err := os.Stat(r.RuntimeDir); !os.IsNotExist(err) {
				t.Errorf("runtime dir kept after stop: %v", err)
			}
		})
	}
}

func sameDir(a, b string) (bool, error) {
	ea, err := filepath.EvalSymlinks(a)
	if err != nil {
		return false, err
	}
	eb, err := filepath.EvalSymlinks(b)
	return ea == eb, err
}

func TestStopEscalatesToKill(t *testing.T) {
	jupytertest.Install(t, "stubborn")
	token, _ := NewToken()
	p, err := Start(context.Background(), StartOptions{SessionID: s1, Workspace: t.TempDir(), Token: token})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if err := p.Stop(context.Background(), StopTimes{Shutdown: 200 * time.Millisecond, Terminate: 200 * time.Millisecond}); err != nil {
		t.Fatal(err)
	}
	if p.Running() {
		t.Fatal("Stop returned while the process runs")
	}
	if time.Since(start) < 200*time.Millisecond {
		t.Error("Stop did not wait for the shutdown request first")
	}
}

// A kernel that outlives its server keeps the server's output open; the stop still returns once
// the server itself has gone, rather than when the kernel lets go of the output.
func TestStopDoesNotWaitForOutputHeldByAChild(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the holder stub is POSIX only")
	}
	dir := jupytertest.Install(t, "holder")
	token, _ := NewToken()
	p, err := Start(context.Background(), StartOptions{SessionID: s1, Workspace: t.TempDir(), Token: token})
	if err != nil {
		t.Fatal(err)
	}
	recs := jupytertest.Records(t, dir)
	if len(recs) != 1 || recs[0].HolderPID == 0 {
		t.Fatalf("records: %+v", recs)
	}
	t.Cleanup(func() {
		if h, err := os.FindProcess(recs[0].HolderPID); err == nil {
			h.Kill()
		}
	})
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	if err := p.Stop(ctx, StopTimes{Shutdown: 2 * time.Second, Terminate: 200 * time.Millisecond}); err != nil {
		t.Fatalf("Stop: %v", err)
	}
	if p.Running() {
		t.Fatal("Stop returned while the process runs")
	}
}

func TestTokenNeverInArgvURLOrLog(t *testing.T) {
	dir := jupytertest.Install(t, "")
	token, _ := NewToken()
	log := &lines{}
	p, err := Start(context.Background(), StartOptions{SessionID: s1, Workspace: t.TempDir(), Token: token, Log: log.add})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	resp, err := p.Client.Do(ctx, "GET", "/api/contents/a.csv", "content=1", nil, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	conn, err := p.Client.DialChannel(ctx, "/api/kernels/"+k1+"/channels", "session_id="+s1)
	if err == nil {
		conn.CloseNow()
	}
	if strings.Contains(redact.Redact(token), token) {
		t.Error("the token is not registered for redaction while the session runs")
	}
	if err := p.Stop(ctx, DefaultStopTimes); err != nil {
		t.Fatal(err)
	}
	for _, r := range jupytertest.Records(t, dir) {
		if strings.Contains(strings.Join(r.Argv, " "), token) {
			t.Errorf("token in argv: %v", r.Argv)
		}
		if !r.TokenInEnv {
			t.Error("token not passed in JUPYTER_TOKEN")
		}
		if len(r.Requests) < 3 {
			t.Errorf("requests %v", r.Requests)
		}
		for _, u := range r.Requests {
			if strings.Contains(u, token) || strings.Contains(strings.ToLower(u), "token=") {
				t.Errorf("token in a request URL: %s", u)
			}
		}
	}
	if out := log.String(); strings.Contains(out, token) || !strings.Contains(out, "token="+redact.Placeholder) {
		t.Errorf("log not redacted:\n%s", out)
	}
	if strings.Contains(p.Output(), token) {
		t.Errorf("output tail holds the token")
	}
}

func TestRedactsTokenFromJupyterLog(t *testing.T) {
	jupytertest.Install(t, "exit")
	token, _ := NewToken()
	log := &lines{}
	_, err := Start(context.Background(), StartOptions{SessionID: s1, Workspace: t.TempDir(), Token: token, Log: log.add})
	var f *Failure
	if !errors.As(err, &f) || f.Code != protocol.CodeJupyterStartFailed {
		t.Fatalf("Start: %v, want jupyter_start_failed", err)
	}
	if strings.Contains(f.Detail, token) || !strings.Contains(f.Detail, redact.Placeholder) {
		t.Errorf("detail not redacted: %q", f.Detail)
	}
	if !strings.Contains(f.Detail, "Running as root") {
		t.Errorf("detail lacks the last lines: %q", f.Detail)
	}
	if strings.Contains(log.String(), token) {
		t.Errorf("log holds the token:\n%s", log)
	}
	if len([]rune(f.Detail)) > 512 {
		t.Errorf("detail longer than 512 characters")
	}
}

func TestStartTimesOut(t *testing.T) {
	jupytertest.Install(t, "hang")
	token, _ := NewToken()
	_, err := Start(context.Background(), StartOptions{SessionID: s1, Workspace: t.TempDir(), Token: token, ReadyTimeout: 500 * time.Millisecond, PollInterval: 50 * time.Millisecond})
	var f *Failure
	if !errors.As(err, &f) || f.Code != protocol.CodeJupyterStartTimeout {
		t.Fatalf("Start: %v, want jupyter_start_timeout", err)
	}
}

func TestProbeRuntime(t *testing.T) {
	cases := []struct {
		mode       string
		viaPython  bool
		want       protocol.Code
		wantPython string
	}{
		{"", false, "", ""},
		{"", true, "", "3.12.8"},
		{"old", false, protocol.CodeJupyterIncompatible, ""},
		{"old", true, protocol.CodeJupyterIncompatible, ""},
		{"missing", false, protocol.CodeJupyterMissing, ""},
		{"missing", true, protocol.CodeJupyterMissing, ""},
	}
	for _, c := range cases {
		dir := jupytertest.Install(t, c.mode)
		python := ""
		if c.viaPython {
			python = jupytertest.Python(dir)
		}
		info, err := ProbeRuntime(context.Background(), python)
		var f *Failure
		errors.As(err, &f)
		switch {
		case c.want == "" && err != nil:
			t.Errorf("%s/%v: %v", c.mode, c.viaPython, err)
		case c.want != "" && (f == nil || f.Code != c.want):
			t.Errorf("%s/%v: %v, want %s", c.mode, c.viaPython, err, c.want)
		case c.want == "" && (info.Version != jupytertest.Version || info.Python != c.wantPython):
			t.Errorf("%s/%v: info %+v", c.mode, c.viaPython, info)
		}
	}
	// An interpreter that does not exist, and a PATH without Jupyter.
	t.Setenv("PATH", t.TempDir())
	if _, err := ProbeRuntime(context.Background(), filepath.Join(t.TempDir(), "python")); !hasCode(err, protocol.CodeEnvironmentInvalid) {
		t.Errorf("missing interpreter: %v", err)
	}
	if _, err := ProbeRuntime(context.Background(), ""); !hasCode(err, protocol.CodeJupyterMissing) {
		t.Errorf("no jupyter on PATH: %v", err)
	}
}

func hasCode(err error, code protocol.Code) bool {
	var f *Failure
	return errors.As(err, &f) && f.Code == code
}

func TestAttachListsLoopbackOnly(t *testing.T) {
	out := strings.Join([]string{
		`{"base_url": "/", "hostname": "127.0.0.1", "password": false, "pid": 4242, "port": 8888, "root_dir": "/home/student", "secure": false, "sock": "", "token": "abc123def456", "url": "http://127.0.0.1:8888/", "version": "2.21.1"}`,
		`{"hostname": "localhost", "pid": 4243, "port": 8889, "root_dir": "/home/student/p", "token": "t2t2t2t2", "url": "http://localhost:8889/", "version": "2.21.1"}`,
		`{"hostname": "0.0.0.0", "pid": 4244, "port": 8890, "root_dir": "/srv", "token": "t3t3t3t3", "url": "http://0.0.0.0:8890/", "version": "2.21.1"}`,
		`{"hostname": "10.0.0.5", "pid": 4245, "port": 8891, "root_dir": "/srv", "token": "t4t4t4t4", "url": "http://10.0.0.5:8891/"}`,
		`{"hostname": "127.0.0.1", "pid": 4246, "port": 8892, "root_dir": "/home/student", "token": "", "url": "http://127.0.0.1:8892/"}`,
		`{"hostname": "127.0.0.1", "pid": 4247, "port": 80, "root_dir": "/", "token": "t6t6t6t6", "url": "http://127.0.0.1:80/"}`,
		`{"hostname": "127.0.0.1", "pid": 4248, "port": 0, "root_dir": "/", "token": "x", "sock": "/tmp/j.sock", "url": "http+unix://x"}`,
		`{"hostname": "127.0.0.1", "pid": 4249, "port": 8893, "root_dir": "/", "token": "t8t8t8t8", "url": "http://192.168.1.2:8893/"}`,
		`not json`,
	}, "\n")
	servers := ParseServerList([]byte(out))
	var attachable []int
	for _, s := range servers {
		if s.Attachable() {
			attachable = append(attachable, s.Port)
		}
	}
	if len(attachable) != 2 || attachable[0] != 8888 || attachable[1] != 8889 {
		t.Errorf("attachable ports %v, want [8888 8889]", attachable)
	}
	// The list itself, through the tool.
	jupytertest.Install(t, "")
	t.Setenv(jupytertest.EnvList, out)
	got, err := ListServers(context.Background(), "")
	if err != nil || len(got) != 7 {
		t.Fatalf("ListServers: %d servers, %v", len(got), err)
	}
}

func TestCLIKernelspecs(t *testing.T) {
	jupytertest.Install(t, "")
	ks, err := CLIKernelspecs(context.Background(), "")
	if err != nil || len(ks) != 2 || ks[0].Name != "ir" || ks[1].DisplayName != "Python 3 (ipykernel)" {
		t.Errorf("CLIKernelspecs = %+v, %v", ks, err)
	}
}

// TestA27_JupyterTextSanitized (A27): what a Jupyter child prints and the kernel names it lists
// reach the terminal log and the web app without escape sequences, C1 controls (the one-byte
// CSI 0x9b) or format characters.
func TestA27_JupyterTextSanitized(t *testing.T) {
	specs, err := ParseKernelspecList([]byte(`{"kernelspecs": {"py": {"spec": {"display_name": "Py\u009b2J‮thon 3\n(x)", "language": "py\u0085thon"}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(specs) != 1 || specs[0].DisplayName != "Python 3 (x)" || specs[0].Language != "python" {
		t.Errorf("kernelspecs %+v", specs)
	}
	log := &lines{}
	out := &tail{token: "unused-token-0123", log: log.add}
	out.read(strings.NewReader("[I] Serving\u009b2J \x1b[31mred\x1b[0m​\n"))
	if got := log.String(); strings.ContainsAny(got, "\u009b\x1b​") || !strings.Contains(got, "[I] Serving red") {
		t.Errorf("log line %q", got)
	}
}
