package cause

import (
	"net"
	"net/netip"
)

// Interfaces reads this computer's interfaces that are up, for Evidence.Before and After. On
// Windows Go reports the adapter's friendly name, which VPNLike checks against the description
// words as well.
func Interfaces() (Snapshot, error) {
	list, err := net.Interfaces()
	if err != nil {
		return Snapshot{}, err
	}
	var s Snapshot
	for _, i := range list {
		if i.Flags&net.FlagUp == 0 {
			continue
		}
		iface := Interface{Name: i.Name}
		addrs, err := i.Addrs()
		if err == nil {
			for _, a := range addrs {
				iface.Addrs = append(iface.Addrs, a.String())
			}
		}
		s.Interfaces = append(s.Interfaces, iface)
	}
	return s, nil
}

// RouteInterface returns the interface of a snapshot that holds local, the local address of a
// connection to the host, or "" when none does.
func RouteInterface(s Snapshot, local netip.Addr) string {
	local = local.Unmap()
	for _, i := range s.Interfaces {
		for _, a := range i.Addrs {
			if p, err := netip.ParsePrefix(a); err == nil && p.Addr().Unmap() == local {
				return i.Name
			}
		}
	}
	return ""
}
