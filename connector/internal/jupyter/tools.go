package jupyter

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"parallax/connector/internal/protocol"
	"parallax/connector/internal/redact"
	"parallax/connector/internal/safetext"
)

// maxToolOutput bounds what the connector reads from one tool run.
const maxToolOutput = 1 << 20

// command returns the fixed command for a Jupyter tool: `jupyter <args>` from PATH, or
// `<python> -m <module> <args>` for a chosen interpreter. Nothing in it comes from the relay
// except the validated interpreter path.
func command(python, module string, args ...string) (string, []string, *Failure) {
	if python != "" {
		return python, append([]string{"-m", module}, args...), nil
	}
	path, err := exec.LookPath("jupyter")
	if err != nil {
		return "", nil, &Failure{Code: protocol.CodeJupyterMissing, Detail: "jupyter was not found on PATH"}
	}
	if module == "jupyter_server" {
		args = append([]string{"server"}, args...)
	}
	return path, args, nil
}

// cappedBuffer keeps at most max bytes.
type cappedBuffer struct {
	bytes.Buffer
	max int
}

func (b *cappedBuffer) Write(p []byte) (int, error) {
	if room := b.max - b.Len(); room > 0 {
		b.Buffer.Write(p[:min(len(p), room)])
	}
	return len(p), nil
}

// execTool runs a fixed command with no standard input and returns its output.
func execTool(ctx context.Context, name string, args []string) (stdout, stderr []byte, err error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Stdin = nil
	cmd.Env = childEnv(nil)
	out := &cappedBuffer{max: maxToolOutput}
	errOut := &cappedBuffer{max: 64 << 10}
	cmd.Stdout, cmd.Stderr = out, errOut
	err = cmd.Run()
	return out.Bytes(), errOut.Bytes(), err
}

// runTool runs `jupyter <args>` (or `<python> -m jupyter <args>`) and returns its output, or a
// *Failure: jupyter_missing when Jupyter is absent, environment_invalid when the interpreter
// does not run.
func runTool(ctx context.Context, python string, args ...string) ([]byte, error) {
	name, argv, f := command(python, "jupyter", args...)
	if f != nil {
		return nil, f
	}
	out, errOut, err := execTool(ctx, name, argv)
	if err != nil {
		return nil, toolFailure(ctx, python, err, errOut)
	}
	return out, nil
}

func toolFailure(ctx context.Context, python string, err error, stderr []byte) *Failure {
	if ctx.Err() != nil {
		return &Failure{Code: protocol.CodeInternal, Detail: "the Jupyter tool did not finish in time"}
	}
	var ee *exec.ExitError
	if !errors.As(err, &ee) {
		// The program could not be started at all.
		if python != "" {
			return &Failure{Code: protocol.CodeEnvironmentInvalid, Detail: fmt.Sprintf("the interpreter %s cannot run", python)}
		}
		return &Failure{Code: protocol.CodeJupyterMissing, Detail: "jupyter cannot run"}
	}
	return &Failure{Code: protocol.CodeJupyterMissing, Detail: lastLines(redact.Redact(string(stderr)), 400)}
}

// childEnv is the environment of every child: the connector's own, without any Jupyter token
// or runtime directory it may have inherited, plus extra.
func childEnv(extra []string) []string {
	var env []string
	for _, kv := range os.Environ() {
		k, _, _ := strings.Cut(kv, "=")
		switch strings.ToUpper(k) {
		case "JUPYTER_TOKEN", "JUPYTER_RUNTIME_DIR", "JPY_SESSION_NAME":
			continue
		}
		env = append(env, kv)
	}
	return append(env, extra...)
}

// lastLines returns the tail of s, at most n bytes, on whole lines where it can.
func lastLines(s string, n int) string {
	s = strings.TrimSpace(safetext.Sanitize(s))
	if len(s) <= n {
		return s
	}
	s = s[len(s)-n:]
	if i := strings.IndexByte(s, '\n'); i >= 0 && i < len(s)-1 {
		s = s[i+1:]
	}
	return strings.ToValidUTF8(s, "")
}

// RuntimeInfo is what the runtime stage learns about an environment.
type RuntimeInfo struct {
	// Version is jupyter_server's version.
	Version string
	// Python is the interpreter's version, when known.
	Python string
}

// probeScript prints the interpreter's and jupyter_server's versions; exit status 3 means
// jupyter_server does not import. It is fixed: nothing in it comes from a message.
const probeScript = `import json, sys
try:
    import jupyter_server
except Exception:
    print(json.dumps({"python": sys.version.split()[0]}))
    sys.exit(3)
print(json.dumps({"python": sys.version.split()[0], "jupyter_server": jupyter_server.__version__}))`

