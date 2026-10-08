// Package safetext makes text that came from outside the connector (an SSH host, a Jupyter
// child process, a tool's output, a message) safe to print on a terminal, write to a log or put
// in a detail (design §5.3, §6). It is the connector's one sanitiser.
package safetext

import (
	"strings"
	"unicode"
	"unicode/utf8"
)

// Sanitize strips escape sequences (ESC, and the C1 CSI 0x9b and OSC 0x9d introducers), the
// other control characters (C0, DEL and C1), format characters (Cf: zero-width and bidirectional
// marks) and U+FFFD, so the text cannot move the cursor, rewrite what the terminal shows or hide
// characters. Line breaks are kept and a tab becomes a space; nothing is trimmed.
func Sanitize(s string) string {
	var b strings.Builder
	rs := []rune(s)
	for i := 0; i < len(rs); i++ {
		r := rs[i]
		if r == 0x1b || r == 0x9b || r == 0x9d {
			i = skipEscape(rs, i)
			continue
		}
		if r == '\n' {
			b.WriteRune(r)
			continue
		}
		if r == '\t' {
			b.WriteRune(' ')
			continue
		}
		if unicode.Is(unicode.Cc, r) || unicode.Is(unicode.Cf, r) || r == utf8.RuneError {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// Line is Sanitize for a value that must fit on one line: line breaks become spaces.
func Line(s string) string {
	return strings.ReplaceAll(Sanitize(s), "\n", " ")
}

// skipEscape returns the index of the last rune of the escape sequence starting at i. An
// unterminated sequence ends at the end of its line, so it cannot swallow the lines after it.
func skipEscape(rs []rune, i int) int {
	csi := rs[i] == 0x9b
	osc := rs[i] == 0x9d
	if rs[i] == 0x1b {
		if i+1 >= len(rs) {
			return i
		}
		switch rs[i+1] {
		case '[':
			csi = true
		case ']', 'P', '_', '^', 'X':
			osc = true
		default:
			return i + 1
		}
		i++
	}
	for j := i + 1; j < len(rs); j++ {
		switch {
		case rs[j] == '\n':
			return j - 1
		case csi && rs[j] >= 0x40 && rs[j] <= 0x7e:
			return j
		case osc && (rs[j] == 0x07 || rs[j] == 0x9c):
			return j
		case osc && rs[j] == 0x1b && j+1 < len(rs) && rs[j+1] == '\\':
			return j + 1
		}
	}
	return len(rs) - 1
}

// Clip keeps the start of s within n characters (runes), ending in "…" when it cut.
func Clip(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	return string([]rune(s)[:n-1]) + "…"
}

// ClipTail keeps the end of s within n characters (runes), starting with "…" when it cut: the
// end of a child's output is where it says why it failed.
func ClipTail(s string, n int) string {
	if n <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return "…" + string(r[len(r)-(n-1):])
}
