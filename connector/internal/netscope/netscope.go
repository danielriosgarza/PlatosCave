// Package netscope is the connector's network scope (docs/design/connector.md §8): the class of
// every address it may dial, the private ranges a person allowed with --allow-net or
// PARALLAX_ALLOW_NET, and a dialer that resolves a name once, requires every answer to be
// allowed, dials the first by IP and checks the address actually being connected again.
package netscope

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"
	"syscall"
	"time"

	"parallax/connector/internal/protocol"
)

// Class is the network class of an address (design §8).
type Class int

// Classes, from never allowed to allowed by default.
const (
	// HardDenied is unspecified, multicast, broadcast or link-local: never allowable.
	HardDenied Class = iota
	// Loopback is 127.0.0.0/8 and ::1: allowed only where --allow-net covers it.
	Loopback
	// Private is a private or shared range: allowed only where --allow-net covers it.
	Private
	// Global is every other unicast address: allowed for a personal connector.
	Global
)

func (c Class) String() string {
	switch c {
	case HardDenied:
		return "hard-denied"
	case Loopback:
		return "loopback"
	case Private:
		return "private"
	}
	return "global"
}

var (
	hardDenied = prefixes("0.0.0.0/8", "224.0.0.0/4", "255.255.255.255/32", "169.254.0.0/16",
		"::/128", "ff00::/8", "fe80::/10")
	loopback = prefixes("127.0.0.0/8", "::1/128")
	private  = prefixes("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7")
)

func prefixes(s ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(s))
	for i, p := range s {
		out[i] = netip.MustParsePrefix(p)
	}
	return out
}

