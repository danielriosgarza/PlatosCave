package jupyter

import (
	"os/exec"
	"runtime"
	"syscall"
)

// startChild starts cmd so that the kernel ends it if the connector dies (design §6): Pdeathsig
// follows the thread that spawned the child, so the child is spawned from a goroutine locked to
// its thread, which stays locked until the child has exited.
func startChild(cmd *exec.Cmd) (<-chan error, func(), error) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
	started := make(chan error, 1)
	wait := make(chan error, 1)
	go func() {
		runtime.LockOSThread()
		// The thread is never unlocked: when this goroutine returns, the thread exits with it,
		// which by then can no longer signal the child.
		if err := cmd.Start(); err != nil {
			started <- err
			return
		}
		started <- nil
		wait <- cmd.Wait()
	}()
	if err := <-started; err != nil {
		return nil, nil, err
	}
	return wait, func() {}, nil
}
