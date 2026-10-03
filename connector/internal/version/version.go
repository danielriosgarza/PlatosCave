// Package version reports the connector build version.
package version

// Version and Commit are overridden at link time with
// -ldflags "-X parallax/connector/internal/version.Version=... -X parallax/connector/internal/version.Commit=...".
var (
	Version = "0.0.0-dev"
	Commit  = "unknown"
)

// String returns the connector version.
func String() string {
	return Version
}
