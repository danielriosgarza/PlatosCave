package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"testing"
	"time"

	"parallax/connector/internal/doctor"
	"parallax/connector/internal/identity"
	"parallax/connector/internal/state"
	"parallax/connector/internal/testserver"
)

type harness struct {
	t      *testing.T
	dir    string
	env    Env
	stdout *bytes.Buffer
	stderr *bytes.Buffer
	stdin  *bytes.Buffer
	tty    bool
}

func newHarness(t *testing.T, client *http.Client) *harness {
	t.Helper()
	h := &harness{t: t, dir: filepath.Join(t.TempDir(), "state"), stdout: &bytes.Buffer{}, stderr: &bytes.Buffer{}, stdin: &bytes.Buffer{}}
	h.env = Env{
		Stdin:      h.stdin,
		Stdout:     h.stdout,
		Stderr:     h.stderr,
		GOOS:       "linux",
		GOARCH:     "amd64",
		StateDir:   func() (string, error) { return h.dir, nil },
		Hostname:   func() (string, error) { return "lab-07", nil },
		IsTerminal: func() bool { return h.tty },
		HTTP:       client,
		Now:        time.Now,
		Sleep:      func(ctx context.Context, _ time.Duration) error { return ctx.Err() },
		Doctor: func(store *state.Store, storeErr error) doctor.Env {
			env := doctor.DefaultEnv()
			env.Store, env.StoreErr, env.HTTP = store, storeErr, client
			return env
		},
	}
	return h
}

func (h *harness) run(args ...string) int {
	h.stdout.Reset()
	h.stderr.Reset()
	return Main(context.Background(), args, h.env)
}

func (h *harness) store() *state.Store { return state.Open(h.dir) }

func (h *harness) exists(name string) bool {
	ok, err := h.store().Exists(name)
	if err != nil {
		h.t.Fatal(err)
	}
	return ok
}

var fingerprintLine = regexp.MustCompile(`Fingerprint: (SHA256:[A-Za-z0-9+/]{43})`)

func (h *harness) printedFingerprint() string {
	m := fingerprintLine.FindStringSubmatch(h.stdout.String())
	if m == nil {
		h.t.Fatalf("no fingerprint printed:\n%s", h.stdout.String())
	}
	return m[1]
}

func approveOnPoll(n int) func(*testserver.Server, string, int) {
	return func(s *testserver.Server, id string, polls int) {
		if polls == n {
			s.Approve(id)
		}
	}
}

// A27 (pairing half): a new connector is tied to the account by a short-lived code and an
// explicit approval, the person can compare the fingerprint the CLI printed with the one the
// server shows, and the connector only ever dials out to the server it was paired with.
func TestA27_PairingHalf(t *testing.T) {
	srv := testserver.NewTLS()
	defer srv.Close()
	srv.AddCode("K7M2-Q9XD")
	srv.OnPoll = approveOnPoll(1)
	h := newHarness(t, srv.Client())

	if code := h.run("pair", "--server", srv.URL+"/", "--code", "k7m2 q9xd", "--name", "Elena's laptop"); code != ExitOK {
		t.Fatalf("pair exit %d\nstdout:\n%s\nstderr:\n%s", code, h.stdout, h.stderr)
	}
	printed := h.printedFingerprint()
	devices := srv.Connectors()
	if len(devices) != 1 {
		t.Fatalf("server holds %d devices", len(devices))
	}
	dev := devices[0]
	if dev.Fingerprint != printed || dev.Name != "Elena's laptop" || dev.OS != "linux" || dev.Arch != "amd64" || dev.Status != testserver.StatusActive {
		t.Fatalf("server record %+v, printed %s", dev, printed)
	}
	for _, r := range srv.Requests() {
		if !strings.HasPrefix(r, "POST /api/connector/v1/") {
			t.Fatalf("unexpected request %q", r)
		}
	}

	cfg, err := h.store().ReadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server != srv.Origin || cfg.ConnectorID != dev.ID || cfg.Name != "Elena's laptop" || cfg.Mode != "personal" {
		t.Fatalf("config %+v", cfg)
	}
	key, err := h.store().ReadFile(state.IdentityFile)
	if err != nil {
		t.Fatal(err)
	}
	id, err := identity.ParsePEM(key)
	if err != nil {
		t.Fatal(err)
	}
	if id.Fingerprint() != dev.Fingerprint {
		t.Fatal("stored key differs from the approved one")
	}
	if !strings.Contains(h.stdout.String(), "Paired as \"Elena's laptop\" ("+dev.ID+")") {
		t.Fatalf("no success line:\n%s", h.stdout)
	}

	// status reports the pairing from local state.
	if code := h.run("status", "--json"); code != ExitOK {
		t.Fatalf("status exit %d: %s", code, h.stderr)
	}
	var rep statusReport
	if err := json.Unmarshal(h.stdout.Bytes(), &rep); err != nil {
		t.Fatal(err)
	}
	if !rep.Paired || rep.Server != srv.Origin || rep.ConnectorID != dev.ID || rep.Fingerprint != printed || rep.Running {
		t.Fatalf("status %+v", rep)
	}
}

