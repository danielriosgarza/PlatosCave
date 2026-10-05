package sshtarget

import (
	"crypto/rand"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"parallax/connector/internal/protocol"
	"parallax/connector/internal/sshtest"
)

// authServer is a trusted in-process server for authentication tests.
func authServer(t *testing.T, f *fixture, opts sshtest.Options) *sshtest.Server {
	t.Helper()
	hk := sshtest.NewSigner(t)
	opts.HostKeys = []ssh.Signer{hk}
	srv := sshtest.New(t, opts)
	f.trust(srv.Host, srv.Port, hk.PublicKey())
	return srv
}

// TestAuthOrderAgentThenKey: with a key file, the agent signs when it holds that key, so its
// passphrase is never asked; otherwise the file is used. With the agent method only the
// identity the hint names is offered.
func TestAuthOrderAgentThenKey(t *testing.T) {
	skipWithoutShell(t)
	key := newClientKey(t, "correct horse")
	other := newClientKey(t, "")

	t.Run("agent holds the key file's key", func(t *testing.T) {
		f := newFixture(t)
		ag := newAgent(t, other, key)
		f.tg.Agent = ag.dial
		srv := authServer(t, f, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}})
		res := f.check(sshReq(srv, keyAuth(key), t.TempDir()))
		if res.conn == nil {
			t.Fatalf("%s", res.statuses())
		}
		if len(f.term.Asked()) != 0 || ag.Signs() != 1 {
			t.Errorf("asked %q, agent signatures %d", f.term.Asked(), ag.Signs())
		}
		if got := srv.Offered(); len(got) != 1 || got[0] != key.fp() {
			t.Errorf("offered %v: a key method must offer only the key file's key", got)
		}
	})
	t.Run("agent lacks it, the file is unlocked", func(t *testing.T) {
		f := newFixture(t)
		ag := newAgent(t, other)
		f.tg.Agent = ag.dial
		f.term.answers = []string{"correct horse"}
		srv := authServer(t, f, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}})
		res := f.check(sshReq(srv, keyAuth(key), t.TempDir()))
		if res.conn == nil {
			t.Fatalf("%s", res.statuses())
		}
		if len(f.term.Asked()) != 1 || ag.Signs() != 0 {
			t.Errorf("asked %q, agent signatures %d", f.term.Asked(), ag.Signs())
		}
		if got := srv.Offered(); len(got) != 1 || got[0] != key.fp() {
			t.Errorf("offered %v", got)
		}
	})
	t.Run("agent method with a hint", func(t *testing.T) {
		f := newFixture(t)
		ag := newAgent(t, other, key)
		f.tg.Agent = ag.dial
		srv := authServer(t, f, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}})
		res := f.check(sshReq(srv, &protocol.AuthRef{Method: protocol.AuthAgent, Hint: key.fp()}, t.TempDir()))
		if res.conn == nil {
			t.Fatalf("%s", res.statuses())
		}
		if got := srv.Offered(); len(got) != 1 || got[0] != key.fp() {
			t.Errorf("offered %v: only the hinted identity", got)
		}
	})
	t.Run("agent method offers identities one at a time", func(t *testing.T) {
		f := newFixture(t)
		ag := newAgent(t, other, key)
		f.tg.Agent = ag.dial
		srv := authServer(t, f, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}})
		res := f.check(sshReq(srv, &protocol.AuthRef{Method: protocol.AuthAgent}, t.TempDir()))
		if res.conn == nil {
			t.Fatalf("%s", res.statuses())
		}
		if got := srv.Offered(); len(got) != 2 || got[0] != other.fp() || got[1] != key.fp() {
			t.Errorf("offered %v", got)
		}
	})
	for _, c := range []struct {
		name  string
		agent func(t *testing.T) AgentDialer
		ref   protocol.AuthRef
		code  protocol.Code
	}{
		{"no agent", func(*testing.T) AgentDialer { return nil }, protocol.AuthRef{Method: protocol.AuthAgent}, protocol.CodeAgentUnavailable},
		{"empty agent", func(t *testing.T) AgentDialer { return newAgent(t).dial }, protocol.AuthRef{Method: protocol.AuthAgent}, protocol.CodeAgentNoIdentity},
		{"hint matches nothing", func(t *testing.T) AgentDialer { return newAgent(t, other).dial }, protocol.AuthRef{Method: protocol.AuthAgent, Hint: "lab key"}, protocol.CodeAgentNoIdentity},
		{"key file missing", func(*testing.T) AgentDialer { return nil }, protocol.AuthRef{Method: protocol.AuthKey, KeyPath: "/nonexistent/id_ed25519"}, protocol.CodeKeyFileUnreadable},
		{"rejected", func(t *testing.T) AgentDialer { return newAgent(t, other).dial }, protocol.AuthRef{Method: protocol.AuthAgent}, protocol.CodeAuthRejected},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			f.tg.Agent = c.agent(t)
			srv := authServer(t, f, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}})
			ref := c.ref
			res := f.check(sshReq(srv, &ref, t.TempDir()))
			st := res.stage(t, "ssh_auth")
			if st.Status != "failed" || st.Code != c.code || st.Data == nil || st.Data.Hop != "target" {
				t.Errorf("ssh_auth %s %s %+v (%s), want %s", st.Status, st.Code, st.Data, st.Detail, c.code)
			}
		})
	}
}

