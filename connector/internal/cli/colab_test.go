package cli

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"parallax/connector/internal/protocol"
)

// TestRunOffersColabOnLinuxAndMacOSOnly: the colab target is offered on Linux (WSL included) and
// macOS, not by the native Windows connector, and `run` lists it in hello.targets.
func TestRunOffersColabOnLinuxAndMacOSOnly(t *testing.T) {
	for goos, want := range map[string]bool{"linux": true, "darwin": true, "windows": false} {
		if got := slices.Contains(personalTargets(goos), protocol.TargetColab); got != want {
			t.Errorf("%s offers colab: %v, want %v", goos, got, want)
		}
	}
	h, srv, _ := pairedHarness(t)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() { done <- Main(ctx, []string{"run"}, h.env) }()
	defer func() {
		cancel()
		<-done
	}()
	lctx, lcancel := context.WithTimeout(ctx, 10*time.Second)
	defer lcancel()
	l, err := srv.NextLink(lctx)
	if err != nil {
		t.Fatalf("no link: %v", err)
	}
	if got := strings.Join(l.Hello.Targets, ","); got != "local,ssh,colab" {
		t.Errorf("hello.targets = %s", got)
	}
}
