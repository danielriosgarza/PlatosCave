// Command parallax-connector is the Parallax compute connector (docs/design/connector.md).
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"parallax/connector/internal/cli"
)

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := cli.Main(ctx, os.Args[1:], cli.DefaultEnv())
	stop()
	os.Exit(code)
}
