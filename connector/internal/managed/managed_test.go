package managed

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"encoding/pem"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"

	"parallax/connector/internal/cause"
	"parallax/connector/internal/identity"
	"parallax/connector/internal/jupyter/jupytertest"
	"parallax/connector/internal/netscope"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/sshtarget"
	"parallax/connector/internal/sshtest"
	"parallax/connector/internal/target"
)

func TestMain(m *testing.M) {
	jupytertest.RunIfStub()
	os.Exit(m.Run())
}

const (
	requestID = "c0ffee00-1111-4222-8333-444455556666"
	subject   = "5a1e7c2d-3b4f-4a6e-9d8c-7b6a5f4e3d2c"
	// hostName is the target's name in the targets file; the tests' resolver answers it with
	// the in-process server's loopback address.
	hostName = "login.hpc.test"
)

func skipOnWindows(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("managed mode judges secret files by their POSIX permissions")
	}
}

// writeFile writes data with mode perm, whatever the umask.
func writeFile(t *testing.T, path string, data []byte, perm os.FileMode) {
	t.Helper()
	if err := os.WriteFile(path, data, perm); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(path, perm); err != nil {
		t.Fatal(err)
	}
}

// clientKey is an SSH key in OpenSSH format, encrypted when passphrase is set.
func clientKey(t *testing.T, passphrase string) (ssh.Signer, []byte) {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var block *pem.Block
	if passphrase == "" {
		block, err = ssh.MarshalPrivateKey(priv, "")
	} else {
		block, err = ssh.MarshalPrivateKeyWithPassphrase(priv, "", []byte(passphrase))
	}
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return signer, pem.EncodeToMemory(block)
}

// operator is the files an operator provides and the environment that names them.
type operator struct {
	t   *testing.T
	dir string
	env map[string]string
}

func newOperator(t *testing.T) *operator {
	t.Helper()
	skipOnWindows(t)
	dir := t.TempDir()
	id, err := identity.Generate()
	if err != nil {
		t.Fatal(err)
	}
	pemData, err := id.MarshalPEM()
	if err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "identity.key"), pemData, 0o600)
	keys := filepath.Join(dir, "keys")
	if err := os.Mkdir(keys, 0o700); err != nil {
		t.Fatal(err)
	}
	_, key := clientKey(t, "")
	writeFile(t, filepath.Join(keys, "hpc"), key, 0o600)
	writeFile(t, filepath.Join(dir, "known_hosts"), nil, 0o644)
	o := &operator{t: t, dir: dir, env: map[string]string{
		EnvServer:              "https://parallax.example.org",
		EnvConnectorID:         "7b1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
		EnvIdentityKey:         filepath.Join(dir, "identity.key"),
		EnvKnownHostsFile:      filepath.Join(dir, "known_hosts"),
		EnvKeysDir:             keys,
		EnvTargetsFile:         filepath.Join(dir, "targets.json"),
		netscope.EnvAllowHosts: hostName,
		netscope.EnvAllowNet:   "10.20.0.0/16",
		netscope.EnvAllowPorts: "22",
	}}
	o.targets(map[string]Entry{"hpc": {Host: hostName, Port: 22, User: "p-{subject}", KeyID: "hpc",
		Workspace: "/scratch/{subject}", Runtime: Runtime{Python: "/opt/conda/bin/python"}}})
	return o
}

func (o *operator) targets(entries map[string]Entry) {
	o.t.Helper()
	data, err := json.Marshal(File{V: 1, Targets: entries})
	if err != nil {
		o.t.Fatal(err)
	}
	writeFile(o.t, filepath.Join(o.dir, "targets.json"), data, 0o644)
}

func (o *operator) getenv(k string) string { return o.env[k] }

func (o *operator) load() (*Config, error) { return Load(o.getenv) }

