package sshtarget

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"parallax/connector/internal/protocol"
	"parallax/connector/internal/sshtest"
)

// TestA30_HostKeyDecisionTable (A30) checks the eight rows of design §5.2, first as the pure function
// and then end to end against an in-process server, including what each row does to the
// connector's known_hosts.
func TestA30_HostKeyDecisionTable(t *testing.T) {
	const L, P, S, X = "SHA256:local", "SHA256:presented", "SHA256:server", "SHA256:other"
	conf := func(sha, replacing string) []protocol.Confirmation {
		return []protocol.Confirmation{{Host: "h", Port: 22, SHA256: sha, Replacing: replacing}}
	}
	pure := []struct {
		name  string
		local []string
		srv   string
		c     []protocol.Confirmation
		want  Decision
	}{
		{"1 L=P", []string{P}, "", nil, Decision{Row: 1, Status: "ok"}},
		{"1 L=P whatever S", []string{P}, X, nil, Decision{Row: 1, Status: "ok"}},
		{"2 L≠P replaced", []string{L}, "", conf(P, L), Decision{Row: 2, Status: "ok", Write: "replace", Replacing: L}},
		{"3 L≠P", []string{L}, "", nil, Decision{Row: 3, Status: "failed", Expected: L}},
		{"3 L≠P confirmed without replacing", []string{L}, "", conf(P, ""), Decision{Row: 3, Status: "failed", Expected: L}},
		{"3 L≠P replacing another key", []string{L}, "", conf(P, X), Decision{Row: 3, Status: "failed", Expected: L}},
		{"3 L≠P S=P does not count", []string{L}, P, nil, Decision{Row: 3, Status: "failed", Expected: L}},
		{"4 no L, S=P", nil, P, nil, Decision{Row: 4, Status: "ok", Write: "add"}},
		{"5 no L, S≠P", nil, S, nil, Decision{Row: 5, Status: "failed", Expected: S}},
		{"5 no L, S≠P, confirmed without replacing", nil, S, conf(P, ""), Decision{Row: 5, Status: "failed", Expected: S}},
		{"6 no records, confirmed", nil, "", conf(P, ""), Decision{Row: 6, Status: "ok", Write: "add"}},
		{"7 no records", nil, "", nil, Decision{Row: 7, Status: "needs_action"}},
		{"7 no records, another key confirmed", nil, "", conf(X, ""), Decision{Row: 7, Status: "needs_action"}},
		{"8 no L, S≠P replaced", nil, S, conf(P, S), Decision{Row: 8, Status: "ok", Write: "add"}},
	}
	for _, c := range pure {
		if got := Decide(c.local, c.srv, c.c, P); got != c.want {
			t.Errorf("Decide %s = %+v, want %+v", c.name, got, c.want)
		}
	}

	// End to end: a server presenting P, with L, S and C arranged per row.
	type setup struct {
		row     int
		local   bool // L holds the old key
		server  string
		confirm func(old, p string) []protocol.Confirmation
		status  string
		code    protocol.Code
		// written is whether L afterwards trusts P.
		written bool
	}
	rows := []setup{
		{row: 1, local: true, status: "ok", written: true},
		{row: 2, local: true, confirm: func(old, p string) []protocol.Confirmation {
			return []protocol.Confirmation{{SHA256: p, Replacing: old}}
		}, status: "ok", written: true},
		{row: 3, local: true, status: "failed", code: protocol.CodeHostKeyChanged},
		{row: 4, server: "P", status: "ok", written: true},
		{row: 5, server: "old", status: "failed", code: protocol.CodeHostKeyChanged},
		{row: 6, confirm: func(old, p string) []protocol.Confirmation { return []protocol.Confirmation{{SHA256: p}} }, status: "ok", written: true},
		{row: 7, status: "needs_action", code: protocol.CodeHostKeyUnknown},
		{row: 8, server: "old", confirm: func(old, p string) []protocol.Confirmation {
			return []protocol.Confirmation{{SHA256: p, Replacing: old}}
		}, status: "ok", written: true},
	}
	for _, r := range rows {
		t.Run("row"+string(rune('0'+r.row)), func(t *testing.T) {
			skipWithoutShell(t)
			f := newFixture(t)
			key := newClientKey(t, "")
			hostKey := sshtest.NewSigner(t)
			oldKey := sshtest.NewSigner(t)
			srv := sshtest.New(t, sshtest.Options{HostKeys: []ssh.Signer{hostKey}, AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}})
			p, old := fingerprint(hostKey), fingerprint(oldKey)
			if r.local {
				if r.row == 1 {
					f.trust(srv.Host, srv.Port, hostKey.PublicKey())
				} else {
					f.trust(srv.Host, srv.Port, oldKey.PublicKey())
				}
			}
			req := sshReq(srv, keyAuth(key), t.TempDir())
			switch r.server {
			case "P":
				req.Target.HostKeys = []protocol.HostKey{{Host: srv.Host, Port: srv.Port, SHA256: p}}
			case "old":
				req.Target.HostKeys = []protocol.HostKey{{Host: srv.Host, Port: srv.Port, SHA256: old}}
			}
			if r.confirm != nil {
				for _, c := range r.confirm(old, p) {
					c.Host, c.Port = srv.Host, srv.Port
					req.Confirmations = append(req.Confirmations, c)
				}
			}
			before := f.knownHosts()
			res := f.check(req)
			st := res.stage(t, "host_identity")
			if st.Status != r.status || st.Code != r.code {
				t.Fatalf("row %d: host_identity %s %s, want %s %s (%s)", r.row, st.Status, st.Code, r.status, r.code, st.Detail)
			}
			keys, err := f.tg.KnownHosts.Lookup(srv.Host, srv.Port)
			if err != nil {
				t.Fatal(err)
			}
			trusted := len(keys) == 1 && fingerprint(hostKey) == ssh.FingerprintSHA256(keys[0])
			if trusted != r.written {
				t.Errorf("row %d: known_hosts trusts P = %v, want %v:\n%s", r.row, trusted, r.written, f.knownHosts())
			}
			switch r.status {
			case "ok":
				if len(st.Data.Hops) != 1 || st.Data.Hops[0].Fingerprint != p || st.Data.Hops[0].Hop != "target" {
					t.Errorf("row %d: hops %+v", r.row, st.Data.Hops)
				}
				if res.statuses() != "reachability=ok host_identity=ok ssh_auth=ok workspace=ok forwarding=ok" {
					t.Errorf("row %d: %s", r.row, res.statuses())
				}
			case "failed":
				want := old
				if st.Data.Expected != want || st.Data.Presented != p || st.Data.Hop != "target" {
					t.Errorf("row %d: data %+v, want expected %s presented %s", r.row, st.Data, want, p)
				}
				if f.knownHosts() != before {
					t.Errorf("row %d: a changed key altered known_hosts", r.row)
				}
			case "needs_action":
				if st.Data.Fingerprint != p || st.Data.Hop != "target" || st.Data.Algorithm != ssh.KeyAlgoED25519 {
					t.Errorf("row %d: data %+v", r.row, st.Data)
				}
				if f.knownHosts() != "" {
					t.Errorf("row %d: an unknown key was written", r.row)
				}
			}
		})
	}
}

