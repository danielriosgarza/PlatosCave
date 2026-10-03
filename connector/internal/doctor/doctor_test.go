package doctor

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"parallax/connector/internal/identity"
	"parallax/connector/internal/pairing"
	"parallax/connector/internal/state"
	"parallax/connector/internal/testserver"
)

// pairedEnv is a computer paired with srv: private state directory, identity and config.
func pairedEnv(t *testing.T, server string, client *http.Client) Env {
	t.Helper()
	s := state.Open(filepath.Join(t.TempDir(), "state"))
	id, err := identity.Generate()
	if err != nil {
		t.Fatal(err)
	}
	pemBytes, _ := id.MarshalPEM()
	if err := s.WritePrivate(state.IdentityFile, pemBytes); err != nil {
		t.Fatal(err)
	}
	origin, err := pairing.NormaliseServer(server)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.WriteConfig(state.Config{V: 1, Server: origin, ConnectorID: "3f2a6c1e-8b7d-4e5f-9a10-2c4d6e8f0a1b", Name: "Lab laptop", PairedAt: "2026-10-03T09:30:00Z", Mode: "personal"}); err != nil {
		t.Fatal(err)
	}
	return Env{
		GOOS:     "linux",
		GOARCH:   "amd64",
		Store:    s,
		Getenv:   func(string) string { return "" },
		LookPath: func(string) (string, error) { return "/usr/bin/jupyter", nil },
		Run: func(context.Context, string, ...string) ([]byte, error) {
			return []byte(`{"kernelspecs":{"python3":{"resource_dir":"/x","spec":{}},"ir":{"resource_dir":"/y","spec":{}}}}`), nil
		},
		ReadFile:   func(string) ([]byte, error) { return []byte("Linux version 6.8.0-45-generic (buildd@lcy02)"), nil },
		IsTerminal: func() bool { return true },
		DialAgent:  func(string) error { return nil },
		HTTP:       client,
		Now:        time.Now,
	}
}

func status(t *testing.T, r Report, name string) Check {
	t.Helper()
	c, ok := r.Get(name)
	if !ok {
		t.Fatalf("no %q check in %+v", name, r.Checks)
	}
	return c
}

func TestDoctorReportsHealthyPairedComputer(t *testing.T) {
	srv := testserver.NewTLS()
	defer srv.Close()
	env := pairedEnv(t, srv.URL, srv.Client())
	env.Getenv = func(k string) string {
		if k == "SSH_AUTH_SOCK" {
			return "/tmp/agent.sock"
		}
		return ""
	}
	r := Run(context.Background(), env)
	for _, c := range r.Checks {
		if c.Status != OK {
			t.Errorf("%s: %s %s", c.Name, c.Status, c.Detail)
		}
	}
	if r.Failed() {
		t.Fatal("report failed")
	}
	if got := status(t, r, "server").Detail; !strings.Contains(got, "certificate valid") {
		t.Errorf("server detail %q", got)
	}
	if got := status(t, r, "kernels").Detail; got != "ir, python3" {
		t.Errorf("kernels detail %q", got)
	}
	names := make([]string, 0, len(r.Checks))
	for _, c := range r.Checks {
		names = append(names, c.Name)
	}
	want := "platform wsl state_dir identity_key config server clock proxy jupyter kernels ssh_agent terminal"
	if got := strings.Join(names, " "); got != want {
		t.Errorf("checks %q, want %q", got, want)
	}
}

func TestDoctorReportsNotPaired(t *testing.T) {
	env := pairedEnv(t, "https://parallax.example.org", http.DefaultClient)
	env.Store = state.Open(filepath.Join(t.TempDir(), "missing"))
	r := Run(context.Background(), env)
	if r.Failed() {
		t.Fatalf("an unpaired computer fails doctor: %+v", r.Checks)
	}
	for _, name := range []string{"state_dir", "identity_key", "config", "server", "clock"} {
		if c := status(t, r, name); c.Status != Warn {
			t.Errorf("%s: %s, want warn", name, c.Status)
		}
	}
}

func TestDoctorReportsLoosePermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		return // Windows permissions are DACLs, checked by TestIdentityKeyMode0600 in state
	}
	srv := testserver.New()
	defer srv.Close()
	env := pairedEnv(t, srv.URL, srv.Client())
	if err := os.Chmod(env.Store.Path(state.IdentityFile), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(env.Store.Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	r := Run(context.Background(), env)
	if !r.Failed() {
		t.Fatal("loose permissions did not fail")
	}
	for _, name := range []string{"state_dir", "identity_key"} {
		if c := status(t, r, name); c.Status != Fail || !strings.Contains(c.Detail, "other accounts") {
			t.Errorf("%s: %s %q", name, c.Status, c.Detail)
		}
	}
}

func TestDoctorReportsUntrustedTLS(t *testing.T) {
	srv := testserver.NewTLS()
	defer srv.Close()
	env := pairedEnv(t, srv.URL, pairing.NewHTTPClient()) // does not trust the test certificate
	r := Run(context.Background(), env)
	c := status(t, r, "server")
	if c.Status != Fail || !strings.Contains(c.Detail, "TLS certificate") {
		t.Fatalf("server: %s %q", c.Status, c.Detail)
	}
	if c := status(t, r, "clock"); c.Status != Warn {
		t.Fatalf("clock without a server answer: %s", c.Status)
	}
}

func TestDoctorReportsUnreachableServer(t *testing.T) {
	srv := testserver.New()
	url := srv.URL
	srv.Close()
	env := pairedEnv(t, url, http.DefaultClient)
	c := status(t, Run(context.Background(), env), "server")
	if c.Status != Fail || !strings.Contains(c.Detail, "Cannot reach") {
		t.Fatalf("server: %s %q", c.Status, c.Detail)
	}
}

func TestDoctorReportsClockSkew(t *testing.T) {
	srv := testserver.New()
	defer srv.Close()
	for _, c := range []struct {
		offset time.Duration
		want   Status
	}{
		{0, OK},
		{45 * time.Second, Warn},
		{-45 * time.Second, Warn},
		{5 * time.Minute, Fail},
		{-5 * time.Minute, Fail},
	} {
		env := pairedEnv(t, srv.URL, srv.Client())
		env.Now = func() time.Time { return time.Now().Add(c.offset) }
		if got := status(t, Run(context.Background(), env), "clock"); got.Status != c.want {
			t.Errorf("offset %s: %s %q, want %s", c.offset, got.Status, got.Detail, c.want)
		}
	}
}

func TestDoctorReportsProxyWithoutCredentials(t *testing.T) {
	env := pairedEnv(t, "https://parallax.example.org", http.DefaultClient)
	env.Store = state.Open(filepath.Join(t.TempDir(), "missing"))
	env.Getenv = func(k string) string {
		if k == "HTTPS_PROXY" {
			return "http://alice:s3cret@proxy.example.org:3128"
		}
		return ""
	}
	c := status(t, Run(context.Background(), env), "proxy")
	if c.Status != OK || !strings.Contains(c.Detail, "proxy.example.org:3128") || strings.Contains(c.Detail, "s3cret") || strings.Contains(c.Detail, "alice") {
		t.Fatalf("proxy: %s %q", c.Status, c.Detail)
	}
}

func TestDoctorReportsJupyterAndKernels(t *testing.T) {
	base := pairedEnv(t, "https://parallax.example.org", http.DefaultClient)
	base.Store = state.Open(filepath.Join(t.TempDir(), "missing"))

	missing := base
	missing.LookPath = func(string) (string, error) { return "", errors.New("not found") }
	r := Run(context.Background(), missing)
	if c := status(t, r, "jupyter"); c.Status != Warn || !strings.Contains(c.Detail, "pip install jupyter-server") {
		t.Errorf("missing jupyter: %s %q", c.Status, c.Detail)
	}

	empty := base
	empty.Run = func(context.Context, string, ...string) ([]byte, error) { return []byte(`{"kernelspecs":{}}`), nil }
	if c := status(t, Run(context.Background(), empty), "kernels"); c.Status != Warn {
		t.Errorf("no kernels: %s", c.Status)
	}

	var gotArgs []string
	ok := base
	ok.Run = func(_ context.Context, name string, args ...string) ([]byte, error) {
		gotArgs = append([]string{name}, args...)
		return []byte(`{"kernelspecs":{"python3":{}}}`), nil
	}
	if c := status(t, Run(context.Background(), ok), "kernels"); c.Status != OK || c.Detail != "python3" {
		t.Errorf("kernels: %s %q", c.Status, c.Detail)
	}
	if strings.Join(gotArgs, " ") != "/usr/bin/jupyter kernelspec list --json" {
		t.Errorf("ran %q", gotArgs)
	}
}

func TestDoctorReportsWSL(t *testing.T) {
	env := pairedEnv(t, "https://parallax.example.org", http.DefaultClient)
	env.Store = state.Open(filepath.Join(t.TempDir(), "missing"))
	env.ReadFile = func(string) ([]byte, error) {
		return []byte("Linux version 5.15.153.1-microsoft-standard-WSL2 (root@941d701f84f1)"), nil
	}
	if c := status(t, Run(context.Background(), env), "wsl"); !strings.Contains(c.Detail, "Running inside WSL") {
		t.Fatalf("wsl: %q", c.Detail)
	}
	env.GOOS = "darwin"
	if _, ok := Run(context.Background(), env).Get("wsl"); ok {
		t.Fatal("wsl reported on macOS")
	}
}

func TestDoctorReportsAgentAndTerminal(t *testing.T) {
	env := pairedEnv(t, "https://parallax.example.org", http.DefaultClient)
	env.Store = state.Open(filepath.Join(t.TempDir(), "missing"))
	env.IsTerminal = func() bool { return false }
	r := Run(context.Background(), env)
	if c := status(t, r, "ssh_agent"); c.Status != Warn || !strings.Contains(c.Detail, "SSH_AUTH_SOCK") {
		t.Errorf("no agent: %s %q", c.Status, c.Detail)
	}
	if c := status(t, r, "terminal"); c.Status != Warn {
		t.Errorf("no terminal: %s", c.Status)
	}

	env.GOOS = "windows"
	var dialled string
	env.DialAgent = func(p string) error { dialled = p; return nil }
	if c := status(t, Run(context.Background(), env), "ssh_agent"); c.Status != OK || dialled != `\\.\pipe\openssh-ssh-agent` {
		t.Errorf("windows agent: %s, dialled %q", c.Status, dialled)
	}
}

func TestDoctorReportsUnsupportedPlatform(t *testing.T) {
	env := pairedEnv(t, "https://parallax.example.org", http.DefaultClient)
	env.Store = state.Open(filepath.Join(t.TempDir(), "missing"))
	env.GOOS, env.GOARCH = "freebsd", "amd64"
	r := Run(context.Background(), env)
	if c := status(t, r, "platform"); c.Status != Fail || !r.Failed() {
		t.Fatalf("platform: %s", c.Status)
	}
}

func TestDoctorReportsServerHTTPStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	env := pairedEnv(t, srv.URL, srv.Client())
	if c := status(t, Run(context.Background(), env), "server"); c.Status != Warn || !strings.Contains(c.Detail, "503") {
		t.Fatalf("server: %s %q", c.Status, c.Detail)
	}
}