// TestCertificateUsed: <keyPath>-cert.pub is offered with the key.
func TestCertificateUsed(t *testing.T) {
	skipWithoutShell(t)
	f := newFixture(t)
	key := newClientKey(t, "")
	ca := sshtest.NewSigner(t)
	cert := &ssh.Certificate{Key: key.signer.PublicKey(), CertType: ssh.UserCert, KeyId: "student",
		ValidPrincipals: []string{"student"}, ValidBefore: ssh.CertTimeInfinity}
	if err := cert.SignCert(rand.Reader, ca); err != nil {
		t.Fatal(err)
	}
	writeFile(t, key.path+"-cert.pub", ssh.MarshalAuthorizedKey(cert))
	srv := authServer(t, f, sshtest.Options{CertAuthority: ca.PublicKey()})
	res := f.check(sshReq(srv, keyAuth(key), t.TempDir()))
	if res.conn == nil {
		t.Fatalf("%s", res.statuses())
	}
	if l := srv.Logins(); len(l) != 1 || !l[0].Cert || l[0].Fingerprint != key.fp() {
		t.Errorf("logins %+v", l)
	}
}

// TestPassphraseFromTerminalOnly: a passphrase is asked only in the connector's terminal, never
// without one, and three wrong ones end the attempt.
func TestPassphraseFromTerminalOnly(t *testing.T) {
	skipWithoutShell(t)
	key := newClientKey(t, "correct horse")
	opts := sshtest.Options{AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}}

	t.Run("no terminal", func(t *testing.T) {
		f := newFixture(t)
		f.tg.TTY = false
		f.term.answers = []string{"correct horse"}
		srv := authServer(t, f, opts)
		st := f.check(sshReq(srv, keyAuth(key), t.TempDir())).stage(t, "ssh_auth")
		if st.Code != protocol.CodeKeyPassphraseRequired {
			t.Errorf("ssh_auth %s %s", st.Status, st.Code)
		}
		if len(f.term.Asked()) != 0 {
			t.Errorf("asked %q without a terminal", f.term.Asked())
		}
	})
	t.Run("terminal", func(t *testing.T) {
		f := newFixture(t)
		f.term.answers = []string{"correct horse"}
		srv := authServer(t, f, opts)
		res := f.check(sshReq(srv, keyAuth(key), t.TempDir()))
		if res.conn == nil {
			t.Fatalf("%s", res.statuses())
		}
		asked := f.term.Asked()
		if len(asked) != 1 || !strings.Contains(asked[0], key.path) || !strings.Contains(asked[0], "student@127.0.0.1:") {
			t.Errorf("asked %q", asked)
		}
	})
	t.Run("three wrong", func(t *testing.T) {
		f := newFixture(t)
		f.term.answers = []string{"a", "b", "c", "correct horse"}
		srv := authServer(t, f, opts)
		st := f.check(sshReq(srv, keyAuth(key), t.TempDir())).stage(t, "ssh_auth")
		if st.Code != protocol.CodeKeyPassphraseWrong || len(f.term.Asked()) != 3 {
			t.Errorf("ssh_auth %s %s after %d prompts", st.Status, st.Code, len(f.term.Asked()))
		}
		if strings.Contains(st.Detail, "correct horse") || strings.Contains(st.Detail, "\"a\"") {
			t.Errorf("detail %q", st.Detail)
		}
	})
	t.Run("not accepted, not asked", func(t *testing.T) {
		// A host that does not accept the key never causes a prompt.
		f := newFixture(t)
		f.term.answers = []string{"correct horse"}
		srv := authServer(t, f, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{newClientKey(t, "").signer.PublicKey()}})
		st := f.check(sshReq(srv, keyAuth(key), t.TempDir())).stage(t, "ssh_auth")
		if st.Code != protocol.CodeAuthRejected || len(f.term.Asked()) != 0 {
			t.Errorf("ssh_auth %s, asked %q", st.Code, f.term.Asked())
		}
	})
}

