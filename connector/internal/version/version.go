// Package version reports the connector build version.
package version

// Version is overridden at link time with -ldflags "-X parallax/connector/internal/version.Version=...".
var Version = "0.0.0-dev"

// String returns the connector version.
func String() string {
	return Version
}
