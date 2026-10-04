package protocol

import (
	"fmt"
	"net/netip"
	"regexp"
	"strings"
)

// TargetError is a target, runtime or confirmation that passes the schema but breaks one of the
// semantic rules of design §4.4. The connector answers it with `error invalid_target`.
type TargetError struct {
	Rule   int
	Field  string
	Reason string
}

func (e *TargetError) Error() string {
	return fmt.Sprintf("%s: %s (rule %d)", e.Field, e.Reason, e.Rule)
}

// ValidateRequest applies ValidateTarget to the requests that carry a target (test_connection
// and open_session); other messages pass.
func ValidateRequest(m Message) error {
	switch m := m.(type) {
	case *TestConnection:
		return ValidateTarget(m.Target, m.Runtime, m.Confirmations)
	case *OpenSession:
		return ValidateTarget(m.Target, m.Runtime, nil)
	}
	return nil
}

// ValidateTarget returns the first rule of design §4.4 that a request breaks, as a *TargetError.
func ValidateTarget(t Target, rt Runtime, confirmations []Confirmation) error {
	if v := TargetViolations(t, rt, confirmations); len(v) > 0 {
		return v[0]
	}
	return nil
}

// TargetViolations returns every rule of design §4.4 that a request breaks, in rule order.
func TargetViolations(t Target, rt Runtime, confirmations []Confirmation) []*TargetError {
	var out []*TargetError
	add := func(rule int, field, format string, args ...any) {
		out = append(out, &TargetError{Rule: rule, Field: field, Reason: fmt.Sprintf(format, args...)})
	}
	ssh := t.Kind == TargetSSH

	// Rules 1 and 2: host syntax, then forbidden literal addresses, for the target and the jump.
	if ssh {
		hosts := [][2]string{{"target.host", t.Host}}
		if t.Jump != nil {
			hosts = append(hosts, [2]string{"target.jump.host", t.Jump.Host})
		}
		for _, h := range hosts {
			if err := CheckHostSyntax(h[1]); err != nil {
				add(1, h[0], "%v", err)
			}
		}
		for _, h := range hosts {
			if addr, ok := hostLiteral(h[1]); ok {
				if why := forbiddenLiteral(addr); why != "" {
					add(2, h[0], "%s is %s", h[1], why)
				}
			}
		}
	}

	// Rule 3: the workspace is absolute and has no `..` segment.
	if t.Kind == TargetLocal || ssh {
		if !isAbsolute(t.Workspace, t.Kind == TargetLocal) {
			add(3, "target.workspace", "must be an absolute path")
		} else if hasDotDot(t.Workspace) {
			add(3, "target.workspace", "must not contain a .. segment")
		}
	}

	// Rule 4: key paths are absolute or under ~/, without `..`.
	if ssh {
		auths := [][2]any{{"target.auth", t.Auth}}
		if t.Jump != nil {
			auths = append(auths, [2]any{"target.jump.auth", t.Jump.Auth})
		}
		for _, a := range auths {
			ref, _ := a[1].(*AuthRef)
			if ref == nil || ref.Method != AuthKey {
				continue
			}
			field := a[0].(string) + ".keyPath"
			if !isAbsolute(ref.KeyPath, true) && !strings.HasPrefix(ref.KeyPath, "~/") {
				add(4, field, "must be absolute or start with ~/")
			} else if hasDotDot(ref.KeyPath) {
				add(4, field, "must not contain a .. segment")
			}
		}
	}

	// Rule 5: the interpreter path, and `login` for ssh only.
	if rt.Mode == RuntimeStart {
		if rt.Python != "" {
			if !isAbsolute(rt.Python, t.Kind == TargetLocal) && !strings.HasPrefix(rt.Python, "~/") {
				add(5, "runtime.python", "must be absolute or start with ~/")
			} else if hasDotDot(rt.Python) {
				add(5, "runtime.python", "must not contain a .. segment")
			}
		}
		if rt.Login != nil && !ssh {
			add(5, "runtime.login", "applies to ssh targets only")
		}
	}

	targetKey := endpoint(t.Host, t.Port)
	jumpKey := ""
	if t.Jump != nil {
		jumpKey = endpoint(t.Jump.Host, t.Jump.Port)
	}
	names := func(host string, port int) bool {
		k := endpoint(host, port)
		return ssh && (k == targetKey || (jumpKey != "" && k == jumpKey))
	}

	// Rule 6: at most one trusted key per host:port, each for the target or the jump host.
	seen := map[string]bool{}
	for _, k := range t.HostKeys {
		key := endpoint(k.Host, k.Port)
		if seen[key] {
			add(6, "target.hostKeys", "lists %s twice", key)
		}
		seen[key] = true
		if !names(k.Host, k.Port) {
			add(6, "target.hostKeys", "%s is neither the target nor the jump host", key)
		}
	}

	// Rule 7: a confirmation names the target or the jump host and replaces another key.
	for _, c := range confirmations {
		if !names(c.Host, c.Port) {
			add(7, "confirmations", "%s is neither the target nor the jump host", endpoint(c.Host, c.Port))
		}
		if c.Replacing != "" && c.Replacing == c.SHA256 {
			add(7, "confirmations", "replacing names the confirmed key itself")
		}
	}

	// Rule 8: the jump host is not the target.
	if ssh && jumpKey != "" && jumpKey == targetKey {
		add(8, "target.jump", "the jump host is the target")
	}
	return out
}

