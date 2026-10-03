//go:build windows

package doctor

import "os"

// dialAgent opens the OpenSSH agent's named pipe as a file, as the SSH client will (design §5.3).
func dialAgent(path string) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	return f.Close()
}
