package sshtarget

import (
	"context"
	"errors"
	"fmt"

	"golang.org/x/crypto/ssh"

	"parallax/connector/internal/protocol"
	"parallax/connector/internal/target"
)

// forwardProbe is where the forwarding stage opens its direct-tcpip channel: loopback on the
// target, on a port nothing is expected to serve. Whether something answers does not matter.
const forwardProbe = "127.0.0.1:1"

// checkForwarding is the forwarding stage (design §5.1): open a direct-tcpip channel to
// 127.0.0.1 and read why it fails. "Administratively prohibited" is forwarding_denied; "connect
// failed" means forwarding works and nothing listens there, which passes; so does an open
// channel.
func checkForwarding(ctx context.Context, client *ssh.Client) error {
	conn, err := client.DialContext(ctx, "tcp", forwardProbe)
	if err == nil {
		conn.Close()
		return nil
	}
	var oe *ssh.OpenChannelError
	switch {
	case ctx.Err() != nil:
		return ctx.Err()
	case errors.As(err, &oe) && oe.Reason == ssh.Prohibited:
		return &target.Failure{Code: protocol.CodeForwardingDenied, Detail: fmt.Sprintf("administratively prohibited (%s)", sanitize(oe.Message))}
	case errors.As(err, &oe) && oe.Reason == ssh.ConnectionFailed:
		return nil
	}
	return &target.Failure{Code: protocol.CodeTunnelUnavailable, Detail: "the host could not open a forwarding channel: " + firstLine(err)}
}
