package sshtarget

import (
	"bytes"
	"context"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"

	"parallax/connector/internal/protocol"
	"parallax/connector/internal/target"
)

// Terminal is the connector's own terminal: the only place a passphrase or a second factor is
// asked and answered (design §5.3). Neither ever passes through Parallax.
type Terminal interface {
	// Say prints a line for the person.
	Say(text string)
	// Ask prints prompt and reads one answer, shown as typed only when echo is true. It returns
	// when the answer arrives or ctx ends.
	Ask(ctx context.Context, prompt string, echo bool) ([]byte, error)
}

// AgentDialer opens the SSH agent of the connector's computer.
type AgentDialer func() (agent.ExtendedAgent, io.Closer, error)

// maxPromptTries is how many passphrases or second-factor answers are taken (design §5.3).
const maxPromptTries = 3

// errUnsupportedMethod marks a method the host offered that the connector does not use.
var errUnsupportedMethod = errors.New("method not supported by the connector")

// authCodePriority orders the codes a hop's authentication can record: the most specific wins
// when the handshake ends without success.
var authCodePriority = map[protocol.Code]int{
	protocol.CodeMfaFailed:             7,
	protocol.CodeMfaRequiresTerminal:   6,
	protocol.CodeKeyPassphraseWrong:    5,
	protocol.CodeKeyPassphraseRequired: 4,
	protocol.CodeAgentNoIdentity:       3,
	protocol.CodeAgentUnavailable:      2,
	protocol.CodeKeyFileUnreadable:     1,
}

// hopAuth authenticates one hop as design §5.3 says: identities from the agent, then the key
// file (with its certificate), then a keyboard-interactive second factor only after a publickey
// partial success. It records why authentication failed, for the ssh_auth stage's code.
type hopAuth struct {
	t     *Target
	ctx   context.Context
	tty   bool
	term  Terminal
	ref   protocol.AuthRef
	user  string
	label string
	// prompted is called once when the first terminal prompt of this hop starts.
	prompted func()

	mu             sync.Mutex
	publicKeyAsked bool
	signed         bool
	others         []string
	answered       int
	code           protocol.Code
	detail         string
	closers        []io.Closer
	promptOnce     sync.Once
}

func (a *hopAuth) methods() []ssh.AuthMethod {
	return []ssh.AuthMethod{
		ssh.PublicKeysCallback(a.signers),
		ssh.KeyboardInteractive(a.keyboard),
		ssh.PasswordCallback(func() (string, error) {
			a.offered("password")
			return "", errUnsupportedMethod
		}),
	}
}

func (a *hopAuth) record(code protocol.Code, format string, args ...any) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if authCodePriority[code] > authCodePriority[a.code] {
		a.code, a.detail = code, fmt.Sprintf(format, args...)
	}
	return errors.New(string(code))
}

func (a *hopAuth) offered(method string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, m := range a.others {
		if m == method {
			return
		}
	}
	a.others = append(a.others, method)
}

func (a *hopAuth) close() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, c := range a.closers {
		c.Close()
	}
	a.closers = nil
}

// failure turns a failed handshake into the ssh_auth stage's failure.
func (a *hopAuth) failure(err error) *target.Failure {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.code != "" {
		return &target.Failure{Code: a.code, Detail: a.detail}
	}
	if a.answered > 0 {
		// The host asked for a second factor and refused the answers it was given.
		return &target.Failure{Code: protocol.CodeMfaFailed, Detail: fmt.Sprintf("%s did not accept the second factor", a.label)}
	}
	if !a.publicKeyAsked {
		offered := "no method it named"
		if len(a.others) > 0 {
			offered = strings.Join(a.others, ", ")
		}
		return &target.Failure{Code: protocol.CodeAuthMethodUnsupported,
			Detail: fmt.Sprintf("%s does not accept public keys; it offered %s, which the connector does not use", a.label, offered)}
	}
	return &target.Failure{Code: protocol.CodeAuthRejected, Detail: fmt.Sprintf("%s rejected every key offered: %s", a.label, firstLine(err))}
}

func (a *hopAuth) startPrompt() {
	a.promptOnce.Do(func() {
		if a.prompted != nil {
			a.prompted()
		}
	})
}

