// Package protocol embeds the normative files of connector protocol v1 (docs/design/connector.md
// §4): the JSON Schemas, the error catalogue, the signing and frame vectors and the example
// messages. internal/protocol builds the codec on them; tests validate every fixture.
package protocol

import "embed"

// V1 holds v1/*.json, v1/examples/** and v1/vectors/**.
//
//go:embed v1/*.json v1/examples v1/vectors
var V1 embed.FS
