package sshtarget

import (
	"bytes"
	"errors"
	"fmt"
	"net"
	"sync"

	"golang.org/x/crypto/ssh"

	"parallax/connector/internal/protocol"
	"parallax/connector/internal/target"
)

// Decision is the result of design §5.2's table for one hop.
type Decision struct {
	// Row is the table's row, 1 to 8.
	Row int
	// Status is ok, failed or needs_action.
	Status string
	// Write is what happens to the connector's record: "", "add" or "replace".
	Write string
	// Replacing is the fingerprint a replace removes (row 2).
	Replacing string
	// Expected is the trusted fingerprint a changed key is compared with (rows 3 and 5).
	Expected string
}

// Decide applies the eight rows of design §5.2. local holds the fingerprints of the connector's
// entries for host:port (L), the one of the presented key's type first; server is the server's
// record (S, "" when none); confirmations are this request's confirmations for host:port (C);
// presented is the key presented now (P). It is a pure function of its arguments.
func Decide(local []string, server string, confirmations []protocol.Confirmation, presented string) Decision {
	inLocal := func(fp string) bool {
		for _, l := range local {
			if l == fp {
				return true
			}
		}
		return false
	}
	// confirmed returns the confirmation of P whose replacing satisfies want, if any.
	confirmed := func(want func(replacing string) bool) (protocol.Confirmation, bool) {
		for _, c := range confirmations {
			if c.SHA256 == presented && want(c.Replacing) {
				return c, true
			}
		}
		return protocol.Confirmation{}, false
	}
	switch {
	case len(local) > 0 && inLocal(presented):
		return Decision{Row: 1, Status: "ok"}
	case len(local) > 0:
		if c, ok := confirmed(func(r string) bool { return r != "" && inLocal(r) }); ok {
			return Decision{Row: 2, Status: "ok", Write: "replace", Replacing: c.Replacing}
		}
		return Decision{Row: 3, Status: "failed", Expected: local[0]}
	case server == presented:
		return Decision{Row: 4, Status: "ok", Write: "add"}
	case server != "":
		if _, ok := confirmed(func(r string) bool { return r == server }); ok {
			return Decision{Row: 8, Status: "ok", Write: "add"}
		}
		return Decision{Row: 5, Status: "failed", Expected: server}
	}
	if _, ok := confirmed(func(string) bool { return true }); ok {
		return Decision{Row: 6, Status: "ok", Write: "add"}
	}
	return Decision{Row: 7, Status: "needs_action"}
}

// hostCheck is the HostKeyCallback of one hop: it applies Decide to the presented key, writes the
// connector's record when the decision says so, and remembers the accepted key so that a rekey
// presenting another key is refused.
type hostCheck struct {
	known         *KnownHosts
	host          string
	port          int
	hop           string
	server        string
	confirmations []protocol.Confirmation
	log           func(string)
	// pinned: the connector's record is the only one, and it is never written.
	pinned bool

	mu        sync.Mutex
	accepted  ssh.PublicKey
	presented ssh.PublicKey
	failure   *target.Failure
	data      *protocol.StageData
	decided   chan struct{}
	once      sync.Once
	// local is the connector's record, read before the handshake to restrict the algorithms.
	local []ssh.PublicKey
}

func newHostCheck(known *KnownHosts, h hop, req *protocol.TestConnection, log func(string), pinned bool) (*hostCheck, error) {
	c := &hostCheck{known: known, host: h.host, port: h.port, hop: h.name, log: log, pinned: pinned, decided: make(chan struct{})}
	if pinned {
		local, err := known.Lookup(h.host, h.port)
		if err != nil {
			return nil, err
		}
		c.local = local
		return c, nil
	}
	for _, k := range req.Target.HostKeys {
		if sameEndpoint(k.Host, k.Port, h.host, h.port) {
			c.server = k.SHA256
		}
	}
	for _, cf := range req.Confirmations {
		if sameEndpoint(cf.Host, cf.Port, h.host, h.port) {
			c.confirmations = append(c.confirmations, cf)
		}
	}
	local, err := known.Lookup(h.host, h.port)
	if err != nil {
		return nil, err
	}
	c.local = local
	return c, nil
}

// errHostKey stops a handshake whose host key did not pass.
var errHostKey = errors.New("host key not accepted")