func wantErr(t *testing.T, err error, parts ...string) {
	t.Helper()
	if err == nil {
		t.Fatalf("no error, want one mentioning %q", parts)
	}
	for _, p := range parts {
		if !strings.Contains(err.Error(), p) {
			t.Fatalf("error %q does not mention %q", err, p)
		}
	}
}

func TestManagedRefusesLooseKeyPermissions(t *testing.T) {
	o := newOperator(t)
	if _, err := o.load(); err != nil {
		t.Fatalf("the operator's files as given: %v", err)
	}
	id := o.env[EnvIdentityKey]
	for _, perm := range []os.FileMode{0o644, 0o640, 0o604, 0o660} {
		os.Chmod(id, perm)
		_, err := o.load()
		wantErr(t, err, EnvIdentityKey, "the group or other accounts can access it")
	}
	os.Chmod(id, 0o400)
	if _, err := o.load(); err != nil {
		t.Fatalf("identity key with mode 0400: %v", err)
	}

	// A key of the key store with loose permissions stops the connector at start-up.
	key := filepath.Join(o.env[EnvKeysDir], "hpc")
	os.Chmod(key, 0o644)
	_, err := o.load()
	wantErr(t, err, EnvTargetsFile, "key hpc", "the group or other accounts can access it")
	// ... and one loosened while it runs is refused on its next use.
	os.Chmod(key, 0o600)
	cfg, err := o.load()
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := cfg.Keys.Read("hpc"); err != nil {
		t.Fatalf("read the key: %v", err)
	}
	os.Chmod(key, 0o640)
	if _, _, err := cfg.Keys.Read("hpc"); err == nil || !strings.Contains(err.Error(), "can access it") {
		t.Fatalf("a loosened key was read: %v", err)
	}
	// A missing key is refused too.
	os.Remove(key)
	_, err = o.load()
	wantErr(t, err, "key hpc")
}

// resolver answers names from a table.
type resolver map[string]string

func (r resolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	a, ok := r[host]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	return []netip.Addr{netip.MustParseAddr(a)}, nil
}

