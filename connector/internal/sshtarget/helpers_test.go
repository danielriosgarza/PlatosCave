package sshtarget

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/santhosh-tekuri/jsonschema/v6"
	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"parallax/connector/internal/netscope"
	"parallax/connector/internal/protocol"
	"parallax/connector/internal/sshtest"
	"parallax/connector/internal/target"
	schemas "parallax/connector/protocol"
)

const requestID = "c0ffee00-1111-4222-8333-444455556666"

// loopback is the scope a person who tunnels to a cluster through localhost would allow; the
// in-process servers listen on 127.0.0.1.
func loopback(t *testing.T) netscope.Scope {
	t.Helper()
	s, err := netscope.ParseScope([]string{"127.0.0.0/8"}, "")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// fakeTerminal is the connector's terminal in tests: it records what was asked and said and
// answers from a script.
type fakeTerminal struct {
	mu      sync.Mutex
	answers []string
	asked   []string
	said    []string
	// delay holds each answer back; block never answers.
	delay time.Duration
	block bool
}

func (f *fakeTerminal) Say(text string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.said = append(f.said, text)
}

func (f *fakeTerminal) Ask(ctx context.Context, prompt string, echo bool) ([]byte, error) {
	f.mu.Lock()
	f.asked = append(f.asked, prompt)
	var ans string
	ok := len(f.answers) > 0
	if ok {
		ans, f.answers = f.answers[0], f.answers[1:]
	}
	f.mu.Unlock()
	if f.block || !ok {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if f.delay > 0 {
		select {
		case <-time.After(f.delay):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	return []byte(ans), nil
}

func (f *fakeTerminal) Asked() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.asked...)
}

func (f *fakeTerminal) Said() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.said...)
}

// fixture is a Target with its own known_hosts in a temporary directory.
type fixture struct {
	t    *testing.T
	tg   *Target
	term *fakeTerminal
	logs *[]string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	var logs []string
	var mu sync.Mutex
	term := &fakeTerminal{}
	tg := &Target{
		Dialer:     &netscope.Dialer{Scope: loopback(t), Timeout: 5 * time.Second},
		KnownHosts: &KnownHosts{Path: filepath.Join(t.TempDir(), "known_hosts")},
		TTY:        true,
		Terminal:   term,
		Log: func(s string) {
			mu.Lock()
			defer mu.Unlock()
			logs = append(logs, s)
		},
	}
	return &fixture{t: t, tg: tg, term: term, logs: &logs}
}

// result is one Check: the stages in the order reported, every progress message, and the
// connection when every stage passed.
type result struct {
	stages   []protocol.Stage
	progress []protocol.Stage
	conn     *Conn
}

func (r *result) stage(t *testing.T, name string) protocol.Stage {
	t.Helper()
	for _, st := range r.stages {
		if st.Name == name {
			return st
		}
	}
	t.Fatalf("no %s stage in %+v", name, r.stages)
	return protocol.Stage{}
}

func (r *result) statuses() string {
	var parts []string
	for _, st := range r.stages {
		p := st.Name + "=" + st.Status
		if st.Code != "" {
			p += ":" + string(st.Code)
		}
		parts = append(parts, p)
	}
	return strings.Join(parts, " ")
}

// check runs Check, then every later stage of an ssh target the way the runtime would (blocked
// stages are reported skipped), and validates each report against the protocol.
func (f *fixture) check(req *protocol.TestConnection) *result {
	f.t.Helper()
	r := &result{}
	s := &target.Stages{Progress: func(st protocol.Stage) { r.progress = append(r.progress, st) }}
	r.conn = f.tg.Check(context.Background(), req, s)
	if r.conn != nil {
		f.t.Cleanup(func() { r.conn.Close() })
	}
	r.stages = s.List
	var names []string
	for _, st := range r.stages {
		names = append(names, st.Name)
	}
	if got := strings.Join(names, ","); got != strings.Join(Stages, ",") {
		f.t.Fatalf("stages %s", got)
	}
	if (r.conn != nil) != (s.BlockedBy() == "") {
		f.t.Fatalf("connection %v with blocked by %q", r.conn != nil, s.BlockedBy())
	}
	for _, st := range r.progress {
		validProgress(f.t, st)
	}
	i := 0
	for _, st := range r.progress {
		if st.Status == "running" {
			continue
		}
		if i >= len(r.stages) || r.stages[i].Name != st.Name || r.stages[i].Status != st.Status {
			f.t.Fatalf("progress %+v does not match stage %d of %s", st, i, r.statuses())
		}
		i++
	}
	if i != len(r.stages) {
		f.t.Fatalf("progress reported %d of %d stages", i, len(r.stages))
	}
	return r
}