// callback is the ssh.HostKeyCallback.
func (c *hostCheck) callback(_ string, _ net.Addr, key ssh.PublicKey) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.accepted != nil {
		// A rekey: the host must present the key that was accepted for this connection.
		if bytes.Equal(c.accepted.Marshal(), key.Marshal()) {
			return nil
		}
		return fmt.Errorf("the host presented a different key while rekeying")
	}
	defer c.once.Do(func() { close(c.decided) })
	c.presented = key
	p := ssh.FingerprintSHA256(key)
	// The entry of the presented key's type is the one a changed key is compared with.
	var local []string
	for _, k := range c.local {
		if k.Type() == key.Type() {
			local = append([]string{ssh.FingerprintSHA256(k)}, local...)
		} else {
			local = append(local, ssh.FingerprintSHA256(k))
		}
	}
	name := endpointName(c.host, c.port)
	if c.pinned {
		return c.pinnedDecision(key, local, p, name)
	}
	d := Decide(local, c.server, c.confirmations, p)
	switch d.Write {
	case "add":
		if err := c.known.Add(c.host, c.port, key); err != nil {
			c.failure = &target.Failure{Code: protocol.CodeInternal, Detail: "the connector could not record the host key: " + err.Error()}
			return errHostKey
		}
		c.logf("Trusted the host key of %s: %s (%s).", name, p, trustReason(d.Row))
	case "replace":
		if err := c.known.Replace(c.host, c.port, d.Replacing, key); err != nil {
			c.failure = &target.Failure{Code: protocol.CodeInternal, Detail: "the connector could not replace the host key: " + err.Error()}
			return errHostKey
		}
		c.logf("Replaced the host key of %s: %s, previously %s (confirmed in Parallax; the old line is kept as a comment).", name, p, d.Replacing)
	}
	switch d.Status {
	case "ok":
		c.accepted = key
		return nil
	case "needs_action":
		c.failure = &target.Failure{Code: protocol.CodeHostKeyUnknown, NeedsAction: true,
			Detail: fmt.Sprintf("first connection to %s: confirm its key %s", name, p)}
		c.data = &protocol.StageData{Hop: c.hop, Fingerprint: p, Algorithm: key.Type()}
	default:
		c.failure = &target.Failure{Code: protocol.CodeHostKeyChanged,
			Detail: fmt.Sprintf("%s presented %s, but %s is trusted; the connection was stopped", name, p, d.Expected)}
		c.data = &protocol.StageData{Hop: c.hop, Expected: d.Expected, Presented: p}
		c.logf("Refused %s: it presented the host key %s, but %s is trusted.", name, p, d.Expected)
	}
	return errHostKey
}

// pinnedDecision is a managed connector's host identity (design §12): the key must be one the
// operator pinned. There is no trust on first use and no replacement, and nothing is written.
func (c *hostCheck) pinnedDecision(key ssh.PublicKey, local []string, p, name string) error {
	for _, l := range local {
		if l == p {
			c.accepted = key
			return nil
		}
	}
	if len(local) > 0 {
		c.failure = &target.Failure{Code: protocol.CodeHostKeyChanged,
			Detail: fmt.Sprintf("%s presented %s, but %s is pinned; the connection was stopped", name, p, local[0])}
		c.data = &protocol.StageData{Hop: c.hop, Expected: local[0], Presented: p}
		c.logf("Refused %s: it presented the host key %s, but %s is pinned.", name, p, local[0])
		return errHostKey
	}
	c.failure = &target.Failure{Code: protocol.CodeHostKeyUntrustedManaged,
		Detail: fmt.Sprintf("%s presented %s, which the operator has not pinned for this connector", name, p)}
	c.data = &protocol.StageData{Hop: c.hop, Fingerprint: p, Algorithm: key.Type()}
	c.logf("Refused %s: its host key %s is not pinned.", name, p)
	return errHostKey
}

func (c *hostCheck) logf(format string, args ...any) {
	if c.log != nil {
		c.log(fmt.Sprintf(format, args...))
	}
}

// result returns the hop's key report: whether it passed, and the failure and data otherwise.
func (c *hostCheck) result() (passed bool, presented ssh.PublicKey, f *target.Failure, data *protocol.StageData) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.accepted != nil, c.presented, c.failure, c.data
}

func trustReason(row int) string {
	switch row {
	case 4:
		return "Parallax already trusted it"
	case 8:
		return "replacing the key Parallax remembered, as confirmed in Parallax"
	}
	return "confirmed in Parallax"
}
