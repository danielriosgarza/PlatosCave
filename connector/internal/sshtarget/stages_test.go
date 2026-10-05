package sshtarget

import (
	"context"
	"io"
	"net/netip"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"parallax/connector/internal/netscope"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/sshtest"
	"parallax/connector/internal/target"
)

func writeFile(t *testing.T, path string, data []byte) {
	t.Helper()
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestJumpRouting: the target is reached as a direct-tcpip channel of the jump host's connection,
// by the name as typed (the connector never resolves it), and authenticated end to end.
func TestJumpRouting(t *testing.T) {
	skipWithoutShell(t)
	f := newFixture(t)
	key := newClientKey(t, "")
	jr := newJumpRoute(t, []ssh.PublicKey{key.signer.PublicKey()})
	f.trustRoute(jr)
	f.tg.Dialer.Resolver = refusingResolver{t}
	res := f.check(jr.req(keyAuth(key), t.TempDir()))
	if res.conn == nil {
		t.Fatalf("%s", res.statuses())
	}
	if got := jr.jump.Opens(); len(got) != 1 || got[0] != jr.name+":22" {
		t.Errorf("jump host opened %v", got)
	}
	if jr.target.Connections() != 1 || len(jr.jump.Logins()) != 1 || len(jr.target.Logins()) != 1 {
		t.Errorf("connections %d, logins jump %d target %d", jr.target.Connections(), len(jr.jump.Logins()), len(jr.target.Logins()))
	}
	// The connection returned runs commands on the target, not on the jump host.
	sess, err := res.conn.Client.NewSession()
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()
	if err := sess.Run("true"); err != nil {
		t.Fatal(err)
	}
	if n := len(jr.target.Execs()); n != 2 || len(jr.jump.Execs()) != 0 {
		t.Errorf("execs: target %v, jump %v", jr.target.Execs(), jr.jump.Execs())
	}
	if reach := res.stage(t, "reachability"); reach.Data.Hop != "target" || reach.Data.Address != "" {
		t.Errorf("reachability data %+v: the target's address is the jump host's business", reach.Data)
	}
}

// refusingResolver fails the test if the connector resolves a name: only literals are dialled.
type refusingResolver struct{ t *testing.T }

func (r refusingResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	r.t.Errorf("the connector resolved %q", host)
	return nil, io.EOF
}

// TestJumpHopKeyChecked: the jump host's key goes through the same table as the target's, and a
// jump host that does not pass stops the route before the target is contacted.
func TestJumpHopKeyChecked(t *testing.T) {
	skipWithoutShell(t)
	key := newClientKey(t, "")
	jr := newJumpRoute(t, []ssh.PublicKey{key.signer.PublicKey()})

	f := newFixture(t)
	f.trust(jr.name, 22, jr.targetKey.PublicKey())
	res := f.check(jr.req(keyAuth(key), t.TempDir()))
	if res.statuses() != "reachability=ok host_identity=needs_action:host_key_unknown ssh_auth=skipped workspace=skipped forwarding=skipped" {
		t.Fatalf("unknown jump key: %s", res.statuses())
	}
	st := res.stage(t, "host_identity")
	if st.Data.Hop != "jump" || st.Data.Fingerprint != fingerprint(jr.jumpKey) || st.Data.Hops != nil {
		t.Errorf("data %+v", st.Data)
	}
	if reach := res.stage(t, "reachability"); reach.Data.Hop != "jump" || reach.Data.Address != "127.0.0.1" {
		t.Errorf("reachability %+v: the route stopped at the jump host", reach.Data)
	}
	if jr.target.Connections() != 0 || len(jr.jump.Offered()) != 0 {
		t.Errorf("the route went on past an unknown jump key: target connections %d, keys offered %v", jr.target.Connections(), jr.jump.Offered())
	}

	g := newFixture(t)
	g.trust(jr.jump.Host, jr.jump.Port, sshtest.NewSigner(t).PublicKey())
	g.trust(jr.name, 22, jr.targetKey.PublicKey())
	st = g.check(jr.req(keyAuth(key), t.TempDir())).stage(t, "host_identity")
	if st.Code != protocol.CodeHostKeyChanged || st.Data.Hop != "jump" || st.Data.Presented != fingerprint(jr.jumpKey) {
		t.Errorf("changed jump key: %s %+v", st.Code, st.Data)
	}
	if jr.target.Connections() != 0 {
		t.Error("the target was contacted after the jump host's key changed")
	}

	// A jump host that rejects the key stops the route at ssh_auth with hop jump.
	h := newFixture(t)
	other := newClientKey(t, "")
	h.trustRoute(jr)
	res = h.check(jr.req(keyAuth(other), t.TempDir()))
	if res.statuses() != "reachability=ok host_identity=ok ssh_auth=failed:auth_rejected workspace=skipped forwarding=skipped" {
		t.Fatalf("rejected at the jump host: %s", res.statuses())
	}
	if a := res.stage(t, "ssh_auth"); a.Data.Hop != "jump" {
		t.Errorf("ssh_auth data %+v", a.Data)
	}
	if hops := res.stage(t, "host_identity").Data.Hops; len(hops) != 1 || hops[0].Hop != "jump" {
		t.Errorf("hops %+v", hops)
	}
}

// TestA28_StagesOverJump (A28): every SSH stage passes through a jump host, each hop authenticated
// with its own reference, and the workspace's canonical path is reported.
func TestA28_StagesOverJump(t *testing.T) {
	skipWithoutShell(t)
	f := newFixture(t)
	jumpKey, targetKey := newClientKey(t, ""), newClientKey(t, "")
	jr := newJumpRoute(t, nil, func(jo, to *sshtest.Options) {
		jo.AuthorizedKeys = []ssh.PublicKey{jumpKey.signer.PublicKey()}
		to.AuthorizedKeys = []ssh.PublicKey{targetKey.signer.PublicKey()}
		to.RekeyThreshold = 256
	})
	ws := t.TempDir()
	link := filepath.Join(t.TempDir(), "parallax")
	if err := os.Symlink(ws, link); err != nil {
		t.Fatal(err)
	}
	req := jr.req(keyAuth(targetKey), link)
	req.Target.Jump.Auth = keyAuth(jumpKey)
	req.Confirmations = []protocol.Confirmation{
		{Host: jr.jump.Host, Port: jr.jump.Port, SHA256: fingerprint(jr.jumpKey)},
		{Host: jr.name, Port: 22, SHA256: fingerprint(jr.targetKey)},
	}
	res := f.check(req)
	if res.statuses() != "reachability=ok host_identity=ok ssh_auth=ok workspace=ok forwarding=ok" {
		t.Fatalf("%s", res.statuses())
	}
	canonical, _ := filepath.EvalSymlinks(ws)
	if got := res.stage(t, "workspace").Data.ResolvedPath; got != canonical {
		t.Errorf("resolvedPath %q, want %q", got, canonical)
	}
	if got := res.stage(t, "host_identity").Data.Hops; len(got) != 2 || got[0].Hop != "jump" || got[1].Hop != "target" {
		t.Errorf("hops %+v", got)
	}
	if l := jr.jump.Logins(); len(l) != 1 || l[0].Fingerprint != jumpKey.fp() {
		t.Errorf("jump logins %+v", l)
	}
	if l := jr.target.Logins(); len(l) != 1 || l[0].Fingerprint != targetKey.fp() {
		t.Errorf("target logins %+v", l)
	}
	if got := jr.target.Opens(); len(got) != 1 || got[0] != forwardProbe {
		t.Errorf("forwarding probe %v", got)
	}
	// A later Check of the same route needs no confirmation: both keys were recorded.
	req.Confirmations = nil
	if again := f.check(req); again.conn == nil {
		t.Errorf("second check: %s", again.statuses())
	}
}

// TestA29_ForwardingDeniedStage (A29, forwarding stage): a host that forbids forwarding fails the forwarding stage with
// forwarding_denied, after the earlier stages passed.
func TestA29_ForwardingDeniedStage(t *testing.T) {
	skipWithoutShell(t)
	f := newFixture(t)
	key := newClientKey(t, "")
	srv := authServer(t, f, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}, DenyForwarding: true})
	res := f.check(sshReq(srv, keyAuth(key), t.TempDir()))
	if res.statuses() != "reachability=ok host_identity=ok ssh_auth=ok workspace=ok forwarding=failed:forwarding_denied" {
		t.Fatalf("%s", res.statuses())
	}
	if d := res.stage(t, "forwarding").Detail; !strings.Contains(d, "administratively prohibited") {
		t.Errorf("detail %q", d)
	}

	// Forwarding that works with nothing listening passes.
	g := newFixture(t)
	srv = authServer(t, g, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}})
	if res := g.check(sshReq(srv, keyAuth(key), t.TempDir())); res.stage(t, "forwarding").Status != "ok" {
		t.Errorf("connect failed is ok: %s", res.statuses())
	}
}

