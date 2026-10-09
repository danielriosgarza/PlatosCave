package session

import (
	"os"
)

// The tests using these helpers skip on Windows (the in-process SSH server runs /bin/sh); the
// file exists so that `GOOS=windows go vet` compiles them.
func killPID(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}

func pidAlive(pid int) bool { return false }