// signers is called when the host accepts publickey. With method agent it offers the agent's
// identities (only the one the hint names, when there is a hint); with method key it offers the
// key file's key, signed by the agent when the agent holds it and otherwise from the file, which
// is decrypted only when the host has accepted the key.
func (a *hopAuth) signers() ([]ssh.Signer, error) {
	a.mu.Lock()
	a.publicKeyAsked = true
	a.mu.Unlock()
	var out []ssh.Signer
	switch a.ref.Method {
	case protocol.AuthAgent:
		ag, err := a.agent()
		if err != nil {
			return nil, a.record(protocol.CodeAgentUnavailable, "no SSH agent is available to the connector: %v", err)
		}
		signers, err := agentSigners(ag, a.ref.Hint)
		if err != nil {
			return nil, a.record(protocol.CodeAgentUnavailable, "the SSH agent did not answer: %v", err)
		}
		if len(signers) == 0 {
			if a.ref.Hint != "" {
				return nil, a.record(protocol.CodeAgentNoIdentity, "the SSH agent holds no identity matching %q", a.ref.Hint)
			}
			return nil, a.record(protocol.CodeAgentNoIdentity, "the SSH agent holds no identities")
		}
		out = signers
	case protocol.AuthKey:
		kf, err := a.loadKey()
		if err != nil {
			return nil, err
		}
		// The agent, when it holds the same key, signs without a passphrase.
		var viaAgent ssh.Signer
		if ag, err := a.agent(); err == nil {
			if signers, err := ag.Signers(); err == nil {
				for _, s := range signers {
					if bytes.Equal(s.PublicKey().Marshal(), kf.pub.Marshal()) {
						viaAgent = s
					}
				}
			}
		}
		base := ssh.Signer(kf)
		if viaAgent != nil {
			base = viaAgent
		}
		if kf.cert != nil {
			if cs, err := ssh.NewCertSigner(kf.cert, base); err == nil {
				out = append(out, cs)
			}
		}
		out = append(out, base)
	default:
		// connect refuses any other reference before dialling.
		return nil, fmt.Errorf("authentication method %q is not served here", a.ref.Method)
	}
	for i, s := range out {
		out[i] = track(s, a.markSigned)
	}
	return out, nil
}

func (a *hopAuth) markSigned() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.signed = true
}

func (a *hopAuth) agent() (agent.ExtendedAgent, error) {
	if a.t.Agent == nil {
		return nil, errors.New("no agent configured")
	}
	ag, closer, err := a.t.Agent()
	if err != nil {
		return nil, err
	}
	a.mu.Lock()
	a.closers = append(a.closers, closer)
	a.mu.Unlock()
	return ag, nil
}

// agentSigners returns the agent's signers, only the one whose comment or fingerprint equals
// hint when hint is set. The client offers them one at a time.
func agentSigners(ag agent.ExtendedAgent, hint string) ([]ssh.Signer, error) {
	signers, err := ag.Signers()
	if err != nil {
		return nil, err
	}
	if hint == "" {
		return signers, nil
	}
	keys, err := ag.List()
	if err != nil {
		return nil, err
	}
	var out []ssh.Signer
	for _, s := range signers {
		blob := s.PublicKey().Marshal()
		for _, k := range keys {
			if bytes.Equal(k.Blob, blob) && (k.Comment == hint || ssh.FingerprintSHA256(s.PublicKey()) == hint) {
				out = append(out, s)
				break
			}
		}
	}
	return out, nil
}

// keyFile is the key at keyPath: its public key is known before it is unlocked, so the
// passphrase is asked only after the host accepted the key.
type keyFile struct {
	a    *hopAuth
	path string
	raw  []byte
	pub  ssh.PublicKey
	cert *ssh.Certificate

	mu     sync.Mutex
	signer ssh.Signer
	err    error
}

