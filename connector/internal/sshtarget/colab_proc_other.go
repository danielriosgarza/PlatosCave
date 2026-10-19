//go:build !linux && !windows

package sshtarget

import (
	"os/exec"
	"syscall"
)

// startProxy starts the colab program as the leader of a session and process group of its own,
// with no controlling terminal, and calls exited once it has ended. macOS cannot tie its life to
// the connector's: when the connector ends, the program loses both ends of its pipes.
func startProxy(cmd *exec.Cmd, exited func()) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() {
		cmd.Wait()
		exited()
	}()
	return nil
}
