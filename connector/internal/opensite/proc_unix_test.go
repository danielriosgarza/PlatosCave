//go:build !windows

package opensite

import "syscall"

// pidAlive reports whether a process still exists.
func pidAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }
