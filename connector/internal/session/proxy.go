package session

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"

	"parallax/connector/internal/jupyter"
	"parallax/connector/internal/link"
	"parallax/connector/internal/protocol"
)

// Stream serves `http` and `ws_open` for a ready session. Anything outside the allowlist is
// reset with path_not_allowed; nothing reaches Jupyter that the table of design §7 refuses.
func (m *Manager) Stream(_ context.Context, l *link.Link, msg protocol.Message, st *link.Stream) {
	m.setLink(l)
	s := m.get(st.SessionID)
	if s == nil {
		reset(st, protocol.CodeUnknownSession, "")
		return
	}
	s.mu.Lock()
	state, rt := s.state, s.runtime
	s.mu.Unlock()
	if state != StateReady || rt == nil {
		reset(st, protocol.CodeNotReady, "the session is "+state)
		return
	}
	scope := jupyter.Scope{Kernels: &s.kernels, ContentRoot: rt.ContentRoot}
	switch msg := msg.(type) {
	case *protocol.HTTP:
		req, err := jupyter.CheckHTTP(msg.Purpose, msg.Method, msg.Path, scope)
		if err != nil {
			refuseStream(st, err)
			return
		}
		go m.serveHTTP(s, rt.Client, msg, req, st)
	case *protocol.WSOpen:
		req, err := jupyter.CheckWS(msg.Path, msg.Protocols, scope)
		if err != nil {
			refuseStream(st, err)
			return
		}
		go m.serveWS(s, rt.Client, req, st)
	default:
		reset(st, protocol.CodeUnsupportedMessage, "")
	}
}

func reset(st *link.Stream, code protocol.Code, detail string) {
	_ = st.Reset(context.Background(), code, clip(detail))
}

func refuseStream(st *link.Stream, err error) {
	var r *jupyter.Refusal
	if errors.As(err, &r) {
		reset(st, r.Code, r.Detail)
		return
	}
	var f *jupyter.Failure
	if errors.As(err, &f) {
		reset(st, f.Code, f.Detail)
		return
	}
	reset(st, protocol.CodeInternal, "")
}

// errLength is a streamed body whose total differs from its contentLength.
var errLength = errors.New("the body does not match its announced length")

