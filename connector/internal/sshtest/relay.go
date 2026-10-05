package sshtest

import (
	"net"
	"sync"
	"testing"
)

// Relay is a TCP relay on 127.0.0.1 in front of a server, standing in for the network between
// the connector and a host: Freeze makes it a black hole (a sleeping laptop, a dead Wi-Fi: the
// connection stays open and nothing arrives, so only a keepalive notices), Cut closes every
// connection (a host that went away or ended the allocation), and Refuse makes new connections
// be refused, as a host that is down refuses them.
type Relay struct {
	Addr string
	Host string
	Port int

	to string

	mu      sync.Mutex
	ln      net.Listener
	frozen  bool
	conns   []net.Conn
	waiting []chan struct{}
	wg      sync.WaitGroup
}

// NewRelay starts a relay to addr and stops it when the test ends.
func NewRelay(t testing.TB, addr string) *Relay {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	a := ln.Addr().(*net.TCPAddr)
	r := &Relay{Addr: ln.Addr().String(), Host: "127.0.0.1", Port: a.Port, to: addr, ln: ln}
	r.wg.Add(1)
	go r.serve(ln)
	t.Cleanup(r.Close)
	return r
}

func (r *Relay) serve(ln net.Listener) {
	defer r.wg.Done()
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		up, err := net.Dial("tcp", r.to)
		if err != nil {
			c.Close()
			continue
		}
		r.mu.Lock()
		r.conns = append(r.conns, c, up)
		r.mu.Unlock()
		go r.pipe(c, up)
		go r.pipe(up, c)
	}
}

// pipe copies until either side closes; while frozen, bytes are held back.
func (r *Relay) pipe(dst, src net.Conn) {
	defer dst.Close()
	defer src.Close()
	buf := make([]byte, 32<<10)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			r.waitThawed()
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (r *Relay) waitThawed() {
	r.mu.Lock()
	if !r.frozen {
		r.mu.Unlock()
		return
	}
	ch := make(chan struct{})
	r.waiting = append(r.waiting, ch)
	r.mu.Unlock()
	<-ch
}

// Freeze holds back every byte in both directions without closing anything.
func (r *Relay) Freeze() {
	r.mu.Lock()
	r.frozen = true
	r.mu.Unlock()
}

// Thaw lets bytes pass again.
func (r *Relay) Thaw() {
	r.mu.Lock()
	r.frozen = false
	for _, ch := range r.waiting {
		close(ch)
	}
	r.waiting = nil
	r.mu.Unlock()
}

// Cut closes every relayed connection; new connections still pass.
func (r *Relay) Cut() {
	r.mu.Lock()
	conns := r.conns
	r.conns = nil
	r.mu.Unlock()
	for _, c := range conns {
		c.Close()
	}
}

// Refuse stops listening, so new connections are refused (refuse=true), or listens again on
// the same port. Connections already relayed are not touched.
func (r *Relay) Refuse(refuse bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if refuse {
		if r.ln != nil {
			r.ln.Close()
			r.ln = nil
		}
		return
	}
	if r.ln != nil {
		return
	}
	ln, err := net.Listen("tcp", r.Addr)
	if err != nil {
		return
	}
	r.ln = ln
	r.wg.Add(1)
	go r.serve(ln)
}

// Close stops the relay and closes every connection.
func (r *Relay) Close() {
	r.Refuse(true)
	r.Thaw()
	r.Cut()
	r.wg.Wait()
}