// TestStagesBlockedAfterFailure: the first stage that fails makes every later stage, including
// the runtime stages that follow Check, skipped with reason blocked.
func TestStagesBlockedAfterFailure(t *testing.T) {
	skipWithoutShell(t)
	key := newClientKey(t, "")
	f := newFixture(t)
	srv := authServer(t, f, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{newClientKey(t, "").signer.PublicKey()}})
	s := &target.Stages{}
	if conn := f.tg.Check(context.Background(), sshReq(srv, keyAuth(key), t.TempDir()), s); conn != nil {
		t.Fatal("a rejected key returned a connection")
	}
	for _, name := range []string{"runtime", "notebook_auth", "kernels"} {
		s.Run(context.Background(), name, func(context.Context) (*protocol.StageData, error) {
			t.Errorf("%s ran after a failure", name)
			return nil, nil
		})
	}
	if s.Outcome() != "failed" || len(s.List) != 8 {
		t.Fatalf("outcome %s with %d stages", s.Outcome(), len(s.List))
	}
	for _, st := range s.List[3:] {
		if st.Status != "skipped" || st.Data == nil || st.Data.Reason != "blocked" || st.Data.BlockedBy != "ssh_auth" || st.MS != nil {
			t.Errorf("%s: %+v", st.Name, st)
		}
	}
	for _, st := range s.List[:2] {
		if st.Status != "ok" {
			t.Errorf("%s: %s", st.Name, st.Status)
		}
	}

	// A refused connection blocks everything after reachability.
	g := newFixture(t)
	srv.Close()
	res := g.check(sshReq(srv, keyAuth(key), t.TempDir()))
	if res.statuses() != "reachability=failed:connection_refused host_identity=skipped ssh_auth=skipped workspace=skipped forwarding=skipped" {
		t.Errorf("%s", res.statuses())
	}
	// A managed key reference is refused by a personal connector before anything is dialled.
	req := sshReq(srv, &protocol.AuthRef{Method: protocol.AuthManagedKey, KeyID: "lab"}, t.TempDir())
	if st := g.check(req).stage(t, "reachability"); st.Code != protocol.CodeUnsupportedTarget {
		t.Errorf("managed key: %+v", st)
	}
	// A target that breaks a semantic rule is invalid_target before anything is dialled.
	req = sshReq(srv, keyAuth(key), "relative/path")
	if st := g.check(req).stage(t, "reachability"); st.Code != protocol.CodeInvalidTarget {
		t.Errorf("invalid target: %+v", st)
	}
}

