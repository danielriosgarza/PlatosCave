import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  CreditWindow,
  decodeFrame,
  encodeFrame,
  FLAG_END,
  FLAG_TEXT,
  type FrameRule,
  MAX_WINDOW,
} from './framing';

interface Vector {
  name: string;
  hex?: string;
  streamId?: number;
  flags?: number;
  payloadText?: string;
  payloadHex?: string;
  repeat?: { byte: string; count: number };
  rule?: FrameRule;
}
const vectors = JSON.parse(
  readFileSync(
    new URL('../../../../connector/protocol/v1/vectors/frames.json', import.meta.url),
    'utf8',
  ),
) as { maxPayload: number; valid: Vector[]; invalid: Vector[] };
const { maxPayload } = vectors;

const payloadOf = (v: Vector) =>
  v.repeat
    ? Buffer.alloc(v.repeat.count, Number.parseInt(v.repeat.byte, 16))
    : v.payloadHex !== undefined
      ? Buffer.from(v.payloadHex, 'hex')
      : Buffer.from(v.payloadText ?? '', 'utf8');

/** The vector's bytes: its hex, or the header of its stream id and flags before its payload. */
function bytesOf(v: Vector): Buffer {
  if (v.hex !== undefined) return Buffer.from(v.hex, 'hex');
  const header = Buffer.alloc(5);
  header.writeUInt32BE(v.streamId ?? 0, 0);
  header.writeUInt8(v.flags ?? 0, 4);
  return Buffer.concat([header, payloadOf(v)]);
}

describe('frame vectors (vectors/frames.json)', () => {
  test('the vectors use the limit auth_ok announces', () => {
    expect(maxPayload).toBe(65536);
  });

  test.each(vectors.valid.map((v) => [v.name, v] as const))('decodes and encodes %s', (_, v) => {
    const decoded = decodeFrame(bytesOf(v), maxPayload);
    expect(decoded).toEqual({
      ok: true,
      frame: { streamId: v.streamId, flags: v.flags, payload: payloadOf(v) },
    });
    const frame = { streamId: v.streamId ?? 0, flags: v.flags ?? 0, payload: payloadOf(v) };
    expect(encodeFrame(frame, maxPayload).equals(bytesOf(v))).toBe(true);
  });

  test.each(vectors.invalid.map((v) => [v.name, v] as const))(
    'refuses %s with its rule',
    (_, v) => {
      expect(decodeFrame(bytesOf(v), maxPayload)).toEqual({ ok: false, rule: v.rule });
    },
  );

  test('encoding refuses what decoding refuses', () => {
    const payload = Buffer.alloc(0);
    expect(() => encodeFrame({ streamId: 0, flags: 0, payload }, maxPayload)).toThrow();
    expect(() => encodeFrame({ streamId: 2 ** 32, flags: 0, payload }, maxPayload)).toThrow();
    expect(() => encodeFrame({ streamId: 1, flags: 0x80, payload }, maxPayload)).toThrow();
    const big = Buffer.alloc(maxPayload + 1);
    expect(() => encodeFrame({ streamId: 1, flags: 0, payload: big }, maxPayload)).toThrow();
    expect(FLAG_END | FLAG_TEXT).toBe(3);
  });
});

describe('credit windows (§4.5)', () => {
  test('a sender may have at most the window in flight; grants extend it', () => {
    const window = new CreditWindow(262144);
    expect(window.consume(200000)).toBe(true);
    expect(window.available).toBe(62144);
    // limit_exceeded: the frame does not fit, and nothing is spent.
    expect(window.consume(62145)).toBe(false);
    expect(window.available).toBe(62144);
    expect(window.consume(62144)).toBe(true);
    expect(window.consume(1)).toBe(false);
    expect(window.grant(4096)).toBe(true);
    expect(window.consume(4096)).toBe(true);
    expect(window.available).toBe(0);
  });

  test('a grant is a positive integer and cannot overflow the window', () => {
    const window = new CreditWindow(MAX_WINDOW - 10);
    expect(window.grant(0)).toBe(false);
    expect(window.grant(1.5)).toBe(false);
    expect(window.grant(11)).toBe(false);
    expect(window.grant(10)).toBe(true);
    expect(window.available).toBe(MAX_WINDOW);
  });
});
