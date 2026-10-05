//go:build !linux && !windows

package jupyter

import "os/exec"

// startChild starts cmd. macOS has no way to tie a child's life to its parent, so the orphan
// sweep at start-up covers a connector that crashed (design §6).
func startChild(cmd *exec.Cmd) (<-chan error, func(), error) {
	if err := cmd.Start(); err != nil {
		return nil, nil, err
	}
	wait := make(chan error, 1)
	go func() { wait <- cmd.Wait() }()
	return wait, func() {}, nil
}
