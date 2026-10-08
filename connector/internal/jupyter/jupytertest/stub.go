package jupytertest

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Environment of the stub program. The test sets them; the connector's children inherit them.
const (
	envStub = "PARALLAX_JUPYTER_STUB"
	// EnvDir is where the stub records what it was given (serve-<pid>.json).
	EnvDir = "PARALLAX_JUPYTER_STUB_DIR"
	// EnvMode changes the stub's behaviour: "" (a working Jupyter), "exit" (prints its URL and
	// exits while starting), "hang" (never answers), "old" (Jupyter Server 1.24), "missing"
	// (jupyter_server is not installed), "stubborn" (ignores shutdown and SIGTERM), "holder"
	// (leaves a child holding its output open, as a kernel does, after it exits; POSIX only),
	// "slowbind" (binds its port 500 ms after printing its URL), "refuse" (refuses the token it
	// was given).
	EnvMode = "PARALLAX_JUPYTER_STUB_MODE"
	// EnvList is printed for `jupyter server list --json`.
	EnvList = "PARALLAX_JUPYTER_STUB_LIST"
)

// Record is what one serving stub was started with.
type Record struct {
	PID        int      `json:"pid"`
	Argv       []string `json:"argv"`
	Dir        string   `json:"dir"`
	TokenInEnv bool     `json:"tokenInEnv"`
	RuntimeDir string   `json:"runtimeDir"`
	Listen     string   `json:"listen"`
	Requests   []string `json:"requests,omitempty"`
	// HolderPID is the child the "holder" mode leaves holding the output.
	HolderPID int `json:"holderPid,omitempty"`
}

// RunIfStub turns the test binary into the stub program when the connector runs it as
// `jupyter` or `python`. Call it first in TestMain.
func RunIfStub() {
	if os.Getenv(envStub) != "1" {
		return
	}
	name := strings.TrimSuffix(filepath.Base(os.Args[0]), ".exe")
	args := os.Args[1:]
	if name == "python" {
		switch {
		case len(args) >= 1 && args[0] == "-c":
			stubProbe()
		case len(args) >= 2 && args[0] == "-m" && args[1] == "jupyter_server":
			stubServe(args[2:])
		case len(args) >= 2 && args[0] == "-m" && args[1] == "jupyter":
			stubJupyter(args[2:])
		}
		fmt.Fprintln(os.Stderr, "python stub: unexpected arguments", args)
		os.Exit(2)
	}
	stubJupyter(args)
}

func stubProbe() {
	switch os.Getenv(EnvMode) {
	case "missing":
		fmt.Println(`{"python": "3.12.8"}`)
		os.Exit(3)
	case "old":
		fmt.Println(`{"python": "3.12.8", "jupyter_server": "1.24.0"}`)
	default:
		fmt.Printf("{\"python\": \"3.12.8\", \"jupyter_server\": %q}\n", Version)
	}
	os.Exit(0)
}

func stubJupyter(args []string) {
	mode := os.Getenv(EnvMode)
	switch {
	case len(args) == 2 && args[0] == "server" && args[1] == "--version":
		if mode == "missing" {
			fmt.Fprintln(os.Stderr, "Jupyter command `jupyter-server` not found.")
			os.Exit(1)
		}
		if mode == "old" {
			fmt.Println("1.24.0")
		} else {
			fmt.Println(Version)
		}
	case len(args) == 3 && args[0] == "server" && args[1] == "list" && args[2] == "--json":
		fmt.Print(os.Getenv(EnvList))
	case len(args) == 3 && args[0] == "kernelspec" && args[1] == "list" && args[2] == "--json":
		fmt.Println(`{"kernelspecs": {"python3": {"resource_dir": "/x", "spec": {"display_name": "Python 3 (ipykernel)", "language": "python"}}, "ir": {"resource_dir": "/y", "spec": {"display_name": "R", "language": "R"}}}}`)
	case len(args) >= 1 && args[0] == "server":
		stubServe(args[1:])
	default:
		fmt.Fprintln(os.Stderr, "jupyter stub: unexpected arguments", args)
		os.Exit(2)
	}
	os.Exit(0)
}

