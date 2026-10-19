package sshtarget

import (
	"errors"
	"os"
	"os/exec"
)

// The native Windows connector does not offer the colab target (design §5.7): `run` gives its
// Target no Colab, so these are never reached.
func startProxy(*exec.Cmd, chan<- struct{}) error {
	return errors.New("the Windows connector does not run the colab program")
}

func endProxy(p *os.Process) { p.Kill() }