var reVersion = regexp.MustCompile(`^(\d+)\.(\d+)(\.\d+)?[A-Za-z0-9.+-]*$`)

// ProbeRuntime checks that the environment can start Jupyter Server 2 or later (the runtime
// stage in start mode): the interpreter runs and jupyter_server imports, or `jupyter server
// --version` answers.
func ProbeRuntime(ctx context.Context, python string) (RuntimeInfo, error) {
	var info RuntimeInfo
	if python != "" {
		out, _, err := execTool(ctx, python, []string{"-c", probeScript})
		var v struct {
			Python        string `json:"python"`
			JupyterServer string `json:"jupyter_server"`
		}
		var ee *exec.ExitError
		switch {
		case err == nil:
		case errors.As(err, &ee) && ee.ExitCode() == 3:
			return info, &Failure{Code: protocol.CodeJupyterMissing, Detail: fmt.Sprintf("jupyter_server is not installed for %s", python)}
		case ctx.Err() != nil:
			return info, &Failure{Code: protocol.CodeJupyterStartTimeout, Detail: "the interpreter did not answer in time"}
		default:
			return info, &Failure{Code: protocol.CodeEnvironmentInvalid, Detail: fmt.Sprintf("the interpreter %s cannot run", python)}
		}
		if json.Unmarshal(bytes.TrimSpace(lastLine(out)), &v) != nil {
			return info, &Failure{Code: protocol.CodeEnvironmentInvalid, Detail: fmt.Sprintf("%s did not report its version", python)}
		}
		info = RuntimeInfo{Version: v.JupyterServer, Python: v.Python}
	} else {
		out, err := runTool(ctx, "", "server", "--version")
		if err != nil {
			return info, err
		}
		info.Version = strings.TrimSpace(string(lastLine(out)))
	}
	m := reVersion.FindStringSubmatch(info.Version)
	if m == nil {
		return info, &Failure{Code: protocol.CodeJupyterIncompatible, Detail: "the Jupyter Server version could not be read"}
	}
	if major, _ := strconv.Atoi(m[1]); major < 2 {
		return info, &Failure{Code: protocol.CodeJupyterIncompatible, Detail: fmt.Sprintf("Jupyter Server %s is older than 2.0", info.Version)}
	}
	return info, nil
}

func lastLine(out []byte) []byte {
	out = bytes.TrimRight(out, "\r\n")
	if i := bytes.LastIndexByte(out, '\n'); i >= 0 {
		return out[i+1:]
	}
	return out
}

// Server is one running Jupyter server from `jupyter server list --json`. Its token never
// leaves the connector.
type Server struct {
	Port     int
	PID      int64
	RootDir  string
	Hostname string
	Version  string
	Token    string
	// Loopback is true when the server listens only on a loopback address.
	Loopback bool
}

// Attachable reports whether the connector may attach: a loopback listener whose token it can
// read, on a port of at least 1024.
func (s Server) Attachable() bool {
	return s.Loopback && s.Token != "" && s.Port >= 1024 && s.Port <= 65535
}

// ParseServerList parses `jupyter server list --json`: one JSON object per line.
func ParseServerList(out []byte) []Server {
	var servers []Server
	for _, line := range bytes.Split(out, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var v struct {
			Hostname string `json:"hostname"`
			Port     int    `json:"port"`
			PID      int64  `json:"pid"`
			RootDir  string `json:"root_dir"`
			Token    string `json:"token"`
			URL      string `json:"url"`
			Version  string `json:"version"`
			Sock     string `json:"sock"`
		}
		if json.Unmarshal(line, &v) != nil || v.Port < 1 || v.Port > 65535 || v.Sock != "" {
			continue
		}
		urlHost := ""
		if u, err := url.Parse(v.URL); err == nil {
			urlHost = u.Hostname()
		}
		servers = append(servers, Server{
			Port: v.Port, PID: v.PID, RootDir: v.RootDir, Hostname: v.Hostname, Version: v.Version, Token: v.Token,
			Loopback: isLoopbackHost(v.Hostname) && (urlHost == "" || isLoopbackHost(urlHost)),
		})
	}
	return servers
}

func isLoopbackHost(h string) bool {
	if strings.EqualFold(h, "localhost") {
		return true
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

// ListServers runs `jupyter server list --json` (or `<python> -m jupyter server list --json`).
func ListServers(ctx context.Context, python string) ([]Server, error) {
	out, err := runTool(ctx, python, "server", "list", "--json")
	if err != nil {
		return nil, err
	}
	return ParseServerList(out), nil
}