func stubServe(flags []string) {
	mode := os.Getenv(EnvMode)
	token := os.Getenv("JUPYTER_TOKEN")
	var ip, port string
	for _, f := range flags {
		if v, ok := strings.CutPrefix(f, "--ServerApp.ip="); ok {
			ip = v
		}
		if v, ok := strings.CutPrefix(f, "--ServerApp.port="); ok {
			port = v
		}
	}
	wd, _ := os.Getwd()
	rec := Record{PID: os.Getpid(), Argv: os.Args, Dir: wd, TokenInEnv: token != "", RuntimeDir: os.Getenv("JUPYTER_RUNTIME_DIR"), Listen: net.JoinHostPort(ip, port)}
	if mode == "holder" {
		holder := exec.Command("/bin/sleep", "60")
		holder.Stdout, holder.Stderr = os.Stderr, os.Stderr
		if err := holder.Start(); err == nil {
			rec.HolderPID = holder.Process.Pid
		}
	}
	var mu sync.Mutex
	write := func() {
		mu.Lock()
		defer mu.Unlock()
		if dir := os.Getenv(EnvDir); dir != "" {
			data, _ := json.Marshal(rec)
			os.WriteFile(filepath.Join(dir, fmt.Sprintf("serve-%d.json", rec.PID)), data, 0o600)
		}
	}
	write()
	// Like Jupyter, print the URL with the token, and the token itself in a log line.
	fmt.Fprintf(os.Stderr, "[I ServerApp] Jupyter Server %s is running at:\n", Version)
	fmt.Fprintf(os.Stderr, "[I ServerApp]     http://%s/tree?token=%s\n", rec.Listen, token)
	fmt.Fprintf(os.Stderr, "[I ServerApp] token is %s\n", token)
	switch mode {
	case "exit":
		fmt.Fprintln(os.Stderr, "[C ServerApp] Running as root is not recommended. Use --allow-root to bypass.")
		os.Exit(1)
	case "hang":
		time.Sleep(time.Hour)
		os.Exit(1)
	case "stubborn":
		signal.Ignore(syscall.SIGTERM, os.Interrupt)
	case "slowbind":
		time.Sleep(500 * time.Millisecond)
	}
	ln, err := net.Listen("tcp", rec.Listen)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[E ServerApp] %v: Address already in use\n", err)
		os.Exit(1)
	}
	srv := New(token)
	if mode == "refuse" {
		srv = New("not-" + token)
	}
	srv.OnShutdown = func() {
		if mode == "stubborn" {
			return
		}
		time.Sleep(50 * time.Millisecond)
		os.Exit(0)
	}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		rec.Requests = append(rec.Requests, r.Method+" "+r.URL.RequestURI())
		mu.Unlock()
		write()
		srv.ServeHTTP(w, r)
	})
	http.Serve(ln, h)
	os.Exit(1)
}

// Install puts the stub in a new directory as `jupyter` and `python` and makes that directory
// the whole PATH. It returns the directory; the stub records into it as well.
func Install(t testing.TB, mode string) string {
	t.Helper()
	dir := t.TempDir()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	for _, name := range []string{"jupyter", "python"} {
		if err := copyFile(self, filepath.Join(dir, name+ext)); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv(envStub, "1")
	t.Setenv(EnvDir, dir)
	t.Setenv(EnvMode, mode)
	return dir
}

// Python returns the stub interpreter's path in dir.
func Python(dir string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(dir, "python.exe")
	}
	return filepath.Join(dir, "python")
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

// Records returns what every serving stub in dir recorded.
func Records(t testing.TB, dir string) []Record {
	t.Helper()
	files, _ := filepath.Glob(filepath.Join(dir, "serve-*.json"))
	var out []Record
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var r Record
		if err := json.Unmarshal(data, &r); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		out = append(out, r)
	}
	return out
}
