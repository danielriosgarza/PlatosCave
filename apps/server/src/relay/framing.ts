/**
 * Binary frames and flow control of the connector link (docs/design/connector.md §4.5). A frame
 * is a 4-byte big-endian stream id, a 1-byte flags field and the payload; `vectors/frames.json`
 * pins the bytes and framing.test.ts reproduces it. Every stream has a credit window in each
 * direction: a sender may have at most that many payload bytes unacknowledged, and the receiver
 * grants more with `window` as it hands data on. Sending beyond it is `limit_exceeded`.
 */

/** Last frame of an HTTP body or of a WebSocket message. */
export const FLAG_END = 0x01;
/** The WebSocket message is text; set on every frame of it. */
export const FLAG_TEXT = 0x02;
const KNOWN_FLAGS = FLAG_END | FLAG_TEXT;
export const FRAME_HEADER_BYTES = 5;
const MAX_STREAM_ID = 0xffffffff;

export interface Frame {
  streamId: number;
  flags: number;
  payload: Buffer;
}

/** Why bytes are not a frame; the names of `vectors/frames.json`. */
export type FrameRule =
  | 'frame_too_short'
  | 'stream_id_zero'
  | 'reserved_flags'
  | 'payload_too_large';

export type DecodedFrame = { ok: true; frame: Frame } | { ok: false; rule: FrameRule };

/** Reads one binary WebSocket message as a frame, refusing anything §4.5 does not allow. */
export function decodeFrame(data: Buffer, maxPayload: number): DecodedFrame {
  if (data.length < FRAME_HEADER_BYTES) return { ok: false, rule: 'frame_too_short' };
  const streamId = data.readUInt32BE(0);
  const flags = data.readUInt8(4);
  if (streamId === 0) return { ok: false, rule: 'stream_id_zero' };
  if ((flags & ~KNOWN_FLAGS) !== 0) return { ok: false, rule: 'reserved_flags' };
  if (data.length - FRAME_HEADER_BYTES > maxPayload) {
    return { ok: false, rule: 'payload_too_large' };
  }
  return { ok: true, frame: { streamId, flags, payload: data.subarray(FRAME_HEADER_BYTES) } };
}

/** The bytes of one frame; throws on a frame `decodeFrame` would refuse. */
export function encodeFrame(frame: Frame, maxPayload: number): Buffer {
  const { streamId, flags, payload } = frame;
  if (!Number.isInteger(streamId) || streamId < 1 || streamId > MAX_STREAM_ID) {
    throw new Error(`stream id ${streamId} is outside 1…2^32-1`);
  }
  if ((flags & ~KNOWN_FLAGS) !== 0) throw new Error(`flags ${flags} set a reserved bit`);
  if (payload.length > maxPayload) {
    throw new Error(`payload of ${payload.length} bytes is too large`);
  }
  const header = Buffer.alloc(FRAME_HEADER_BYTES);
  header.writeUInt32BE(streamId, 0);
  header.writeUInt8(flags, 4);
  return Buffer.concat([header, payload]);
}

/** The most credit a window may hold, so grants cannot overflow it. */
export const MAX_WINDOW = 0x7fffffff;

/**
 * One direction of one stream's flow control. The sender's side `consume`s credit before it
 * sends; the receiver's side `consume`s what arrives and `grant`s as it hands data on. A
 * `false` from either is `stream_reset limit_exceeded` (§4.5).
 */
export class CreditWindow {
  private credit: number;

  constructor(initial: number) {
    if (!Number.isInteger(initial) || initial < 0 || initial > MAX_WINDOW) {
      throw new Error(`initial window ${initial} is out of range`);
    }
    this.credit = initial;
  }

  /** Bytes that may still be in flight. */
  get available(): number {
    return this.credit;
  }

  /** Spends `bytes` of credit; false (and nothing spent) when the window is smaller. */
  consume(bytes: number): boolean {
    if (bytes > this.credit) return false;
    this.credit -= bytes;
    return true;
  }

  /** Adds `credit`; false (and nothing added) when the window would exceed MAX_WINDOW. */
  grant(credit: number): boolean {
    if (!Number.isInteger(credit) || credit < 1 || this.credit + credit > MAX_WINDOW) return false;
    this.credit += credit;
    return true;
  }
}