var (
	schemaOnce sync.Once
	schema     *jsonschema.Schema
	schemaErr  error
)

// validProgress checks a stage report as a test_progress message, with the connector's encoder
// and with link.schema.json itself.
func validProgress(t *testing.T, st protocol.Stage) {
	t.Helper()
	msg := &protocol.TestProgress{RequestID: requestID, Stage: st}
	data, err := protocol.Encode(msg)
	if err != nil {
		t.Fatalf("invalid test_progress %+v: %v", st, err)
	}
	schemaOnce.Do(func() {
		raw, err := schemas.V1.ReadFile("v1/link.schema.json")
		if err != nil {
			schemaErr = err
			return
		}
		doc, err := jsonschema.UnmarshalJSON(bytes.NewReader(raw))
		if err != nil {
			schemaErr = err
			return
		}
		c := jsonschema.NewCompiler()
		const loc = "https://parallax.invalid/connector/v1/link.schema.json"
		if err := c.AddResource(loc, doc); err != nil {
			schemaErr = err
			return
		}
		schema, schemaErr = c.Compile(loc)
	})
	if schemaErr != nil {
		t.Fatal(schemaErr)
	}
	inst, err := jsonschema.UnmarshalJSON(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if err := schema.Validate(inst); err != nil {
		t.Fatalf("test_progress fails link.schema.json: %v\n%s", err, data)
	}
}

// clientKey is a client key pair written to a file.
type clientKey struct {
	signer ssh.Signer
	priv   ed25519.PrivateKey
	path   string
}

func newClientKey(t *testing.T, passphrase string) *clientKey {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	var block *pem.Block
	if passphrase == "" {
		block, err = ssh.MarshalPrivateKey(priv, "test key")
	} else {
		block, err = ssh.MarshalPrivateKeyWithPassphrase(priv, "test key", []byte(passphrase))
	}
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "id_ed25519")
	if err := os.WriteFile(path, pem.EncodeToMemory(block), 0o600); err != nil {
		t.Fatal(err)
	}
	return &clientKey{signer: signer, priv: priv, path: path}
}

func (k *clientKey) fp() string { return ssh.FingerprintSHA256(k.signer.PublicKey()) }

func keyAuth(k *clientKey) *protocol.AuthRef {
	return &protocol.AuthRef{Method: protocol.AuthKey, KeyPath: k.path}
}

