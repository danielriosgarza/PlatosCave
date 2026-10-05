package cause

import (
	"net/netip"
	"testing"
	"time"
)

var t0 = time.Date(2026, 10, 3, 9, 30, 0, 0, time.UTC)

var (
	wifi    = Interface{Name: "wlan0", Addrs: []string{"192.168.1.20/24"}}
	wifiNew = Interface{Name: "wlan0", Addrs: []string{"192.168.7.31/24"}}
	vpnIf   = Interface{Name: "wg0", Addrs: []string{"10.8.0.2/32"}}
	ethIf   = Interface{Name: "eth0", Addrs: []string{"172.20.0.5/16"}}
)

func snap(ifs ...Interface) Snapshot { return Snapshot{Interfaces: ifs} }

// sleptAcross runs a 1 s ticker on a fake wall clock from t0, then jumps by gap, and reports
// whether the detector saw a sleep after the healthy check at t0.
func sleptAcross(gap time.Duration) bool {
	var d SleepDetector
	now := t0
	for range 5 {
		now = now.Add(time.Second)
		d.Tick(now)
	}
	d.Tick(now.Add(gap))
	return d.SleptSince(t0)
}

// A36 (connector half): each row of design §5.5, with a fake clock and fake interface
// snapshots. Every case also carries the evidence of every later row, so the first rule that
// holds is the one reported.
func TestA36_CauseClassification(t *testing.T) {
	// Evidence that satisfies rules 5, 6 and 7 at once, so earlier rules must win over them.
	lower := func(e Evidence) Evidence {
		e.TransportHealthy, e.ProcessExited, e.WasReachable, e.DialsFail, e.KeepaliveLost = true, true, true, true, true
		return e
	}
	base := Evidence{OS: "linux", Now: t0.Add(time.Hour), Before: snap(wifi), After: snap(wifi)}
	cases := []struct {
		name string
		ev   Evidence
		want string
	}{
		{"1 sleep: ticks 40 s apart", func() Evidence {
			e := lower(base)
			e.Slept = sleptAcross(40 * time.Second)
			e.ExpectedEnd, e.TransportEnded = e.Now, true
			e.Before, e.After = snap(wifi, vpnIf), snap(wifiNew)
			return e
		}(), Sleep},
		{"2 allocation_expired: within 5 minutes of expectedEnd and the transport ended", func() Evidence {
			e := lower(base)
			e.ExpectedEnd, e.TransportEnded = e.Now.Add(4*time.Minute), true
			e.Before, e.After = snap(wifi, vpnIf), snap(wifiNew)
			return e
		}(), AllocationExpired},
		{"2 allocation_expired: past expectedEnd, reconnect refused", func() Evidence {
			e := lower(base)
			e.ExpectedEnd, e.TransportEnded = e.Now.Add(-time.Hour), true
			return e
		}(), AllocationExpired},
		{"3 vpn: a VPN-like interface went away", func() Evidence {
			e := lower(base)
			e.Before, e.After = snap(wifi, vpnIf), snap(wifiNew)
			return e
		}(), VPN},
		{"3 vpn: the route to the host moved to another interface", func() Evidence {
			e := lower(base)
			e.Before, e.After = snap(wifi, ethIf), snap(wifi, ethIf)
			e.RouteBefore, e.RouteAfter = "eth0", "wlan0"
			return e
		}(), VPN},
		{"3 vpn: a Windows adapter described as a VPN went away", func() Evidence {
			e := lower(base)
			e.OS = "windows"
			corp := Interface{Name: "Ethernet 3", Description: "Cisco AnyConnect Secure Mobility Client Virtual Miniport Adapter"}
			e.Before, e.After = snap(wifi, corp), snap(wifi)
			return e
		}(), VPN},
		{"4 network_change: an address changed", func() Evidence {
			e := lower(base)
			e.Before, e.After = snap(wifi), snap(wifiNew)
			return e
		}(), NetworkChange},
		{"4 network_change: a non-VPN interface went away", func() Evidence {
			e := lower(base)
			e.Before, e.After = snap(wifi, ethIf), snap(wifi)
			return e
		}(), NetworkChange},
		{"5 service_stopped: SSH answers and the owned process exited", func() Evidence {
			e := lower(base)
			e.ExpectedEnd = e.Now.Add(time.Hour) // declared, but not near
			e.TransportEnded = true
			return e
		}(), ServiceStopped},
		{"5 service_stopped: an attached server stopped answering while SSH answers", Evidence{
			OS: "linux", Now: base.Now, Before: snap(wifi), After: snap(wifi),
			TransportHealthy: true, ServiceUnanswered: true, WasReachable: true, DialsFail: true, KeepaliveLost: true,
		}, ServiceStopped},
		{"6 host_unreachable: reachable before, every dial fails now", Evidence{
			OS: "linux", Now: base.Now, Before: snap(wifi), After: snap(wifi),
			ProcessExited: true, WasReachable: true, DialsFail: true, KeepaliveLost: true,
		}, HostUnreachable},
		{"7 ssh_timeout: keepalive unanswered and nothing above", Evidence{
			OS: "linux", Now: base.Now, Before: snap(wifi), After: snap(wifi), KeepaliveLost: true, DialsFail: true,
		}, SSHTimeout},
		{"local process_exited: the local process ended on its own", Evidence{
			OS: "linux", Local: true, Now: base.Now, Before: snap(wifi, vpnIf), After: snap(wifiNew), ProcessExited: true,
		}, ProcessExited},
		{"local sleep: the computer slept before the local process ended", Evidence{
			OS: "linux", Local: true, Now: base.Now, Slept: sleptAcross(20 * time.Second), ProcessExited: true,
		}, Sleep},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Classify(c.ev); got != c.want {
				t.Errorf("Classify = %s, want %s", got, c.want)
			}
		})
	}
	// The near-miss forms of the timing rules do not fire.
	t.Run("no sleep: ticks 15 s apart", func(t *testing.T) {
		if sleptAcross(15 * time.Second) {
			t.Error("a 15 s gap counted as sleep")
		}
	})
	t.Run("no allocation_expired: 6 minutes before expectedEnd", func(t *testing.T) {
		e := Evidence{OS: "linux", Now: t0, ExpectedEnd: t0.Add(6 * time.Minute), TransportEnded: true, KeepaliveLost: true}
		if got := Classify(e); got != SSHTimeout {
			t.Errorf("Classify = %s", got)
		}
	})
}

