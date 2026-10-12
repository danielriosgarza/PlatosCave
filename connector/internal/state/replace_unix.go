//go:build !windows

package state

import "os"

// A rename over an open file succeeds at once here; see replace_windows.go for the other case.
func openFile(p string) (*os.File, error) { return os.Open(p) }

func replaceFile(from, to string) error { return os.Rename(from, to) }
