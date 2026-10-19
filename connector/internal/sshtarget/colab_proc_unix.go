//go:build !windows

package sshtarget

import "syscall"

// signalGroup signals the process group that pid leads. dial gives it to each run, whose own
// copy a test may replace to see that run's signals.
func signalGroup(pid int, sig syscall.Signal) { syscall.Kill(-pid, sig) }