func TestPairWaitsForApproval(t *testing.T) {
	srv := testserver.New()
	defer srv.Close()
	srv.AddCode("AAAA-BBBB")
	h := newHarness(t, srv.Client())
	srv.OnPoll = func(s *testserver.Server, id string, polls int) {
		// Until the device is approved nothing is written on this computer.
		if h.exists(state.IdentityFile) || h.exists(state.ConfigFile) {
			t.Errorf("poll %d: state written before approval", polls)
		}
		if polls == 4 {
			s.Approve(id)
		}
	}
	if code := h.run("pair", "--server", srv.URL, "--code", "AAAA-BBBB"); code != ExitOK {
		t.Fatalf("pair exit %d: %s", code, h.stderr)
	}
	dev := srv.Connectors()[0]
	if dev.Polls != 4 {
		t.Fatalf("polled %d times, want 4", dev.Polls)
	}
	if dev.Name != "lab-07" {
		t.Fatalf("default name %q", dev.Name)
	}
	if !strings.Contains(h.stdout.String(), "Waiting for approval") {
		t.Fatalf("no waiting message:\n%s", h.stdout)
	}
	if !h.exists(state.IdentityFile) || !h.exists(state.ConfigFile) {
		t.Fatal("state not written after approval")
	}
}

func TestPairOutcomesLeaveNothingBehind(t *testing.T) {
	for _, c := range []struct {
		name   string
		code   string
		onPoll func(*testserver.Server, string, int)
		want   string
	}{
		{"wrong code", "ZZZZ-ZZZZ", nil, "wrong, already used or expired"},
		{"rejected", "AAAA-BBBB", func(s *testserver.Server, id string, _ int) { s.Reject(id) }, "rejected in Parallax"},
	} {
		t.Run(c.name, func(t *testing.T) {
			srv := testserver.New()
			defer srv.Close()
			srv.AddCode("AAAA-BBBB")
			srv.OnPoll = c.onPoll
			h := newHarness(t, srv.Client())
			if code := h.run("pair", "--server", srv.URL, "--code", c.code); code != ExitError {
				t.Fatalf("exit %d", code)
			}
			if !strings.Contains(h.stderr.String(), c.want) {
				t.Fatalf("stderr %q", h.stderr)
			}
			if h.exists(state.IdentityFile) || h.exists(state.ConfigFile) {
				t.Fatal("state left behind")
			}
		})
	}
}

func TestPairCancelledLeavesNothingBehind(t *testing.T) {
	srv := testserver.New()
	defer srv.Close()
	srv.AddCode("AAAA-BBBB")
	h := newHarness(t, srv.Client())
	ctx, cancel := context.WithCancel(context.Background())
	srv.OnPoll = func(*testserver.Server, string, int) { cancel() }
	code := Main(ctx, []string{"pair", "--server", srv.URL, "--code", "AAAA-BBBB"}, h.env)
	if code != ExitError || !strings.Contains(h.stderr.String(), "cancelled") {
		t.Fatalf("exit %d, stderr %q", code, h.stderr)
	}
	if h.exists(state.IdentityFile) || h.exists(state.ConfigFile) {
		t.Fatal("state left behind")
	}
}

