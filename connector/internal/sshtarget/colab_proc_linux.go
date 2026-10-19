package sshtarget

import (
	"os/exec"
	"runtime"
	"syscall"
)

// startProxy starts the colab program as the leader of a session and process group of its own,
// with no controlling terminal, and closes exited once it has ended. Pdeathsig ends it with the
// connector; it follows the thread that started the program, so that thread stays locked to
// this goroutine until the program has exited (as jupyter/proc_linux.go does).
func startProxy(cmd *exec.Cmd, exited chan<- struct{}) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Pdeathsig: syscall.SIGKILL}
	started := make(chan error, 1)
	go func() {
		runtime.LockOSThread() // never unlocked: the thread ends with this goroutine
		if err := cmd.Start(); err != nil {
			started <- err
			return
		}
		started <- nil
		cmd.Wait()
		close(exited)
	}()
	return <-started
}
