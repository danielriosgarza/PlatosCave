package version

import "testing"

func TestStringIsNotEmpty(t *testing.T) {
	if String() == "" {
		t.Fatal("version.String() must not be empty")
	}
}

func TestCommitIsNotEmpty(t *testing.T) {
	if Commit == "" {
		t.Fatal("version.Commit must not be empty")
	}
}