func TestPairRefusesExistingIdentity(t *testing.T) {
	srv := testserver.New()
	defer srv.Close()
	srv.AddCode("AAAA-BBBB")
	srv.AddCode("CCCC-DDDD")
	srv.OnPoll = approveOnPoll(1)
	h := newHarness(t, srv.Client())
	if code := h.run("pair", "--server", srv.URL, "--code", "AAAA-BBBB"); code != ExitOK {
		t.Fatalf("first pair exit %d: %s", code, h.stderr)
	}
	first := h.printedFingerprint()
	before := len(srv.Requests())

	if code := h.run("pair", "--server", srv.URL, "--code", "CCCC-DDDD"); code != ExitError {
		t.Fatalf("second pair exit %d", code)
	}
	if !strings.Contains(h.stderr.String(), "already has a connector identity") || !strings.Contains(h.stderr.String(), "--force") {
		t.Fatalf("stderr %q", h.stderr)
	}
	if len(srv.Requests()) != before {
		t.Fatal("a refused pair contacted the server")
	}
	key, _ := h.store().ReadFile(state.IdentityFile)
	if id, _ := identity.ParsePEM(key); id.Fingerprint() != first {
		t.Fatal("the existing identity was changed")
	}

	// --force replaces the identity and says the old device must be revoked.
	if err := h.store().WritePrivate(state.SessionsFile, []byte(`{"v":1,"sessions":[]}`)); err != nil {
		t.Fatal(err)
	}
	if code := h.run("pair", "--server", srv.URL, "--code", "CCCC-DDDD", "--force"); code != ExitOK {
		t.Fatalf("forced pair exit %d: %s", code, h.stderr)
	}
	second := h.printedFingerprint()
	if second == first {
		t.Fatal("--force kept the old identity")
	}
	if !strings.Contains(h.stdout.String(), "revoke the old device") {
		t.Fatalf("stdout %q", h.stdout)
	}
	if h.exists(state.SessionsFile) {
		t.Fatal("sessions of the replaced identity kept")
	}
	cfg, _ := h.store().ReadConfig()
	if dev, _ := srv.Connector(cfg.ConnectorID); dev.Fingerprint != second {
		t.Fatal("config does not name the new device")
	}
}

func TestPairRefusesWhileRunLockHeld(t *testing.T) {
	srv := testserver.New()
	defer srv.Close()
	srv.AddCode("AAAA-BBBB")
	h := newHarness(t, srv.Client())
	lock, err := h.store().Lock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	if code := h.run("pair", "--server", srv.URL, "--code", "AAAA-BBBB"); code != ExitError || !strings.Contains(h.stderr.String(), "stop it first") {
		t.Fatalf("exit %d, stderr %q", code, h.stderr)
	}
	if len(srv.Requests()) != 0 {
		t.Fatal("server contacted")
	}
}

func TestPairUsage(t *testing.T) {
	h := newHarness(t, http.DefaultClient)
	for _, args := range [][]string{
		{"pair"},
		{"pair", "--server", "https://parallax.example.org"},
		{"pair", "--server", "http://parallax.example.org", "--code", "AAAA-BBBB"},
		{"pair", "--server", "https://parallax.example.org", "--code", "nope"},
		{"pair", "--server", "https://parallax.example.org", "--code", "AAAA-BBBB", "--name", "bad\x1bname"},
		{"pair", "--server", "https://parallax.example.org", "--code", "AAAA-BBBB", "extra"},
		{"frobnicate"},
		{},
	} {
		if code := h.run(args...); code != ExitUsage {
			t.Errorf("%q: exit %d, want %d (stderr %q)", args, code, ExitUsage, h.stderr)
		}
	}
	if h.exists(state.IdentityFile) {
		t.Fatal("a usage error wrote state")
	}
}

