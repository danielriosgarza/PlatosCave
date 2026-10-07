package managed

import "os"

// kill ends a stub server a test left running.
func kill(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		p.Kill()
	}
}
