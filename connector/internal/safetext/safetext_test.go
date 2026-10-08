package safetext

import "testing"

// TestA29_SanitizeStripsTerminalControl (A29): text a host or a Jupyter child prints names the
// failing stage in the terminal log; escape sequences, C0 and C1 controls (including the
// one-byte CSI 0x9b) and format characters are removed before it is shown.
func TestA29_SanitizeStripsTerminalControl(t *testing.T) {
	cases := map[string]string{
		"a\x1b[1;31mb\u009b2Jc\x1bPq#0\x1b\\d\te​f\r\ng": "abcd ef\ng",
		"x\u009d0;title\u0007y":                          "xy",
		"bell\u0007 del\u007f c1\u0085 rlo‮evil":         "bell del c1 rloevil",
		"  kept indentation":                             "  kept indentation",
		"bad � byte":                                     "bad  byte",
	}
	for in, want := range cases {
		if got := Sanitize(in); got != want {
			t.Errorf("Sanitize(%q) = %q, want %q", in, got, want)
		}
	}
	if got := Line("Python 3\n(ipykernel)\u009b2J"); got != "Python 3 (ipykernel)" {
		t.Errorf("Line = %q", got)
	}
}

func TestClip(t *testing.T) {
	if got := Clip("héllo wörld", 5); got != "héll…" {
		t.Errorf("Clip = %q", got)
	}
	if got := Clip("short", 5); got != "short" {
		t.Errorf("Clip = %q", got)
	}
	if got := ClipTail("héllo wörld", 5); got != "…örld" {
		t.Errorf("ClipTail = %q", got)
	}
	if got := ClipTail("short", 5); got != "short" {
		t.Errorf("ClipTail = %q", got)
	}
}

// TestA29_UnterminatedEscapeKeepsLaterLines (A29): an escape sequence that never ends stops at
// its line, so the lines after it, which say why a start failed, are kept.
func TestA29_UnterminatedEscapeKeepsLaterLines(t *testing.T) {
	cases := map[string]string{
		"open \x1b]0;never ends\nnext line kept": "open \nnext line kept",
		"csi \u009b12\nlast line":                "csi \nlast line",
	}
	for in, want := range cases {
		if got := Sanitize(in); got != want {
			t.Errorf("Sanitize(%q) = %q, want %q", in, got, want)
		}
	}
}