func TestUnpairKeepsNothing(t *testing.T) {
	srv := testserver.New()
	defer srv.Close()
	srv.AddCode("AAAA-BBBB")
	srv.OnPoll = approveOnPoll(1)
	h := newHarness(t, srv.Client())
	if code := h.run("pair", "--server", srv.URL, "--code", "AAAA-BBBB"); code != ExitOK {
		t.Fatalf("pair exit %d: %s", code, h.stderr)
	}
	cfg, _ := h.store().ReadConfig()
	for _, name := range []string{state.SessionsFile, state.RuntimeFile, state.KnownHostsFile} {
		if err := h.store().WritePrivate(name, []byte("x")); err != nil {
			t.Fatal(err)
		}
	}

	// Without a terminal and without --yes nothing happens.
	if code := h.run("unpair"); code != ExitUsage {
		t.Fatalf("unpair without --yes exit %d", code)
	}
	if !h.exists(state.IdentityFile) {
		t.Fatal("unpair without confirmation deleted state")
	}

	if code := h.run("unpair", "--yes"); code != ExitOK {
		t.Fatalf("unpair exit %d: %s", code, h.stderr)
	}
	dev, _ := srv.Connector(cfg.ConnectorID)
	if dev.Status != testserver.StatusRevoked || !dev.Unpaired {
		t.Fatalf("server record %+v", dev)
	}
	entries, err := os.ReadDir(h.dir)
	if err != nil {
		t.Fatal(err)
	}
	// Only the empty run.lock stays: deleting a lock file other processes may have open would
	// let two of them hold the lock at once.
	if len(entries) != 1 || entries[0].Name() != state.LockFile {
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name())
		}
		t.Fatalf("state left behind: %v", names)
	}
	if info, err := entries[0].Info(); err != nil || info.Size() != 0 {
		t.Fatalf("run.lock is not empty: %v %v", info, err)
	}
	out := h.stdout.String()
	if !strings.Contains(out, "revoked this device") || !strings.Contains(out, "does not revoke your SSH accounts") {
		t.Fatalf("stdout %q", out)
	}

	if code := h.run("status"); code != ExitOK || !strings.Contains(h.stdout.String(), "Not paired") {
		t.Fatalf("status after unpair: %d %q", code, h.stdout)
	}
	if code := h.run("unpair", "--yes"); code != ExitOK || !strings.Contains(h.stdout.String(), "not paired") {
		t.Fatalf("second unpair: %d %q", code, h.stdout)
	}
}

func TestUnpairWithServerUnreachableStillDeletes(t *testing.T) {
	srv := testserver.New()
	srv.AddCode("AAAA-BBBB")
	srv.OnPoll = approveOnPoll(1)
	h := newHarness(t, srv.Client())
	if code := h.run("pair", "--server", srv.URL, "--code", "AAAA-BBBB"); code != ExitOK {
		t.Fatalf("pair exit %d: %s", code, h.stderr)
	}
	srv.Close()
	h.tty = true
	h.stdin.WriteString("y\n")
	if code := h.run("unpair"); code != ExitOK {
		t.Fatalf("unpair exit %d: %s", code, h.stderr)
	}
	out := h.stdout.String()
	if !strings.Contains(out, "Could not reach") || !strings.Contains(out, "Revoke this device in Parallax") {
		t.Fatalf("stdout %q", out)
	}
	if h.exists(state.IdentityFile) || h.exists(state.ConfigFile) {
		t.Fatal("local state kept")
	}
}

func TestUnpairConfirmationDeclined(t *testing.T) {
	srv := testserver.New()
	defer srv.Close()
	srv.AddCode("AAAA-BBBB")
	srv.OnPoll = approveOnPoll(1)
	h := newHarness(t, srv.Client())
	if code := h.run("pair", "--server", srv.URL, "--code", "AAAA-BBBB"); code != ExitOK {
		t.Fatalf("pair exit %d: %s", code, h.stderr)
	}
	h.tty = true
	h.stdin.WriteString("n\n")
	if code := h.run("unpair"); code != ExitOK || !strings.Contains(h.stdout.String(), "Cancelled") {
		t.Fatalf("exit %d, stdout %q", code, h.stdout)
	}
	if !h.exists(state.IdentityFile) {
		t.Fatal("declined unpair deleted state")
	}
	if dev := srv.Connectors()[0]; dev.Status != testserver.StatusActive {
		t.Fatal("declined unpair told the server")
	}
}

