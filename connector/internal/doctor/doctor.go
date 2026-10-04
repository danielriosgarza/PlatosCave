// Package doctor checks what the connector needs on this computer and says what to fix
// (docs/design/connector.md §13). Every check reports ok, warn or fail; any fail makes
// `parallax-connector doctor` exit non-zero.
package doctor

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"runtime"
	"sort"
	"strings"
	"time"

	"golang.org/x/term"

	"parallax/connector/internal/identity"
	"parallax/connector/internal/pairing"
	"parallax/connector/internal/redact"
	"parallax/connector/internal/state"
)

// Status of one check.
type Status string

// Check statuses.
const (
	OK   Status = "ok"
	Warn Status = "warn"
	Fail Status = "fail"
)

// Check is one line of the report.
type Check struct {
	Name   string `json:"name"`
	Status Status `json:"status"`
	Detail string `json:"detail"`
}

// Report is every check, in a fixed order.
type Report struct {
	Checks []Check `json:"checks"`
}

// Failed reports whether any check failed.
func (r Report) Failed() bool {
	for _, c := range r.Checks {
		if c.Status == Fail {
			return true
		}
	}
	return false
}

// Get returns the check with a name.
func (r Report) Get(name string) (Check, bool) {
	for _, c := range r.Checks {
		if c.Name == name {
			return c, true
		}
	}
	return Check{}, false
}

// Env is everything the checks read, so tests can replace it.
type Env struct {
	GOOS, GOARCH string
	// Store is the state directory; StoreErr is set instead when it cannot be determined.
	Store    *state.Store
	StoreErr error
	Getenv   func(string) string
	LookPath func(string) (string, error)
	// Run runs a program and returns its standard output.
	Run        func(ctx context.Context, name string, args ...string) ([]byte, error)
	ReadFile   func(string) ([]byte, error)
	IsTerminal func() bool
	// DialAgent checks that the SSH agent socket or pipe at path answers.
	DialAgent func(path string) error
	HTTP      *http.Client
	Now       func() time.Time
}

// DefaultEnv is the real computer.
func DefaultEnv() Env {
	env := Env{
		GOOS:     runtime.GOOS,
		GOARCH:   runtime.GOARCH,
		Getenv:   os.Getenv,
		LookPath: exec.LookPath,
		Run: func(ctx context.Context, name string, args ...string) ([]byte, error) {
			return exec.CommandContext(ctx, name, args...).Output()
		},
		ReadFile:   os.ReadFile,
		IsTerminal: func() bool { return term.IsTerminal(int(os.Stdin.Fd())) },
		DialAgent:  dialAgent,
		HTTP:       pairing.NewHTTPClient(),
		Now:        time.Now,
	}
	if dir, err := state.Dir(); err != nil {
		env.StoreErr = err
	} else {
		env.Store = state.Open(dir)
	}
	return env
}

// Thresholds for the clock check: the server refuses signatures beyond MaxSkew.
const (
	MaxSkew  = 120 * time.Second
	WarnSkew = 30 * time.Second
)

const (
	serverTimeout  = 10 * time.Second
	commandTimeout = 10 * time.Second
	windowsAgent   = `\\.\pipe\openssh-ssh-agent`
)

// Run performs every check.
func Run(ctx context.Context, env Env) Report {
	var r Report
	add := func(name string, s Status, format string, args ...any) {
		r.Checks = append(r.Checks, Check{Name: name, Status: s, Detail: redact.Redact(fmt.Sprintf(format, args...))})
	}

	platform := env.GOOS + "/" + env.GOARCH
	switch platform {
	case "linux/amd64", "linux/arm64", "darwin/amd64", "darwin/arm64", "windows/amd64":
		add("platform", OK, "%s", platform)
	default:
		add("platform", Fail, "%s is not a supported platform (Linux and macOS on amd64 or arm64, Windows on amd64)", platform)
	}

	if env.GOOS == "linux" {
		if v, err := env.ReadFile("/proc/version"); err == nil && isWSL(string(v)) {
			add("wsl", OK, "Running inside WSL: This computer means this Linux distribution, not Windows. Jupyter must be installed in the distribution.")
		} else {
			add("wsl", OK, "Not running inside WSL")
		}
	}

	cfg := checkState(env, add)
	resp := checkServer(ctx, env, cfg, add)
	checkClock(env, resp, add)
	checkProxy(env, add)
	checkJupyter(ctx, env, add)
	checkAgent(env, add)

	if env.IsTerminal() {
		add("terminal", OK, "Key passphrases and second factors can be typed in this terminal")
	} else {
		add("terminal", Warn, "No terminal: a key with a passphrase or a host that asks for a second factor needs an SSH agent")
	}
	return r
}