// readBody reads a whole small body from the stream.
func readBody(ctx context.Context, st *link.Stream, length int64, limit int64) ([]byte, error) {
	if length > limit {
		return nil, &jupyter.Refusal{Code: protocol.CodeBodyTooLarge, Detail: fmt.Sprintf("the body exceeds %d bytes", limit)}
	}
	var buf bytes.Buffer
	if err := copyBody(ctx, st, &buf, length); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// copyBody copies a streamed request body of exactly length bytes to w, granting credit as it
// hands data on.
func copyBody(ctx context.Context, st *link.Stream, w io.Writer, length int64) error {
	var n int64
	for {
		f, err := st.Recv(ctx)
		if err != nil {
			return err
		}
		n += int64(len(f.Payload))
		if n > length {
			return errLength
		}
		if _, err := w.Write(f.Payload); err != nil {
			return err
		}
		if len(f.Payload) > 0 {
			if err := st.Grant(ctx, len(f.Payload)); err != nil {
				return err
			}
		}
		if f.End() {
			if n != length {
				return errLength
			}
			return nil
		}
	}
}

func (m *Manager) serveHTTP(s *Session, c *jupyter.Client, msg *protocol.HTTP, req jupyter.Request, st *link.Stream) {
	limit := jupyter.MaxBody(msg.Purpose)
	deadline := sessionDeadline
	if msg.Purpose == jupyter.PurposeContents {
		deadline = contentsDeadline
	}
	ctx, cancel := context.WithTimeout(s.ctx, deadline)
	defer cancel()
	defer st.Close()

	var length int64
	if msg.ContentLength != nil {
		length = *msg.ContentLength
	}
	if msg.Body != "stream" {
		length = 0
	}
	if length > limit {
		reset(st, protocol.CodeBodyTooLarge, fmt.Sprintf("the body exceeds %d bytes", limit))
		return
	}

	// Bodies the connector must read before passing on: they are small and checked whole.
	var body io.Reader
	switch req.Op {
	case jupyter.OpStartKernel, jupyter.OpContentsPost:
		if msg.Body != "stream" {
			reset(st, protocol.CodePathNotAllowed, "this request needs a JSON body")
			return
		}
		data, err := readBody(ctx, st, length, jupyter.MaxKernelStartBody)
		if err != nil {
			bodyFailed(st, err)
			return
		}
		if req.Op == jupyter.OpStartKernel {
			_, err = jupyter.CheckKernelStart(data)
		} else {
			err = jupyter.CheckContentsPost(data)
		}
		if err != nil {
			refuseStream(st, err)
			return
		}
		body = bytes.NewReader(data)
	default:
		if msg.Body == "stream" {
			pr, pw := io.Pipe()
			go func() { pw.CloseWithError(copyBody(ctx, st, pw, length)) }()
			body = pr
			defer pr.Close()
		}
	}

	resp, err := c.Do(ctx, msg.Method, req.Path, req.RawQuery, msg.Headers, body, length)
	if err != nil {
		switch {
		case errors.Is(err, errLength):
			reset(st, protocol.CodeInvalidMessage, errLength.Error())
		case ctx.Err() != nil:
			reset(st, protocol.CodeNotebookServiceUnreachable, "Jupyter did not answer in time")
		default:
			reset(st, protocol.CodeNotebookServiceUnreachable, "Jupyter did not answer")
		}
		return
	}
	defer resp.Body.Close()
	if resp.ContentLength > limit {
		reset(st, protocol.CodeBodyTooLarge, fmt.Sprintf("the response exceeds %d bytes", limit))
		return
	}
	headers := jupyter.FilterResponseHeaders(resp.Header)

	switch req.Op {
	case jupyter.OpStartKernel, jupyter.OpListKernels, jupyter.OpDeleteKernel:
		// Small answers that the session reads: the kernel ids it creates and may reach.
		data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
		if err != nil || int64(len(data)) > limit {
			reset(st, protocol.CodeBodyTooLarge, "the response exceeds the limit")
			return
		}
		ok := resp.StatusCode/100 == 2
		switch {
		case req.Op == jupyter.OpStartKernel && ok:
			id, err := jupyter.KernelID(data)
			if err != nil {
				reset(st, protocol.CodeKernelStartFailed, err.Error())
				return
			}
			s.kernels.Add(id)
			m.persist()
			m.logf("Session %s started kernel %s.", s.ID, id)
		case req.Op == jupyter.OpListKernels && ok:
			if data, err = jupyter.FilterKernelList(data, &s.kernels); err != nil {
				reset(st, protocol.CodeNotebookServiceUnreachable, err.Error())
				return
			}
			headers["content-length"] = strconv.Itoa(len(data))
		case req.Op == jupyter.OpDeleteKernel && ok:
			s.kernels.Remove(req.KernelID)
			m.persist()
		}
		m.respond(ctx, st, resp.StatusCode, headers, bytes.NewReader(data), limit)
	default:
		m.respond(ctx, st, resp.StatusCode, headers, resp.Body, limit)
	}
}

func bodyFailed(st *link.Stream, err error) {
	switch {
	case errors.Is(err, errLength):
		reset(st, protocol.CodeInvalidMessage, errLength.Error())
	default:
		refuseStream(st, err)
	}
}

// respond sends http_head and then the body as frames ending with END, resetting the stream
// with body_too_large if the body passes the limit.
func (m *Manager) respond(ctx context.Context, st *link.Stream, status int, headers protocol.Headers, body io.Reader, limit int64) {
	hasBody := status != http.StatusNoContent && status != http.StatusNotModified && headers["content-length"] != "0"
	mode := "none"
	if hasBody {
		mode = "stream"
	}
	if err := st.Send(ctx, &protocol.HTTPHead{StreamID: st.ID, Status: status, Headers: headers, Body: mode}); err != nil || !hasBody {
		return
	}
	buf := make([]byte, 32<<10)
	var n int64
	for {
		k, err := body.Read(buf)
		if k > 0 {
			n += int64(k)
			if n > limit {
				reset(st, protocol.CodeBodyTooLarge, "the response exceeds the limit")
				return
			}
			if werr := st.Write(ctx, buf[:k], 0); werr != nil {
				if ctx.Err() != nil {
					reset(st, protocol.CodeStreamCancelled, "the response made no progress before its deadline")
				}
				return
			}
		}
		if err == io.EOF {
			_ = st.Write(ctx, nil, protocol.FlagEnd)
			return
		}
		if err != nil {
			reset(st, protocol.CodeNotebookServiceUnreachable, "Jupyter's answer was cut off")
			return
		}
	}
}

func (m *Manager) serveWS(s *Session, c *jupyter.Client, req jupyter.Request, st *link.Stream) {
	dctx, cancel := context.WithTimeout(s.ctx, sessionDeadline)
	conn, err := c.DialChannel(dctx, req.Path, req.RawQuery)
	cancel()
	if err != nil {
		refuseStream(st, err)
		return
	}
	if err := st.Send(s.ctx, &protocol.WSOpened{StreamID: st.ID}); err != nil {
		conn.CloseNow()
		st.Close()
		return
	}
	jupyter.Bridge(s.ctx, conn, st)
}
