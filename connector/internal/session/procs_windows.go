package session

import "errors"

// systemProcesses cannot read another process's command line on Windows without more than the
// standard library offers, so the sweep cannot prove the marker and leaves the record as possibly
// orphaned. The job object with kill-on-close ends a crashed connector's children there
// (design §6).
type systemProcesses struct{}

var errNoInspect = errors.New("reading another process's command line is not supported on Windows")

func (systemProcesses) Inspect(int) (string, bool, error) { return "", false, errNoInspect }

func (systemProcesses) Signal(int, bool) error { return errNoInspect }
