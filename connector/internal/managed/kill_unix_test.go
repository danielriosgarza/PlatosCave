//go:build !windows

package managed

import "syscall"

// kill ends a stub server a test left running.
func kill(pid int) { syscall.Kill(pid, syscall.SIGKILL) }