// TestWorkspaceStagesCreateNothing: the workspace stage reports a missing, non-directory or
// unwritable workspace and a refused exec by code, and creates nothing on the host.
func TestWorkspaceStagesCreateNothing(t *testing.T) {
	skipWithoutShell(t)
	key := newClientKey(t, "")
	opts := sshtest.Options{AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}}
	root := t.TempDir()
	file := filepath.Join(root, "notes.txt")
	writeFile(t, file, []byte("x"))
	quoted := filepath.Join(root, "it's here")
	if err := os.Mkdir(quoted, 0o700); err != nil {
		t.Fatal(err)
	}

	snapshot := func() []string {
		var names []string
		filepath.Walk(root, func(p string, _ os.FileInfo, _ error) error {
			names = append(names, p)
			return nil
		})
		sort.Strings(names)
		return names
	}
	before := snapshot()
	for _, c := range []struct {
		name string
		ws   string
		opts func(*sshtest.Options)
		code protocol.Code
	}{
		{"missing", filepath.Join(root, "parallax", "new"), nil, protocol.CodeWorkspaceMissing},
		{"not a directory", file, nil, protocol.CodeWorkspaceNotDirectory},
		{"not writable", quoted, func(o *sshtest.Options) {
			// The account cannot write there (the test may run as root, which can write anywhere).
			o.Exec = func(cmd string, _ io.Reader, _, _ io.Writer) int {
				if strings.Contains(cmd, "test -w") {
					return exitNotWritable
				}
				return 1
			}
		}, protocol.CodeWorkspaceNotWritable},
		{"exec denied", quoted, func(o *sshtest.Options) { o.DenyExec = true }, protocol.CodeRemoteExecDenied},
		{"quote in the path", quoted, nil, ""},
	} {
		f := newFixture(t)
		o := opts
		if c.opts != nil {
			c.opts(&o)
		}
		srv := authServer(t, f, o)
		res := f.check(sshReq(srv, keyAuth(key), c.ws))
		st := res.stage(t, "workspace")
		if c.code == "" {
			if st.Status != "ok" || st.Data.ResolvedPath != quoted {
				t.Errorf("%s: %+v", c.name, st)
			}
			continue
		}
		if st.Status != "failed" || st.Code != c.code {
			t.Errorf("%s: workspace %s %s %q", c.name, st.Status, st.Code, st.Detail)
		}
		if fw := res.stage(t, "forwarding"); fw.Status != "skipped" || fw.Data.BlockedBy != "workspace" {
			t.Errorf("%s: forwarding %+v", c.name, fw)
		}
	}
	if after := snapshot(); strings.Join(after, "\n") != strings.Join(before, "\n") {
		t.Errorf("the workspace checks changed the host's files:\n%v\nwas\n%v", after, before)
	}
	if got := workspaceCommand("/home/o'neil/ws"); got != `sh -c 'test -e "$1" || exit 3; test -d "$1" || exit 4; test -w "$1" || exit 5; cd -P -- "$1" && pwd -P' sh '/home/o'\''neil/ws'` {
		t.Errorf("command %s", got)
	}
}