// TestA30_ChangedKeyIsAHardStop (A30): a host whose key changed is stopped at host_identity; nothing
// is retried, no credential is offered, later stages are blocked and the record is untouched.
func TestA30_ChangedKeyIsAHardStop(t *testing.T) {
	skipWithoutShell(t)
	f := newFixture(t)
	key := newClientKey(t, "")
	oldKey, newKey := sshtest.NewSigner(t), sshtest.NewSigner(t)
	srv := sshtest.New(t, sshtest.Options{HostKeys: []ssh.Signer{oldKey}, AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}})
	req := sshReq(srv, keyAuth(key), t.TempDir())
	req.Confirmations = []protocol.Confirmation{{Host: srv.Host, Port: srv.Port, SHA256: fingerprint(oldKey)}}
	if res := f.check(req); res.conn == nil {
		t.Fatalf("first use: %s", res.statuses())
	}
	before := f.knownHosts()
	logins := len(srv.Logins())

	srv.SetHostKeys(newKey) // the host's key is rotated, or another computer answers
	conns := srv.Connections()
	req.Confirmations = nil
	res := f.check(req)
	if res.statuses() != "reachability=ok host_identity=failed:host_key_changed ssh_auth=skipped workspace=skipped forwarding=skipped" {
		t.Fatalf("stages: %s", res.statuses())
	}
	st := res.stage(t, "host_identity")
	if st.Data.Expected != fingerprint(oldKey) || st.Data.Presented != fingerprint(newKey) || st.Data.Hops != nil {
		t.Errorf("data %+v", st.Data)
	}
	for _, name := range []string{"ssh_auth", "workspace", "forwarding"} {
		if d := res.stage(t, name).Data; d == nil || d.Reason != "blocked" || d.BlockedBy != "host_identity" {
			t.Errorf("%s not blocked by host_identity: %+v", name, d)
		}
	}
	if got := srv.Connections() - conns; got != 1 {
		t.Errorf("%d connections after the change; a changed key must not be retried", got)
	}
	if len(srv.Logins()) != logins || len(srv.Offered()) != 1 {
		t.Errorf("credentials were offered to a host whose key changed: logins %d, offered %v", len(srv.Logins()), srv.Offered())
	}
	if f.knownHosts() != before {
		t.Errorf("known_hosts changed:\n%s\nwas\n%s", f.knownHosts(), before)
	}
	// A server record for the new key does not override the connector's (row 3, not row 1).
	req.Target.HostKeys = []protocol.HostKey{{Host: srv.Host, Port: srv.Port, SHA256: fingerprint(newKey)}}
	if st := f.check(req).stage(t, "host_identity"); st.Code != protocol.CodeHostKeyChanged {
		t.Errorf("server record overrode a changed key: %+v", st)
	}
	if f.knownHosts() != before {
		t.Error("known_hosts changed")
	}
}

