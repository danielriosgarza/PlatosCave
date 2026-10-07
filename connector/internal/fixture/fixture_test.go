//go:build fixture

package fixture

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/netscope"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/sshtarget"
	"parallax/connector/internal/target"
)

// The fixture's endpoints (infra/compose.yml, profile connector), all on loopback.
const (
	host         = "127.0.0.1"
	directPort   = 2222 // sshd-jupyter, forwarding on
	noFwdPort    = 2223 // sshd-jupyter, AllowTcpForwarding no
	rotatingPort = 2224 // sshd-jupyter, host key replaced by rotate-host-key
	jumpPort     = 2225 // jump: may open sshd-jupyter:22 only
	onwardName   = "sshd-jupyter"
	requestID    = "c0ffee00-1111-4222-8333-444455556666"
	sessionID    = "7b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f"
)

// repoRoot is the directory with infra/compose.yml above the test's.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "infra", "compose.yml")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			t.Fatal("infra/compose.yml not found above the working directory")
		}
		dir = parent
	}
}

// keyPath is the fixture client key made by scripts/connector-fixture-keys.sh.
func keyPath(t *testing.T) string {
	t.Helper()
	dir := os.Getenv("CONNECTOR_FIXTURE_DIR")
	if dir == "" {
		dir = filepath.Join(repoRoot(t), ".local", "connector-fixtures")
	}
	p := filepath.Join(dir, "id_ed25519")
	if _, err := os.Stat(p); err != nil {
		t.Fatalf("no fixture key: run scripts/connector-fixture-keys.sh (%v)", err)
	}
	return p
}

// reachable fails the test, not skips it, when a fixture is down: a skipped fixture suite would
// be a green check that proved nothing.
func reachable(t *testing.T, port int) {
	t.Helper()
	c, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), 3*time.Second)
	if err != nil {
		t.Fatalf("fixture on port %d is not running: %v", port, err)
	}
	c.Close()
}

// presented dials addr, optionally through a jump client, and returns the host key it presents
// without authenticating.
func presented(t *testing.T, addr string, via *ssh.Client) string {
	t.Helper()
	got, err := presentedKey(addr, via)
	if err != nil {
		t.Fatal(err)
	}
	return got
}

func presentedKey(addr string, via *ssh.Client) (string, error) {
	var got string
	cfg := &ssh.ClientConfig{
		User: "probe",
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			got = ssh.FingerprintSHA256(key)
			return errors.New("probe done")
		},
		Timeout: 10 * time.Second,
	}
	var conn net.Conn
	var err error
	if via != nil {
		conn, err = via.Dial("tcp", addr)
	} else {
		conn, err = net.DialTimeout("tcp", addr, 10*time.Second)
	}
	if err != nil {
		return "", fmt.Errorf("dial %s: %w", addr, err)
	}
	defer conn.Close()
	// ClientConfig.Timeout covers only ssh.Dial: a key exchange that stalls (sshd re-executing
	// after SIGHUP) must not hang the poll that calls this.
	conn.SetDeadline(time.Now().Add(10 * time.Second))
	ssh.NewClientConn(conn, addr, cfg) // fails by design once the key is read
	if got == "" {
		return "", fmt.Errorf("%s presented no host key", addr)
	}
	return got, nil
}

