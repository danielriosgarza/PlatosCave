package jupyter

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"parallax/connector/internal/protocol"
	"parallax/connector/internal/redact"
	"parallax/connector/internal/safetext"
)

// NewToken returns a fresh session token: 32 random bytes, hex-encoded (design §6).
func NewToken() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

// ServerFlags are the fixed flags of design §6. Only the port, the validated workspace and the
// session id vary.
func ServerFlags(port int, workspace, sessionID string) []string {
	return []string{
		"--ServerApp.ip=127.0.0.1",
		"--ServerApp.port=" + strconv.Itoa(port),
		"--ServerApp.port_retries=0",
		"--ServerApp.open_browser=False",
		"--ServerApp.root_dir=" + workspace,
		"--ServerApp.allow_remote_access=False",
		"--ParallaxMarker.session=" + sessionID,
	}
}

// FreePort picks a loopback port nothing listens on: bind 127.0.0.1:0, read the port, close.
func FreePort() (int, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port, nil
}

// StartOptions describe one local Jupyter server.
type StartOptions struct {
	SessionID string
	Workspace string
	// Python is the chosen interpreter; empty runs `jupyter server` from PATH.
	Python string
	Token  string
	// Log receives every line Jupyter prints, already redacted.
	Log func(line string)
	// ReadyTimeout and PollInterval default to 30 s and 250 ms (design §6).
	ReadyTimeout time.Duration
	PollInterval time.Duration
}

// Process is a Jupyter server the connector started and owns.
type Process struct {
	Port       int
	PID        int
	Client     *Client
	runtimeDir string
	token      string
	cmd        *exec.Cmd
	release    func()
	exited     chan struct{}
	exitErr    error
	out        *tail
	// holdsToken is set once Start returns the process: it then holds the token's redaction
	// reference, dropped once by cleanup.
	holdsToken bool
	forgetOnce sync.Once
}

// outputGrace is how long the output of an exited server is still read.
const outputGrace = time.Second

// startAttempts is how often a bind race on the chosen port is retried.
const startAttempts = 3

// Start runs a local Jupyter server with the fixed flags, the token in JUPYTER_TOKEN and a
// private runtime directory, and waits until GET /api/status answers with the token. Failures
// are *Failure with the runtime or notebook_auth code.
func Start(ctx context.Context, o StartOptions) (*Process, error) {
	if o.ReadyTimeout <= 0 {
		o.ReadyTimeout = 30 * time.Second
	}
	if o.PollInterval <= 0 {
		o.PollInterval = 250 * time.Millisecond
	}
	// One reference for the whole start; a successful process drops it in its cleanup.
	redact.Register(o.Token)
	var last error
	for attempt := 0; attempt < startAttempts; attempt++ {
		p, err := startOnce(ctx, o)
		if err == nil {
			p.holdsToken = true
			return p, nil
		}
		last = err
		var f *Failure
		if !errors.As(err, &f) || f.Code != protocol.CodeJupyterStartFailed || !strings.Contains(strings.ToLower(f.Detail), "already in use") {
			break
		}
	}
	redact.Forget(o.Token)
	return nil, last
}

func startOnce(ctx context.Context, o StartOptions) (*Process, error) {
	port, err := FreePort()
	if err != nil {
		return nil, &Failure{Code: protocol.CodeJupyterStartFailed, Detail: "no free loopback port"}
	}
	name, args, f := command(o.Python, "jupyter_server", ServerFlags(port, o.Workspace, o.SessionID)...)
	if f != nil {
		return nil, f
	}
	runtimeDir, err := os.MkdirTemp("", "parallax-jupyter-")
	if err != nil {
		return nil, &Failure{Code: protocol.CodeJupyterStartFailed, Detail: "cannot create a private runtime directory"}
	}
	if err := os.Chmod(runtimeDir, 0o700); err != nil {
		os.RemoveAll(runtimeDir)
		return nil, &Failure{Code: protocol.CodeJupyterStartFailed, Detail: "cannot make the runtime directory private"}
	}
	cmd := exec.Command(name, args...)
	cmd.Dir = o.Workspace
	cmd.Stdin = nil
	// A kernel that outlives the server inherits its output; once the server has exited, its
	// output is read for at most outputGrace more, so the exit is seen.
	cmd.WaitDelay = outputGrace
	cmd.Env = childEnv([]string{"JUPYTER_TOKEN=" + o.Token, "JUPYTER_RUNTIME_DIR=" + runtimeDir})
	out := &tail{token: o.Token, log: o.Log}
	pr, pw := io.Pipe()
	cmd.Stdout, cmd.Stderr = pw, pw
	go out.read(pr)

	p := &Process{Port: port, runtimeDir: runtimeDir, token: o.Token, cmd: cmd, exited: make(chan struct{}), out: out}
	wait, release, err := startChild(cmd)
	if err != nil {
		pw.Close()
		os.RemoveAll(runtimeDir)
		code := protocol.CodeJupyterStartFailed
		if o.Python != "" {
			code = protocol.CodeEnvironmentInvalid
		}
		return nil, &Failure{Code: code, Detail: fmt.Sprintf("%s could not be started", filepath.Base(name))}
	}
	p.PID, p.release = cmd.Process.Pid, release
	go func() {
		p.exitErr = <-wait
		pw.Close()
		out.wait()
		close(p.exited)
	}()
	p.Client = NewClient(port, o.Token, LoopbackDial(port))

	deadline := time.NewTimer(o.ReadyTimeout)
	defer deadline.Stop()
	tick := time.NewTicker(o.PollInterval)
	defer tick.Stop()
	for {
		sctx, cancel := context.WithTimeout(ctx, max(o.PollInterval*4, time.Second))
		err := p.Client.Status(sctx)
		cancel()
		var f *Failure
		switch {
		case err == nil:
			return p, nil
		case errors.As(err, &f) && f.Code == protocol.CodeTokenRejected:
			p.kill()
			return nil, f
		}
		select {
		case <-p.exited:
			p.cleanup()
			return nil, &Failure{Code: protocol.CodeJupyterStartFailed, Detail: safetext.ClipTail(safetext.Sanitize("Jupyter exited while starting: "+out.last()), 512)}
		case <-deadline.C:
			p.kill()
			return nil, &Failure{Code: protocol.CodeJupyterStartTimeout, Detail: "Jupyter did not answer within 30 seconds"}
		case <-ctx.Done():
			p.kill()
			return nil, &Failure{Code: protocol.CodeJupyterStartTimeout, Detail: "Jupyter did not become ready in time"}
		case <-tick.C:
		}
	}
}

