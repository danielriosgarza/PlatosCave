package session

import (
	"context"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"

	"parallax/connector/internal/protocol"
	"parallax/connector/internal/state"
	"parallax/connector/internal/target"
	schemas "parallax/connector/protocol"
)

// TestDescribeColabSession: the session line and the --confirm-sessions question name the Colab
// runtime, the account and the workspace, and never this computer or the connector's account.
func TestDescribeColabSession(t *testing.T) {
	var mu sync.Mutex
	var asked string
	e := newEnv(t, func(c *Config) {
		c.Targets[protocol.TargetColab] = struct{ target.Target }{} // declined, so never opened
		c.Confirm = func(_ context.Context, q string) bool {
			mu.Lock()
			defer mu.Unlock()
			asked = q
			return false
		}
	}, protocol.Limits{})
	e.send(&protocol.OpenSession{RequestID: reqA, SessionID: sessionA, Lease: lease(), Runtime: protocol.Runtime{Mode: protocol.RuntimeStart},
		Target: protocol.Target{Kind: protocol.TargetColab, User: "student", Auth: &protocol.AuthRef{Method: protocol.AuthAgent}, Workspace: "/content/work"}})
	expect[*protocol.Error](e)
	_, line, _ := strings.Cut(e.log.String(), "Session "+sessionA+" requested by Parallax ")
	line, _, _ = strings.Cut(line, "\n")
	device, _ := os.Hostname() // the device name a pairing gives by default
	mu.Lock()
	defer mu.Unlock()
	for _, s := range []string{line, asked} {
		if !strings.Contains(s, "on the Colab runtime as student in /content/work: start Jupyter") || strings.Contains(s, "this computer") ||
			strings.Contains(s, "the account running the connector") || (device != "" && strings.Contains(s, device)) {
			t.Errorf("%q", s)
		}
	}
}

// TestSessionsFileKeepsColabRecords: a colab record of sessions.json is read, written back and
// read again unchanged, as the schema allows, and its process is on the Colab runtime.
func TestSessionsFileKeepsColabRecords(t *testing.T) {
	example, err := schemas.V1.ReadFile("v1/examples/state-Sessions-colab.json")
	store := state.Open(t.TempDir())
	if err == nil {
		err = store.WritePrivate(state.SessionsFile, example)
	}
	f, err2 := readFile(store)
	if err != nil || err2 != nil {
		t.Fatalf("a colab record: %v %v", err, err2)
	}
	if err := writeFile(store, f); err != nil {
		t.Fatal(err)
	}
	written, _ := store.ReadFile(state.SessionsFile)
	validSessionsFile(t, compileSessionsSchema(t), written)
	if again, err := readFile(store); err != nil || !reflect.DeepEqual(again, f) || f.Sessions[0].Target.Kind != protocol.TargetColab {
		t.Fatalf("read back %+v, %v", again, err)
	}
	if got := where(f.Sessions[0]); got != "on the Colab runtime" {
		t.Errorf("the sweep's line names %q", got)
	}
}