// loadKey reads the key file and, when present, <keyPath>-cert.pub.
func (a *hopAuth) loadKey() (*keyFile, error) {
	path, err := expandHome(a.ref.KeyPath)
	if err != nil {
		return nil, a.record(protocol.CodeKeyFileUnreadable, "%v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, a.record(protocol.CodeKeyFileUnreadable, "the key file %s cannot be read: %v", a.ref.KeyPath, unwrapPathError(err))
	}
	kf := &keyFile{a: a, path: a.ref.KeyPath, raw: raw}
	signer, err := ssh.ParsePrivateKey(raw)
	var missing *ssh.PassphraseMissingError
	switch {
	case err == nil:
		kf.signer, kf.pub = signer, signer.PublicKey()
	case errors.As(err, &missing):
		kf.pub = missing.PublicKey
		if kf.pub == nil {
			if data, err := os.ReadFile(path + ".pub"); err == nil {
				if pub, _, _, _, err := ssh.ParseAuthorizedKey(data); err == nil {
					kf.pub = pub
				}
			}
		}
		if kf.pub == nil {
			// An old-format encrypted key whose public half is unknown: unlock it now.
			s, err := kf.unlock()
			if err != nil {
				return nil, err
			}
			kf.pub = s.PublicKey()
		}
	default:
		return nil, a.record(protocol.CodeKeyFileUnreadable, "%s is not a private key the connector can read", a.ref.KeyPath)
	}
	if data, err := os.ReadFile(path + "-cert.pub"); err == nil {
		if pub, _, _, _, err := ssh.ParseAuthorizedKey(data); err == nil {
			if cert, ok := pub.(*ssh.Certificate); ok && bytes.Equal(cert.Key.Marshal(), kf.pub.Marshal()) {
				kf.cert = cert
			}
		}
	}
	return kf, nil
}

func (k *keyFile) PublicKey() ssh.PublicKey { return k.pub }

func (k *keyFile) Sign(rand io.Reader, data []byte) (*ssh.Signature, error) {
	s, err := k.unlock()
	if err != nil {
		return nil, err
	}
	return s.Sign(rand, data)
}

func (k *keyFile) SignWithAlgorithm(rand io.Reader, data []byte, algorithm string) (*ssh.Signature, error) {
	s, err := k.unlock()
	if err != nil {
		return nil, err
	}
	if as, ok := s.(ssh.AlgorithmSigner); ok {
		return as.SignWithAlgorithm(rand, data, algorithm)
	}
	if algorithm != "" && algorithm != s.PublicKey().Type() {
		return nil, fmt.Errorf("the key cannot sign with %s", algorithm)
	}
	return s.Sign(rand, data)
}

// unlock returns the decrypted key, asking for the passphrase in the connector's terminal (never
// without one) at most three times.
func (k *keyFile) unlock() (ssh.Signer, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.signer != nil || k.err != nil {
		return k.signer, k.err
	}
	a := k.a
	if !a.tty || a.term == nil {
		k.err = a.record(protocol.CodeKeyPassphraseRequired, "the key %s needs a passphrase and the connector has no terminal to ask in", k.path)
		return nil, k.err
	}
	a.startPrompt()
	for i := 0; i < maxPromptTries; i++ {
		pw, err := a.term.Ask(a.ctx, fmt.Sprintf("Passphrase for %s (Parallax, %s): ", k.path, a.label), false)
		if err != nil {
			k.err = a.record(protocol.CodeKeyPassphraseRequired, "no passphrase was given for %s", k.path)
			return nil, k.err
		}
		s, err := ssh.ParsePrivateKeyWithPassphrase(k.raw, pw)
		clear(pw)
		if err == nil {
			k.signer = s
			return s, nil
		}
		if !errors.Is(err, x509.IncorrectPasswordError) {
			k.err = a.record(protocol.CodeKeyFileUnreadable, "%s could not be unlocked", k.path)
			return nil, k.err
		}
		a.term.Say("That passphrase did not unlock the key.")
	}
	k.err = a.record(protocol.CodeKeyPassphraseWrong, "the passphrase did not unlock %s after %d tries", k.path, maxPromptTries)
	return nil, k.err
}

// keyboard answers keyboard-interactive. Only after the host accepted a key with partial success
// is it a second factor, asked in the connector's terminal; on its own it is a password-style
// method the connector does not use.
func (a *hopAuth) keyboard(name, instruction string, questions []string, echos []bool) ([]string, error) {
	a.mu.Lock()
	signed := a.signed
	a.mu.Unlock()
	if !signed {
		a.offered("keyboard-interactive")
		return nil, errUnsupportedMethod
	}
	if !a.tty || a.term == nil {
		return nil, a.record(protocol.CodeMfaRequiresTerminal, "%s asks for a second factor and the connector has no terminal to ask in", a.label)
	}
	if len(questions) == 0 {
		if text := sanitize(name + "\n" + instruction); text != "" {
			a.term.Say(fmt.Sprintf("[%s] %s", a.label, text))
		}
		return []string{}, nil
	}
	a.mu.Lock()
	a.answered++
	round := a.answered
	a.mu.Unlock()
	if round > maxPromptTries {
		return nil, a.record(protocol.CodeMfaFailed, "%s did not accept the second factor after %d tries", a.label, maxPromptTries)
	}
	a.startPrompt()
	a.term.Say(fmt.Sprintf("Second factor for %s, asked by the host (answer here; it never passes through Parallax):", a.label))
	if text := sanitize(name + "\n" + instruction); text != "" {
		a.term.Say(fmt.Sprintf("[%s] %s", a.label, text))
	}
	answers := make([]string, len(questions))
	for i, q := range questions {
		echo := i < len(echos) && echos[i]
		ans, err := a.term.Ask(a.ctx, fmt.Sprintf("[%s] %s", a.label, sanitize(q)), echo)
		if err != nil {
			return nil, a.record(protocol.CodeMfaFailed, "the second factor for %s was not given in time", a.label)
		}
		answers[i] = string(ans)
		clear(ans)
	}
	return answers, nil
}

// sanitize strips escape sequences and control and format characters from text a host sent, so
// it cannot move the cursor, rewrite what the terminal shows or hide characters (design §5.3).
// Line breaks are kept; surrounding space is trimmed.
func sanitize(s string) string {
	var b strings.Builder
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		if r == 0x1b || r == 0x9b || r == 0x9d {
			i = skipEscape(rs, i)
			continue
		}
		if r == '\n' {
			b.WriteRune(r)
			continue
		}
		if r == '\t' {
			b.WriteRune(' ')
			continue
		}
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) || r == unicode.ReplacementChar {
			continue
		}
		b.WriteRune(r)
	}
	return strings.TrimSpace(b.String())
}

