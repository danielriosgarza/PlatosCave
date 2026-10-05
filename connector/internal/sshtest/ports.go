package sshtest

import (
	"math/rand/v2"
	"net"
	"strconv"
)

// QuietPorts picks start ports for a remote session in tests: random ports in 20000–32767,
// inside the design's start range (20000–59999) and below the ephemeral ranges of Linux (from
// 32768) and macOS (from 49152), each free on 127.0.0.1 when picked. A port from the ephemeral
// range may already be taken by any connection the machine makes, which turns one start into two
// attempts; tests that count servers use this so each start binds on its first attempt.
func QuietPorts() int {
	for {
		p := 20000 + rand.IntN(32768-20000)
		ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p)))
		if err == nil {
			ln.Close()
			return p
		}
	}
}
