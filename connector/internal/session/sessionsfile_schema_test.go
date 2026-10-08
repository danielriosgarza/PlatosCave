package session

import (
	"testing"

	"parallax/connector/internal/state"
	schemas "parallax/connector/protocol"
)

// TestSessionsFileMatchesSchema reads the protocol's sessions example and checks the bytes
// writeFile produces for it against state.schema.json#/$defs/Sessions.
func TestSessionsFileMatchesSchema(t *testing.T) {
	example, err := schemas.V1.ReadFile("v1/examples/state-Sessions.json")
	if err != nil {
		t.Fatal(err)
	}
	store := state.Open(t.TempDir())
	if err := store.WritePrivate(state.SessionsFile, example); err != nil {
		t.Fatal(err)
	}
	f, err := readFile(store)
	if err != nil {
		t.Fatalf("state-Sessions.json example: %v", err)
	}
	if err := writeFile(store, f); err != nil {
		t.Fatal(err)
	}
	written, err := store.ReadFile(state.SessionsFile)
	if err != nil {
		t.Fatal(err)
	}
	validSessionsFile(t, compileSessionsSchema(t), written)
}
