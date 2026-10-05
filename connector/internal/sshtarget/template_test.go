package sshtarget

import (
	"flag"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"unicode/utf8"
)

var update = flag.Bool("update", false, "rewrite the golden files")

// goldenCases are the start template's golden inputs: a plain interpreter, a login shell with a
// ~/ interpreter, and no interpreter with a quote in the workspace.
var goldenCases = []struct {
	name, workspace, python string
	login                   bool
}{
	{"interpreter", "/home/student/course work/week 1", "/opt/conda/envs/ds/bin/python", false},
	{"login shell, interpreter under ~/", "/scratch/student/bio101", "~/miniconda3/bin/python", true},
	{"jupyter from PATH, a quote in the workspace", "/home/o'brien/notebooks", "", false},
}

// TestRemoteStartTemplate: the start command of design §6, golden.
func TestRemoteStartTemplate(t *testing.T) {
	// The script is design §6's template, character for character.
	const design = `cd -- "$1" || exit 70; IFS= read -r JUPYTER_TOKEN || exit 71; export JUPYTER_TOKEN; echo "PARALLAX_PID=$$"; shift; exec "$@"`
	if startScript != design {
		t.Fatalf("start script\n%s\ndiffers from the design's\n%s", startScript, design)
	}
	var b strings.Builder
	for _, c := range goldenCases {
		b.WriteString("# " + c.name + "\n")
		b.WriteString(startCommand(c.login, c.workspace, c.python, 34567, sessionID) + "\n")
	}
	golden := filepath.Join("testdata", "start-template.golden")
	if *update {
		if err := os.WriteFile(golden, []byte(b.String()), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if b.String() != string(want) {
		t.Fatalf("start template changed:\n%s\nwant:\n%s", b.String(), want)
	}
	for _, line := range strings.Split(b.String(), "\n") {
		if strings.Contains(line, "\r") {
			t.Fatal("a command holds a carriage return")
		}
	}
	if strings.ContainsAny(startScript+toolScript+probeScript, "\n!") {
		t.Fatal("a script holds a newline or a ! that csh would reject")
	}
}

// unquote parses a command line the way a POSIX shell splits words made only of single-quoted
// strings, the escaped quote \', the "$HOME" form and bare lower-case letters and dashes (the
// fixed words), and fails on anything else: a shell character outside quotes.
func unquote(t *testing.T, cmd string) []string {
	t.Helper()
	var words []string
	var cur strings.Builder
	in := false
	for i := 0; i < len(cmd); i++ {
		c := cmd[i]
		switch {
		case c == ' ':
			if in {
				words = append(words, cur.String())
				cur.Reset()
				in = false
			}
		case c == '\'':
			j := strings.IndexByte(cmd[i+1:], '\'')
			if j < 0 {
				t.Fatalf("unterminated quote in %q", cmd)
			}
			cur.WriteString(cmd[i+1 : i+1+j])
			i += j + 1
			in = true
		case strings.HasPrefix(cmd[i:], `\'`):
			cur.WriteByte('\'')
			i++
			in = true
		case !in && strings.HasPrefix(cmd[i:], `"$HOME"/`):
			cur.WriteString("$HOME/")
			i += len(`"$HOME"/`) - 1
			in = true
		case c >= 'a' && c <= 'z' || c == '-':
			// The fixed words: sh, -c, bash, -lc and $0.
			cur.WriteByte(c)
			in = true
		default:
			t.Fatalf("unquoted %q at %d in %q", c, i, cmd)
		}
	}
	if in {
		words = append(words, cur.String())
	}
	return words
}

// randomArg draws a string full of what a shell would act on.
func randomArg(r *rand.Rand) string {
	alphabet := []rune("ab /'\"$`\\;|&<>(){}*?[]~#=%!\t\n-é漢")
	n := r.IntN(24)
	out := make([]rune, n)
	for i := range out {
		out[i] = alphabet[r.IntN(len(alphabet))]
	}
	return string(out)
}

// TestShellQuoteFuzz: shellQuote gives every string back unchanged to a POSIX shell.
func TestShellQuoteFuzz(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	for i := 0; i < 20000; i++ {
		s := randomArg(r)
		got := unquote(t, shellQuote(s))
		if s == "" {
			if len(got) != 1 || got[0] != "" {
				t.Fatalf("%q quoted as %v", s, got)
			}
			continue
		}
		if len(got) != 1 || got[0] != s {
			t.Fatalf("%q quoted as %q parses as %q", s, shellQuote(s), got)
		}
	}
	if runtime.GOOS == "windows" {
		return
	}
	// A real shell gives every quoted argument back unchanged.
	for i := 0; i < 200; i++ {
		s := randomArg(r)
		if !utf8.ValidString(s) {
			continue
		}
		out, err := exec.Command("/bin/sh", "-c", "printf %s "+shellQuote(s)).Output()
		if err != nil {
			t.Fatalf("%q: %v", s, err)
		}
		if string(out) != s {
			t.Fatalf("sh printed %q for %q", out, s)
		}
	}
}

// TestCommandTemplates: every remote command is a fixed script whose only variable parts are the
// quoted, validated workspace, interpreter, port, session id and pid.
func TestCommandTemplates(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 4))
	hostile := []string{`'; rm -rf ~ #`, `$(id)`, "`id`", `a"b`, "x\ny", `\'`, `~/x'y`, "-c", ""}
	for i := 0; i < 50; i++ {
		hostile = append(hostile, randomArg(r))
	}
	for _, v := range hostile {
		ws := "/w/" + v
		py := "/p/" + v
		for _, login := range []bool{false, true} {
			shell := []string{"sh", "-c"}
			if login {
				shell = []string{"bash", "-lc"}
			}
			check := func(name, cmd, script string, args ...string) {
				t.Helper()
				want := append(append(append([]string{}, shell...), script, "sh"), args...)
				got := unquote(t, cmd)
				if strings.Join(got, "\x00") != strings.Join(want, "\x00") {
					t.Fatalf("%s for %q:\n got %q\nwant %q", name, v, got, want)
				}
			}
			flags := []string{"--ServerApp.ip=127.0.0.1", "--ServerApp.port=20001", "--ServerApp.port_retries=0",
				"--ServerApp.open_browser=False", "--ServerApp.root_dir=" + ws, "--ServerApp.allow_remote_access=False",
				"--ParallaxMarker.session=" + sessionID}
			check("start", startCommand(login, ws, py, 20001, sessionID), startScript, append([]string{ws, py, "-m", "jupyter_server"}, flags...)...)
			check("start from PATH", startCommand(login, ws, "", 20001, sessionID), startScript, append([]string{ws, "jupyter", "server"}, flags...)...)
			check("start with ~/", startCommand(login, ws, "~/"+v, 20001, sessionID), startScript, append([]string{ws, "$HOME/" + v, "-m", "jupyter_server"}, flags...)...)
			check("probe", probeCommand(login, py), toolScript, py, "-c", probeScript)
			check("probe from PATH", probeCommand(login, ""), toolScript, "jupyter", "server", "--version")
			check("server list", serverListCommand(login, py), toolScript, py, "-m", "jupyter", "server", "list", "--json")
			check("kernelspec list", kernelspecCommand(login, ""), toolScript, "jupyter", "kernelspec", "list", "--json")
		}
	}
	// The pid commands carry only a number the connector recorded.
	for _, c := range []string{psCommand(4194304), killCommand(12, false), killCommand(12, true), unameCommand} {
		if strings.Trim(c, "abcdefghijklmnopqrstuvwxyzKILTERM -=0123456789") != "" {
			t.Fatalf("%q has a variable part", c)
		}
	}
	if psCommand(7) != "ps -ww -o args= -p 7" || killCommand(7, false) != "kill -TERM 7" || killCommand(7, true) != "kill -KILL 7" {
		t.Fatalf("pid commands %q %q %q", psCommand(7), killCommand(7, false), killCommand(7, true))
	}
	for _, pid := range []int{0, -1, 4194305} {
		if validPID(pid) {
			t.Fatalf("pid %d accepted", pid)
		}
	}
}
