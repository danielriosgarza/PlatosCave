package sshtarget

import "strings"

// shellQuote quotes one argument for a POSIX shell (design §6): it wraps s in single quotes and
// writes each single quote inside it as quote, backslash, quote, quote, which closes the quoted
// text, adds an escaped quote and reopens it.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