func TestStatusNotPairedCreatesNothing(t *testing.T) {
	h := newHarness(t, http.DefaultClient)
	if code := h.run("status"); code != ExitOK || !strings.Contains(h.stdout.String(), "Not paired") {
		t.Fatalf("exit %d, stdout %q", code, h.stdout)
	}
	if _, err := os.Stat(h.dir); !os.IsNotExist(err) {
		t.Fatal("status created the state directory")
	}
}

func TestStatusShowsRunningConnector(t *testing.T) {
	srv := testserver.New()
	defer srv.Close()
	srv.AddCode("AAAA-BBBB")
	srv.OnPoll = approveOnPoll(1)
	h := newHarness(t, srv.Client())
	if code := h.run("pair", "--server", srv.URL, "--code", "AAAA-BBBB"); code != ExitOK {
		t.Fatalf("pair exit %d: %s", code, h.stderr)
	}
	rt := `{"v":1,"pid":4711,"startedAt":"2026-10-03T09:30:00Z","link":"up","since":"2026-10-03T09:31:00Z","sessions":2}`
	if err := h.store().WritePrivate(state.RuntimeFile, []byte(rt)); err != nil {
		t.Fatal(err)
	}
	// runtime.json without a live run.lock holder is stale.
	h.run("status")
	if !strings.Contains(h.stdout.String(), "Not running") {
		t.Fatalf("stale runtime.json reported as running:\n%s", h.stdout)
	}
	lock, err := h.store().Lock()
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Release()
	h.run("status")
	if !strings.Contains(h.stdout.String(), "Running. Link up since 2026-10-03T09:31:00Z; 2 session(s).") {
		t.Fatalf("stdout:\n%s", h.stdout)
	}
}

func TestDoctorCommandExitStatus(t *testing.T) {
	srv := testserver.New()
	defer srv.Close()
	srv.AddCode("AAAA-BBBB")
	srv.OnPoll = approveOnPoll(1)
	h := newHarness(t, srv.Client())
	if code := h.run("pair", "--server", srv.URL, "--code", "AAAA-BBBB"); code != ExitOK {
		t.Fatalf("pair exit %d: %s", code, h.stderr)
	}
	if code := h.run("doctor", "--json"); code != ExitOK {
		t.Fatalf("doctor exit %d:\n%s", code, h.stdout)
	}
	var rep doctor.Report
	if err := json.Unmarshal(h.stdout.Bytes(), &rep); err != nil {
		t.Fatal(err)
	}
	if c, ok := rep.Get("server"); !ok || c.Status != doctor.OK {
		t.Fatalf("server check %+v", c)
	}
	srv.Close()
	if code := h.run("doctor"); code != ExitError || !strings.Contains(h.stdout.String(), "fail  server") {
		t.Fatalf("doctor with the server down: exit %d\n%s", code, h.stdout)
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(filepath.Join(h.dir, state.IdentityFile), 0o640); err != nil {
			t.Fatal(err)
		}
		if code := h.run("doctor"); code != ExitError || !strings.Contains(h.stdout.String(), "fail  identity_key") {
			t.Fatalf("doctor with a readable key: exit %d\n%s", code, h.stdout)
		}
	}
}

func TestVersionCommand(t *testing.T) {
	h := newHarness(t, http.DefaultClient)
	if code := h.run("version"); code != ExitOK {
		t.Fatal(code)
	}
	if got := h.stdout.String(); got != "parallax-connector 0.0.0-dev (commit unknown, linux/amd64)\n" {
		t.Fatalf("version %q", got)
	}
	if code := h.run("help"); code != ExitOK || !strings.Contains(h.stdout.String(), "pair --server URL --code") {
		t.Fatalf("help: %d %q", code, h.stdout)
	}
}
