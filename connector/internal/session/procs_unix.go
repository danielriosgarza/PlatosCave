//go:build !windows

package session

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// systemProcesses reads processes with ps, which Linux and macOS both have.
type systemProcesses struct{}

// Inspect returns a process's command line and whether it still runs; a zombie has exited.
func (systemProcesses) Inspect(pid int) (string, bool, error) {
	if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
		return "", false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, psPath(), "-ww", "-o", "stat=", "-o", "args=", "-p", strconv.Itoa(pid)).Output()
	line := strings.TrimSpace(string(out))
	if line == "" {
		var exit *exec.ExitError
		if err == nil || errors.As(err, &exit) {
			return "", false, nil // ps lists nothing: the process is gone
		}
		return "", false, err
	}
	stat, args, _ := strings.Cut(line, " ")
	if strings.HasPrefix(stat, "Z") {
		return "", false, nil
	}
	return strings.TrimSpace(args), true, nil
}

// psPath is the system's ps, found where Linux and macOS install it rather than on PATH, so a
// program named ps earlier on PATH cannot answer for it.
func psPath() string {
	for _, p := range []string{"/bin/ps", "/usr/bin/ps"} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return "ps"
}

// Signal sends SIGTERM, or SIGKILL when kill is set.
func (systemProcesses) Signal(pid int, kill bool) error {
	sig := syscall.SIGTERM
	if kill {
		sig = syscall.SIGKILL
	}
	err := syscall.Kill(pid, sig)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
