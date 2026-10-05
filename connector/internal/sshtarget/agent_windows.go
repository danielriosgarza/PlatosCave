//go:build windows

package sshtarget

import (
	"io"
	"os"

	"golang.org/x/crypto/ssh/agent"
)

// agentPipe is the Windows OpenSSH agent's named pipe.
const agentPipe = `\\.\pipe\openssh-ssh-agent`

// DialAgent opens the Windows OpenSSH agent's named pipe as a file, so no extra dependency is
// needed (design §5.3).
func DialAgent() (agent.ExtendedAgent, io.Closer, error) {
	f, err := os.OpenFile(agentPipe, os.O_RDWR, 0)
	if err != nil {
		return nil, nil, err
	}
	return agent.NewClient(f), f, nil
}
