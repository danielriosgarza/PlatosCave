//go:build !windows

package sshtarget

import "syscall"

// killPID ends a process a test started; alive reports whether it still exists.
func killPID(pid int) error { return syscall.Kill(pid, syscall.SIGKILL) }
func alive(pid int) bool    { return syscall.Kill(pid, 0) == nil }
