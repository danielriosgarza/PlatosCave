// Command parallax-connector is the compute connector. Phase 0 only prints its version.
package main

import (
	"fmt"

	"parallax/connector/internal/version"
)

func main() {
	fmt.Println(version.String())
}
