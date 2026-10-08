package session

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"parallax/connector/internal/cause"
	"parallax/connector/internal/jupyter/jupytertest"
	"parallax/connector/internal/netscope"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/sshtarget"
	"parallax/connector/internal/sshtest"
)

// sshEnv is a manager whose `ssh` target is the real SSH runtime: an in-process SSH server
// behind a relay that can freeze or cut the transport, running commands with /bin/sh and a stub
// Jupyter, as a remote host would.
type sshEnv struct {
	*env
	host  *sshtest.Server
	relay *sshtest.Relay
	stub  string
	ws    string
	key   string
	clock *clock
}

func newSSHEnv(t *testing.T) *sshEnv {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the in-process SSH server runs commands with /bin/sh")
	}
	stub := jupytertest.Install(t, "")
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	block, err := ssh.MarshalPrivateKey(priv, "test key")
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(t.TempDir(), "id_ed25519")
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	hostKey := sshtest.NewSigner(t)
	host := sshtest.New(t, sshtest.Options{HostKeys: []ssh.Signer{hostKey}, AuthorizedKeys: []ssh.PublicKey{signer.PublicKey()}, Exec: sshtest.POSIXHost(stub)})
	relay := sshtest.NewRelay(t, host.Addr)
	known := &sshtarget.KnownHosts{Path: filepath.Join(t.TempDir(), "known_hosts")}
	if err := known.Add(relay.Host, relay.Port, hostKey.PublicKey()); err != nil {
		t.Fatal(err)
	}
	scope, err := netscope.ParseScope([]string{"127.0.0.0/8"}, "")
	if err != nil {
		t.Fatal(err)
	}
	remote := &sshtarget.Remote{
		SSH:          &sshtarget.Target{Dialer: &netscope.Dialer{Scope: scope, Timeout: 5 * time.Second}, KnownHosts: known},
		PollInterval: 50 * time.Millisecond, Keepalive: 50 * time.Millisecond, KeepaliveLoss: 500 * time.Millisecond,
		Ports: sshtest.QuietPorts,
		Interfaces: func() (cause.Snapshot, error) {
			return cause.Snapshot{Interfaces: []cause.Interface{{Name: "lo", Addrs: []string{"127.0.0.1/8"}}}}, nil
		},
	}
	c := &clock{t: time.Now()}
	e := newEnv(t, func(cfg *Config) {
		cfg.Targets[protocol.TargetSSH] = remote
		cfg.Now = c.Now
		cfg.ManualTicks = true
	}, protocol.Limits{})
	// Before the manager stops its sessions: let bytes pass again, then kill whatever still serves.
	t.Cleanup(func() {
		for _, rec := range jupytertest.Records(t, stub) {
			syscall.Kill(rec.PID, syscall.SIGKILL)
		}
	})
	t.Cleanup(relay.Thaw)
	return &sshEnv{env: e, host: host, relay: relay, stub: stub, ws: t.TempDir(), key: keyPath, clock: c}
}

func (e *sshEnv) target() protocol.Target {
	return protocol.Target{Kind: protocol.TargetSSH, Host: e.relay.Host, Port: e.relay.Port, User: "student",
		Auth: &protocol.AuthRef{Method: protocol.AuthKey, KeyPath: e.key}, Workspace: e.ws}
}

// openSSH opens an owned session on the host and returns its server's pid.
func (e *sshEnv) openSSH(t protocol.Target) int {
	e.t.Helper()
	e.send(&protocol.OpenSession{RequestID: reqA, SessionID: sessionA, Target: t,
		Runtime: protocol.Runtime{Mode: protocol.RuntimeStart, Python: jupytertest.Python(e.stub), KernelName: "python3"}, Lease: lease()})
	e.state(StateStarting)
	e.state(StateReady)
	recs := jupytertest.Records(e.t, e.stub)
	if len(recs) != 1 {
		e.t.Fatalf("%d servers started", len(recs))
	}
	return recs[0].PID
}

// lost waits for the session's next state, which must be want with cause.
func (e *sshEnv) lost(want, why string) {
	e.t.Helper()
	st := e.state(want)
	if st.Cause != why {
		e.t.Fatalf("%s with cause %q, want %q\n%s", st.State, st.Cause, why, e.log.String())
	}
}

