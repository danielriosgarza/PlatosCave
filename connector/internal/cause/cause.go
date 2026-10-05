// Package cause decides why a session was lost (docs/design/connector.md §5.5): the first rule of
// the design's table that holds over the evidence gathered since the session's last healthy
// check. Every input is injectable: the 1 s ticker's wall-clock readings (SleepDetector), the
// network interface snapshots (Snapshot, Interfaces), the target's expectedEnd, and the transport
// and service probes the caller ran. It also holds the transport-reconnect schedule of §5.5.
package cause

import (
	"slices"
	"strings"
	"time"
)

// Causes a connector sends (link.schema.json and state.schema.json `cause`).
const (
	Sleep             = "sleep"
	AllocationExpired = "allocation_expired"
	VPN               = "vpn"
	NetworkChange     = "network_change"
	ServiceStopped    = "service_stopped"
	HostUnreachable   = "host_unreachable"
	SSHTimeout        = "ssh_timeout"
	ProcessExited     = "process_exited"
	LeaseIdle         = "lease_idle"
	LeaseGrace        = "lease_grace"
	UserStop          = "user_stop"
	ConnectorExit     = "connector_exit"
	MaxLifetime       = "max_lifetime"
	// ConnectorRestarted is a server-side cause in the protocol; the connector records it in
	// sessions.json for an orphan its start-up sweep stopped (design §6).
	ConnectorRestarted = "connector_restarted"
)

// SleepGap is the wall-clock gap between two consecutive ticks of the 1 s ticker that counts as
// a sleep (rule 1).
const SleepGap = 15 * time.Second

// AllocationMargin is how close to expectedEnd a closed transport counts as the allocation
// ending (rule 2).
const AllocationMargin = 5 * time.Minute

// SleepDetector is the lateness source of rule 1. Feed it the wall-clock time of every tick of
// a 1 s ticker; a sleeping computer runs no ticks, so a gap longer than SleepGap between two
// ticks is a sleep (a clock step of that size is indistinguishable and is reported as sleep too).
type SleepDetector struct {
	last  time.Time // the previous tick
	woke  time.Time // the tick that ended the latest gap
	start time.Time // the tick that began the latest gap
}

// Tick records one tick and reports whether it ends a sleep. Readings are compared without a
// monotonic component (Round(0)), because a monotonic clock may not count the time asleep.
func (d *SleepDetector) Tick(now time.Time) bool {
	now = now.Round(0)
	woke := !d.last.IsZero() && now.Sub(d.last) > SleepGap
	if woke {
		d.start, d.woke = d.last, now
	}
	d.last = now
	return woke
}

// SleptSince reports whether a sleep ended after t (the session's last healthy check).
func (d *SleepDetector) SleptSince(t time.Time) bool {
	return !d.woke.IsZero() && d.woke.After(t)
}

// Interface is one network interface: its name, on Windows also the adapter description, and
// its addresses in CIDR form.
type Interface struct {
	Name        string
	Description string
	Addrs       []string
}

// Snapshot is the computer's network interfaces at one moment.
type Snapshot struct {
	Interfaces []Interface
}

// Has reports whether an interface of that name is present.
func (s Snapshot) Has(name string) bool {
	return slices.ContainsFunc(s.Interfaces, func(i Interface) bool { return i.Name == name })
}

// key is a canonical form for comparing two snapshots.
func (s Snapshot) key() []string {
	var out []string
	for _, i := range s.Interfaces {
		addrs := slices.Clone(i.Addrs)
		slices.Sort(addrs)
		out = append(out, i.Name+"="+strings.Join(addrs, ","))
	}
	slices.Sort(out)
	return out
}

// Changed reports whether any interface or address differs between two snapshots.
func Changed(a, b Snapshot) bool { return !slices.Equal(a.key(), b.key()) }

var (
	vpnPrefixes = []string{"tun", "utun", "wg", "ppp", "tap", "ipsec", "tailscale", "zt"}
	vpnWindows  = []string{"vpn", "tap", "wireguard", "tailscale", "anyconnect", "globalprotect"}
)

