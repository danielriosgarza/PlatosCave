package state

import (
	"errors"
	"fmt"
	"os"
)

// ErrLocked means another process holds run.lock for this state directory.
var ErrLocked = errors.New("another parallax-connector process is using this state directory")

// Lock is a held run.lock. One `run` (and no `pair` or `unpair` beside it) uses a state
// directory at a time.
type Lock struct {
	f *os.File
}

// Lock takes run.lock without waiting; it fails with ErrLocked when another process holds it.
func (s *Store) Lock() (*Lock, error) {
	if err := s.Ensure(); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(s.Path(LockFile), os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("open %s: %w", LockFile, err)
	}
	if err := restrict(f.Name(), false); err != nil {
		f.Close()
		return nil, fmt.Errorf("restrict %s: %w", LockFile, err)
	}
	if err := lockFile(f); err != nil {
		f.Close()
		return nil, err
	}
	return &Lock{f: f}, nil
}

// Release gives the lock up.
func (l *Lock) Release() error {
	if l == nil || l.f == nil {
		return nil
	}
	err := errors.Join(unlockFile(l.f), l.f.Close())
	l.f = nil
	return err
}