// TestSSHDialUsesNetScope: the first hop is dialled through the network scope, and a jump host's
// onward hop is classified when it is an address literal; nothing outside the scope is dialled.
func TestSSHDialUsesNetScope(t *testing.T) {
	skipWithoutShell(t)
	key := newClientKey(t, "")
	f := newFixture(t)
	f.tg.Dialer = &netscope.Dialer{} // the default scope: public addresses only
	srv := authServer(t, f, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}})
	res := f.check(sshReq(srv, keyAuth(key), t.TempDir()))
	if res.statuses() != "reachability=failed:network_scope_denied host_identity=skipped ssh_auth=skipped workspace=skipped forwarding=skipped" {
		t.Fatalf("%s", res.statuses())
	}
	if srv.Connections() != 0 {
		t.Error("a loopback host was dialled outside the scope")
	}

	jr := newJumpRoute(t, []ssh.PublicKey{key.signer.PublicKey()})
	for _, host := range []string{"10.20.0.5", "100.64.1.1", "fd00::5"} {
		g := newFixture(t)
		g.trust(jr.jump.Host, jr.jump.Port, jr.jumpKey.PublicKey())
		req := jr.req(keyAuth(key), t.TempDir())
		req.Target.Host = host
		res := g.check(req)
		st := res.stage(t, "reachability")
		if st.Code != protocol.CodeNetworkScopeDenied || st.Data.Hop != "target" {
			t.Errorf("%s through the jump host: %+v", host, st)
		}
	}
	if got := jr.jump.Opens(); len(got) != 0 {
		t.Errorf("the jump host was asked to reach %v", got)
	}
	// Allowed by --allow-net, the same literal is forwarded by the jump host.
	h := newFixture(t)
	scope, _ := netscope.ParseScope([]string{"127.0.0.0/8", "10.20.0.0/16"}, "")
	h.tg.Dialer.Scope = scope
	h.trust(jr.jump.Host, jr.jump.Port, jr.jumpKey.PublicKey())
	req := jr.req(keyAuth(key), t.TempDir())
	req.Target.Host = "10.20.0.5"
	h.check(req)
	if got := jr.jump.Opens(); len(got) != 1 || got[0] != "10.20.0.5:22" {
		t.Errorf("opens %v", got)
	}
}