// jumpClient opens an authenticated connection to the jump host, for reading the target's key.
func jumpClient(t *testing.T) *ssh.Client {
	t.Helper()
	pem, err := os.ReadFile(keyPath(t))
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.ParsePrivateKey(pem)
	if err != nil {
		t.Fatal(err)
	}
	c, err := ssh.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(jumpPort)), &ssh.ClientConfig{
		User:            "jump",
		Auth:            []ssh.AuthMethod{ssh.PublicKeys(signer)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(), // the fixture's own key, read only to confirm it below
		Timeout:         10 * time.Second,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

// rig is a Remote with its own known_hosts, as the connector builds it.
type rig struct {
	t      *testing.T
	remote *sshtarget.Remote
	known  *sshtarget.KnownHosts
}

func newRig(t *testing.T) *rig {
	t.Helper()
	scope, err := netscope.ParseScope([]string{"127.0.0.0/8"}, "")
	if err != nil {
		t.Fatal(err)
	}
	known := &sshtarget.KnownHosts{Path: filepath.Join(t.TempDir(), "known_hosts")}
	tg := &sshtarget.Target{
		Dialer:     &netscope.Dialer{Scope: scope, Timeout: 10 * time.Second},
		KnownHosts: known,
		Log:        func(string) {},
	}
	return &rig{t: t, known: known, remote: &sshtarget.Remote{
		SSH:          tg,
		Log:          func(string) {},
		ReadyTimeout: 60 * time.Second,
	}}
}

// student is the target of the main account on one port, directly or through the jump host.
func student(t *testing.T, user string, port int, jump bool) protocol.Target {
	t.Helper()
	auth := &protocol.AuthRef{Method: protocol.AuthKey, KeyPath: keyPath(t)}
	tg := protocol.Target{Kind: protocol.TargetSSH, Host: host, Port: port, User: user, Auth: auth, Workspace: "/home/" + user + "/work"}
	if jump {
		tg.Host, tg.Port = onwardName, 22
		tg.Jump = &protocol.Hop{Host: host, Port: jumpPort, User: "jump", Auth: auth}
	}
	return tg
}

func start() protocol.Runtime {
	return protocol.Runtime{Mode: protocol.RuntimeStart, KernelName: "python3"}
}

// confirmations are the first-use keys the person would confirm, read from what each host presents.
func confirmations(t *testing.T, tg protocol.Target) []protocol.Confirmation {
	t.Helper()
	if tg.Jump == nil {
		return []protocol.Confirmation{{Host: tg.Host, Port: tg.Port, SHA256: presented(t, net.JoinHostPort(tg.Host, strconv.Itoa(tg.Port)), nil)}}
	}
	via := jumpClient(t)
	return []protocol.Confirmation{
		{Host: tg.Jump.Host, Port: tg.Jump.Port, SHA256: presented(t, net.JoinHostPort(tg.Jump.Host, strconv.Itoa(tg.Jump.Port)), nil)},
		{Host: tg.Host, Port: tg.Port, SHA256: presented(t, net.JoinHostPort(tg.Host, strconv.Itoa(tg.Port)), via)},
	}
}

func (r *rig) test(tg protocol.Target, rt protocol.Runtime, confirm []protocol.Confirmation) *protocol.TestResult {
	r.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	return r.remote.Test(ctx, &protocol.TestConnection{RequestID: requestID, Target: tg, Runtime: rt, Confirmations: confirm}, func(protocol.Stage) {})
}

func summary(stages []protocol.Stage) string {
	var parts []string
	for _, st := range stages {
		p := st.Name + "=" + st.Status
		if st.Code != "" {
			p += ":" + string(st.Code)
		}
		parts = append(parts, p)
	}
	return strings.Join(parts, " ")
}

func (r *rig) open(tg protocol.Target, rt protocol.Runtime) (*target.Runtime, error) {
	r.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	out, err := r.remote.Open(ctx, &protocol.OpenSession{RequestID: requestID, SessionID: sessionID, Target: tg, Runtime: rt,
		Lease: protocol.Lease{IdleTimeoutMin: 30, GracePeriodMin: 5}})
	if out != nil {
		r.t.Cleanup(out.Remote.Close)
	}
	return out, err
}

func wantFailure(t *testing.T, err error, code protocol.Code) {
	t.Helper()
	var f *target.Failure
	if !errors.As(err, &f) || f.Code != code {
		t.Fatalf("got %v, want %s", err, code)
	}
}

// TestA28_RealSSHAndJump (A28): against a real sshd, directly and through a jump host that may
// open only the host's port 22, every stage passes, Jupyter starts on the host's loopback and
// answers through the tunnel only, and Stop ends it.
func TestA28_RealSSHAndJump(t *testing.T) {
	reachable(t, directPort)
	reachable(t, jumpPort)
	want := "reachability=ok host_identity=ok ssh_auth=ok workspace=ok forwarding=ok runtime=ok notebook_auth=skipped kernels=ok"
	for _, route := range []struct {
		name string
		jump bool
		port int
	}{{"direct", false, directPort}, {"through the jump host", true, 22}} {
		t.Run(route.name, func(t *testing.T) {
			r := newRig(t)
			tg := student(t, "student", route.port, route.jump)
			res := r.test(tg, start(), confirmations(t, tg))
			if got := summary(res.Stages); got != want || res.Outcome != "ready_to_start" {
				t.Fatalf("%s %s\nwant %s", res.Outcome, got, want)
			}
			if d := res.Stages[3].Data; d == nil || d.ResolvedPath != "/home/student/work" {
				t.Errorf("workspace stage %+v", res.Stages[3])
			}
			if route.jump {
				d := res.Stages[1].Data
				if d == nil {
					t.Fatalf("host_identity stage has no data: %+v", res.Stages[1])
				}
				if hops := d.Hops; len(hops) != 2 || hops[0].Hop != "jump" || hops[1].Hop != "target" {
					t.Errorf("hops %+v", hops)
				}
			}
			if res.Environment == nil || res.Environment.OS != "linux" || res.JupyterVersion == "" {
				t.Errorf("environment %+v, jupyter %q", res.Environment, res.JupyterVersion)
			}

			rt, err := r.open(tg, start())
			if err != nil {
				t.Fatal(err)
			}
			if !rt.Owned || !jupyter.HasKernel(rt.Kernelspecs, "python3") {
				t.Fatalf("runtime %+v", rt)
			}
			ctx := context.Background()
			if err := rt.Client.Status(ctx); err != nil {
				t.Fatalf("status through the tunnel: %v", err)
			}
			pid, port := rt.Remote.Process()
			if pid <= 0 || port < 20000 || port > 59999 {
				t.Fatalf("process %d, port %d", pid, port)
			}
			// No Jupyter port is published: the host's loopback is inside the container. Without
			// containers (CONNECTOR_FIXTURE_NO_DOCKER=1, a local sshd) it is this computer's.
			if os.Getenv("CONNECTOR_FIXTURE_NO_DOCKER") != "" {
				t.Log("no containers: the published-port check is skipped")
			} else if c, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(port)), time.Second); err == nil {
				c.Close()
				t.Errorf("the Jupyter port %d answers on this computer's loopback", port)
			}
			if err := rt.Remote.Stop(ctx, jupyter.DefaultStopTimes); err != nil {
				t.Fatalf("stop: %v", err)
			}
		})
	}
}

