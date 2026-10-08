// Package redact removes secrets from text before it is printed or logged. Every later package
// that writes child-process output or error details passes it through Redact.
package redact

import (
	"regexp"
	"sort"
	"strings"
	"sync"
)

// Placeholder replaces every removed value.
const Placeholder = "[redacted]"

// minSecretLen keeps a registered value too short to be a real secret from mangling ordinary
// output; every secret the connector holds (tokens, passphrases, one-time codes) is longer.
const minSecretLen = 4

// tokenQuery matches the value of a query parameter whose name ends in "token" (token,
// access_token, id_token …), as Jupyter prints in its start-up URLs.
var tokenQuery = regexp.MustCompile(`(?i)([?&;][a-z0-9_.-]*token=)[^&#;\s"'<>]*`)

// Redactor holds the registered secrets. The zero value is ready to use.
//
// Registrations are counted: a secret registered n times stays redacted until it has been
// forgotten n times. Two sessions attached to the same Jupyter server share its token, so the
// first session to end must not unredact the token the other still holds.
type Redactor struct {
	mu      sync.RWMutex
	refs    map[string]int
	secrets []string // longest first, so a secret containing another is removed whole
}

// Register adds a reference to a secret; later calls to Redact remove every occurrence of it.
func (r *Redactor) Register(secret string) {
	if len(secret) < minSecretLen {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.refs == nil {
		r.refs = map[string]int{}
	}
	r.refs[secret]++
	if r.refs[secret] > 1 {
		return
	}
	r.secrets = append(r.secrets, secret)
	sort.SliceStable(r.secrets, func(i, j int) bool { return len(r.secrets[i]) > len(r.secrets[j]) })
}

// Forget drops one reference to a secret that is no longer held (for example, a stopped
// session's token); the secret stops being redacted when its last reference is dropped.
// Forgetting a secret that is not registered does nothing.
func (r *Redactor) Forget(secret string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	n, ok := r.refs[secret]
	if !ok {
		return
	}
	if n > 1 {
		r.refs[secret] = n - 1
		return
	}
	delete(r.refs, secret)
	for i, s := range r.secrets {
		if s == secret {
			r.secrets = append(r.secrets[:i], r.secrets[i+1:]...)
			return
		}
	}
}

// Redact returns s with token query values and every registered secret replaced.
func (r *Redactor) Redact(s string) string {
	r.mu.RLock()
	for _, secret := range r.secrets {
		s = strings.ReplaceAll(s, secret, Placeholder)
	}
	r.mu.RUnlock()
	return tokenQuery.ReplaceAllString(s, "${1}"+Placeholder)
}

var std Redactor

// Register adds a secret to the process-wide redactor.
func Register(secret string) { std.Register(secret) }

// Forget drops one reference to a secret in the process-wide redactor.
func Forget(secret string) { std.Forget(secret) }

// Redact applies the process-wide redactor.
func Redact(s string) string { return std.Redact(s) }