// TestA36_SSHLossCausesOverRealTransport (A36, SSH half): a lost SSH session is reported with the
// cause its evidence shows, over a real transport that sleeps, times out, loses its server, ends
// its allocation or becomes unreachable.
func TestA36_SSHLossCausesOverRealTransport(t *testing.T) {
	t.Run("sleep: the computer slept, then the keepalive went unanswered", func(t *testing.T) {
		e := newSSHEnv(t)
		e.openSSH(e.target())
		e.mgr.tick()
		e.clock.add(40 * time.Second) // no tick ran for 40 s: the computer was asleep
		e.mgr.tick()
		e.relay.Freeze()
		e.lost(StateDisconnected, cause.Sleep)
	})
	t.Run("ssh_timeout: the keepalive went unanswered and the host still accepts connections", func(t *testing.T) {
		e := newSSHEnv(t)
		e.openSSH(e.target())
		e.relay.Freeze()
		e.lost(StateDisconnected, cause.SSHTimeout)
	})
	t.Run("service_stopped: SSH answers and the server exited", func(t *testing.T) {
		e := newSSHEnv(t)
		pid := e.openSSH(e.target())
		if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
			t.Fatal(err)
		}
		e.lost(StateStopped, cause.ServiceStopped)
	})
	t.Run("allocation_expired: the transport closed within 5 minutes of expectedEnd", func(t *testing.T) {
		e := newSSHEnv(t)
		tg := e.target()
		tg.ExpectedEnd = time.Now().Add(2 * time.Minute).UTC().Format(time.RFC3339)
		e.openSSH(tg)
		e.relay.Cut()
		e.lost(StateDisconnected, cause.AllocationExpired)
	})
	t.Run("host_unreachable: the transport closed and the host refuses every connection", func(t *testing.T) {
		e := newSSHEnv(t)
		e.openSSH(e.target())
		e.relay.Refuse(true)
		e.relay.Cut()
		e.lost(StateDisconnected, cause.HostUnreachable)
		e.relay.Refuse(false)
	})
}

// TestA36_SSHServerReplacedAfterReconnect (A36): after a reconnect the owned server is watched
// through /api/status. When another program takes its port and refuses the session's token, the
// session is stopped with service_stopped only because its own process is proved gone.
func TestA36_SSHServerReplacedAfterReconnect(t *testing.T) {
	e := newSSHEnv(t)
	pid := e.openSSH(e.target())
	e.relay.Cut()
	e.lost(StateDisconnected, cause.SSHTimeout)
	e.state(StateReady)
	listen := jupytertest.Records(t, e.stub)[0].Listen
	// No keepalive is answered during the swap, so no check can find the port empty meanwhile.
	e.relay.Freeze()
	if err := syscall.Kill(pid, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	var ln net.Listener
	waitUntil(t, "the port to be free", func() bool {
		var err error
		ln, err = net.Listen("tcp", listen)
		return err == nil
	})
	stranger := jupytertest.New("someone-elses-token")
	srv := httptest.NewUnstartedServer(stranger)
	srv.Listener.Close()
	srv.Listener = ln
	srv.Start()
	t.Cleanup(srv.Close)
	e.relay.Thaw()
	e.lost(StateStopped, cause.ServiceStopped)
	refused := false
	for _, r := range stranger.Requests() {
		refused = refused || r.URI == "/api/status"
	}
	if !refused {
		t.Fatal("the stranger on the port was never asked")
	}
}

// TestSSHReconnectKeepsSession (A36): after the transport drops, the connector reconnects on its
// schedule and the session is ready again with the same server and kernel.
func TestSSHReconnectKeepsSession(t *testing.T) {
	e := newSSHEnv(t)
	pid := e.openSSH(e.target())
	kernel := e.startKernel(sessionA)
	e.relay.Cut()
	e.lost(StateDisconnected, cause.SSHTimeout)
	// The schedule's first attempt comes 2 s later; the server and its kernel are still there.
	st := e.state(StateReady)
	if st.Cause != "" {
		t.Fatalf("ready with cause %q", st.Cause)
	}
	if recs := jupytertest.Records(t, e.stub); len(recs) != 1 || recs[0].PID != pid || syscall.Kill(pid, 0) != nil {
		t.Fatal("the server was replaced or ended")
	}
	_, body := e.mustCall(sessionA, "session", "GET", "/api/kernels/"+kernel, nil)
	if !strings.Contains(string(body), kernel) {
		t.Fatalf("the kernel is gone after reconnecting: %s", body)
	}
	// Stopping after a reconnect still ends the server: shutdown, then the marker-proved pid.
	e.send(&protocol.CloseSession{RequestID: reqB, SessionID: sessionA, Stop: true})
	e.state(StateStopping)
	e.lost(StateStopped, cause.UserStop)
	if syscall.Kill(pid, 0) == nil {
		t.Fatal("stopped while the server runs")
	}
}
