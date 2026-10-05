//go:build !windows

package sshtarget

import (
	"errors"
	"io"
	"net"
	"os"
	"time"

	"golang.org/x/crypto/ssh/agent"
)

// DialAgent opens the SSH agent named by SSH_AUTH_SOCK (design §5.3).
func DialAgent() (agent.ExtendedAgent, io.Closer, error) {
	path := os.Getenv("SSH_AUTH_SOCK")
	if path == "" {
		return nil, nil, errors.New("SSH_AUTH_SOCK is not set")
	}
	conn, err := net.DialTimeout("unix", path, 5*time.Second)
	if err != nil {
		return nil, nil, err
	}
	return agent.NewClient(conn), conn, nil
}
