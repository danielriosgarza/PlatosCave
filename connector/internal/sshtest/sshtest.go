// Package sshtest is an in-process SSH server for the connector's tests (docs/design/connector.md
// §15): host keys that can be rotated, rekeying, publickey (plain keys and certificates),
// keyboard-interactive as a second factor after publickey or on its own, password, direct-tcpip
// channels that are allowed, denied or routed (a jump host), and exec. Commands run under
// /bin/sh, as a POSIX account's shell would run them, unless Exec is replaced.
package sshtest

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os/exec"
	"strconv"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// Exec runs one command for an exec request and returns its exit status.
type Exec func(command string, stdin io.Reader, stdout, stderr io.Writer) int

// MFA is a keyboard-interactive second factor.
type MFA struct {
	// Question is the prompt sent to the client.
	Question string
	// Answer is the accepted answer.
	Answer string
	// Tries is how many answers the server takes before it gives up; zero means 3.
	Tries int
}

// Options configure a Server.
type Options struct {
	// HostKeys are the server's host keys; one Ed25519 key is generated when empty.
	HostKeys []ssh.Signer
	// User is the only account; empty means "student".
	User string
	// AuthorizedKeys are accepted for publickey.
	AuthorizedKeys []ssh.PublicKey
	// CertAuthority, when set, accepts user certificates it signed for User.
	CertAuthority ssh.PublicKey
	// MFA, when set, is asked with keyboard-interactive after a publickey partial success.
	MFA *MFA
	// Password, when set, is the only method offered: password authentication with this value.
	Password string
	// KeyboardOnly offers only keyboard-interactive, as a host with password-style PAM would.
	KeyboardOnly bool
	// DenyForwarding answers every direct-tcpip open "administratively prohibited".
	DenyForwarding bool
	// Routes maps a direct-tcpip destination "host:port" to the address actually dialled, as a
	// jump host resolving a name would. Destinations without a route are dialled as given only
	// when they are on 127.0.0.1; anything else is "connect failed".
	Routes map[string]string
	// DenyExec rejects every exec request, as a host that permits no commands would.
	DenyExec bool
	// Exec replaces /bin/sh for exec requests.
	Exec Exec
	// BannerDelay delays the SSH version banner of every connection.
	BannerDelay time.Duration
	// AuthDelay delays every publickey decision.
	AuthDelay time.Duration
	// RekeyThreshold, when set, makes the server rekey after this many bytes.
	RekeyThreshold uint64
}

// Login is one successful authentication.
type Login struct {
	User        string
	Fingerprint string
	Cert        bool
	MFA         bool
}

// Server is a running in-process SSH server on 127.0.0.1.
type Server struct {
	Addr string
	Host string
	Port int

	opts Options
	ln   net.Listener

	mu        sync.Mutex
	hostKeys  []ssh.Signer
	logins    []Login
	offered   []string
	execs     []string
	opens     []string
	kbdAsked  int
	conns     int
	closeOnce sync.Once
	wg        sync.WaitGroup
}

// New starts a server and stops it when the test ends.
func New(t testing.TB, opts Options) *Server {
	t.Helper()
	if opts.User == "" {
		opts.User = "student"
	}
	if len(opts.HostKeys) == 0 {
		opts.HostKeys = []ssh.Signer{NewSigner(t)}
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().(*net.TCPAddr)
	s := &Server{Addr: ln.Addr().String(), Host: "127.0.0.1", Port: addr.Port, opts: opts, ln: ln, hostKeys: opts.HostKeys}
	s.wg.Add(1)
	go s.serve()
	t.Cleanup(s.Close)
	return s
}

// NewSigner generates an Ed25519 key.
func NewSigner(t testing.TB) ssh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// SetHostKeys replaces the host keys for new connections: a rotated host key.
func (s *Server) SetHostKeys(keys ...ssh.Signer) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.hostKeys = keys
}

// Logins returns the successful authentications so far.
func (s *Server) Logins() []Login {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Login(nil), s.logins...)
}

// Offered returns the fingerprints of every public key a client offered, in order.
func (s *Server) Offered() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.offered...)
}