func TestSleepDetectorUsesWallClock(t *testing.T) {
	var d SleepDetector
	// A reading with a monotonic component that says one second passed, while the wall clock
	// jumped 30 s: the wall clock decides.
	start := time.Now()
	d.Tick(start)
	late := start.Add(time.Second).Round(0).Add(29 * time.Second)
	if !d.Tick(late) {
		t.Error("a 30 s wall-clock gap was not a sleep")
	}
	if d.SleptSince(late) {
		t.Error("a check after the wake-up still sees the sleep")
	}
	if !d.SleptSince(start) {
		t.Error("a check before the sleep does not see it")
	}
}

func TestVPNLikeNames(t *testing.T) {
	for _, n := range []string{"tun0", "utun3", "wg0", "ppp0", "tap1", "ipsec0", "tailscale0", "zt7nnig26"} {
		if !VPNLike("linux", Interface{Name: n}) {
			t.Errorf("%s is not VPN-like", n)
		}
	}
	for _, n := range []string{"eth0", "wlan0", "en0", "lo", "docker0"} {
		if VPNLike("darwin", Interface{Name: n}) {
			t.Errorf("%s is VPN-like", n)
		}
	}
	for _, d := range []string{"TAP-Windows Adapter V9", "WireGuard Tunnel", "Tailscale Tunnel", "PANGP Virtual Ethernet Adapter GlobalProtect", "Contoso VPN"} {
		if !VPNLike("windows", Interface{Name: "Ethernet 2", Description: d}) {
			t.Errorf("windows %q is not VPN-like", d)
		}
	}
	if VPNLike("windows", Interface{Name: "Wi-Fi", Description: "Intel(R) Wi-Fi 6 AX201"}) {
		t.Error("windows Wi-Fi is VPN-like")
	}
}

func TestRouteInterface(t *testing.T) {
	s := snap(wifi, vpnIf)
	if got := RouteInterface(s, netip.MustParseAddr("10.8.0.2")); got != "wg0" {
		t.Errorf("route = %q", got)
	}
	if got := RouteInterface(s, netip.MustParseAddr("::ffff:192.168.1.20")); got != "wlan0" {
		t.Errorf("mapped route = %q", got)
	}
	if got := RouteInterface(s, netip.MustParseAddr("10.9.9.9")); got != "" {
		t.Errorf("unknown route = %q", got)
	}
	if _, err := Interfaces(); err != nil {
		t.Errorf("Interfaces: %v", err)
	}
}

func TestReconnectSchedule(t *testing.T) {
	var waits []time.Duration
	elapsed := time.Duration(0)
	for n := 0; ; n++ {
		w, ok := NextReconnect(n, elapsed)
		if !ok {
			break
		}
		waits = append(waits, w)
		elapsed += w
	}
	want := []time.Duration{2, 4, 8, 16}
	for i, w := range want {
		if waits[i] != w*time.Second {
			t.Fatalf("wait %d = %s, want %ds", i, waits[i], w)
		}
	}
	for _, w := range waits[4:] {
		if w != 30*time.Second {
			t.Fatalf("later wait %s", w)
		}
	}
	if elapsed > ReconnectFor || elapsed < ReconnectFor-30*time.Second {
		t.Errorf("the schedule ran for %s", elapsed)
	}
}
