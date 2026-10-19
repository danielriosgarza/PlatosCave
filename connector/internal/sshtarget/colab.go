package sshtarget

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"parallax/connector/internal/protocol"
	"parallax/connector/internal/redact"
	"parallax/connector/internal/safetext"
	"parallax/connector/internal/target"
)

// The one command of a `colab` target (docs/design/connector.md §5.7): the program colab, found
// on the PATH of the connector's own process, with exactly these arguments and never a shell. No
// message, configuration file or flag adds to them or names another program.
const colabProgram = "colab"

var colabArgs = [...]string{"ssh", "--proxy-mode"}

// colabEnv names the only variables the program receives, copied from the connector's own
// environment: never SSH_AUTH_SOCK or a PARALLAX_* variable, and no value of a message.
var colabEnv = [...]string{"HOME", "USER", "LOGNAME", "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR",
	"XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_RUNTIME_DIR",
	"HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"}

// stderrKeep is how much of the program's standard error is held at a time.
const stderrKeep = 4 << 10

// Colab reaches a `colab` target's runtime: one run of the program per SSH connection, whose
// standard output and input carry what an `ssh` target sends over TCP.
type Colab struct {
	// Log receives the connector's own line about a run that ended before an SSH banner: fixed
	// text and the exit status, never a byte of the program's output.
	Log func(string)
}

// colabEnviron is the program's environment: the variables of colabEnv that the connector's own
// environment sets. It is never nil, so the program never inherits the whole environment.
func colabEnviron() []string {
	env := []string{}
	for _, k := range colabEnv {
		if v := os.Getenv(k); v != "" {
			env = append(env, k+"="+v)
		}
	}
	return env
}

// dial starts one run of the program, in the home directory, and returns its standard output
// and input as the connection. Closing the connection ends the run.
func (c *Colab) dial(context.Context) (*proxyConn, error) {
	path, err := exec.LookPath(colabProgram) // a match through a relative PATH entry is not absolute
	if err != nil || !filepath.IsAbs(path) {
		return nil, &target.Failure{Code: protocol.CodeColabMissing, Detail: "the colab program is not on the PATH of the connector's computer"}
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, &target.Failure{Code: protocol.CodeColabProxyFailed, Detail: "the colab program was not started: the connector's account has no home directory"}
	}
	// Pipes of its own, not StdoutPipe: Wait would close a reader that x/crypto/ssh still reads.
	inR, inW, err1 := os.Pipe()
	outR, outW, err2 := os.Pipe()
	errR, errW, err3 := os.Pipe()
	cmd := &exec.Cmd{Path: path, Args: append([]string{colabProgram}, colabArgs[:]...), Env: colabEnviron(), Dir: home,
		Stdin: inR, Stdout: outW, Stderr: errW}
	p := &proxyConn{r: outR, w: inW, cmd: cmd, exited: make(chan struct{}), signalGroup: signalGroup}
	if err = errors.Join(err1, err2, err3); err == nil {
		err = startProxy(cmd, func() { p.signal(syscall.SIGKILL, true); close(p.exited) })
	}
	inR.Close() // a nil *os.File's Close is harmless
	outW.Close()
	errW.Close()
	if err != nil {
		inW.Close()
		outR.Close()
		errR.Close()
		return nil, &target.Failure{Code: protocol.CodeColabProxyFailed, Detail: "the colab program could not be started"}
	}
	go drain(errR)
	return p, nil
}

// drain reads the program's standard error until it closes, so a full pipe never blocks the
// program, holding only the last 4 KiB. Those bytes are redacted and sanitised and then dropped:
// no byte of the program's output is logged, shown or sent (design §5.7).
func drain(r *os.File) {
	defer r.Close()
	tail, buf := make([]byte, 0, 2*stderrKeep), make([]byte, stderrKeep)
	for {
		n, err := r.Read(buf)
		if tail = append(tail, buf[:n]...); len(tail) > stderrKeep {
			tail = append(tail[:0], tail[len(tail)-stderrKeep:]...)
		}
		if err != nil {
			break
		}
	}
	_ = safetext.Sanitize(redact.Redact(string(tail)))
}

// failed is a run that sent no SSH banner: once the program has ended (closing the run ends it),
// the connector logs and reports its own line with the exit status, or without one when its own
// signal ended the program, and nothing the program wrote.
func (c *Colab) failed(ctx context.Context, p *proxyConn) error {
	p.Close()
	select {
	case <-p.exited:
	case <-ctx.Done():
		return ctx.Err()
	}
	p.mu.Lock()
	ended := p.ended
	p.mu.Unlock()
	line := "the colab program ended with " + p.cmd.ProcessState.String() + " before a Colab runtime answered"
	if ended {
		line = "the colab program did not answer as an SSH server, and the connector ended it"
	}
	if c.Log != nil {
		c.Log(line)
	}
	return &target.Failure{Code: protocol.CodeColabProxyFailed, Detail: line}
}

// proxyConn is one run of the program as a net.Conn.
type proxyConn struct {
	r, w   *os.File
	cmd    *exec.Cmd
	exited chan struct{}
	once   sync.Once
	mu     sync.Mutex // the group is signalled, and reaped and ended set, under mu
	reaped bool
	ended  bool // the connector signalled the program before it exited
	// signalGroup signals the group pid leads: the package's, or a test's for this run only.
	signalGroup func(pid int, sig syscall.Signal)
}

func (p *proxyConn) Read(b []byte) (int, error)  { return p.r.Read(b) }
func (p *proxyConn) Write(b []byte) (int, error) { return p.w.Write(b) }

// signal sends sig to the program's group until its leader's end (last) is recorded; at that end
// what is left of the group is killed, before its id can be reused, and never signalled again.
func (p *proxyConn) signal(sig syscall.Signal, last bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.reaped {
		p.signalGroup(p.cmd.Process.Pid, sig)
		p.ended = p.ended || !last
	}
	p.reaped = p.reaped || last
}

// Close closes both pipes, which ends the program's connection. If the program has not exited
// 2 s later, its group gets SIGTERM and 1 s after that SIGKILL (signal ends one that exits).
func (p *proxyConn) Close() error {
	p.once.Do(func() {
		p.w.Close()
		p.r.Close()
		go func() {
			for i, sig := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
				select {
				case <-p.exited:
					return
				case <-time.After(time.Duration(2-i) * time.Second):
					p.signal(sig, false)
				}
			}
		}()
	})
	return nil
}

// The run has no address: reachable() and routeOf() cannot parse colabAddr, so a lost route
// counts as unreachable (design §5.5).
var colabAddr = &net.UnixAddr{Net: "colab", Name: endpointName(protocol.ColabHost, protocol.ColabPort)}

func (p *proxyConn) LocalAddr() net.Addr              { return colabAddr }
func (p *proxyConn) RemoteAddr() net.Addr             { return colabAddr }
func (p *proxyConn) SetDeadline(time.Time) error      { return nil }
func (p *proxyConn) SetReadDeadline(time.Time) error  { return nil }
func (p *proxyConn) SetWriteDeadline(time.Time) error { return nil }