// Exited is closed when the process has ended.
func (p *Process) Exited() <-chan struct{} { return p.exited }

// Running reports whether the process has not ended.
func (p *Process) Running() bool {
	select {
	case <-p.exited:
		return false
	default:
		return true
	}
}

// Output returns the last lines Jupyter printed, redacted.
func (p *Process) Output() string { return p.out.last() }

// StopTimes are the waits of design §6: after the shutdown request, then after SIGTERM.
type StopTimes struct {
	Shutdown, Terminate time.Duration
}

// DefaultStopTimes are 10 s and 5 s.
var DefaultStopTimes = StopTimes{Shutdown: 10 * time.Second, Terminate: 5 * time.Second}

// Stop stops the server: POST /api/shutdown, wait for the process, then SIGTERM (a kill on
// Windows), then SIGKILL. It returns only once the process is gone. The process is the
// connector's own child, so its pid cannot have been reused while it is being stopped.
func (p *Process) Stop(ctx context.Context, times StopTimes) error {
	if p.Running() {
		sctx, cancel := context.WithTimeout(ctx, times.Shutdown)
		_ = p.Client.Shutdown(sctx)
		select {
		case <-p.exited:
		case <-sctx.Done():
		}
		cancel()
	}
	if p.Running() {
		_ = terminate(p.cmd.Process)
		select {
		case <-p.exited:
		case <-time.After(times.Terminate):
		}
	}
	if p.Running() {
		_ = p.cmd.Process.Kill()
		select {
		case <-p.exited:
		case <-ctx.Done():
			return fmt.Errorf("the Jupyter process %d did not end", p.PID)
		}
	}
	p.cleanup()
	return nil
}

// kill ends a process that never became a session.
func (p *Process) kill() {
	_ = p.cmd.Process.Kill()
	<-p.exited
	p.cleanup()
}

func (p *Process) cleanup() {
	p.Client.CloseIdle()
	if p.release != nil {
		p.release()
	}
	os.RemoveAll(p.runtimeDir)
	if p.holdsToken {
		p.forgetOnce.Do(func() { redact.Forget(p.token) })
	}
}

// tail keeps the last lines of a child's output, redacted, and passes each line to log.
type tail struct {
	token string
	log   func(string)
	mu    sync.Mutex
	lines []string
	done  chan struct{}
	once  sync.Once
}

const tailLines = 20

func (t *tail) init() {
	t.once.Do(func() { t.done = make(chan struct{}) })
}

func (t *tail) read(r io.Reader) {
	t.init()
	defer close(t.done)
	var rd redact.Redactor
	rd.Register(t.token)
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		line := safetext.Line(rd.Redact(redact.Redact(sc.Text())))
		t.mu.Lock()
		t.lines = append(t.lines, line)
		if len(t.lines) > tailLines {
			t.lines = t.lines[len(t.lines)-tailLines:]
		}
		t.mu.Unlock()
		if t.log != nil {
			t.log(line)
		}
	}
	io.Copy(io.Discard, r)
}

func (t *tail) wait() {
	t.init()
	<-t.done
}

func (t *tail) last() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return strings.Join(t.lines, "\n")
}