// TestStageDeadlinesCoverEveryHop: on a jump route a stage's deadline covers both hops together,
// and a prompt left unanswered past the prompt deadline is mfa_failed.
func TestStageDeadlinesCoverEveryHop(t *testing.T) {
	skipWithoutShell(t)
	key := newClientKey(t, "")
	authorized := []ssh.PublicKey{key.signer.PublicKey()}

	t.Run("reachability", func(t *testing.T) {
		// Each banner takes 250 ms: either hop alone fits in 400 ms, both do not.
		jr := newJumpRoute(t, authorized, func(jo, to *sshtest.Options) {
			jo.BannerDelay, to.BannerDelay = 250*time.Millisecond, 250*time.Millisecond
		})
		f := newFixture(t)
		f.trustRoute(jr)
		f.tg.Deadlines = map[string]time.Duration{"reachability": 400 * time.Millisecond}
		res := f.check(jr.req(keyAuth(key), t.TempDir()))
		st := res.stage(t, "reachability")
		if st.Code != protocol.CodeConnectionTimeout || st.Data.Hop != "target" || *st.MS > 1000 {
			t.Errorf("%+v ms %d", st, *st.MS)
		}
	})
	t.Run("ssh_auth", func(t *testing.T) {
		jr := newJumpRoute(t, authorized, func(jo, to *sshtest.Options) {
			jo.AuthDelay, to.AuthDelay = 250*time.Millisecond, 250*time.Millisecond
		})
		f := newFixture(t)
		f.trustRoute(jr)
		// Each hop's publickey decision takes 250 ms: either alone fits in 400 ms, both do not.
		f.tg.Deadlines = map[string]time.Duration{"ssh_auth": 400 * time.Millisecond}
		res := f.check(jr.req(keyAuth(key), t.TempDir()))
		st := res.stage(t, "ssh_auth")
		if st.Code != protocol.CodeConnectionTimeout || st.Data.Hop != "target" {
			t.Errorf("%s: %+v", res.statuses(), st)
		}
		if reach := res.stage(t, "reachability"); reach.Status != "ok" {
			t.Errorf("reachability %+v", reach)
		}
	})
	t.Run("unanswered prompt", func(t *testing.T) {
		f := newFixture(t)
		locked := newClientKey(t, "correct horse")
		f.term.block = true
		f.tg.Deadlines = map[string]time.Duration{"ssh_auth": 100 * time.Millisecond}
		f.tg.PromptDeadline = 400 * time.Millisecond
		srv := authServer(t, f, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{locked.signer.PublicKey()}})
		start := time.Now()
		res := f.check(sshReq(srv, keyAuth(locked), t.TempDir()))
		st := res.stage(t, "ssh_auth")
		if st.Code != protocol.CodeMfaFailed {
			t.Errorf("%+v", st)
		}
		if d := time.Since(start); d < 400*time.Millisecond || d > 3*time.Second {
			t.Errorf("gave up after %s, want the prompt deadline", d)
		}
	})
	t.Run("design deadlines", func(t *testing.T) {
		want := map[string]time.Duration{"reachability": 20 * time.Second, "host_identity": 20 * time.Second,
			"ssh_auth": 60 * time.Second, "workspace": 20 * time.Second, "forwarding": 20 * time.Second}
		s := &target.Stages{}
		tg := &Target{}
		for name, d := range want {
			if got := tg.deadline(s, name); got != d {
				t.Errorf("%s: %s, want %s", name, got, d)
			}
		}
		if tg.promptDeadline() != 120*time.Second {
			t.Errorf("prompt deadline %s", tg.promptDeadline())
		}
		if f := target.DeadlineFailure("forwarding", time.Second); f.Code != protocol.CodeTunnelUnavailable {
			t.Errorf("forwarding deadline code %s", f.Code)
		}
	})
}