// TestMFAKeyboardInteractive: after a publickey partial success the host's question is shown in
// the connector's terminal, stripped of control sequences and labelled with the host, and the
// answer goes only to the host.
func TestMFAKeyboardInteractive(t *testing.T) {
	skipWithoutShell(t)
	f := newFixture(t)
	key := newClientKey(t, "")
	f.term.answers = []string{"424242"}
	srv := authServer(t, f, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()},
		MFA: &sshtest.MFA{Question: "\x1b[2J\x1b]0;pwned\x07Verification \x1b[31mcode\x1b[0m:\u202e ", Answer: "424242"}})
	res := f.check(sshReq(srv, keyAuth(key), t.TempDir()))
	if res.conn == nil {
		t.Fatalf("%s", res.statuses())
	}
	asked := f.term.Asked()
	if len(asked) != 1 || !strings.HasSuffix(asked[0], "] Verification code:") || !strings.HasPrefix(asked[0], "[student@127.0.0.1:") {
		t.Errorf("asked %q", asked)
	}
	for _, a := range asked {
		if strings.ContainsAny(a, "\x1b\x07\u202e") {
			t.Errorf("control characters reached the terminal: %q", a)
		}
	}
	if l := srv.Logins(); len(l) != 1 || !l[0].MFA {
		t.Errorf("logins %+v", l)
	}
	for _, st := range res.progress {
		if strings.Contains(mustJSON(t, st), "424242") {
			t.Errorf("the answer appeared in a stage report: %+v", st)
		}
	}
	if sanitize("a\x1b[1;31mb\u009b2Jc\x1bPq#0\x1b\\d\te\u200bf\r\ng") != "abcd ef\ng" {
		t.Errorf("sanitize %q", sanitize("a\x1b[1;31mb\u009b2Jc\x1bPq#0\x1b\\d\te\u200bf\r\ng"))
	}
}

// TestMFANoTerminal: without a terminal a second factor is mfa_requires_terminal.
func TestMFANoTerminal(t *testing.T) {
	skipWithoutShell(t)
	f := newFixture(t)
	f.tg.TTY = false
	key := newClientKey(t, "")
	srv := authServer(t, f, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}, MFA: &sshtest.MFA{Question: "Code: ", Answer: "1"}})
	res := f.check(sshReq(srv, keyAuth(key), t.TempDir()))
	if st := res.stage(t, "ssh_auth"); st.Code != protocol.CodeMfaRequiresTerminal {
		t.Errorf("ssh_auth %s %s", st.Status, st.Code)
	}
	if len(f.term.Asked()) != 0 || len(srv.Logins()) != 0 {
		t.Errorf("asked %q, logins %v", f.term.Asked(), srv.Logins())
	}
}

