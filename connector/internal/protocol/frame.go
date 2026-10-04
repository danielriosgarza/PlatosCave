package protocol

import (
	"encoding/binary"
	"fmt"
)

// Frame flags (design §4.5). Other bits must be zero.
const (
	FlagEnd  byte = 0x01 // last frame of an HTTP body or of a WebSocket message
	FlagText byte = 0x02 // the WebSocket message is text; set on every frame of it
)

// FrameHeaderSize is the stream id and the flags byte before a frame's payload.
const FrameHeaderSize = 5

// DefaultMaxPayload is the payload limit until auth_ok sets one.
const DefaultMaxPayload = 64 << 10

// Frame is one binary WebSocket message of the link: stream data.
type Frame struct {
	StreamID uint32
	Flags    byte
	Payload  []byte
}

// End reports whether the frame ends its body or message.
func (f Frame) End() bool { return f.Flags&FlagEnd != 0 }

// Text reports whether the frame belongs to a text WebSocket message.
func (f Frame) Text() bool { return f.Flags&FlagText != 0 }

// Frame rules, named as in vectors/frames.json.
const (
	RuleFrameTooShort   = "frame_too_short"
	RuleStreamIDZero    = "stream_id_zero"
	RuleReservedFlags   = "reserved_flags"
	RulePayloadTooLarge = "payload_too_large"
)

// FrameError is a frame that breaks one rule of design §4.5. On the link it ends the link with
// 4400.
type FrameError struct {
	Rule string
}

func (e *FrameError) Error() string { return "invalid frame: " + e.Rule }

// DecodeFrame parses a binary message. The payload aliases b.
func DecodeFrame(b []byte, maxPayload int) (Frame, error) {
	if len(b) < FrameHeaderSize {
		return Frame{}, &FrameError{RuleFrameTooShort}
	}
	f := Frame{StreamID: binary.BigEndian.Uint32(b), Flags: b[4], Payload: b[FrameHeaderSize:]}
	if err := f.check(maxPayload); err != nil {
		return Frame{}, err
	}
	return f, nil
}

func (f Frame) check(maxPayload int) error {
	switch {
	case f.StreamID == 0:
		return &FrameError{RuleStreamIDZero}
	case f.Flags&^(FlagEnd|FlagText) != 0:
		return &FrameError{RuleReservedFlags}
	case len(f.Payload) > maxPayload:
		return &FrameError{RulePayloadTooLarge}
	}
	return nil
}

// AppendFrame checks a frame and appends its encoding to dst.
func AppendFrame(dst []byte, f Frame, maxPayload int) ([]byte, error) {
	if err := f.check(maxPayload); err != nil {
		return dst, err
	}
	dst = binary.BigEndian.AppendUint32(dst, f.StreamID)
	dst = append(dst, f.Flags)
	return append(dst, f.Payload...), nil
}

// EncodeFrame returns a frame's encoding.
func EncodeFrame(f Frame, maxPayload int) ([]byte, error) {
	if len(f.Payload) > maxPayload {
		return nil, &FrameError{RulePayloadTooLarge}
	}
	out, err := AppendFrame(make([]byte, 0, FrameHeaderSize+len(f.Payload)), f, maxPayload)
	if err != nil {
		return nil, err
	}
	return out, nil
}

// String describes a frame without its payload.
func (f Frame) String() string {
	return fmt.Sprintf("frame{stream %d, flags %#02x, %d bytes}", f.StreamID, f.Flags, len(f.Payload))
}
