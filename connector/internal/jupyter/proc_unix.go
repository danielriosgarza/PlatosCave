//go:build !windows

package jupyter

import (
	"os"
	"syscall"
)

// terminate asks a process to end.
func terminate(p *os.Process) error { return p.Signal(syscall.SIGTERM) }