type addFunc func(name string, s Status, format string, args ...any)

func isWSL(procVersion string) bool {
	v := strings.ToLower(procVersion)
	return strings.Contains(v, "microsoft") || strings.Contains(v, "wsl")
}

func checkState(env Env, add addFunc) *state.Config {
	if env.StoreErr != nil {
		add("state_dir", Fail, "%v", env.StoreErr)
		add("identity_key", Warn, "Skipped: no state directory")
		add("config", Warn, "Skipped: no state directory")
		return nil
	}
	s := env.Store
	if _, err := os.Stat(s.Dir); errors.Is(err, fs.ErrNotExist) {
		add("state_dir", Warn, "%s does not exist yet; `parallax-connector pair` creates it", s.Dir)
		add("identity_key", Warn, "Not paired: no identity key")
		add("config", Warn, "Not paired: run `parallax-connector pair --server URL --code CODE`")
		return nil
	} else if err != nil {
		add("state_dir", Fail, "%s: %v", s.Dir, err)
		return nil
	}
	if err := s.CheckPrivate(""); err != nil {
		add("state_dir", Fail, "%v", err)
	} else {
		add("state_dir", OK, "%s is private to this account", s.Dir)
	}

	if ok, _ := s.Exists(state.IdentityFile); !ok {
		add("identity_key", Warn, "Not paired: no identity key")
	} else if err := s.CheckPrivate(state.IdentityFile); err != nil {
		add("identity_key", Fail, "%v; run `parallax-connector unpair` and pair again", err)
	} else if data, err := s.ReadFile(state.IdentityFile); err != nil {
		add("identity_key", Fail, "%v", err)
	} else if id, err := identity.ParsePEM(data); err != nil {
		add("identity_key", Fail, "%v", err)
	} else {
		add("identity_key", OK, "Fingerprint %s; private to this account", id.Fingerprint())
	}

	cfg, err := s.ReadConfig()
	switch {
	case errors.Is(err, fs.ErrNotExist):
		add("config", Warn, "Not paired: run `parallax-connector pair --server URL --code CODE`")
		return nil
	case err != nil:
		add("config", Fail, "%v", err)
		return nil
	}
	if err := s.CheckPrivate(state.ConfigFile); err != nil {
		add("config", Warn, "%v", err)
	} else {
		add("config", OK, "Paired with %s as %q (%s)", cfg.Server, cfg.Name, cfg.ConnectorID)
	}
	return cfg
}

func checkServer(ctx context.Context, env Env, cfg *state.Config, add addFunc) *http.Response {
	if cfg == nil {
		add("server", Warn, "Skipped: not paired")
		return nil
	}
	ctx, cancel := context.WithTimeout(ctx, serverTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, cfg.Server+"/api/health", nil)
	if err != nil {
		add("server", Fail, "%v", err)
		return nil
	}
	resp, err := env.HTTP.Do(req)
	if err != nil {
		var certErr *tls.CertificateVerificationError
		if errors.As(err, &certErr) {
			add("server", Fail, "%s presented a TLS certificate this computer does not trust: %v", cfg.Server, certErr.Err)
		} else {
			add("server", Fail, "Cannot reach %s: %v", cfg.Server, unwrapURL(err))
		}
		return nil
	}
	resp.Body.Close()
	transport := "plain HTTP (loopback)"
	if resp.TLS != nil {
		transport = "TLS " + tls.VersionName(resp.TLS.Version) + ", certificate valid"
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		add("server", OK, "%s answered (%s)", cfg.Server, transport)
	} else {
		add("server", Warn, "%s answered HTTP %d (%s)", cfg.Server, resp.StatusCode, transport)
	}
	return resp
}

func unwrapURL(err error) error {
	var u *url.Error
	if errors.As(err, &u) {
		return u.Err
	}
	return err
}