// TestA30_ReplaceNeedsConfirmationAndKeepsHistory (A30): only a confirmation naming the presented key
// and replacing the recorded one replaces it; the old line stays as a comment.
func TestA30_ReplaceNeedsConfirmationAndKeepsHistory(t *testing.T) {
	skipWithoutShell(t)
	f := newFixture(t)
	f.tg.KnownHosts.Now = func() time.Time { return time.Date(2026, 10, 5, 9, 30, 0, 0, time.UTC) }
	key := newClientKey(t, "")
	oldKey, newKey := sshtest.NewSigner(t), sshtest.NewSigner(t)
	srv := sshtest.New(t, sshtest.Options{HostKeys: []ssh.Signer{newKey}, AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}})
	// A comment the person wrote, and an entry for another host, must survive.
	if err := f.tg.KnownHosts.write([]byte("# lab machines\n")); err != nil {
		t.Fatal(err)
	}
	f.trust("other.example.org", 22, oldKey.PublicKey())
	f.trust(srv.Host, srv.Port, oldKey.PublicKey())
	req := sshReq(srv, keyAuth(key), t.TempDir())

	for _, c := range []struct {
		name string
		c    protocol.Confirmation
	}{
		{"no replacing", protocol.Confirmation{SHA256: fingerprint(newKey)}},
		{"replacing another key", protocol.Confirmation{SHA256: fingerprint(newKey), Replacing: fingerprint(sshtest.NewSigner(t))}},
		{"confirming another key", protocol.Confirmation{SHA256: fingerprint(sshtest.NewSigner(t)), Replacing: fingerprint(oldKey)}},
	} {
		c.c.Host, c.c.Port = srv.Host, srv.Port
		req.Confirmations = []protocol.Confirmation{c.c}
		before := f.knownHosts()
		if st := f.check(req).stage(t, "host_identity"); st.Code != protocol.CodeHostKeyChanged {
			t.Errorf("%s: %s %s", c.name, st.Status, st.Code)
		}
		if f.knownHosts() != before {
			t.Errorf("%s: known_hosts changed", c.name)
		}
	}

	req.Confirmations = []protocol.Confirmation{{Host: srv.Host, Port: srv.Port, SHA256: fingerprint(newKey), Replacing: fingerprint(oldKey)}}
	res := f.check(req)
	if res.conn == nil {
		t.Fatalf("confirmed replacement: %s", res.statuses())
	}
	kh := f.knownHosts()
	lines := strings.Split(strings.TrimSpace(kh), "\n")
	if len(lines) != 4 || lines[0] != "# lab machines" || !strings.HasPrefix(lines[1], "other.example.org ") {
		t.Fatalf("known_hosts:\n%s", kh)
	}
	history := regexp.MustCompile(`^# replaced 2026-10-05T09:30:00Z ` + regexp.QuoteMeta(fingerprint(oldKey)) + ` \[127\.0\.0\.1\]:\d+ ssh-ed25519 `)
	if !history.MatchString(lines[2]) {
		t.Errorf("history line %q", lines[2])
	}
	if !strings.HasPrefix(lines[3], "[127.0.0.1]:") {
		t.Errorf("new line %q", lines[3])
	}
	keys, _ := f.tg.KnownHosts.Lookup(srv.Host, srv.Port)
	if len(keys) != 1 || ssh.FingerprintSHA256(keys[0]) != fingerprint(newKey) {
		t.Errorf("trusted keys %v", fingerprints(keys))
	}
	if !containsLine(*f.logs, "Replaced the host key of 127.0.0.1:") {
		t.Errorf("the replacement was not logged: %q", *f.logs)
	}
	// The next test is row 1 without any confirmation.
	req.Confirmations = nil
	if res := f.check(req); res.conn == nil {
		t.Errorf("after replacement: %s", res.statuses())
	}
}

