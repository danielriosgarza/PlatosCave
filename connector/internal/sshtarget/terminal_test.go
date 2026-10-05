package sshtarget

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
	"time"
)

// TestTTYAskReadsOneLine: an echoed answer is one line, nothing after it is consumed, and a
// prompt whose context ends stops waiting.
func TestTTYAskReadsOneLine(t *testing.T) {
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	defer w.Close()
	var out bytes.Buffer
	tty := &TTY{In: r, Out: &out}
	w.WriteString("424242\r\nnext\n")
	got, err := tty.Ask(context.Background(), "Code: ", true)
	if err != nil || string(got) != "424242" {
		t.Fatalf("answer %q, %v", got, err)
	}
	got, err = tty.Ask(context.Background(), "Again: ", true)
	if err != nil || string(got) != "next" {
		t.Fatalf("second answer %q, %v", got, err)
	}
	if !strings.Contains(out.String(), "Code: ") || !strings.Contains(out.String(), "Again: ") {
		t.Errorf("prompts %q", out.String())
	}

	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := tty.Ask(ctx, "Code: ", true); err == nil {
		t.Fatal("an unanswered prompt returned an answer")
	}
	// The line typed after the deadline goes to the abandoned prompt, not to the next one.
	w.WriteString("late\nfresh\n")
	got, err = tty.Ask(context.Background(), "Code: ", true)
	if err != nil || string(got) != "fresh" {
		t.Errorf("after a timed-out prompt: %q, %v", got, err)
	}
}