// TestA29_RealStages (A29): a host that forbids forwarding, an account without Jupyter and an
// account whose Jupyter holds another token each name their stage and never reach ready.
func TestA29_RealStages(t *testing.T) {
	reachable(t, noFwdPort)
	reachable(t, directPort)

	t.Run("forwarding forbidden", func(t *testing.T) {
		r := newRig(t)
		tg := student(t, "student", noFwdPort, false)
		res := r.test(tg, start(), confirmations(t, tg))
		want := "reachability=ok host_identity=ok ssh_auth=ok workspace=ok forwarding=failed:forwarding_denied runtime=skipped notebook_auth=skipped kernels=skipped"
		if got := summary(res.Stages); got != want || res.Outcome != "failed" {
			t.Fatalf("%s %s\nwant %s", res.Outcome, got, want)
		}
		_, err := r.open(tg, start())
		wantFailure(t, err, protocol.CodeForwardingDenied)
	})

	t.Run("Jupyter missing", func(t *testing.T) {
		r := newRig(t)
		tg := student(t, "bare", directPort, false)
		res := r.test(tg, start(), confirmations(t, tg))
		want := "reachability=ok host_identity=ok ssh_auth=ok workspace=ok forwarding=ok runtime=failed:jupyter_missing notebook_auth=skipped kernels=skipped"
		if got := summary(res.Stages); got != want || res.Outcome != "failed" {
			t.Fatalf("%s %s\nwant %s", res.Outcome, got, want)
		}
		_, err := r.open(tg, start())
		wantFailure(t, err, protocol.CodeJupyterMissing)
	})

	t.Run("token rejected", func(t *testing.T) {
		r := newRig(t)
		tg := student(t, "locked", directPort, false)
		confirm := confirmations(t, tg)
		// Test connection starts nothing, so the stages before the server pass...
		res := r.test(tg, start(), confirm)
		if res.Outcome != "ready_to_start" {
			t.Fatalf("%s %s", res.Outcome, summary(res.Stages))
		}
		// ...and Connect, which starts the server, is refused at the token and never reaches ready.
		out, err := r.open(tg, start())
		if out != nil {
			t.Fatalf("a session opened on a server that rejects the token: %+v", out)
		}
		wantFailure(t, err, protocol.CodeTokenRejected)
	})
}