func ecdsaSigner(t *testing.T) ssh.Signer {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// sshReq is a test_connection for one in-process server.
func sshReq(srv *sshtest.Server, auth *protocol.AuthRef, workspace string) *protocol.TestConnection {
	return &protocol.TestConnection{
		RequestID: requestID,
		Target: protocol.Target{Kind: protocol.TargetSSH, Host: srv.Host, Port: srv.Port, User: "student",
			Auth: auth, Workspace: workspace},
		Runtime: protocol.Runtime{Mode: protocol.RuntimeStart},
	}
}

func fingerprint(s ssh.Signer) string { return ssh.FingerprintSHA256(s.PublicKey()) }

// trust writes a known_hosts entry for a server's endpoint.
func (f *fixture) trust(host string, port int, key ssh.PublicKey) {
	f.t.Helper()
	if err := f.tg.KnownHosts.Add(host, port, key); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) knownHosts() string {
	f.t.Helper()
	data, err := os.ReadFile(f.tg.KnownHosts.Path)
	if errors.Is(err, os.ErrNotExist) {
		return ""
	}
	if err != nil {
		f.t.Fatal(err)
	}
	return string(data)
}

// countingAgent serves an in-memory keyring over a pipe, as the agent's socket would, and
// counts signatures.
type countingAgent struct {
	keyring agent.Agent
	mu      sync.Mutex
	signs   int
	dials   int
}

func newAgent(t *testing.T, keys ...*clientKey) *countingAgent {
	t.Helper()
	kr := agent.NewKeyring()
	for _, k := range keys {
		if err := kr.Add(agent.AddedKey{PrivateKey: k.priv, Comment: filepath.Base(k.path)}); err != nil {
			t.Fatal(err)
		}
	}
	return &countingAgent{keyring: kr}
}

func (a *countingAgent) Sign(key ssh.PublicKey, data []byte) (*ssh.Signature, error) {
	a.mu.Lock()
	a.signs++
	a.mu.Unlock()
	return a.keyring.Sign(key, data)
}

func (a *countingAgent) SignWithFlags(key ssh.PublicKey, data []byte, flags agent.SignatureFlags) (*ssh.Signature, error) {
	a.mu.Lock()
	a.signs++
	a.mu.Unlock()
	return a.keyring.(agent.ExtendedAgent).SignWithFlags(key, data, flags)
}

func (a *countingAgent) List() ([]*agent.Key, error)    { return a.keyring.List() }
func (a *countingAgent) Add(k agent.AddedKey) error     { return a.keyring.Add(k) }
func (a *countingAgent) Remove(k ssh.PublicKey) error   { return a.keyring.Remove(k) }
func (a *countingAgent) RemoveAll() error               { return a.keyring.RemoveAll() }
func (a *countingAgent) Lock(p []byte) error            { return a.keyring.Lock(p) }
func (a *countingAgent) Unlock(p []byte) error          { return a.keyring.Unlock(p) }
func (a *countingAgent) Signers() ([]ssh.Signer, error) { return a.keyring.Signers() }
func (a *countingAgent) Extension(string, []byte) ([]byte, error) {
	return nil, agent.ErrExtensionUnsupported
}

func (a *countingAgent) Signs() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.signs
}

// dial is an AgentDialer speaking the agent protocol over a pipe.
func (a *countingAgent) dial() (agent.ExtendedAgent, io.Closer, error) {
	a.mu.Lock()
	a.dials++
	a.mu.Unlock()
	c1, c2 := net.Pipe()
	go func() {
		agent.ServeAgent(a, c2)
		c2.Close()
	}()
	return agent.NewClient(c1), c1, nil
}

func skipWithoutShell(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("the in-process SSH server runs commands with /bin/sh")
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

func rsaPublic(t *testing.T) ssh.PublicKey {
	t.Helper()
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	pub, err := ssh.NewPublicKey(&priv.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return pub
}

// jumpRoute is a jump host that routes a name only it can resolve to a second server.
type jumpRoute struct {
	jump, target       *sshtest.Server
	jumpKey, targetKey ssh.Signer
	name               string
}

func newJumpRoute(t *testing.T, authorized []ssh.PublicKey, opts ...func(jump, target *sshtest.Options)) *jumpRoute {
	t.Helper()
	jr := &jumpRoute{jumpKey: sshtest.NewSigner(t), targetKey: sshtest.NewSigner(t), name: "gpu01.lab.example.org"}
	jo := sshtest.Options{HostKeys: []ssh.Signer{jr.jumpKey}, AuthorizedKeys: authorized}
	to := sshtest.Options{HostKeys: []ssh.Signer{jr.targetKey}, AuthorizedKeys: authorized}
	for _, o := range opts {
		o(&jo, &to)
	}
	jr.target = sshtest.New(t, to)
	jo.Routes = map[string]string{jr.name + ":22": jr.target.Addr}
	jr.jump = sshtest.New(t, jo)
	return jr
}

func (jr *jumpRoute) req(auth *protocol.AuthRef, workspace string) *protocol.TestConnection {
	return &protocol.TestConnection{
		RequestID: requestID,
		Target: protocol.Target{Kind: protocol.TargetSSH, Host: jr.name, Port: 22, User: "student", Auth: auth,
			Workspace: workspace, Jump: &protocol.Hop{Host: jr.jump.Host, Port: jr.jump.Port, User: "student"}},
		Runtime: protocol.Runtime{Mode: protocol.RuntimeStart},
	}
}

// trustRoute records both hops' keys.
func (f *fixture) trustRoute(jr *jumpRoute) {
	f.trust(jr.jump.Host, jr.jump.Port, jr.jumpKey.PublicKey())
	f.trust(jr.name, 22, jr.targetKey.PublicKey())
}
