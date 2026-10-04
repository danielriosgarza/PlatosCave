import { describe, expect, test } from 'vitest';
import { Demux } from './executor';

/** One frame of Docker's multiplexed attach stream. */
const mux = (type: number, text: string | Buffer) => {
  const payload = Buffer.isBuffer(text) ? text : Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = type;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

describe('attach stream demultiplexing', () => {
  test('stdout and stderr are separated across arbitrary chunk boundaries', () => {
    const demux = new Demux(1024);
    const stream = Buffer.concat([mux(1, 'out-1 '), mux(2, 'err'), mux(1, 'out-2')]);
    for (let i = 0; i < stream.length; i += 3) demux.push(stream.subarray(i, i + 3));
    expect(demux.stdout.toString()).toBe('out-1 out-2');
    expect(demux.stderrTail).toBe('err');
    expect(demux.overflow).toBe(false);
  });

  test('stdout keeps at most cap + 1 bytes and flags the overflow', () => {
    const demux = new Demux(10);
    demux.push(mux(1, 'x'.repeat(8)));
    demux.push(mux(1, 'y'.repeat(8)));
    expect(demux.stdout.length).toBe(11);
    expect(demux.overflow).toBe(true);
  });

  test('stderr keeps the last 8 KiB of valid UTF-8', () => {
    const demux = new Demux(10);
    demux.push(mux(2, 'a'.repeat(9000)));
    demux.push(mux(2, 'é'.repeat(5000)));
    const tail = demux.stderrTail;
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(8192);
    expect(tail.endsWith('é')).toBe(true);
    expect(tail).not.toContain('�');
  });
});
