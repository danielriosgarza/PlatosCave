package sshtarget

import (
	"strconv"
	"strings"

	"parallax/connector/internal/jupyter"
)

// The commands the connector runs on an SSH target (design §6). Each is a fixed script run by
// `sh -c` (or `bash -lc` when the runtime asks for a login shell), followed by `sh` as $0 and
// its arguments, every one single-quoted by shellQuote. The only variable parts are the
// validated workspace, interpreter, port, session id and pid; nothing else from a message ever
// reaches a command line. Scripts stay on one line because SSH hands the command to the
// account's login shell, and csh and tcsh reject a newline inside quotes.

// Exit statuses of the start script.
const (
	exitNoWorkspace = 70
	exitNoToken     = 71
)

// startScript is design §6's start template: enter the workspace, read the token from the first
// line of standard input, print the pid ($$ becomes the server's pid at exec) and run the server.
const startScript = `cd -- "$1" || exit 70; IFS= read -r JUPYTER_TOKEN || exit 71; export JUPYTER_TOKEN; echo "PARALLAX_PID=$$"; shift; exec "$@"`

// toolScript runs its arguments: an interpreter or `jupyter` with fixed arguments.
const toolScript = `exec "$@"`

// pidPrefix starts the line that carries the started server's pid.
const pidPrefix = "PARALLAX_PID="

// probeScript prints the interpreter's and jupyter_server's versions; exit status 3 means
// jupyter_server does not import. It is one line, with no single quote and no `!`.
const probeScript = `import json, sys; exec("try:\n import jupyter_server as j\n v = j.__version__\nexcept Exception:\n v = None"); print(json.dumps({"python": sys.version.split()[0], "jupyter_server": v})); sys.exit(0 if v else 3)`

// unameCommand is the POSIX check. It is sent as it is: a host without a POSIX shell must still
// be able to answer it (or fail to), so it is not wrapped in sh.
const unameCommand = "uname -s"

// wrap is the command line that runs script with args under sh, or bash as a login shell.
func wrap(login bool, script string, args ...string) string {
	shell := "sh -c"
	if login {
		shell = "bash -lc"
	}
	parts := make([]string, 0, len(args)+3)
	parts = append(parts, shell, shellQuote(script), "sh")
	parts = append(parts, args...)
	return strings.Join(parts, " ")
}

// quoteArgs single-quotes each argument.
func quoteArgs(args ...string) []string {
	out := make([]string, len(args))
	for i, a := range args {
		out[i] = shellQuote(a)
	}
	return out
}

// quotePython quotes the interpreter path. A leading ~/ is sent as "$HOME"/…, because ~ is not
// expanded inside quotes (design §6); the rest is single-quoted.
func quotePython(python string) string {
	if rest, ok := strings.CutPrefix(python, "~/"); ok {
		return `"$HOME"/` + shellQuote(rest)
	}
	return shellQuote(python)
}

// toolArgs is `<python> -m <module> args…`, or `jupyter <args…>` from PATH when no interpreter
// was chosen (as on this computer, design §6), each quoted.
func toolArgs(python, module string, args ...string) []string {
	var out []string
	if python != "" {
		out = append(out, quotePython(python), shellQuote("-m"), shellQuote(module))
	} else {
		out = append(out, shellQuote("jupyter"))
		if module == "jupyter_server" {
			out = append(out, shellQuote("server"))
		}
	}
	return append(out, quoteArgs(args...)...)
}

// startCommand is the start template for one attempt: the workspace, then the server with the
// fixed flags of design §6 on port, its root the workspace and its marker the session id.
func startCommand(login bool, workspace, python string, port int, sessionID string) string {
	args := []string{shellQuote(workspace)}
	args = append(args, toolArgs(python, "jupyter_server", jupyter.ServerFlags(port, workspace, sessionID)...)...)
	return wrap(login, startScript, args...)
}

// probeCommand checks the interpreter and jupyter_server, or asks `jupyter server --version`.
func probeCommand(login bool, python string) string {
	if python != "" {
		return wrap(login, toolScript, quotePython(python), shellQuote("-c"), shellQuote(probeScript))
	}
	return wrap(login, toolScript, toolArgs("", "jupyter", "server", "--version")...)
}

// serverListCommand is `jupyter server list --json`.
func serverListCommand(login bool, python string) string {
	return wrap(login, toolScript, toolArgs(python, "jupyter", "server", "list", "--json")...)
}

// kernelspecCommand is `jupyter kernelspec list --json`.
func kernelspecCommand(login bool, python string) string {
	return wrap(login, toolScript, toolArgs(python, "jupyter", "kernelspec", "list", "--json")...)
}

// psCommand prints a process's command line, so its marker can be checked (design §6).
func psCommand(pid int) string { return "ps -ww -o args= -p " + strconv.Itoa(pid) }

// killCommand sends SIGTERM, or SIGKILL when kill is set, to a pid whose marker was proved.
func killCommand(pid int, kill bool) string {
	sig := "TERM"
	if kill {
		sig = "KILL"
	}
	return "kill -" + sig + " " + strconv.Itoa(pid)
}

// validPID is a pid the commands may carry.
func validPID(pid int) bool { return pid >= 1 && pid <= 4194304 }