// rotate replaces the host key of the rotating instance, as `ssh-keygen -A` after a rebuild would.
// CONNECTOR_FIXTURE_ROTATE_CMD replaces the docker command for a local sshd without containers.
func rotate(t *testing.T) {
	t.Helper()
	cmd := exec.Command("docker", "compose", "-f", filepath.Join(repoRoot(t), "infra", "compose.yml"),
		"--profile", "connector", "exec", "-T", "sshd-jupyter", "rotate-host-key")
	if custom := os.Getenv("CONNECTOR_FIXTURE_ROTATE_CMD"); custom != "" {
		cmd = exec.Command("sh", "-c", custom)
	}
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("rotate-host-key: %v\n%s", err, out)
	}
}

// TestA30_RealRotatedHostKey (A30): after the host key of a trusted host is replaced, the
// connection stops at host_identity with host_key_changed, no credential is offered and the
// connector's record keeps the old key.
func TestA30_RealRotatedHostKey(t *testing.T) {
	reachable(t, rotatingPort)
	r := newRig(t)
	// A connection kept from Test connection would be reused for Connect (design §5.3) and never
	// meet the new key; Connect must check the key itself.
	r.remote.ReuseFor = time.Nanosecond
	tg := student(t, "student", rotatingPort, false)
	confirm := confirmations(t, tg)
	if res := r.test(tg, start(), confirm); res.Outcome != "ready_to_start" {
		t.Fatalf("first use: %s %s", res.Outcome, summary(res.Stages))
	}
	before, err := os.ReadFile(r.known.Path)
	if err != nil || len(before) == 0 {
		t.Fatalf("the first connection recorded no key: %v", err)
	}

	rotate(t)
	deadline := time.Now().Add(15 * time.Second)
	for {
		// sshd re-executes itself on SIGHUP, so the port may refuse for a moment.
		got, err := presentedKey(net.JoinHostPort(host, strconv.Itoa(rotatingPort)), nil)
		if err == nil && got != confirm[0].SHA256 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("sshd still presents the old key after rotate-host-key (%v)", err)
		}
		time.Sleep(200 * time.Millisecond)
	}

	res := r.test(tg, start(), nil)
	want := "reachability=ok host_identity=failed:host_key_changed ssh_auth=skipped workspace=skipped forwarding=skipped runtime=skipped notebook_auth=skipped kernels=skipped"
	if got := summary(res.Stages); got != want || res.Outcome != "failed" {
		t.Fatalf("%s %s\nwant %s", res.Outcome, got, want)
	}
	if d := res.Stages[1].Data; d == nil || d.Expected != confirm[0].SHA256 || d.Presented == confirm[0].SHA256 {
		t.Errorf("host_identity %+v, expected the old key %s", res.Stages[1].Data, confirm[0].SHA256)
	}
	after, _ := os.ReadFile(r.known.Path)
	if string(after) != string(before) {
		t.Errorf("known_hosts changed:\n%s\nwas\n%s", after, before)
	}
	_, err = r.open(tg, start())
	wantFailure(t, err, protocol.CodeHostKeyChanged)
}