// Execs returns every command a client asked to run.
func (s *Server) Execs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.execs...)
}

// Opens returns every direct-tcpip destination a client asked for.
func (s *Server) Opens() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.opens...)
}

// KeyboardRounds is how many keyboard-interactive rounds the server sent.
func (s *Server) KeyboardRounds() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kbdAsked
}

// Connections is how many TCP connections the server accepted.
func (s *Server) Connections() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.conns
}

// Close stops the server.
func (s *Server) Close() {
	s.closeOnce.Do(func() {
		s.ln.Close()
		s.wg.Wait()
	})
}

func (s *Server) serve() {
	defer s.wg.Done()
	for {
		c, err := s.ln.Accept()
		if err != nil {
			return
		}
		s.mu.Lock()
		s.conns++
		s.mu.Unlock()
		go s.handle(c)
	}
}

func (s *Server) config() *ssh.ServerConfig {
	o := s.opts
	cfg := &ssh.ServerConfig{}
	cfg.RekeyThreshold = o.RekeyThreshold
	s.mu.Lock()
	for _, k := range s.hostKeys {
		cfg.AddHostKey(k)
	}
	s.mu.Unlock()
	kbd := func(c ssh.ConnMetadata, client ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
		m := o.MFA
		tries := 3
		if m != nil && m.Tries > 0 {
			tries = m.Tries
		}
		for i := 0; i < tries; i++ {
			s.mu.Lock()
			s.kbdAsked++
			s.mu.Unlock()
			q := "Password: "
			if m != nil {
				q = m.Question
			}
			ans, err := client(c.User(), "", []string{q}, []bool{false})
			if err != nil {
				return nil, err
			}
			if m != nil && len(ans) == 1 && ans[0] == m.Answer {
				return &ssh.Permissions{Extensions: map[string]string{"mfa": "yes"}}, nil
			}
		}
		return nil, errors.New("second factor rejected")
	}
	switch {
	case o.Password != "":
		cfg.PasswordCallback = func(c ssh.ConnMetadata, pw []byte) (*ssh.Permissions, error) {
			if c.User() == o.User && string(pw) == o.Password {
				return nil, nil
			}
			return nil, errors.New("wrong password")
		}
		return cfg
	case o.KeyboardOnly:
		cfg.KeyboardInteractiveCallback = kbd
		return cfg
	}
	checker := &ssh.CertChecker{
		IsUserAuthority: func(auth ssh.PublicKey) bool {
			return o.CertAuthority != nil && bytes.Equal(auth.Marshal(), o.CertAuthority.Marshal())
		},
	}
	cfg.PublicKeyCallback = func(c ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
		if o.AuthDelay > 0 {
			time.Sleep(o.AuthDelay)
		}
		fp := ssh.FingerprintSHA256(key)
		cert, isCert := key.(*ssh.Certificate)
		if isCert {
			fp = ssh.FingerprintSHA256(cert.Key)
		}
		s.mu.Lock()
		s.offered = append(s.offered, fp)
		s.mu.Unlock()
		if c.User() != o.User {
			return nil, errors.New("unknown user")
		}
		ok := false
		if isCert {
			if _, err := checker.Authenticate(c, key); err == nil {
				ok = true
			}
		} else {
			for _, k := range o.AuthorizedKeys {
				if bytes.Equal(k.Marshal(), key.Marshal()) {
					ok = true
				}
			}
		}
		if !ok {
			return nil, errors.New("key not authorized")
		}
		perms := &ssh.Permissions{Extensions: map[string]string{"fp": fp}}
		if isCert {
			perms.Extensions["cert"] = "yes"
		}
		if o.MFA != nil {
			return nil, &ssh.PartialSuccessError{Next: ssh.ServerAuthCallbacks{
				KeyboardInteractiveCallback: func(c ssh.ConnMetadata, client ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
					p, err := kbd(c, client)
					if err != nil {
						return nil, err
					}
					p.Extensions["fp"] = fp
					if isCert {
						p.Extensions["cert"] = "yes"
					}
					return p, nil
				},
			}}
		}
		return perms, nil
	}
	return cfg
}

