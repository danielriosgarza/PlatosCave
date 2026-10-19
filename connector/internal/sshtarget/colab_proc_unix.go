//go:build !windows

package sshtarget

import "syscall"

// signalGroup signals the process group that pid leads; a test may replace it to see the signals.
var signalGroup = func(pid int, sig syscall.Signal) { syscall.Kill(-pid, sig) }