func containsLine(lines []string, prefix string) bool {
	for _, l := range lines {
		if strings.HasPrefix(l, prefix) {
			return true
		}
	}
	return false
}

// TestHostKeyAlgorithmRestriction: the negotiation is restricted to the key types recorded for
// the host, so a host that also offers another type is not reported as changed; a host that no
// longer offers any recorded type is compared by the key it does present.
func TestHostKeyAlgorithmRestriction(t *testing.T) {
	skipWithoutShell(t)
	f := newFixture(t)
	key := newClientKey(t, "")
	ed, ec := sshtest.NewSigner(t), ecdsaSigner(t)
	srv := sshtest.New(t, sshtest.Options{HostKeys: []ssh.Signer{ed, ec}, AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}})
	f.trust(srv.Host, srv.Port, ec.PublicKey())
	req := sshReq(srv, keyAuth(key), t.TempDir())
	res := f.check(req)
	if res.conn == nil {
		t.Fatalf("a recorded ECDSA key with an extra Ed25519 key offered: %s", res.statuses())
	}
	if hops := res.stage(t, "host_identity").Data.Hops; hops[0].Fingerprint != fingerprint(ec) {
		t.Errorf("negotiated %s, want the recorded %s", hops[0].Fingerprint, fingerprint(ec))
	}
	if !equalStrings(hostKeyAlgorithms([]ssh.PublicKey{ec.PublicKey()}), []string{ssh.KeyAlgoECDSA256}) {
		t.Errorf("algorithms %v", hostKeyAlgorithms([]ssh.PublicKey{ec.PublicKey()}))
	}
	rsaAlgos := hostKeyAlgorithms([]ssh.PublicKey{rsaPublic(t)})
	if !equalStrings(rsaAlgos, []string{ssh.KeyAlgoRSASHA512, ssh.KeyAlgoRSASHA256, ssh.KeyAlgoRSA}) {
		t.Errorf("RSA algorithms %v", rsaAlgos)
	}

	// The host drops its ECDSA key: the Ed25519 key it presents is a changed key.
	srv.SetHostKeys(ed)
	before := f.knownHosts()
	st := f.check(req).stage(t, "host_identity")
	if st.Code != protocol.CodeHostKeyChanged || st.Data.Expected != fingerprint(ec) || st.Data.Presented != fingerprint(ed) {
		t.Errorf("after the recorded type went away: %s %s %+v", st.Status, st.Code, st.Data)
	}
	if f.knownHosts() != before {
		t.Error("known_hosts changed")
	}
	// Confirming the replacement of the recorded key works the same way.
	req.Confirmations = []protocol.Confirmation{{Host: srv.Host, Port: srv.Port, SHA256: fingerprint(ed), Replacing: fingerprint(ec)}}
	if res := f.check(req); res.conn == nil {
		t.Errorf("replacement across key types: %s", res.statuses())
	}
}

