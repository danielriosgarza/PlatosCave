package opensite

import "golang.org/x/sys/windows"

// stillActive is GetExitCodeProcess's answer for a process that has not ended.
const stillActive = 259

// pidAlive reports whether a process still runs.
func pidAlive(pid int) bool {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return false
	}
	defer windows.CloseHandle(h)
	var code uint32
	return windows.GetExitCodeProcess(h, &code) == nil && code == stillActive
}
