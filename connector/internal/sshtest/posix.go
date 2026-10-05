package sshtest

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
)

// POSIXHost is an Exec that runs every command with /bin/sh -c as a POSIX account's sshd does,
// with the channel as standard input (so a command can read what the client writes, such as a
// token on its first line) and no time limit, so a server it starts keeps running until it ends.
// pathFirst, when set, is put before /usr/bin and /bin on PATH (a stub `jupyter` or `python`).
// A command's child processes are not killed when the channel closes, as with a real sshd and a
// process that ignores the hang-up.
func POSIXHost(pathFirst string) Exec {
	return func(command string, stdin io.Reader, stdout, stderr io.Writer) int {
		cmd := exec.Command("/bin/sh", "-c", command)
		var env []string
		for _, kv := range os.Environ() {
			if !strings.HasPrefix(kv, "PATH=") {
				env = append(env, kv)
			}
		}
		path := "/usr/bin:/bin"
		if pathFirst != "" {
			path = pathFirst + ":" + path
		}
		cmd.Env = append(env, "PATH="+path)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = stdin, stdout, stderr
		err := cmd.Run()
		var ee *exec.ExitError
		switch {
		case err == nil:
			return 0
		case errors.As(err, &ee):
			if ee.ExitCode() < 0 {
				return 128 + 15
			}
			return ee.ExitCode()
		}
		fmt.Fprintln(stderr, err)
		return 127
	}
}