// TestMFAWrongThreeTimes (A29, authentication stage): three wrong answers are mfa_failed, whether the host or the connector
// stops first.
func TestMFAWrongThreeTimes(t *testing.T) {
	skipWithoutShell(t)
	key := newClientKey(t, "")
	for _, tries := range []int{3, 6} {
		f := newFixture(t)
		f.term.answers = []string{"1", "2", "3", "4", "5", "6"}
		srv := authServer(t, f, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}, MFA: &sshtest.MFA{Question: "Code: ", Answer: "424242", Tries: tries}})
		res := f.check(sshReq(srv, keyAuth(key), t.TempDir()))
		st := res.stage(t, "ssh_auth")
		if st.Code != protocol.CodeMfaFailed || len(f.term.Asked()) != 3 {
			t.Errorf("host tries %d: ssh_auth %s %s after %d answers", tries, st.Status, st.Code, len(f.term.Asked()))
		}
	}
}

// TestUnsupportedMethodsReported (A29, authentication stage): a host that takes only methods the connector does not use is
// auth_method_unsupported, with the methods it offered; nothing is asked.
func TestUnsupportedMethodsReported(t *testing.T) {
	skipWithoutShell(t)
	key := newClientKey(t, "")
	for _, c := range []struct {
		opts sshtest.Options
		want string
	}{
		{sshtest.Options{Password: "hunter2"}, "password"},
		{sshtest.Options{KeyboardOnly: true}, "keyboard-interactive"},
	} {
		f := newFixture(t)
		f.term.answers = []string{"hunter2"}
		srv := authServer(t, f, c.opts)
		st := f.check(sshReq(srv, keyAuth(key), t.TempDir())).stage(t, "ssh_auth")
		if st.Code != protocol.CodeAuthMethodUnsupported || !strings.Contains(st.Detail, c.want) {
			t.Errorf("%s: ssh_auth %s %s %q", c.want, st.Status, st.Code, st.Detail)
		}
		if len(f.term.Asked()) != 0 || srv.KeyboardRounds() > 1 || len(srv.Logins()) != 0 {
			t.Errorf("%s: asked %q, rounds %d", c.want, f.term.Asked(), srv.KeyboardRounds())
		}
	}
}

// TestTerminalPromptSendsRunningProgress: when ssh_auth starts waiting on the terminal, a running
// report with terminalPrompt is sent, the stage's deadline rises to the prompt deadline, and the
// result itself never carries running.
func TestTerminalPromptSendsRunningProgress(t *testing.T) {
	skipWithoutShell(t)
	f := newFixture(t)
	key := newClientKey(t, "correct horse")
	f.term.answers = []string{"correct horse"}
	f.term.delay = 600 * time.Millisecond
	f.tg.Deadlines = map[string]time.Duration{"ssh_auth": 300 * time.Millisecond}
	f.tg.PromptDeadline = 5 * time.Second
	srv := authServer(t, f, sshtest.Options{AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}})
	res := f.check(sshReq(srv, keyAuth(key), t.TempDir()))
	if res.conn == nil {
		t.Fatalf("a prompt answered after the plain deadline but within the prompt deadline: %s", res.statuses())
	}
	var running []string
	for _, st := range res.progress {
		if st.Status == "running" {
			running = append(running, mustJSON(t, st))
		}
	}
	if len(running) != 1 || running[0] != `{"name":"ssh_auth","status":"running","data":{"hop":"target","terminalPrompt":true}}` {
		t.Errorf("running reports %v", running)
	}
	for _, st := range res.stages {
		if st.Status == "running" {
			t.Errorf("running in the result: %+v", st)
		}
	}
}
