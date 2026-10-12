package state

import (
	"errors"
	"os"
	"time"

	"golang.org/x/sys/windows"
)

// While a new version is renamed over a state file, Windows refuses another open of that file
// with a sharing violation, and it refuses the rename with a sharing violation or access denied
// while a reader or a virus scanner holds the old file. Both pass in a moment, so both are
// retried for a short time. Access denied on an open is not retried: there it means a file this
// account may not read, and waiting would only delay that report.
const busyWait = 2 * time.Second

func retryWhile(busy func(error) bool, op func() error) error {
	deadline := time.Now().Add(busyWait)
	for delay := time.Millisecond; ; {
		err := op()
		if err == nil || !busy(err) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(delay)
		if delay < 32*time.Millisecond {
			delay *= 2
		}
	}
}

func shared(err error) bool { return errors.Is(err, windows.ERROR_SHARING_VIOLATION) }

func held(err error) bool { return shared(err) || errors.Is(err, windows.ERROR_ACCESS_DENIED) }

func openFile(p string) (*os.File, error) {
	var f *os.File
	err := retryWhile(shared, func() (err error) {
		f, err = os.Open(p)
		return err
	})
	return f, err
}

func replaceFile(from, to string) error {
	return retryWhile(held, func() error { return os.Rename(from, to) })
}
