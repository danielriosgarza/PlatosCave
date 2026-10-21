package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"parallax/connector/internal/jupyter/jupytertest"
)

func TestOpenUsage(t *testing.T) {
	h := newHarness(t, nil)
	if code := h.run("open"); code != ExitUsage || !strings.Contains(h.stderr.String(), "asks in a terminal") {
		t.Errorf("without a terminal: exit %d: %s", code, h.stderr)
	}
	h.tty = true
	for _, origin := range []string{"http://course.example.org", "https://course.example.org/notebooks", "null"} {
		if code := h.run("open", "--allow", origin); code != ExitUsage {
			t.Errorf("--allow %s: exit %d", origin, code)
		}
	}
	if code := h.run("open", "extra"); code != ExitUsage {
		t.Errorf("an argument: exit %d", code)
	}
	if code := h.run("help"); code != ExitOK || !strings.Contains(h.stdout.String(), "open [--workspace DIR]") {
		t.Errorf("usage does not list open:\n%s", h.stdout)
	}
}

var openLine = regexp.MustCompile(`is open on http://127\.0\.0\.1:(\d+) `)

func TestA57_OpenAsksInTheTerminal(t *testing.T) {
	jupytertest.Install(t, "")
	h := newHarness(t, nil)
	h.tty = true
	pr, pw := io.Pipe()
	defer pw.Close()
	h.env.Stdin = pr
	out := &syncBuffer{}
	h.env.Stdout = out
	h.env.Listen = func(int) (net.Listener, error) { return net.Listen("tcp", "127.0.0.1:0") }
	ws := filepath.Join(t.TempDir(), "Parallax")
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan int, 1)
	go func() { done <- Main(ctx, []string{"open", "--workspace", ws}, h.env) }()
	waitFor(t, "the service", func() bool { return openLine.MatchString(out.String()) })
	port := openLine.FindStringSubmatch(out.String())[1]
	if !strings.Contains(out.String(), "Each notebook gets a folder in "+ws) {
		t.Errorf("the workspace is not named:\n%s", out)
	}

	pair := func(origin, code string) (int, map[string]string) {
		body, _ := json.Marshal(map[string]string{"code": code})
		req, _ := http.NewRequest("POST", "http://127.0.0.1:"+port+"/v1/pair", bytes.NewReader(body))
		req.Header.Set("Origin", origin)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		var m map[string]string
		json.NewDecoder(resp.Body).Decode(&m)
		return resp.StatusCode, m
	}
	ask := func(origin, code string) string {
		return fmt.Sprintf("%s asks to run notebooks on this computer, with your files and your Python.\nThe page shows the code %s. Allow this site until the connector stops? [y/N] ", origin, code)
	}

	// A "y" typed before anyone asked does not answer the next question.
	io.WriteString(pw, "y\n")
	time.Sleep(50 * time.Millisecond)
	type answer struct {
		status int
		body   map[string]string
	}
	got := make(chan answer, 1)
	go func() { s, b := pair("https://other.example.org", "1111-2222"); got <- answer{s, b} }()
	waitFor(t, "the first question", func() bool { return strings.Contains(out.String(), ask("https://other.example.org", "1111-2222")) })
	select {
	case a := <-got:
		t.Fatalf("answered before the person did: %+v", a)
	case <-time.After(200 * time.Millisecond):
	}
	io.WriteString(pw, "n\n")
	if a := <-got; a.status != 403 || a.body["code"] != "refused" {
		t.Errorf("declined: %+v", a)
	}

	go func() { s, b := pair("https://course.example.org", "4821-7730"); got <- answer{s, b} }()
	waitFor(t, "the second question", func() bool { return strings.Contains(out.String(), ask("https://course.example.org", "4821-7730")) })
	io.WriteString(pw, "yes\n")
	if a := <-got; a.status != 200 || len(a.body["key"]) != 64 {
		t.Errorf("allowed: %+v", a)
	}
	if !strings.Contains(out.String(), "Allowed https://course.example.org until the connector stops.") {
		t.Errorf("no line for the allowed site:\n%s", out)
	}
	cancel()
	if code := <-done; code != ExitOK || !strings.HasSuffix(out.String(), "Stopped.\n") {
		t.Errorf("exit %d: %s\n%s", code, h.stderr, out)
	}
}

func TestOpenAllowsWithoutATerminal(t *testing.T) {
	h := newHarness(t, nil)
	out := &syncBuffer{}
	h.env.Stdout = out
	h.env.Listen = func(int) (net.Listener, error) { return net.Listen("tcp", "127.0.0.1:0") }
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan int, 1)
	go func() {
		done <- Main(ctx, []string{"open", "--workspace", t.TempDir(), "--allow", "https://Course.Example.org:443"}, h.env)
	}()
	waitFor(t, "the service", func() bool { return openLine.MatchString(out.String()) })
	if !strings.Contains(out.String(), "Allowed without asking: https://course.example.org\n") {
		t.Errorf("the allowed origin is not shown:\n%s", out)
	}
	cancel()
	if code := <-done; code != ExitOK {
		t.Errorf("exit %d: %s", code, h.stderr)
	}
}
