package sshtarget

import (
	"context"
	"net"
	"strconv"

	"golang.org/x/crypto/ssh"

	"parallax/connector/internal/jupyter"
)

// tunnelDial is the session's tunnel (design §6, §8 rule 5): every connection is a direct-tcpip
// channel of the SSH connection to 127.0.0.1:<port> on the host. The destination is fixed when
// the session opens; the address a request names is ignored, so no later message can change a
// host or a port. The HTTP and WebSocket bridge of the session (P3-04's proxy, through
// jupyter.Client) reaches Jupyter only through it.
func tunnelDial(client *ssh.Client, port int) jupyter.DialFunc {
	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	return func(ctx context.Context) (net.Conn, error) {
		return client.DialContext(ctx, "tcp", addr)
	}
}