func checkClock(env Env, resp *http.Response, add addFunc) {
	if resp == nil {
		add("clock", Warn, "Skipped: the server's time is not known")
		return
	}
	date, err := http.ParseTime(resp.Header.Get("Date"))
	if err != nil {
		add("clock", Warn, "The server sent no usable Date header")
		return
	}
	skew := env.Now().Sub(date).Round(time.Second)
	abs := skew
	if abs < 0 {
		abs = -abs
	}
	// Date has one-second resolution, so a skew up to 1 s is noise.
	switch {
	case abs > MaxSkew:
		add("clock", Fail, "This computer's clock differs from the server's by %s; the server refuses signatures beyond %s. Set the clock automatically", skew, MaxSkew)
	case abs > WarnSkew:
		add("clock", Warn, "This computer's clock differs from the server's by %s (refused beyond %s)", skew, MaxSkew)
	default:
		add("clock", OK, "Within %s of the server's clock", max(abs, time.Second))
	}
}

func checkProxy(env Env, add addFunc) {
	raw := env.Getenv("HTTPS_PROXY")
	if raw == "" {
		raw = env.Getenv("https_proxy")
	}
	if raw == "" {
		add("proxy", OK, "No HTTPS_PROXY set; the link connects directly")
		return
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		if !strings.Contains(raw, "://") {
			u, err = url.Parse("http://" + raw)
		}
		if err != nil || u.Host == "" {
			add("proxy", Fail, "HTTPS_PROXY is not a valid URL")
			return
		}
	}
	u.User = nil // never print proxy credentials
	noProxy := env.Getenv("NO_PROXY")
	if noProxy == "" {
		noProxy = env.Getenv("no_proxy")
	}
	detail := fmt.Sprintf("The link uses the proxy %s://%s; SSH connections do not use it", u.Scheme, u.Host)
	if noProxy != "" {
		detail += "; NO_PROXY is set"
	}
	add("proxy", OK, "%s", detail)
}

func checkJupyter(ctx context.Context, env Env, add addFunc) {
	path, err := env.LookPath("jupyter")
	if err != nil {
		add("jupyter", Warn, "jupyter is not on PATH: This computer needs Jupyter Server 2 (pip install jupyter-server ipykernel) or a Python interpreter chosen in the connection")
		add("kernels", Warn, "Skipped: jupyter is not on PATH")
		return
	}
	add("jupyter", OK, "%s", path)
	ctx, cancel := context.WithTimeout(ctx, commandTimeout)
	defer cancel()
	out, err := env.Run(ctx, path, "kernelspec", "list", "--json")
	if err != nil {
		add("kernels", Warn, "`jupyter kernelspec list --json` failed: %v", err)
		return
	}
	var list struct {
		Kernelspecs map[string]json.RawMessage `json:"kernelspecs"`
	}
	if err := json.Unmarshal(out, &list); err != nil {
		add("kernels", Warn, "`jupyter kernelspec list --json` printed something that is not its JSON list")
		return
	}
	names := make([]string, 0, len(list.Kernelspecs))
	for name := range list.Kernelspecs {
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) == 0 {
		add("kernels", Warn, "Jupyter lists no kernel; install one, for example pip install ipykernel")
		return
	}
	add("kernels", OK, "%s", strings.Join(names, ", "))
}

func checkAgent(env Env, add addFunc) {
	path := windowsAgent
	if env.GOOS != "windows" {
		path = env.Getenv("SSH_AUTH_SOCK")
		if path == "" {
			add("ssh_agent", Warn, "No SSH agent (SSH_AUTH_SOCK is not set); key files still work")
			return
		}
	}
	if err := env.DialAgent(path); err != nil {
		add("ssh_agent", Warn, "The SSH agent at %s does not answer; key files still work", path)
		return
	}
	add("ssh_agent", OK, "SSH agent at %s", path)
}

// WriteText prints the report as aligned lines.
func WriteText(w interface{ Write([]byte) (int, error) }, r Report) error {
	for _, c := range r.Checks {
		if _, err := fmt.Fprintf(w, "%-4s  %-12s  %s\n", c.Status, c.Name, c.Detail); err != nil {
			return err
		}
	}
	return nil
}