func equalStrings(a, b []string) bool {
	return strings.Join(a, ",") == strings.Join(b, ",")
}

// TestServerRecordWithoutLocalEntryTrusts is row 4: a key the server already trusts (perhaps from
// another device) is accepted without a prompt and recorded by this connector.
func TestServerRecordWithoutLocalEntryTrusts(t *testing.T) {
	skipWithoutShell(t)
	f := newFixture(t)
	key := newClientKey(t, "")
	hostKey := sshtest.NewSigner(t)
	srv := sshtest.New(t, sshtest.Options{HostKeys: []ssh.Signer{hostKey}, AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}})
	req := sshReq(srv, keyAuth(key), t.TempDir())
	req.Target.HostKeys = []protocol.HostKey{{Host: srv.Host, Port: srv.Port, SHA256: fingerprint(hostKey)}}
	res := f.check(req)
	if res.conn == nil {
		t.Fatalf("%s", res.statuses())
	}
	keys, _ := f.tg.KnownHosts.Lookup(srv.Host, srv.Port)
	if len(keys) != 1 || ssh.FingerprintSHA256(keys[0]) != fingerprint(hostKey) {
		t.Errorf("not recorded: %s", f.knownHosts())
	}
	if !containsLine(*f.logs, "Trusted the host key of 127.0.0.1:") {
		t.Errorf("the trust write was not logged: %q", *f.logs)
	}
	if len(f.term.Asked()) != 0 {
		t.Errorf("asked %q", f.term.Asked())
	}
}

