package sshtarget

import (
	"crypto/ed25519"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

// KnownHosts is the connector's own known_hosts file (design §5.2), in OpenSSH format and written
// with x/crypto's knownhosts helpers. The person's ~/.ssh/known_hosts is neither read nor
// written. Lines the connector did not write, comments included, are kept as they are; a replaced
// key stays in the file as a `# replaced <time> <old fingerprint>` comment.
type KnownHosts struct {
	Path string
	// Now stamps replacements; nil means time.Now.
	Now func() time.Time

	mu sync.Mutex
}

// hostAddr is a net.Addr for the host as typed, so knownhosts checks the name and never an
// address it resolved to (design §8: the host key is verified against the name as typed).
type hostAddr string

func (a hostAddr) Network() string { return "tcp" }
func (a hostAddr) String() string  { return string(a) }

// address is the host:port knownhosts looks up: a lower-case name, or an address literal.
func address(host string, port int) string {
	return net.JoinHostPort(strings.ToLower(host), strconv.Itoa(port))
}

// probeKey is a key no host presents: looking it up returns every key the file holds for a host.
var probeKey = func() ssh.PublicKey {
	k, err := ssh.NewPublicKey(ed25519.PublicKey(make([]byte, ed25519.PublicKeySize)))
	if err != nil {
		panic(err)
	}
	return k
}()

// Lookup returns the keys the file holds for host:port, at most one per key type (the first line
// of each type counts, as in OpenSSH).
func (k *KnownHosts) Lookup(host string, port int) ([]ssh.PublicKey, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	return k.lookup(host, port)
}

func (k *KnownHosts) lookup(host string, port int) ([]ssh.PublicKey, error) {
	cb, err := k.callback()
	if err != nil {
		return nil, err
	}
	a := address(host, port)
	err = cb(a, hostAddr(a), probeKey)
	var ke *knownhosts.KeyError
	if !errors.As(err, &ke) {
		return nil, fmt.Errorf("reading %s: %v", k.Path, err)
	}
	keys := make([]ssh.PublicKey, 0, len(ke.Want))
	for _, w := range ke.Want {
		keys = append(keys, w.Key)
	}
	return keys, nil
}

func (k *KnownHosts) callback() (ssh.HostKeyCallback, error) {
	if _, err := os.Stat(k.Path); errors.Is(err, fs.ErrNotExist) {
		return knownhosts.New()
	}
	return knownhosts.New(k.Path)
}

// Add appends a line trusting key for host:port.
func (k *KnownHosts) Add(host string, port int, key ssh.PublicKey) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	data, err := k.read()
	if err != nil {
		return err
	}
	if len(data) > 0 && data[len(data)-1] != '\n' {
		data = append(data, '\n')
	}
	data = append(data, knownhosts.Line([]string{address(host, port)}, key)+"\n"...)
	return k.write(data)
}

// Replace trusts key for host:port in place of the key whose fingerprint is old. Each line that
// names host:port with the old key becomes a `# replaced <time> <old fingerprint> <line>` comment
// and the new key is appended, so the history stays in the file. It fails when no such line
// exists, so a replacement never adds trust that the confirmation did not name.
func (k *KnownHosts) Replace(host string, port int, old string, key ssh.PublicKey) error {
	k.mu.Lock()
	defer k.mu.Unlock()
	data, err := k.read()
	if err != nil {
		return err
	}
	now := time.Now
	if k.Now != nil {
		now = k.Now
	}
	want := knownhosts.Normalize(address(host, port))
	lines := strings.SplitAfter(string(data), "\n")
	replaced := false
	for i, line := range lines {
		if !lineNames(line, want, old) {
			continue
		}
		body := strings.TrimRight(line, "\r\n")
		lines[i] = fmt.Sprintf("# replaced %s %s %s\n", now().UTC().Format(time.RFC3339), old, body)
		replaced = true
	}
	if !replaced {
		return fmt.Errorf("%s holds no key %s for %s", k.Path, old, want)
	}
	out := strings.Join(lines, "")
	if out != "" && !strings.HasSuffix(out, "\n") {
		out += "\n"
	}
	out += knownhosts.Line([]string{address(host, port)}, key) + "\n"
	return k.write([]byte(out))
}

// lineNames reports whether a known_hosts line is an active (unmarked) entry whose host list
// contains want literally and whose key has the fingerprint fp. The connector writes plain host
// names, so a hashed or wildcard line is never one it replaces.
func lineNames(line, want, fp string) bool {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "@") {
		return false
	}
	fields := strings.Fields(trimmed)
	if len(fields) < 3 {
		return false
	}
	named := false
	for _, h := range strings.Split(fields[0], ",") {
		if strings.EqualFold(h, want) {
			named = true
		}
	}
	if !named {
		return false
	}
	key, _, _, _, err := ssh.ParseAuthorizedKey([]byte(strings.Join(fields[1:], " ")))
	return err == nil && ssh.FingerprintSHA256(key) == fp
}

func (k *KnownHosts) read() ([]byte, error) {
	data, err := os.ReadFile(k.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

// write replaces the file atomically with mode 0600.
func (k *KnownHosts) write(data []byte) error {
	dir := filepath.Dir(k.Path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".known_hosts-*")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(0o600); err != nil && runtime.GOOS != "windows" {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(name, k.Path)
}

// fingerprints returns the SHA256 fingerprints of keys.
func fingerprints(keys []ssh.PublicKey) []string {
	out := make([]string, len(keys))
	for i, k := range keys {
		out[i] = ssh.FingerprintSHA256(k)
	}
	return out
}

// hostKeyAlgorithms restricts the negotiation to the key types already recorded for a host
// (design §5.2), so a server that offers an additional type is not reported as changed. An RSA
// record admits the SHA-2 signature algorithms as well as ssh-rsa. Nil means no restriction.
func hostKeyAlgorithms(keys []ssh.PublicKey) []string {
	var out []string
	seen := map[string]bool{}
	add := func(a string) {
		if !seen[a] {
			seen[a] = true
			out = append(out, a)
		}
	}
	for _, k := range keys {
		if k.Type() == ssh.KeyAlgoRSA {
			add(ssh.KeyAlgoRSASHA512)
			add(ssh.KeyAlgoRSASHA256)
		}
		add(k.Type())
	}
	return out
}