var hexPrefix = regexp.MustCompile(`^0[xX]`)

// CheckHostSyntax applies rule 1 of design §4.4: a host without `:` is a dotted-quad IPv4
// address (four decimal octets, no leading zeros) or a DNS name whose labels are 1–63 characters
// of letters, digits and hyphens, not starting or ending with a hyphen, and whose last label is
// neither all digits nor hexadecimal-prefixed; a host with `:` is an IPv6 literal without a zone.
// This closes the decimal, hex, octal and short forms a system resolver may still accept.
func CheckHostSyntax(host string) error {
	if strings.Contains(host, ":") {
		a, err := netip.ParseAddr(host)
		if err != nil || !a.Is6() || a.Zone() != "" {
			return fmt.Errorf("%q is not an IPv6 address", host)
		}
		return nil
	}
	if _, ok := dottedQuad(host); ok {
		return nil
	}
	labels := strings.Split(host, ".")
	for _, l := range labels {
		if len(l) < 1 || len(l) > 63 {
			return fmt.Errorf("%q has an empty or over-long label", host)
		}
		for _, r := range l {
			if !(r == '-' || r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
				return fmt.Errorf("%q has a character a host name cannot have", host)
			}
		}
		if l[0] == '-' || l[len(l)-1] == '-' {
			return fmt.Errorf("%q has a label starting or ending with -", host)
		}
	}
	last := labels[len(labels)-1]
	if strings.Trim(last, "0123456789") == "" || hexPrefix.MatchString(last) {
		return fmt.Errorf("%q is a numeric address in a form other than four decimal octets", host)
	}
	return nil
}

// dottedQuad parses four decimal octets without leading zeros.
func dottedQuad(s string) (netip.Addr, bool) {
	parts := strings.Split(s, ".")
	if len(parts) != 4 {
		return netip.Addr{}, false
	}
	var b [4]byte
	for i, p := range parts {
		if len(p) < 1 || len(p) > 3 || (len(p) > 1 && p[0] == '0') || strings.Trim(p, "0123456789") != "" {
			return netip.Addr{}, false
		}
		n := 0
		for _, r := range p {
			n = n*10 + int(r-'0')
		}
		if n > 255 {
			return netip.Addr{}, false
		}
		b[i] = byte(n)
	}
	return netip.AddrFrom4(b), true
}

// hostLiteral returns the address a host names literally, if it is an address.
func hostLiteral(host string) (netip.Addr, bool) {
	if strings.Contains(host, ":") {
		a, err := netip.ParseAddr(host)
		return a, err == nil && a.Zone() == ""
	}
	return dottedQuad(host)
}

var (
	nat64  = netip.MustParsePrefix("64:ff9b::/96")
	sixTo4 = netip.MustParsePrefix("2002::/16")
)

// Unwrap returns the IPv4 address embedded in an IPv4-mapped (::ffff:a.b.c.d), NAT64
// (64:ff9b::/96) or 6to4 (2002::/16) address, and any other address unchanged.
func Unwrap(a netip.Addr) netip.Addr {
	switch {
	case a.Is4In6():
		return a.Unmap()
	case nat64.Contains(a):
		b := a.As16()
		return netip.AddrFrom4([4]byte(b[12:16]))
	case sixTo4.Contains(a):
		b := a.As16()
		return netip.AddrFrom4([4]byte(b[2:6]))
	}
	return a
}

var broadcast = netip.AddrFrom4([4]byte{255, 255, 255, 255})

// forbiddenLiteral applies rule 2: never unspecified, multicast, broadcast or link-local, for the
// address as written or the IPv4 address it wraps.
func forbiddenLiteral(a netip.Addr) string {
	for _, x := range []netip.Addr{a, Unwrap(a)} {
		switch {
		case x.IsUnspecified():
			return "an unspecified address"
		case x.IsMulticast():
			return "a multicast address"
		case x == broadcast:
			return "the broadcast address"
		case x.IsLinkLocalUnicast():
			return "a link-local address"
		}
	}
	return ""
}

// endpoint is a comparable host:port: names in lower case, addresses in canonical form.
func endpoint(host string, port int) string {
	h := strings.ToLower(host)
	if a, ok := hostLiteral(host); ok {
		h = a.Unmap().String()
	}
	if strings.Contains(h, ":") {
		h = "[" + h + "]"
	}
	return fmt.Sprintf("%s:%d", h, port)
}

var driveRoot = regexp.MustCompile(`^[A-Za-z]:[\\/]`)

// isAbsolute reports whether p starts with / or, when drives are allowed, with X:\ or X:/.
func isAbsolute(p string, drives bool) bool {
	return strings.HasPrefix(p, "/") || drives && driveRoot.MatchString(p)
}

// hasDotDot reports whether any /- or \-separated segment of p is `..`.
func hasDotDot(p string) bool {
	for _, seg := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if seg == ".." {
			return true
		}
	}
	return false
}
