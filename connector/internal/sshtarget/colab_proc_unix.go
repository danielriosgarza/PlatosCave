//go:build !windows

package sshtarget

import (
	"os"
	"syscall"
	"time"
)

// endProxy ends the process group the colab program leads: SIGTERM, then SIGKILL 1 s later.
func endProxy(p *os.Process) {
	syscall.Kill(-p.Pid, syscall.SIGTERM)
	time.AfterFunc(time.Second, func() { syscall.Kill(-p.Pid, syscall.SIGKILL) })
}
