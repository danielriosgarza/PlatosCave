package sshtarget

import (
	"context"
	"errors"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"parallax/connector/internal/protocol"
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

// Colab reaches a `colab` target's runtime: one run of the program per SSH connection, whose
// standard output and input carry what an `ssh` target sends over TCP.
type Colab struct{}

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
func (c *Colab) dial(context.Context) (net.Conn, error) {
	path, err := exec.LookPath(colabProgram) // a match through a relative PATH entry is not absolute
	if err != nil || !filepath.IsAbs(path) {
		return nil, &target.Failure{Code: protocol.CodeConnectionRefused, Detail: "the colab program is not on this computer's PATH"}
	}
	home, _ := os.UserHomeDir()
	// Pipes of its own, not StdoutPipe: Wait would close a reader that x/crypto/ssh still reads.
	inR, inW, err1 := os.Pipe()
	outR, outW, err2 := os.Pipe()
	cmd := &exec.Cmd{Path: path, Args: append([]string{colabProgram}, colabArgs[:]...), Env: colabEnviron(), Dir: home,
		Stdin: inR, Stdout: outW}
	if err = errors.Join(err1, err2); err == nil {
		err = cmd.Start()
	}
	inR.Close() // a nil *os.File's Close is harmless
	outW.Close()
	if err != nil {
		inW.Close()
		outR.Close()
		return nil, &target.Failure{Code: protocol.CodeConnectionRefused, Detail: "the colab program could not be started"}
	}
	p := &proxyConn{r: outR, w: inW, cmd: cmd, exited: make(chan struct{})}
	go func() {
		cmd.Wait()
		close(p.exited)
	}()
	return p, nil
}

// proxyConn is one run of the program as a net.Conn.
type proxyConn struct {
	r, w   *os.File
	cmd    *exec.Cmd
	exited chan struct{}
	once   sync.Once
}

func (p *proxyConn) Read(b []byte) (int, error)  { return p.r.Read(b) }
func (p *proxyConn) Write(b []byte) (int, error) { return p.w.Write(b) }

// Close closes both pipes, which ends the program's connection; a program still running 2 s
// later is killed.
func (p *proxyConn) Close() error {
	p.once.Do(func() {
		p.w.Close()
		p.r.Close()
		go func() {
			select {
			case <-p.exited:
			case <-time.After(2 * time.Second):
				p.cmd.Process.Kill()
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
