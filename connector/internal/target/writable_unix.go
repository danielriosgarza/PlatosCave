//go:build !windows

package target

import "golang.org/x/sys/unix"

// writable reports whether this account may create files in dir (test -w).
func writable(dir string) bool { return unix.Access(dir, unix.W_OK) == nil }