// VPNLike reports whether an interface looks like a VPN on an operating system (design §5.5
// rule 3): names starting tun, utun, wg, ppp, tap, ipsec, tailscale or zt; on Windows, where an
// adapter's name is chosen by the person, a description (or name) containing VPN, TAP,
// WireGuard, Tailscale, AnyConnect or GlobalProtect.
func VPNLike(goos string, i Interface) bool {
	if goos == "windows" {
		text := strings.ToLower(i.Description + " " + i.Name)
		for _, w := range vpnWindows {
			if strings.Contains(text, w) {
				return true
			}
		}
		return false
	}
	name := strings.ToLower(i.Name)
	for _, p := range vpnPrefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}

// VPNGone reports whether a VPN-like interface present in before is missing from after.
func VPNGone(goos string, before, after Snapshot) bool {
	for _, i := range before.Interfaces {
		if VPNLike(goos, i) && !after.Has(i.Name) {
			return true
		}
	}
	return false
}

// Evidence is what the caller knows when a session's transport or process disappears. Before
// and the route are from the session's last healthy check; the probes are the caller's.
type Evidence struct {
	// OS is the connector's operating system (for the VPN name rules).
	OS string
	// Local is true for the `local` target, where only rule 1 and process_exited apply.
	Local bool
	Now   time.Time
	// Slept is rule 1: a SleepDetector saw a sleep since the last healthy check.
	Slept bool
	// ExpectedEnd is the target's declared allocation end; zero when it declared none.
	ExpectedEnd time.Time
	// TransportEnded: the transport closed with a disconnect message, or reconnecting was
	// refused or timed out.
	TransportEnded bool
	// Before is the snapshot at the last healthy check, After the current one.
	Before, After Snapshot
	// RouteBefore and RouteAfter name the interface carrying the route to the host; empty when
	// unknown.
	RouteBefore, RouteAfter string
	// TransportHealthy: the SSH transport still answers.
	TransportHealthy bool
	// ProcessExited: the owned process has exited.
	ProcessExited bool
	// ServiceUnanswered: an attached server stopped answering.
	ServiceUnanswered bool
	// WasReachable: the host was reachable before; DialsFail: every dial now fails.
	WasReachable, DialsFail bool
	// KeepaliveLost: the keepalive went unanswered for 45 s.
	KeepaliveLost bool
}

// Classify returns the cause of the first rule of design §5.5 that holds. When none does, a
// remote session's cause is ssh_timeout (the transport stopped answering) and a local one's is
// process_exited.
func Classify(e Evidence) string {
	if e.Slept {
		return Sleep
	}
	if e.Local {
		return ProcessExited
	}
	if !e.ExpectedEnd.IsZero() && !e.Now.Before(e.ExpectedEnd.Add(-AllocationMargin)) && e.TransportEnded {
		return AllocationExpired
	}
	if VPNGone(e.OS, e.Before, e.After) || (e.RouteBefore != "" && e.RouteAfter != e.RouteBefore) {
		return VPN
	}
	if Changed(e.Before, e.After) {
		return NetworkChange
	}
	if e.TransportHealthy && (e.ProcessExited || e.ServiceUnanswered) {
		return ServiceStopped
	}
	if e.WasReachable && e.DialsFail {
		return HostUnreachable
	}
	return SSHTimeout
}

// Reconnect schedule of design §5.5: after 2, 4, 8 and 16 s, then every 30 s, for up to 10
// minutes, and only while the session's lease is valid.
var (
	reconnectFirst = []time.Duration{2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second}
	reconnectEvery = 30 * time.Second
	// ReconnectFor is how long reconnecting goes on.
	ReconnectFor = 10 * time.Minute
)

// NextReconnect returns the wait before reconnect attempt n (from 0) after a loss that happened
// elapsed ago, and false once the schedule is over.
func NextReconnect(n int, elapsed time.Duration) (time.Duration, bool) {
	var wait time.Duration
	if n < len(reconnectFirst) {
		wait = reconnectFirst[n]
	} else {
		wait = reconnectEvery
	}
	if elapsed+wait > ReconnectFor {
		return 0, false
	}
	return wait, true
}