func TestManagedDefaultScopeDeniesAll(t *testing.T) {
	s, err := netscope.ParseManagedScope("", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(s.CIDRs()) != 0 || len(s.Hosts()) != 0 {
		t.Fatalf("default scope = %v %v, want empty", s.CIDRs(), s.Hosts())
	}
	for _, a := range []string{"93.184.216.34", "2606:2800:220:1::1", "10.0.0.1", "192.168.1.1", "127.0.0.1", "::1", "169.254.169.254"} {
		if ok, _ := s.Allows(netip.MustParseAddr(a)); ok {
			t.Errorf("the default managed scope allows %s", a)
		}
	}
	if !s.AllowsPort(22) || s.AllowsPort(2222) {
		t.Errorf("default ports: 22 %v, 2222 %v; want only 22", s.AllowsPort(22), s.AllowsPort(2222))
	}
	if ok, _ := s.AllowsOnward("node01.cluster"); ok {
		t.Error("a jump host may be asked to reach a name the scope does not name")
	}
	d := &netscope.Dialer{Scope: s, Resolver: resolver{"example.org": "93.184.216.34"}, Timeout: time.Second}
	for _, host := range []string{"example.org", "93.184.216.34"} {
		_, err := d.DialContext(context.Background(), host, 22)
		var ne *netscope.Error
		if !errorsAs(err, &ne) || ne.Code != protocol.CodeNetworkScopeDenied {
			t.Errorf("dial %s in the default scope: %v, want network_scope_denied", host, err)
		}
	}

	// What the operator allows is all that is reachable: a named host's global answers, a range,
	// and only the ports listed.
	s, err = netscope.ParseManagedScope("10.20.0.0/16", "login.hpc.example.org,*.cluster.example.org", "22,2222")
	if err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.Allows(netip.MustParseAddr("10.20.3.4")); !ok {
		t.Error("10.20.3.4 is in PARALLAX_ALLOW_NET")
	}
	if ok, _ := s.Allows(netip.MustParseAddr("93.184.216.34")); ok {
		t.Error("a global address outside every range is allowed by address")
	}
	d = &netscope.Dialer{Scope: s, Timeout: time.Second, Resolver: resolver{
		"login.hpc.example.org": "93.184.216.34", "other.example.org": "93.184.216.35", "evil.cluster.example.org": "10.99.0.1",
	}}
	if addrs, err := d.Resolve(context.Background(), "login.hpc.example.org"); err != nil || len(addrs) != 1 {
		t.Errorf("an allowed name: %v %v", addrs, err)
	}
	for _, host := range []string{"other.example.org", "evil.cluster.example.org"} {
		if _, err := d.Resolve(context.Background(), host); err == nil {
			t.Errorf("%s resolved inside the scope", host)
		}
	}
	if _, err := d.DialContext(context.Background(), "login.hpc.example.org", 8022); err == nil || !strings.Contains(err.Error(), "PARALLAX_ALLOW_PORTS") {
		t.Errorf("dial a port outside PARALLAX_ALLOW_PORTS: %v", err)
	}
	if ok, _ := s.AllowsOnward("node01.cluster.example.org"); !ok {
		t.Error("*.cluster.example.org covers node01.cluster.example.org")
	}
	if ok, _ := s.AllowsOnward("cluster.example.org"); ok {
		t.Error("*.cluster.example.org covers the suffix itself")
	}

	// A targets file whose host the empty scope does not reach is refused at start-up.
	o := newOperator(t)
	delete(o.env, netscope.EnvAllowNet)
	delete(o.env, netscope.EnvAllowHosts)
	o.targets(map[string]Entry{"hpc": {Host: "93.184.216.34", Port: 22, User: "parallax", KeyID: "hpc", Workspace: "/scratch"}})
	_, err = o.load()
	wantErr(t, err, EnvTargetsFile, "outside the approved network scope")
}

func errorsAs(err error, target **netscope.Error) bool {
	ne, ok := err.(*netscope.Error)
	if ok {
		*target = ne
	}
	return ok
}

func TestManagedRefusesLoopbackConfig(t *testing.T) {
	for _, nets := range []string{"127.0.0.0/8", "127.0.0.1/32", "::1/128", "169.254.0.0/16", "169.254.169.254/32",
		"fe80::/10", "0.0.0.0/0", "::/0", "::ffff:127.0.0.1/128", "64:ff9b::a9fe:a9fe/128", "2002:7f00::/24", "10.0.0.0/8,127.0.0.0/16"} {
		if _, err := netscope.ParseManagedScope(nets, "", ""); err == nil {
			t.Errorf("PARALLAX_ALLOW_NET=%s was accepted", nets)
		}
	}
	for _, hosts := range []string{"127.0.0.1", "::1", "10.0.0.1", "bad_name", "-x.example.org"} {
		if _, err := netscope.ParseManagedScope("", hosts, ""); err == nil {
			t.Errorf("PARALLAX_ALLOW_HOSTS=%s was accepted", hosts)
		}
	}
	for _, ports := range []string{"0", "65536", "ssh", "22,x", "022"} {
		if _, err := netscope.ParseManagedScope("", "", ports); err == nil {
			t.Errorf("PARALLAX_ALLOW_PORTS=%s was accepted", ports)
		}
	}

	o := newOperator(t)
	o.env[netscope.EnvAllowNet] = "127.0.0.0/8"
	_, err := o.load()
	wantErr(t, err, netscope.EnvAllowNet, "loopback")

	o.env[netscope.EnvAllowNet] = "10.20.0.0/16"
	for _, host := range []string{"127.0.0.1", "::1", "169.254.169.254", "fe80::1", "::ffff:127.0.0.1"} {
		o.targets(map[string]Entry{"hpc": {Host: hostName, Port: 22, User: "parallax", KeyID: "hpc", Workspace: "/scratch",
			Jump: &JumpEntry{Host: host, Port: 22, User: "parallax"}}})
		if _, err := o.load(); err == nil {
			t.Errorf("a jump host %s was accepted", host)
		}
		o.targets(map[string]Entry{"hpc": {Host: host, Port: 22, User: "parallax", KeyID: "hpc", Workspace: "/scratch"}})
		if _, err := o.load(); err == nil {
			t.Errorf("a target host %s was accepted", host)
		}
	}
	// The targets the scope and the protocol allow are the only ones accepted.
	for name, e := range map[string]Entry{
		"port outside PARALLAX_ALLOW_PORTS": {Host: hostName, Port: 2222, User: "parallax", KeyID: "hpc", Workspace: "/scratch"},
		"relative workspace":                {Host: hostName, Port: 22, User: "parallax", KeyID: "hpc", Workspace: "scratch"},
		"workspace with ..":                 {Host: hostName, Port: 22, User: "parallax", KeyID: "hpc", Workspace: "/scratch/../etc"},
		"user option":                       {Host: hostName, Port: 22, User: "-oProxyCommand=x", KeyID: "hpc", Workspace: "/scratch"},
		"unknown placeholder":               {Host: hostName, Port: 22, User: "p-{name}", KeyID: "hpc", Workspace: "/scratch"},
		"onward name not allowed":           {Host: "node01.internal", Port: 22, User: "parallax", KeyID: "hpc", Workspace: "/scratch", Jump: &JumpEntry{Host: hostName, Port: 22, User: "parallax"}},
	} {
		o.targets(map[string]Entry{"hpc": e})
		if _, err := o.load(); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

// host is an in-process SSH server named hostName, the operator's files for it, and a managed
// Target whose dialer reaches it on loopback (the managed scope never would; the tests' server
// listens nowhere else).
type host struct {
	t       *testing.T
	o       *operator
	srv     *sshtest.Server
	hostKey ssh.Signer
	cfg     *Config
	mt      *Target
	ssh     *sshtarget.Target
	term    *recordingTerminal
	ws      string
	stub    string
}

type recordingTerminal struct {
	mu    sync.Mutex
	asked []string
}

func (r *recordingTerminal) Say(string) {}

func (r *recordingTerminal) Ask(_ context.Context, prompt string, _ bool) ([]byte, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.asked = append(r.asked, prompt)
	return []byte("123456"), nil
}

func (r *recordingTerminal) Asked() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.asked...)
}

type hostOptions struct {
	passphrase string
	mfa        bool
	pin        bool
}

func newHost(t *testing.T, opts hostOptions) *host {
	t.Helper()
	o := newOperator(t)
	stub := jupytertest.Install(t, "ok")
	signer, keyPEM := clientKey(t, opts.passphrase)
	writeFile(t, filepath.Join(o.env[EnvKeysDir], "hpc"), keyPEM, 0o600)
	hostKey := sshtest.NewSigner(t)
	so := sshtest.Options{HostKeys: []ssh.Signer{hostKey}, User: "p-" + subject,
		AuthorizedKeys: []ssh.PublicKey{signer.PublicKey()}, Exec: sshtest.POSIXHost(stub)}
	if opts.mfa {
		so.MFA = &sshtest.MFA{Question: "Verification code: ", Answer: "123456"}
	}
	srv := sshtest.New(t, so)
	ws := t.TempDir()
	if err := os.Mkdir(filepath.Join(ws, subject), 0o700); err != nil {
		t.Fatal(err)
	}
	o.env[netscope.EnvAllowPorts] = strconv.Itoa(srv.Port)
	o.targets(map[string]Entry{"hpc": {Host: hostName, Port: srv.Port, User: "p-{subject}", KeyID: "hpc",
		Workspace: ws + "/{subject}", Runtime: Runtime{Python: jupytertest.Python(stub)}}})
	if opts.pin {
		line := knownhosts.Line([]string{net.JoinHostPort(hostName, strconv.Itoa(srv.Port))}, hostKey.PublicKey())
		writeFile(t, o.env[EnvKnownHostsFile], []byte(line+"\n"), 0o644)
	}
	cfg, err := o.load()
	if err != nil {
		t.Fatal(err)
	}
	tg := NewSSH(cfg, nil)
	loop, err := netscope.ParseScope([]string{"127.0.0.0/8"}, "")
	if err != nil {
		t.Fatal(err)
	}
	tg.Dialer = &netscope.Dialer{Scope: loop, Resolver: resolver{hostName: srv.Host}, Timeout: 5 * time.Second}
	// A terminal is present but the connector has no TTY: nothing may be asked in it.
	term := &recordingTerminal{}
	tg.Terminal = term
	tg.Deadlines = map[string]time.Duration{"ssh_auth": 10 * time.Second}
	mt := &Target{Targets: cfg.Targets, Remote: &sshtarget.Remote{SSH: tg, ReadyTimeout: 10 * time.Second,
		PollInterval: 50 * time.Millisecond, Keepalive: 50 * time.Millisecond, KeepaliveLoss: time.Second,
		Interfaces: func() (cause.Snapshot, error) { return cause.Snapshot{}, nil }, Ports: sshtest.QuietPorts}}
	t.Cleanup(func() {
		for _, rec := range jupytertest.Records(t, stub) {
			kill(rec.PID)
		}
	})
	return &host{t: t, o: o, srv: srv, hostKey: hostKey, cfg: cfg, mt: mt, ssh: tg, term: term, ws: ws, stub: stub}
}

func (h *host) test(tg protocol.Target, rt protocol.Runtime, confirmations ...protocol.Confirmation) *protocol.TestResult {
	h.t.Helper()
	res := h.mt.Test(context.Background(), &protocol.TestConnection{RequestID: requestID, Target: tg, Runtime: rt, Confirmations: confirmations}, nil)
	if _, err := protocol.Encode(res); err != nil {
		h.t.Fatalf("invalid test_result: %v\n%+v", err, res)
	}
	return res
}

func managedTarget(id string) protocol.Target {
	return protocol.Target{Kind: protocol.TargetManaged, TargetID: id, Subject: subject}
}

func start() protocol.Runtime {
	return protocol.Runtime{Mode: protocol.RuntimeStart, KernelName: "python3"}
}

func stage(t *testing.T, res *protocol.TestResult, name string) protocol.Stage {
	t.Helper()
	for _, st := range res.Stages {
		if st.Name == name {
			return st
		}
	}
	t.Fatalf("no %s stage in %+v", name, res.Stages)
	return protocol.Stage{}
}

func TestManagedUnpinnedHostRefused(t *testing.T) {
	skipOnWindows(t)
	h := newHost(t, hostOptions{})
	fp := ssh.FingerprintSHA256(h.hostKey.PublicKey())
	// A confirmation of the presented key, as a compromised relay could send, changes nothing.
	res := h.test(managedTarget("hpc"), start(), protocol.Confirmation{Host: hostName, Port: h.srv.Port, SHA256: fp})
	st := stage(t, res, "host_identity")
	if res.Outcome != "failed" || st.Status != "failed" || st.Code != protocol.CodeHostKeyUntrustedManaged {
		t.Fatalf("unpinned host: outcome %s, host_identity %+v", res.Outcome, st)
	}
	if st.Data == nil || st.Data.Fingerprint != fp || st.Data.Hop != "target" {
		t.Errorf("host_identity data = %+v, want the presented fingerprint for the operator to pin", st.Data)
	}
	if data, err := os.ReadFile(h.o.env[EnvKnownHostsFile]); err != nil || len(data) != 0 {
		t.Errorf("the pinned known_hosts was written: %q %v", data, err)
	}
	if n := len(h.srv.Logins()); n != 0 {
		t.Errorf("%d logins to an unpinned host", n)
	}

	// A host presenting another key than the one pinned is a changed key, a hard stop.
	other := sshtest.NewSigner(t)
	line := knownhosts.Line([]string{net.JoinHostPort(hostName, strconv.Itoa(h.srv.Port))}, other.PublicKey())
	writeFile(t, h.o.env[EnvKnownHostsFile], []byte(line+"\n"), 0o644)
	res = h.test(managedTarget("hpc"), start(), protocol.Confirmation{Host: hostName, Port: h.srv.Port, SHA256: fp,
		Replacing: ssh.FingerprintSHA256(other.PublicKey())})
	st = stage(t, res, "host_identity")
	if st.Code != protocol.CodeHostKeyChanged || st.Data.Expected != ssh.FingerprintSHA256(other.PublicKey()) || st.Data.Presented != fp {
		t.Fatalf("pinned to another key: %+v", st)
	}
	if data, _ := os.ReadFile(h.o.env[EnvKnownHostsFile]); string(data) != line+"\n" {
		t.Errorf("the pinned known_hosts changed:\n%s", data)
	}
}

func TestManagedNeverPrompts(t *testing.T) {
	skipOnWindows(t)
	h := newHost(t, hostOptions{passphrase: "correct horse", pin: true})
	res := h.test(managedTarget("hpc"), start())
	if st := stage(t, res, "ssh_auth"); st.Status != "failed" || st.Code != protocol.CodeKeyPassphraseRequired {
		t.Fatalf("an encrypted key: ssh_auth %+v, want key_passphrase_required", st)
	}

	m := newHost(t, hostOptions{mfa: true, pin: true})
	res = m.test(managedTarget("hpc"), start())
	if st := stage(t, res, "ssh_auth"); st.Status != "failed" || st.Code != protocol.CodeMfaRequiresTerminal {
		t.Fatalf("a second factor: ssh_auth %+v, want mfa_requires_terminal", st)
	}
	// The host asked once; nothing answered it and nobody logged in.
	if m.srv.KeyboardRounds() > 1 || len(m.srv.Logins()) != 0 {
		t.Errorf("second-factor rounds %d, logins %+v", m.srv.KeyboardRounds(), m.srv.Logins())
	}
	for _, x := range []*host{h, m} {
		if asked := x.term.Asked(); len(asked) != 0 {
			t.Errorf("the connector asked %q", asked)
		}
		if x.ssh.TTY || x.ssh.Agent != nil {
			t.Errorf("a managed SSH target has TTY %v, agent %v", x.ssh.TTY, x.ssh.Agent != nil)
		}
	}
}

func TestManagedRejectsLocalTarget(t *testing.T) {
	skipOnWindows(t)
	o := newOperator(t)
	cfg, err := o.load()
	if err != nil {
		t.Fatal(err)
	}
	mt := &Target{Targets: cfg.Targets, Remote: &sshtarget.Remote{SSH: NewSSH(cfg, nil)}}
	key := &protocol.AuthRef{Method: protocol.AuthKey, KeyPath: "/home/p/.ssh/id_ed25519"}
	for _, tg := range []protocol.Target{
		{Kind: protocol.TargetLocal, Workspace: "/tmp"},
		{Kind: protocol.TargetSSH, Host: "93.184.216.34", Port: 22, User: "p", Auth: key, Workspace: "/tmp"},
	} {
		res := mt.Test(context.Background(), &protocol.TestConnection{RequestID: requestID, Target: tg, Runtime: start()}, nil)
		if _, err := protocol.Encode(res); err != nil {
			t.Fatalf("invalid test_result: %v", err)
		}
		st := res.Stages[0]
		if res.Outcome != "failed" || st.Name != "reachability" || st.Code != protocol.CodeUnsupportedTarget || len(res.Stages) != 8 {
			t.Errorf("%s target: outcome %s, stages %+v", tg.Kind, res.Outcome, res.Stages)
		}
		_, err := mt.Open(context.Background(), &protocol.OpenSession{RequestID: requestID, SessionID: subject, Target: tg, Runtime: start()})
		var f *target.Failure
		if !errorsAsFailure(err, &f) || f.Code != protocol.CodeUnsupportedTarget {
			t.Errorf("open a %s target: %v, want unsupported_target", tg.Kind, err)
		}
	}
	// A managed SSH target refuses a key path or the agent even if a resolved target named one.
	tg := NewSSH(cfg, nil)
	conn, err := tg.Connect(context.Background(), &protocol.TestConnection{RequestID: requestID,
		Target:  protocol.Target{Kind: protocol.TargetSSH, Host: hostName, Port: 22, User: "p", Auth: key, Workspace: "/tmp"},
		Runtime: start()})
	var f *target.Failure
	if conn != nil || !errorsAsFailure(err, &f) || f.Code != protocol.CodeUnsupportedTarget {
		t.Errorf("a key path on a managed connector: %v", err)
	}
}

func errorsAsFailure(err error, f **target.Failure) bool {
	got, ok := err.(*target.Failure)
	if ok {
		*f = got
	}
	return ok
}

func TestManagedTargetResolution(t *testing.T) {
	skipOnWindows(t)
	h := newHost(t, hostOptions{pin: true})

	// Resolution: the operator's host, port, account rule, key and workspace rule; the request's
	// kernel; never the request's interpreter.
	rt := start()
	rt.Python = "/usr/bin/evil-python"
	tg, outRT, err := h.cfg.Targets.Resolve(managedTarget("hpc"), rt)
	if err != nil {
		t.Fatal(err)
	}
	want := protocol.Target{Kind: protocol.TargetSSH, Host: hostName, Port: h.srv.Port, User: "p-" + subject,
		Auth: &protocol.AuthRef{Method: protocol.AuthManagedKey, KeyID: "hpc"}, Workspace: h.ws + "/" + subject}
	if got, _ := json.Marshal(tg); string(got) != mustJSON(t, want) {
		t.Errorf("resolved target %s, want %s", got, mustJSON(t, want))
	}
	if outRT.Mode != protocol.RuntimeStart || outRT.Python != jupytertest.Python(h.stub) || outRT.KernelName != "python3" {
		t.Errorf("resolved runtime %+v", outRT)
	}

	for name, c := range map[string]struct {
		tg   protocol.Target
		rt   protocol.Runtime
		code protocol.Code
	}{
		"unknown target id": {managedTarget("gpu"), start(), protocol.CodeInvalidTarget},
		"attach":            {managedTarget("hpc"), protocol.Runtime{Mode: protocol.RuntimeAttach, Port: 8888}, protocol.CodeUnsupportedTarget},
		"local":             {protocol.Target{Kind: protocol.TargetLocal, Workspace: "/tmp"}, start(), protocol.CodeUnsupportedTarget},
	} {
		_, _, err := h.cfg.Targets.Resolve(c.tg, c.rt)
		var f *target.Failure
		if !errorsAsFailure(err, &f) || f.Code != c.code {
			t.Errorf("%s: %v, want %s", name, err, c.code)
		}
	}

	// A test of the managed target runs every stage on the resolved one.
	res := h.test(managedTarget("hpc"), rt)
	if res.Outcome != "ready_to_start" {
		t.Fatalf("outcome %s: %+v", res.Outcome, res.Stages)
	}
	if st := stage(t, res, "workspace"); !strings.HasSuffix(st.Data.ResolvedPath, "/"+subject) {
		t.Errorf("workspace %+v, want the subject's directory", st.Data)
	}
	logins := h.srv.Logins()
	if len(logins) == 0 || logins[0].User != "p-"+subject {
		t.Errorf("logins %+v, want the subject's account", logins)
	}
	if res.Attachable != nil {
		t.Errorf("attachable servers reported: %+v", res.Attachable)
	}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