// skipEscape returns the index of the last rune of the escape sequence starting at i.
func skipEscape(rs []rune, i int) int {
	csi := rs[i] == 0x9b
	osc := rs[i] == 0x9d
	if rs[i] == 0x1b {
		if i+1 >= len(rs) {
			return i
		}
		switch rs[i+1] {
		case '[':
			csi = true
		case ']', 'P', '_', '^', 'X':
			osc = true
		default:
			return i + 1
		}
		i++
	}
	for j := i + 1; j < len(rs); j++ {
		switch {
		case csi && rs[j] >= 0x40 && rs[j] <= 0x7e:
			return j
		case osc && (rs[j] == 0x07 || rs[j] == 0x9c):
			return j
		case osc && rs[j] == 0x1b && j+1 < len(rs) && rs[j+1] == '\\':
			return j + 1
		}
	}
	return len(rs) - 1
}

// track wraps a signer so that signing marks that the host accepted a key.
func track(s ssh.Signer, mark func()) ssh.Signer {
	if m, ok := s.(ssh.MultiAlgorithmSigner); ok {
		return &trackedMulti{m, mark}
	}
	if as, ok := s.(ssh.AlgorithmSigner); ok {
		return &trackedAlgorithm{as, mark}
	}
	return &tracked{s, mark}
}

type tracked struct {
	ssh.Signer
	mark func()
}

func (t *tracked) Sign(rand io.Reader, data []byte) (*ssh.Signature, error) {
	sig, err := t.Signer.Sign(rand, data)
	if err == nil {
		t.mark()
	}
	return sig, err
}

type trackedAlgorithm struct {
	ssh.AlgorithmSigner
	mark func()
}

func (t *trackedAlgorithm) Sign(rand io.Reader, data []byte) (*ssh.Signature, error) {
	return t.SignWithAlgorithm(rand, data, "")
}

func (t *trackedAlgorithm) SignWithAlgorithm(rand io.Reader, data []byte, algorithm string) (*ssh.Signature, error) {
	sig, err := t.AlgorithmSigner.SignWithAlgorithm(rand, data, algorithm)
	if err == nil {
		t.mark()
	}
	return sig, err
}

type trackedMulti struct {
	ssh.MultiAlgorithmSigner
	mark func()
}

func (t *trackedMulti) Sign(rand io.Reader, data []byte) (*ssh.Signature, error) {
	return t.SignWithAlgorithm(rand, data, "")
}

func (t *trackedMulti) SignWithAlgorithm(rand io.Reader, data []byte, algorithm string) (*ssh.Signature, error) {
	sig, err := t.MultiAlgorithmSigner.SignWithAlgorithm(rand, data, algorithm)
	if err == nil {
		t.mark()
	}
	return sig, err
}

// expandHome expands a leading ~/ to the connector's home directory.
func expandHome(p string) (string, error) {
	if !strings.HasPrefix(p, "~/") {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot find the home directory for %s: %v", p, err)
	}
	return filepath.Join(home, filepath.FromSlash(p[2:])), nil
}

// unwrapPathError drops the path from an *os.PathError: the caller names the path as the person
// configured it.
func unwrapPathError(err error) error {
	var pe *os.PathError
	if errors.As(err, &pe) {
		return pe.Err
	}
	return err
}

func firstLine(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return s
}
