package sshtarget

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"

	"golang.org/x/term"
)

// TTY is the connector's controlling terminal as a Terminal: answers are read from In, a
// passphrase or hidden answer without echo through golang.org/x/term. One prompt is open at a
// time. A prompt whose context ends stops waiting, and the line typed for it later is discarded.
type TTY struct {
	In  *os.File
	Out io.Writer

	// turn holds the right to read In; a read that outlived its prompt keeps it until it ends.
	turn chan struct{}
	once sync.Once
}

// NewTTY returns the terminal on standard input and standard error.
func NewTTY() *TTY { return &TTY{In: os.Stdin, Out: os.Stderr} }

func (t *TTY) init() {
	t.once.Do(func() { t.turn = make(chan struct{}, 1) })
}

// Say prints a line.
func (t *TTY) Say(text string) { fmt.Fprintln(t.Out, text) }

// Ask prints prompt and reads one line.
func (t *TTY) Ask(ctx context.Context, prompt string, echo bool) ([]byte, error) {
	t.init()
	select {
	case t.turn <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	fmt.Fprint(t.Out, prompt)
	type answer struct {
		b   []byte
		err error
	}
	got := make(chan answer, 1)
	go func() {
		var b []byte
		var err error
		if echo {
			b, err = readLine(t.In)
		} else {
			b, err = term.ReadPassword(int(t.In.Fd()))
			fmt.Fprintln(t.Out)
		}
		got <- answer{b, err}
	}()
	select {
	case a := <-got:
		<-t.turn
		return a.b, a.err
	case <-ctx.Done():
		fmt.Fprintln(t.Out, "\nNo answer in time; the connector stopped waiting. Press Enter to continue.")
		go func() {
			a := <-got
			clear(a.b)
			<-t.turn
		}()
		return nil, ctx.Err()
	}
}

// readLine reads up to a newline one byte at a time, so nothing after the line is consumed.
func readLine(r io.Reader) ([]byte, error) {
	var out []byte
	b := make([]byte, 1)
	for len(out) < 4096 {
		n, err := r.Read(b)
		if n == 1 {
			if b[0] == '\n' {
				if l := len(out); l > 0 && out[l-1] == '\r' {
					out = out[:l-1]
				}
				return out, nil
			}
			out = append(out, b[0])
		}
		if err != nil {
			if errors.Is(err, io.EOF) && len(out) > 0 {
				return out, nil
			}
			return nil, err
		}
	}
	return out, nil
}
