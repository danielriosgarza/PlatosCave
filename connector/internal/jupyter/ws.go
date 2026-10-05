package jupyter

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/coder/websocket"

	"parallax/connector/internal/link"
	"parallax/connector/internal/protocol"
)

// MaxChannelMessage bounds one kernel-channel message in either direction.
const MaxChannelMessage = 32 << 20

// DialChannel opens a kernel channel WebSocket with the token in the Authorization header and
// the server's own origin, without a subprotocol (Jupyter's JSON text dialect).
func (c *Client) DialChannel(ctx context.Context, uri string) (*websocket.Conn, error) {
	h := http.Header{}
	h.Set("Authorization", "token "+c.token)
	h.Set("Origin", c.Origin())
	u := "ws" + strings.TrimPrefix(c.target(uri), "http")
	conn, resp, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPClient: c.hc, HTTPHeader: h})
	if err != nil {
		if resp != nil && (resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden) {
			return nil, &Failure{Code: protocol.CodeTokenRejected, Detail: "Jupyter refused the kernel channel"}
		}
		if resp != nil && resp.StatusCode == http.StatusNotFound {
			return nil, &Failure{Code: protocol.CodeKernelStartFailed, Detail: "the kernel no longer exists"}
		}
		return nil, &Failure{Code: protocol.CodeNotebookServiceUnreachable, Detail: "the kernel channel could not be opened"}
	}
	conn.SetReadLimit(MaxChannelMessage)
	return conn, nil
}

// Bridge carries one kernel channel between Jupyter and a link stream until either side closes
// it: every WebSocket message becomes frames ending with END (TEXT on text messages), and frames
// from the link are reassembled into messages. Credit is granted as data is handed on.
func Bridge(ctx context.Context, conn *websocket.Conn, s *link.Stream) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var byLink atomic.Bool // the relay closed the channel; Jupyter's answer is not passed back
	done := make(chan struct{}, 2)
	go func() { toLink(ctx, conn, s, &byLink); cancel(); done <- struct{}{} }()
	go func() { toJupyter(ctx, conn, s, &byLink); cancel(); done <- struct{}{} }()
	<-done
	<-done
	conn.CloseNow()
	s.Close()
}

func toLink(ctx context.Context, conn *websocket.Conn, s *link.Stream, byLink *atomic.Bool) {
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			if ctx.Err() != nil || byLink.Load() {
				return
			}
			code, reason := int(websocket.CloseStatus(err)), ""
			var ce websocket.CloseError
			if errors.As(err, &ce) {
				reason = ce.Reason
			}
			if code < 1000 || code > 4999 || code == 1005 || code == 1006 {
				code, reason = 1011, "the kernel channel was lost"
			}
			if len(reason) > 123 {
				reason = reason[:123]
			}
			_ = s.Send(context.WithoutCancel(ctx), &protocol.WSClose{StreamID: s.ID, Code: code, Reason: reason})
			return
		}
		flags := protocol.FlagEnd
		if typ == websocket.MessageText {
			flags |= protocol.FlagText
		}
		if err := s.Write(ctx, data, flags); err != nil {
			return
		}
	}
}

func toJupyter(ctx context.Context, conn *websocket.Conn, s *link.Stream, byLink *atomic.Bool) {
	var msg []byte
	for {
		f, err := s.Recv(ctx)
		if err != nil {
			var wc *link.WSCloseError
			if errors.As(err, &wc) {
				byLink.Store(true)
				code := websocket.StatusCode(wc.Code)
				if wc.Code == 1005 || wc.Code == 1006 || wc.Code == 1015 {
					code = websocket.StatusNormalClosure
				}
				conn.Close(code, wc.Reason)
			}
			return
		}
		if len(msg)+len(f.Payload) > MaxChannelMessage {
			_ = s.Reset(ctx, protocol.CodeBodyTooLarge, "a kernel channel message exceeds 32 MiB")
			return
		}
		msg = append(msg, f.Payload...)
		// The data is handed on to the message being assembled, which is bounded above; a message
		// larger than the window would otherwise never complete.
		if len(f.Payload) > 0 {
			if err := s.Grant(ctx, len(f.Payload)); err != nil {
				return
			}
		}
		if f.Flags&protocol.FlagEnd == 0 {
			continue
		}
		typ := websocket.MessageBinary
		if f.Flags&protocol.FlagText != 0 {
			typ = websocket.MessageText
		}
		if err := conn.Write(ctx, typ, msg); err != nil {
			return
		}
		msg = nil
	}
}