func within(a netip.Addr, ps []netip.Prefix) bool {
	for _, p := range ps {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// Classify returns the class of an address, after unwrapping the IPv4 address embedded in an
// IPv4-mapped, NAT64 or 6to4 address. An address is hard-denied if either form is.
func Classify(a netip.Addr) Class {
	a = a.WithZone("")
	u := protocol.Unwrap(a)
	switch {
	case within(a, hardDenied) || within(u, hardDenied):
		return HardDenied
	case within(u, loopback):
		return Loopback
	case within(u, private):
		return Private
	}
	return Global
}

// EnvAllowNet is the environment variable that adds ranges to the scope, comma-separated.
const EnvAllowNet = "PARALLAX_ALLOW_NET"

// MaxRanges is the number of ranges hello.networkScope can carry.
const MaxRanges = 64

// Scope is what this connector may dial: global unicast, plus the loopback and private ranges
// the person allowed. Hard-denied addresses are never allowed, whatever the ranges say. A managed
// scope (ParseManagedScope) starts empty instead: only its ranges, names and ports are reachable,
// and loopback never is.
type Scope struct {
	ranges []netip.Prefix
	// managed scopes only
	managed bool
	hosts   []string
	ports   map[int]bool
}

// ParseScope builds a scope from --allow-net values and the value of PARALLAX_ALLOW_NET.
func ParseScope(flags []string, env string) (Scope, error) {
	var s Scope
	all := append([]string{}, flags...)
	for _, v := range strings.Split(env, ",") {
		if v = strings.TrimSpace(v); v != "" {
			all = append(all, v)
		}
	}
	seen := map[netip.Prefix]bool{}
	for _, v := range all {
		p, err := netip.ParsePrefix(strings.TrimSpace(v))
		if err != nil || p.Addr().Zone() != "" {
			return Scope{}, fmt.Errorf("%q is not a CIDR range such as 10.0.0.0/8", v)
		}
		p = p.Masked()
		if seen[p] {
			continue
		}
		seen[p] = true
		s.ranges = append(s.ranges, p)
	}
	if len(s.ranges) > MaxRanges {
		return Scope{}, fmt.Errorf("at most %d ranges may be allowed", MaxRanges)
	}
	return s, nil
}

// Environment variables of a managed connector's scope (design §12).
const (
	EnvAllowHosts = "PARALLAX_ALLOW_HOSTS"
	EnvAllowPorts = "PARALLAX_ALLOW_PORTS"
)

// neverManaged are the ranges a managed scope may not overlap: loopback and the hard-denied
// classes (link-local among them), in their own and in every wrapped IPv6 form.
var neverManaged = func() []netip.Prefix {
	var out []netip.Prefix
	for _, p := range append(append([]netip.Prefix{}, loopback...), hardDenied...) {
		out = append(out, p)
		if !p.Addr().Is4() {
			continue
		}
		v4 := p.Addr().As4()
		for _, w := range []struct {
			prefix [16]byte
			at     int
			bits   int
		}{
			{[16]byte{10: 0xff, 11: 0xff}, 12, 96},                 // ::ffff:a.b.c.d
			{[16]byte{0: 0x00, 1: 0x64, 2: 0xff, 3: 0x9b}, 12, 96}, // 64:ff9b::a.b.c.d
			{[16]byte{0: 0x20, 1: 0x02}, 2, 16},                    // 2002:aabb:ccdd::
		} {
			b := w.prefix
			copy(b[w.at:], v4[:])
			out = append(out, netip.PrefixFrom(netip.AddrFrom16(b), w.bits+p.Bits()).Masked())
		}
	}
	return out
}()

// ParseManagedScope builds a managed connector's scope from PARALLAX_ALLOW_NET (comma-separated
// ranges), PARALLAX_ALLOW_HOSTS (comma-separated names, or *.suffix patterns) and
// PARALLAX_ALLOW_PORTS (comma-separated ports, default 22). Nothing else is reachable, and a range
// that would reach loopback or a link-local or other hard-denied address is refused here.
func ParseManagedScope(nets, hosts, ports string) (Scope, error) {
	s, err := ParseScope(nil, nets)
	if err != nil {
		return Scope{}, fmt.Errorf("%s: %v", EnvAllowNet, err)
	}
	for _, p := range s.ranges {
		for _, n := range neverManaged {
			if p.Overlaps(n) {
				return Scope{}, fmt.Errorf("%s: %s reaches %s, which is loopback, link-local or otherwise never reachable by a managed connector",
					EnvAllowNet, p, n)
			}
		}
	}
	s.managed = true
	seen := map[string]bool{}
	for _, h := range strings.Split(hosts, ",") {
		h = strings.ToLower(strings.TrimSpace(h))
		if h == "" || seen[h] {
			continue
		}
		name := strings.TrimPrefix(h, "*.")
		if err := protocol.CheckHostSyntax(name); err != nil || strings.Contains(name, ":") || isDottedQuad(name) {
			return Scope{}, fmt.Errorf("%s: %q is not a host name or a *.domain pattern (put addresses in %s)", EnvAllowHosts, h, EnvAllowNet)
		}
		seen[h] = true
		s.hosts = append(s.hosts, h)
	}
	if len(s.hosts) > MaxRanges {
		return Scope{}, fmt.Errorf("%s: at most %d names may be allowed", EnvAllowHosts, MaxRanges)
	}
	if strings.TrimSpace(ports) == "" {
		ports = "22"
	}
	s.ports = map[int]bool{}
	for _, v := range strings.Split(ports, ",") {
		v = strings.TrimSpace(v)
		if v == "" {
			continue
		}
		p, err := strconv.Atoi(v)
		if err != nil || p < 1 || p > 65535 || strconv.Itoa(p) != v {
			return Scope{}, fmt.Errorf("%s: %q is not a port between 1 and 65535", EnvAllowPorts, v)
		}
		s.ports[p] = true
	}
	if len(s.ports) == 0 {
		return Scope{}, fmt.Errorf("%s names no port", EnvAllowPorts)
	}
	return s, nil
}

func isDottedQuad(h string) bool {
	a, err := netip.ParseAddr(h)
	return err == nil && a.Is4()
}

// Managed reports whether this is a managed connector's scope.
func (s Scope) Managed() bool { return s.managed }

// Hosts returns the allowed names and patterns, for hello.networkScope.
func (s Scope) Hosts() []string { return append([]string{}, s.hosts...) }

// AllowsName reports whether a managed scope names host in PARALLAX_ALLOW_HOSTS, exactly or by a
// *.suffix pattern (which covers names below the suffix, not the suffix itself). A personal
// scope names nothing: it judges addresses only.
func (s Scope) AllowsName(host string) bool {
	host = strings.ToLower(host)
	for _, h := range s.hosts {
		if suffix, ok := strings.CutPrefix(h, "*."); ok {
			if strings.HasSuffix(host, "."+suffix) {
				return true
			}
		} else if host == h {
			return true
		}
	}
	return false
}

// AllowsOnward reports whether a jump host may be asked to reach host, the next hop it dials on
// the connector's behalf (design §8, step 4). The connector classifies a literal itself; a name it
// cannot resolve, so a personal connector relies on the jump host's own policy and a managed one
// requires the name in PARALLAX_ALLOW_HOSTS.
func (s Scope) AllowsOnward(host string) (bool, string) {
	if a, err := netip.ParseAddr(host); err == nil {
		return s.Allows(a)
	}
	if !s.managed || s.AllowsName(host) {
		return true, ""
	}
	return false, fmt.Sprintf("%s is not named in %s", host, EnvAllowHosts)
}

// AllowsPort reports whether the scope lets the connector dial port: any port for a personal
// connector, only PARALLAX_ALLOW_PORTS for a managed one.
func (s Scope) AllowsPort(port int) bool {
	if port < 1 || port > 65535 {
		return false
	}
	return !s.managed || s.ports[port]
}

// allowsResolved judges an answer for a name: a managed scope also reaches the global unicast
// addresses of a name it allows.
func (s Scope) allowsResolved(named bool, a netip.Addr) (bool, string) {
	ok, why := s.Allows(a)
	if !ok && named && Classify(a) == Global {
		return true, ""
	}
	return ok, why
}

// CIDRs returns the allowed ranges in canonical form, for hello.networkScope.
func (s Scope) CIDRs() []string {
	out := make([]string, len(s.ranges))
	for i, p := range s.ranges {
		out[i] = p.String()
	}
	return out
}

// Allows reports whether the scope lets the connector dial a, and if not, why.
func (s Scope) Allows(a netip.Addr) (bool, string) {
	a = a.WithZone("")
	switch c := Classify(a); {
	case c == HardDenied:
		return false, "is never reachable (unspecified, multicast, broadcast or link-local)"
	case c == Loopback && s.managed:
		return false, "is a loopback address, which a managed connector never reaches"
	case c == Global && !s.managed:
		return true, ""
	default:
		// A wrapped address is judged by the IPv4 address it carries.
		u := protocol.Unwrap(a)
		for _, p := range s.ranges {
			if p.Contains(u) {
				return true, ""
			}
		}
		return false, fmt.Sprintf("is a %s address outside the approved network scope", Classify(a))
	}
}

// Error is a dial refused or failed with a catalogue code.
type Error struct {
	Code   protocol.Code
	Detail string
	Err    error
}

func (e *Error) Error() string { return e.Detail }

func (e *Error) Unwrap() error { return e.Err }

// Resolver looks up a name; *net.Resolver is one.
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// Dialer dials TCP addresses inside a scope.
type Dialer struct {
	Scope    Scope
	Resolver Resolver
	// Timeout bounds one connect; zero means 10 seconds (design §5.1, reachability).
	Timeout time.Duration
}

// Resolve applies steps 1–2 of design §8 to a host: its syntax (rule 1 of §4.4), then a literal
// is classified, or a name is resolved once and every answer must be allowed. It returns the
// allowed addresses in the resolver's order.
func (d *Dialer) Resolve(ctx context.Context, host string) ([]netip.Addr, error) {
	if err := protocol.CheckHostSyntax(host); err != nil {
		return nil, &Error{Code: protocol.CodeInvalidTarget, Detail: err.Error(), Err: err}
	}
	if a, err := netip.ParseAddr(host); err == nil {
		if ok, why := d.Scope.Allows(a); !ok {
			return nil, &Error{Code: protocol.CodeNetworkScopeDenied, Detail: fmt.Sprintf("%s %s", a, why)}
		}
		return []netip.Addr{a}, nil
	}
	r := d.Resolver
	if r == nil {
		r = net.DefaultResolver
	}
	addrs, err := r.LookupNetIP(ctx, "ip", host)
	if err != nil || len(addrs) == 0 {
		if err == nil {
			err = errors.New("no addresses")
		}
		return nil, &Error{Code: protocol.CodeHostUnresolved, Detail: fmt.Sprintf("%s did not resolve", host), Err: err}
	}
	named := d.Scope.AllowsName(host)
	for _, a := range addrs {
		// One denied answer refuses the name: mixing allowed and denied answers is how a
		// rebinding attack would reach an internal address.
		if ok, why := d.Scope.allowsResolved(named, a); !ok {
			return nil, &Error{Code: protocol.CodeNetworkScopeDenied,
				Detail: fmt.Sprintf("%s resolves to %s, which %s", host, a.WithZone(""), why)}
		}
	}
	return addrs, nil
}

// DialContext resolves host (once), checks every answer and connects to the first by IP. The
// connect itself is checked again in the socket's Control hook. Errors are *Error with the
// catalogue code of the reachability stage.
func (d *Dialer) DialContext(ctx context.Context, host string, port int) (net.Conn, error) {
	if port < 1 || port > 65535 {
		return nil, &Error{Code: protocol.CodeInvalidTarget, Detail: fmt.Sprintf("port %d is outside 1–65535", port)}
	}
	if !d.Scope.AllowsPort(port) {
		return nil, &Error{Code: protocol.CodeNetworkScopeDenied, Detail: fmt.Sprintf("port %d is not in %s", port, EnvAllowPorts)}
	}
	addrs, err := d.Resolve(ctx, host)
	if err != nil {
		return nil, err
	}
	// A name a managed scope allows reaches its global unicast answers; a literal is judged alone.
	_, notLiteral := netip.ParseAddr(host)
	named := notLiteral != nil && d.Scope.AllowsName(host)
	return d.dial(ctx, netip.AddrPortFrom(addrs[0].WithZone(""), uint16(port)), named)
}

// dialAddr connects to one address, judged by the scope alone.
func (d *Dialer) dialAddr(ctx context.Context, ap netip.AddrPort) (net.Conn, error) {
	return d.dial(ctx, ap, false)
}

// dial connects to one address. The Control hook classifies the address the socket is actually
// connecting to, so nothing between the check and the connect can redirect it.
func (d *Dialer) dial(ctx context.Context, ap netip.AddrPort, named bool) (net.Conn, error) {
	timeout := d.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	nd := &net.Dialer{Timeout: timeout, Control: d.control(named)}
	conn, err := nd.DialContext(ctx, "tcp", ap.String())
	if err == nil {
		return conn, nil
	}
	var se *Error
	switch {
	case errors.As(err, &se):
		return nil, se
	case errors.Is(err, syscall.ECONNREFUSED):
		return nil, &Error{Code: protocol.CodeConnectionRefused, Detail: fmt.Sprintf("%s refused the connection", ap), Err: err}
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() || errors.Is(err, context.DeadlineExceeded) {
		return nil, &Error{Code: protocol.CodeConnectionTimeout, Detail: fmt.Sprintf("%s did not answer in time", ap), Err: err}
	}
	return nil, &Error{Code: protocol.CodeConnectionRefused, Detail: fmt.Sprintf("could not connect to %s", ap), Err: err}
}

// control returns the net.Dialer.Control hook of a dial: it runs after the socket is created
// and before it connects. named is true when the dial answers a name the managed scope allows.
func (d *Dialer) control(named bool) func(network, address string, _ syscall.RawConn) error {
	return func(network, address string, _ syscall.RawConn) error { return d.check(named, network, address) }
}

// check judges the address a socket is connecting to; named is true when it answers a name the
// managed scope allows.
func (d *Dialer) check(named bool, network, address string) error {
	host, portStr, err := net.SplitHostPort(address)
	if err != nil {
		return &Error{Code: protocol.CodeNetworkScopeDenied, Detail: "unparseable destination", Err: err}
	}
	a, err := netip.ParseAddr(host)
	if err != nil {
		return &Error{Code: protocol.CodeNetworkScopeDenied, Detail: "the destination is not an address", Err: err}
	}
	if ok, why := d.Scope.allowsResolved(named, a); !ok {
		return &Error{Code: protocol.CodeNetworkScopeDenied, Detail: fmt.Sprintf("%s %s", a.WithZone(""), why)}
	}
	if p, err := strconv.Atoi(portStr); err != nil || !d.Scope.AllowsPort(p) {
		return &Error{Code: protocol.CodeNetworkScopeDenied, Detail: "the destination port is invalid"}
	}
	return nil
}