func (s *Server) handle(c net.Conn) {
	if s.opts.BannerDelay > 0 {
		time.Sleep(s.opts.BannerDelay)
	}
	sc, chans, reqs, err := ssh.NewServerConn(c, s.config())
	if err != nil {
		c.Close()
		return
	}
	defer sc.Close()
	if p := sc.Permissions; p != nil && p.Extensions != nil {
		s.mu.Lock()
		s.logins = append(s.logins, Login{User: sc.User(), Fingerprint: p.Extensions["fp"], Cert: p.Extensions["cert"] == "yes", MFA: p.Extensions["mfa"] == "yes"})
		s.mu.Unlock()
	} else {
		s.mu.Lock()
		s.logins = append(s.logins, Login{User: sc.User()})
		s.mu.Unlock()
	}
	go ssh.DiscardRequests(reqs)
	for nc := range chans {
		switch nc.ChannelType() {
		case "direct-tcpip":
			go s.forward(nc)
		case "session":
			go s.session(nc)
		default:
			nc.Reject(ssh.UnknownChannelType, "unsupported channel type")
		}
	}
}

// forward serves a direct-tcpip channel (RFC 4254 §7.2).
func (s *Server) forward(nc ssh.NewChannel) {
	var p struct {
		Host     string
		Port     uint32
		OrigHost string
		OrigPort uint32
	}
	if err := ssh.Unmarshal(nc.ExtraData(), &p); err != nil {
		nc.Reject(ssh.ConnectionFailed, "bad request")
		return
	}
	dest := net.JoinHostPort(p.Host, strconv.Itoa(int(p.Port)))
	s.mu.Lock()
	s.opens = append(s.opens, dest)
	s.mu.Unlock()
	if s.opts.DenyForwarding {
		nc.Reject(ssh.Prohibited, "open failed")
		return
	}
	addr, ok := s.opts.Routes[dest]
	if !ok {
		if p.Host != "127.0.0.1" {
			nc.Reject(ssh.ConnectionFailed, "no route to "+dest)
			return
		}
		addr = dest
	}
	conn, err := net.DialTimeout("tcp", addr, 5*time.Second)
	if err != nil {
		nc.Reject(ssh.ConnectionFailed, "connect failed")
		return
	}
	ch, reqs, err := nc.Accept()
	if err != nil {
		conn.Close()
		return
	}
	go ssh.DiscardRequests(reqs)
	go func() {
		io.Copy(ch, conn)
		ch.CloseWrite()
	}()
	io.Copy(conn, ch)
	conn.Close()
	ch.Close()
}

// session serves exec requests on a session channel.
func (s *Server) session(nc ssh.NewChannel) {
	ch, reqs, err := nc.Accept()
	if err != nil {
		return
	}
	defer ch.Close()
	for req := range reqs {
		if req.Type != "exec" {
			req.Reply(false, nil)
			continue
		}
		var p struct{ Command string }
		if err := ssh.Unmarshal(req.Payload, &p); err != nil || s.opts.DenyExec {
			req.Reply(false, nil)
			continue
		}
		s.mu.Lock()
		s.execs = append(s.execs, p.Command)
		s.mu.Unlock()
		req.Reply(true, nil)
		run := s.opts.Exec
		if run == nil {
			run = shell
		}
		code := run(p.Command, ch, ch, ch.Stderr())
		status := make([]byte, 4)
		binary.BigEndian.PutUint32(status, uint32(code))
		ch.SendRequest("exit-status", false, status)
		return
	}
}

// shell runs a command with /bin/sh -c, as sshd runs it with a POSIX account's shell.
func shell(command string, stdin io.Reader, stdout, stderr io.Writer) int {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	cmd.Stdout, cmd.Stderr = stdout, stderr
	cmd.Stdin = io.LimitReader(stdin, 0)
	err := cmd.Run()
	var ee *exec.ExitError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &ee):
		return ee.ExitCode()
	}
	fmt.Fprintln(stderr, err)
	return 127
}