// TestHostIdentityReportsPassedHops: every hop that passed is in data.hops, jump host first, on
// an ok stage and on one the target stopped; the singular fields describe only that stop.
func TestHostIdentityReportsPassedHops(t *testing.T) {
	skipWithoutShell(t)
	key := newClientKey(t, "")
	authorized := []ssh.PublicKey{key.signer.PublicKey()}

	t.Run("single hop", func(t *testing.T) {
		f := newFixture(t)
		hk := sshtest.NewSigner(t)
		srv := sshtest.New(t, sshtest.Options{HostKeys: []ssh.Signer{hk}, AuthorizedKeys: authorized})
		f.trust(srv.Host, srv.Port, hk.PublicKey())
		st := f.check(sshReq(srv, keyAuth(key), t.TempDir())).stage(t, "host_identity")
		want := `{"hops":[{"hop":"target","fingerprint":"` + fingerprint(hk) + `","address":"127.0.0.1"}]}`
		if got := mustJSON(t, st.Data); got != want {
			t.Errorf("data %s, want %s", got, want)
		}
	})

	jr := newJumpRoute(t, authorized)
	t.Run("jump route", func(t *testing.T) {
		f := newFixture(t)
		f.trust(jr.jump.Host, jr.jump.Port, jr.jumpKey.PublicKey())
		f.trust(jr.name, 22, jr.targetKey.PublicKey())
		st := f.check(jr.req(keyAuth(key), t.TempDir())).stage(t, "host_identity")
		want := `{"hops":[{"hop":"jump","fingerprint":"` + fingerprint(jr.jumpKey) + `","address":"127.0.0.1"},{"hop":"target","fingerprint":"` + fingerprint(jr.targetKey) + `"}]}`
		if got := mustJSON(t, st.Data); got != want {
			t.Errorf("data %s, want %s", got, want)
		}
	})
	t.Run("jump passed, target unknown", func(t *testing.T) {
		f := newFixture(t)
		req := jr.req(keyAuth(key), t.TempDir())
		req.Confirmations = []protocol.Confirmation{{Host: jr.jump.Host, Port: jr.jump.Port, SHA256: fingerprint(jr.jumpKey)}}
		res := f.check(req)
		if res.statuses() != "reachability=ok host_identity=needs_action:host_key_unknown ssh_auth=skipped workspace=skipped forwarding=skipped" {
			t.Fatalf("%s", res.statuses())
		}
		st := res.stage(t, "host_identity")
		want := `{"hop":"target","fingerprint":"` + fingerprint(jr.targetKey) + `","algorithm":"ssh-ed25519","hops":[{"hop":"jump","fingerprint":"` + fingerprint(jr.jumpKey) + `","address":"127.0.0.1"}]}`
		if got := mustJSON(t, st.Data); got != want {
			t.Errorf("data %s, want %s", got, want)
		}
		if reach := res.stage(t, "reachability"); reach.Data.Hop != "target" {
			t.Errorf("reachability %+v", reach.Data)
		}
	})
	t.Run("jump passed, target changed", func(t *testing.T) {
		f := newFixture(t)
		f.trust(jr.jump.Host, jr.jump.Port, jr.jumpKey.PublicKey())
		old := sshtest.NewSigner(t)
		f.trust(jr.name, 22, old.PublicKey())
		st := f.check(jr.req(keyAuth(key), t.TempDir())).stage(t, "host_identity")
		want := `{"hop":"target","expected":"` + fingerprint(old) + `","presented":"` + fingerprint(jr.targetKey) + `","hops":[{"hop":"jump","fingerprint":"` + fingerprint(jr.jumpKey) + `","address":"127.0.0.1"}]}`
		if got := mustJSON(t, st.Data); got != want {
			t.Errorf("data %s, want %s", got, want)
		}
	})
}

// TestRekeyKeepsAcceptedKey: a connection that rekeys keeps working when the host presents the
// key that was accepted.
func TestRekeyKeepsAcceptedKey(t *testing.T) {
	skipWithoutShell(t)
	f := newFixture(t)
	key := newClientKey(t, "")
	hk := sshtest.NewSigner(t)
	srv := sshtest.New(t, sshtest.Options{HostKeys: []ssh.Signer{hk}, AuthorizedKeys: []ssh.PublicKey{key.signer.PublicKey()}, RekeyThreshold: 256})
	f.trust(srv.Host, srv.Port, hk.PublicKey())
	res := f.check(sshReq(srv, keyAuth(key), t.TempDir()))
	if res.conn == nil {
		t.Fatalf("%s", res.statuses())
	}
	// More traffic after the stages, across further rekeys.
	for i := 0; i < 3; i++ {
		sess, err := res.conn.Client.NewSession()
		if err != nil {
			t.Fatal(err)
		}
		out, err := sess.Output("printf '%0512d' 0")
		sess.Close()
		if err != nil || len(out) != 512 {
			t.Fatalf("exec after rekey: %v (%d bytes)", err, len(out))
		}
	}
}
