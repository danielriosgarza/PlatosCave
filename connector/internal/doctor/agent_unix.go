//go:build !windows

package doctor

import (
	"net"
	"time"
)

func dialAgent(path string) error {
	conn, err := net.DialTimeout("unix", path, 2*time.Second)
	if err != nil {
		return err
	}
	return conn.Close()
}
