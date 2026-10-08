package netscope

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"strings"
	"testing"
	"time"

	"parallax/connector/internal/protocol"
)

// fakeResolver answers names from a table.
type fakeResolver map[string][]string

func (f fakeResolver) LookupNetIP(_ context.Context, _, host string) ([]netip.Addr, error) {
	answers, ok := f[host]
	if !ok {
		return nil, &net.DNSError{Err: "no such host", Name: host, IsNotFound: true}
	}
	out := make([]netip.Addr, len(answers))
	for i, a := range answers {
		out[i] = netip.MustParseAddr(a)
	}
	return out, nil
}

func scope(t *testing.T, cidrs ...string) Scope {
	t.Helper()
	s, err := ParseScope(cidrs, "")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func codeOf(err error) protocol.Code {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// A33 (forbidden destination, connector half): a user-supplied destination cannot reach cloud
// metadata, unspecified, multicast or broadcast addresses in any spelling, nor loopback or
// private ranges outside the approved scope, nor an internal address hidden among DNS answers.
func TestA33_ForbiddenDestinationsRejected(t *testing.T) {
	resolver := fakeResolver{
		"metadata.example":      {"169.254.169.254"},
		"metadata6.example":     {"fd00:ec2::254", "fe80::a9fe:a9fe"},
		"db.internal.example":   {"10.0.0.5"},
		"rebind.example":        {"93.184.216.34", "10.1.2.3"},
		"rebind-loop.example":   {"93.184.216.34", "127.0.0.1"},
		"rebind-meta.example":   {"169.254.169.254", "93.184.216.34"},
		"localhost":             {"127.0.0.1", "::1"},
		"public.example":        {"93.184.216.34"},
		"mapped-meta.example":   {"::ffff:169.254.169.254"},
		"lan.example":           {"192.168.1.20"},
		"cgnat.example":         {"100.64.0.9"},
		"ula.example":           {"fd12:3456::1"},
		"zero.example":          {"0.0.0.0"},
		"multicast.example":     {"239.1.1.1"},
		"public-and-v6.example": {"93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"},
	}
	const (
		denied  = protocol.CodeNetworkScopeDenied
		invalid = protocol.CodeInvalidTarget
		ok      = protocol.Code("")
	)
	cases := []struct {
		host     string
		allowNet []string
		want     protocol.Code
	}{
		// Cloud metadata and link-local, in every spelling: never reachable.
		{"169.254.169.254", nil, denied},
		{"169.254.169.254", []string{"0.0.0.0/0"}, denied},
		{"169.254.169.254", []string{"169.254.0.0/16"}, denied},
		{"fe80::1", nil, denied},
		{"fe80::a9fe:a9fe", []string{"::/0"}, denied},
		{"::ffff:169.254.169.254", nil, denied},
		{"::ffff:a9fe:a9fe", nil, denied},
		{"64:ff9b::a9fe:a9fe", nil, denied},
		{"2002:a9fe:a9fe::1", nil, denied},
		{"metadata.example", nil, denied},
		{"metadata6.example", []string{"fc00::/7"}, denied},
		{"mapped-meta.example", nil, denied},
		// Numeric forms a system resolver may accept: refused before any lookup.
		{"2852039166", nil, invalid},
		{"0xa9fea9fe", nil, invalid},
		{"0XA9FEA9FE", nil, invalid},
		{"0251.0376.0251.0376", nil, invalid},
		{"169.254.43518", nil, invalid},
		{"127.1", nil, invalid},
		{"0x7f000001", nil, invalid},
		{"017700000001", nil, invalid},
		{"fe80::1%eth0", nil, invalid},
		{"[::1]", nil, invalid},
		// Unspecified, multicast and broadcast: never reachable.
		{"0.0.0.0", nil, denied},
		{"0.1.2.3", []string{"0.0.0.0/8"}, denied},
		{"::", []string{"::/0"}, denied},
		{"224.0.0.1", nil, denied},
		{"239.255.255.250", []string{"239.0.0.0/8"}, denied},
		{"ff02::1", nil, denied},
		{"255.255.255.255", nil, denied},
		{"zero.example", nil, denied},
		{"multicast.example", nil, denied},
		// Loopback: only with --allow-net.
		{"127.0.0.1", nil, denied},
		{"127.10.20.30", nil, denied},
		{"::1", nil, denied},
		{"::ffff:127.0.0.1", nil, denied},
		{"64:ff9b::7f00:1", nil, denied},
		{"2002:7f00:1::", nil, denied},
		{"localhost", nil, denied},
		{"127.0.0.1", []string{"127.0.0.0/8"}, ok},
		{"::ffff:127.0.0.1", []string{"127.0.0.0/8"}, ok},
		{"::1", []string{"::1/128"}, ok},
		{"localhost", []string{"127.0.0.0/8"}, denied}, // ::1 is not covered
		// Private and shared ranges: only with --allow-net covering them.
		{"10.0.0.5", nil, denied},
		{"172.16.0.1", nil, denied},
		{"172.31.255.254", nil, denied},
		{"192.168.1.1", nil, denied},
		{"100.64.0.1", nil, denied},
		{"fd00::1", nil, denied},
		{"fc00::1", nil, denied},
		{"::ffff:10.0.0.5", nil, denied},
		{"64:ff9b::a00:5", nil, denied},
		{"2002:a00:5::", nil, denied},
		{"db.internal.example", nil, denied},
		{"lan.example", nil, denied},
		{"cgnat.example", nil, denied},
		{"ula.example", nil, denied},
		{"10.0.0.5", []string{"10.0.0.0/8"}, ok},
		{"10.0.0.5", []string{"10.1.0.0/16"}, denied},
		{"192.168.1.1", []string{"192.168.1.0/24"}, ok},
		{"::ffff:10.0.0.5", []string{"10.0.0.0/8"}, ok},
		{"db.internal.example", []string{"10.0.0.0/8"}, ok},
		{"ula.example", []string{"fd00::/8"}, ok},
		// Mixed answers: one denied answer refuses the name.
		{"rebind.example", nil, denied},
		{"rebind-loop.example", nil, denied},
		{"rebind-meta.example", []string{"0.0.0.0/0"}, denied},
		{"rebind.example", []string{"10.0.0.0/8"}, ok},
		// Global unicast: allowed.
		{"93.184.216.34", nil, ok},
		{"2606:2800:220:1:248:1893:25c8:1946", nil, ok},
		{"public.example", nil, ok},
		{"public-and-v6.example", nil, ok},
		{"172.32.0.1", nil, ok},
		{"100.128.0.1", nil, ok},
		// Unknown names do not resolve.
		{"nowhere.example", nil, protocol.CodeHostUnresolved},
	}
	if len(cases) < 40 {
		t.Fatalf("the table needs at least 40 addresses, has %d", len(cases))
	}
	for _, c := range cases {
		name := c.host
		if len(c.allowNet) > 0 {
			name += " allow " + strings.Join(c.allowNet, ",")
		}
		t.Run(name, func(t *testing.T) {
			d := &Dialer{Scope: scope(t, c.allowNet...), Resolver: resolver}
			_, err := d.Resolve(context.Background(), c.host)
			if got := codeOf(err); got != c.want {
				t.Fatalf("Resolve(%q) = %v (code %q), want code %q", c.host, err, got, c.want)
			}
			if c.want == ok {
				return
			}
			// The dial refuses the same way, and connects nowhere.
			_, err = d.DialContext(context.Background(), c.host, 22)
			if got := codeOf(err); got != c.want {
				t.Fatalf("DialContext(%q) code %q, want %q", c.host, got, c.want)
			}
		})
	}
}

func TestAddressClassification(t *testing.T) {
	cases := []struct {
		addr string
		want Class
	}{
		{"0.0.0.0", HardDenied},
		{"0.255.255.255", HardDenied},
		{"::", HardDenied},
		{"224.0.0.0", HardDenied},
		{"239.255.255.255", HardDenied},
		{"ff00::", HardDenied},
		{"ff0e::1", HardDenied},
		{"255.255.255.255", HardDenied},
		{"169.254.0.0", HardDenied},
		{"169.254.255.255", HardDenied},
		{"fe80::", HardDenied},
		{"febf:ffff::1", HardDenied},
		{"::ffff:169.254.169.254", HardDenied},
		{"64:ff9b::a9fe:a9fe", HardDenied},
		{"2002:a9fe:a9fe::", HardDenied},
		{"::ffff:0.0.0.0", HardDenied},
		{"2002:e000:1::", HardDenied},
		{"127.0.0.1", Loopback},
		{"127.255.255.254", Loopback},
		{"::1", Loopback},
		{"::ffff:127.0.0.1", Loopback},
		{"64:ff9b::7f00:1", Loopback},
		{"2002:7f00:1::", Loopback},
		{"10.0.0.0", Private},
		{"10.255.255.255", Private},
		{"172.16.0.0", Private},
		{"172.31.255.255", Private},
		{"192.168.0.0", Private},
		{"192.168.255.255", Private},
		{"100.64.0.0", Private},
		{"100.127.255.255", Private},
		{"fc00::", Private},
		{"fdff:ffff::1", Private},
		{"::ffff:192.168.1.1", Private},
		{"2002:c0a8:101::", Private},
		{"1.1.1.1", Global},
		{"9.255.255.255", Global},
		{"11.0.0.0", Global},
		{"172.15.255.255", Global},
		{"172.32.0.0", Global},
		{"192.167.255.255", Global},
		{"100.63.255.255", Global},
		{"100.128.0.0", Global},
		{"2001:4860:4860::8888", Global},
		{"fec0::1", Global},
		{"2002:808:808::", Global},
	}
	for _, c := range cases {
		if got := Classify(netip.MustParseAddr(c.addr)); got != c.want {
			t.Errorf("Classify(%s) = %s, want %s", c.addr, got, c.want)
		}
	}
}

func TestParseScopeFromFlagsAndEnvironment(t *testing.T) {
	s, err := ParseScope([]string{"10.20.30.40/16", " fd00::1/8"}, "192.168.1.0/24, 10.20.0.0/16,,")
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(s.CIDRs(), " "); got != "10.20.0.0/16 fd00::/8 192.168.1.0/24" {
		t.Errorf("CIDRs = %q", got)
	}
	for _, bad := range []string{"10.0.0.1", "10.0.0.0/33", "fe80::/10%eth0", "example.com/8"} {
		if _, err := ParseScope([]string{bad}, ""); err == nil {
			t.Errorf("ParseScope(%q) accepted", bad)
		}
	}
	if _, err := ParseScope(nil, "bogus"); err == nil {
		t.Error("PARALLAX_ALLOW_NET=bogus accepted")
	}
	many := make([]string, MaxRanges+1)
	for i := range many {
		many[i] = netip.PrefixFrom(netip.AddrFrom4([4]byte{10, byte(i), 0, 0}), 16).String()
	}
	if _, err := ParseScope(many, ""); err == nil {
		t.Error("more than MaxRanges ranges accepted")
	}
}

func TestDialRechecksConnectedAddress(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	accepted := make(chan struct{}, 8)
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			accepted <- struct{}{}
			c.Close()
		}
	}()
	port := ln.Addr().(*net.TCPAddr).Port

	// A resolver answering an allowed and a denied address refuses the name, even though the
	// denied one is not the first.
	d := &Dialer{Scope: scope(t, "127.0.0.0/8"), Resolver: fakeResolver{
		"mixed.example":  {"127.0.0.1", "169.254.169.254"},
		"mixed2.example": {"127.0.0.1", "10.0.0.1"},
		"good.example":   {"127.0.0.1"},
	}}
	for _, name := range []string{"mixed.example", "mixed2.example"} {
		if _, err := d.DialContext(context.Background(), name, port); codeOf(err) != protocol.CodeNetworkScopeDenied {
			t.Errorf("%s: %v, want network_scope_denied", name, err)
		}
	}
	// The allowed name connects, by IP.
	conn, err := d.DialContext(context.Background(), "good.example", port)
	if err != nil {
		t.Fatalf("good.example: %v", err)
	}
	if got := conn.RemoteAddr().String(); got != ln.Addr().String() {
		t.Errorf("connected to %s, want %s", got, ln.Addr())
	}
	conn.Close()
	<-accepted

	// The Control hook refuses an address the scope does not cover even when the earlier
	// checks are bypassed (a race between check and connect), and no connection is made.
	strict := &Dialer{Scope: scope(t)}
	_, err = strict.dialAddr(context.Background(), netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), uint16(port)))
	if codeOf(err) != protocol.CodeNetworkScopeDenied {
		t.Fatalf("dialAddr outside the scope: %v, want network_scope_denied", err)
	}
	if err := strict.control(false)("tcp4", "169.254.169.254:80", nil); codeOf(err) != protocol.CodeNetworkScopeDenied {
		t.Errorf("control(169.254.169.254) = %v", err)
	}
	if err := strict.control(false)("tcp6", "[::ffff:10.0.0.1]:22", nil); codeOf(err) != protocol.CodeNetworkScopeDenied {
		t.Errorf("control(::ffff:10.0.0.1) = %v", err)
	}
	if err := strict.control(false)("tcp4", "93.184.216.34:22", nil); err != nil {
		t.Errorf("control(global) = %v", err)
	}
	select {
	case <-accepted:
		t.Error("a refused dial reached the listener")
	case <-time.After(100 * time.Millisecond):
	}
}

func TestDialReportsRefusedConnection(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	d := &Dialer{Scope: scope(t, "127.0.0.0/8")}
	if _, err := d.DialContext(context.Background(), "127.0.0.1", port); codeOf(err) != protocol.CodeConnectionRefused {
		t.Errorf("closed port: %v, want connection_refused", err)
	}
	if _, err := d.DialContext(context.Background(), "127.0.0.1", 0); codeOf(err) != protocol.CodeInvalidTarget {
		t.Errorf("port 0: %v, want invalid_target", err)
	}
}
