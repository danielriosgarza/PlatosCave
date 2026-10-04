//go:build !windows

package state

import (
	"fmt"
	"os"
)

// restrict sets owner-only permissions: 0700 on a directory, 0600 on a file.
func restrict(path string, dir bool) error {
	mode := os.FileMode(0o600)
	if dir {
		mode = 0o700
	}
	return os.Chmod(path, mode)
}

func checkPrivate(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%s is a symbolic link", path)
	}
	if perm := info.Mode().Perm(); perm&0o077 != 0 {
		return fmt.Errorf("%s has mode %04o; other accounts can access it (want %04o)", path, perm, perm&0o700)
	}
	if owner, ok := fileOwner(info); ok && owner != os.Getuid() {
		return fmt.Errorf("%s is owned by uid %d, not by this account (uid %d)", path, owner, os.Getuid())
	}
	return nil
}

// syncDir flushes a directory entry after a rename; best effort.
func syncDir(dir string) {
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
}
