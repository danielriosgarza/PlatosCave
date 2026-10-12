package session

import (
	"os"

	"golang.org/x/sys/windows"
)

// killPID ends a process a test started; pidAlive reports whether it still runs. The SSH tests
// skip on Windows (the in-process SSH server runs /bin/sh); the lease and sweep tests do not.
func killPID(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}

// An exited process whose handle is still held somewhere can be opened, so the exit code decides.
func pidAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	if err := windows.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	const stillActive = 259
	return code == stillActive
}
