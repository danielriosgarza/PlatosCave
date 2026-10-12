package session

import (
	"os"
	"sync"
	"testing"

	"golang.org/x/sys/windows"
)

// killPID ends a process a test started. The SSH tests skip on Windows (the in-process SSH
// server runs /bin/sh); the lease and sweep tests do not.
func killPID(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}

// Windows gives a freed process ID to the next process it creates. A test therefore asks about a
// process through a handle opened while that process ran; the open handle also keeps the ID from
// being given out again.
var watched sync.Map // process ID → windows.Handle

// watchPID opens that handle for a process that runs now. The test's cleanup closes it.
func watchPID(t testing.TB, pid int) {
	t.Helper()
	if _, ok := watched.Load(pid); ok {
		return
	}
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		t.Fatalf("open process %d: %v", pid, err)
	}
	watched.Store(pid, h)
	t.Cleanup(func() {
		watched.Delete(pid)
		windows.CloseHandle(h)
	})
}

// pidAlive reports whether a watched process still runs. For one that is not watched it can only
// ask by ID.
func pidAlive(pid int) bool {
	h, ok := watched.Load(pid)
	if !ok {
		opened, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
		if err != nil {
			return false
		}
		defer windows.CloseHandle(opened)
		h = opened
	}
	var code uint32
	if err := windows.GetExitCodeProcess(h.(windows.Handle), &code); err != nil {
		return false
	}
	const stillActive = 259
	return code == stillActive
}
