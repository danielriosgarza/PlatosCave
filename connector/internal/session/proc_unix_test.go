//go:build !windows

package session

import (
	"syscall"
	"testing"
)

// killPID ends a process a test started; pidAlive reports whether it still exists.
func killPID(pid int) error { return syscall.Kill(pid, syscall.SIGKILL) }
func pidAlive(pid int) bool { return syscall.Kill(pid, 0) == nil }

// watchPID is needed on Windows only (proc_windows_test.go).
func watchPID(testing.TB, int) {}
