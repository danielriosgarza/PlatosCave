import { describe, expect, test } from 'vitest';
import { EXECUTION_BUFFER_BYTES, OutputBuffer, SESSION_BUFFER_BYTES } from './buffer';

/**
 * The relay's output buffer (docs/design/connector.md §10.6): 256 KiB per execution, 8 MiB per
 * session with finished executions evicted first, replay by event sequence, and a new epoch per
 * buffer.
 */

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

const stream = (executionId: string, text: string) => ({
  executionId,
  generation: 0,
  kind: 'output' as const,
  output: { output_type: 'stream' as const, name: 'stdout' as const, text },
});

describe('output buffer', () => {
  test('numbers events from 1 and replays those after a position in the same epoch', () => {
    const buffer = new OutputBuffer();
    expect(buffer.eventSeq).toBe(0);
    const first = buffer.append(stream(A, 'one'));
    const second = buffer.append(stream(B, 'two'));
    const third = buffer.append(stream(A, 'three'));
    expect([first.eventSeq, second.eventSeq, third.eventSeq]).toEqual([1, 2, 3]);
    expect(buffer.eventSeq).toBe(3);
    const replay = buffer.replay({ epoch: buffer.epoch, afterEventSeq: 1 });
    expect(replay.sameEpoch).toBe(true);
    expect(replay.events.map((e) => e.eventSeq)).toEqual([2, 3]);
    expect(replay.events.every((e) => e.truncated === undefined)).toBe(true);
  });

  test('a resume from another epoch gets every held event and is told the position is lost', () => {
    const buffer = new OutputBuffer();
    buffer.append(stream(A, 'one'));
    buffer.append(stream(A, 'two'));
    const other = new OutputBuffer();
    expect(other.epoch).not.toBe(buffer.epoch);
    const replay = buffer.replay({ epoch: other.epoch, afterEventSeq: 2 });
    expect(replay.sameEpoch).toBe(false);
    expect(replay.events.map((e) => e.eventSeq)).toEqual([1, 2]);
    expect(buffer.replay().events).toHaveLength(2);
  });

  test('keeps the last 256 KiB of one execution and marks the first kept event truncated', () => {
    const buffer = new OutputBuffer();
    const chunk = 'x'.repeat(64 * 1024);
    for (let i = 0; i < 6; i++) buffer.append(stream(A, chunk));
    expect(buffer.size).toBeLessThanOrEqual(EXECUTION_BUFFER_BYTES);
    const replay = buffer.replay({ epoch: buffer.epoch, afterEventSeq: 0 });
    expect(replay.events.length).toBeLessThan(6);
    expect(replay.events[0]?.truncated).toBe(true);
    expect(replay.events.slice(1).every((e) => e.truncated === undefined)).toBe(true);
    expect(replay.events.at(-1)?.eventSeq).toBe(6);
    // A browser that had already seen the dropped events is not told they were dropped.
    const seen = replay.events[0]?.eventSeq ?? 0;
    const later = buffer.replay({ epoch: buffer.epoch, afterEventSeq: seen });
    expect(later.events.every((e) => e.truncated === undefined)).toBe(true);
  });

  test('keeps a session within 8 MiB, evicting finished executions oldest first', () => {
    const buffer = new OutputBuffer();
    const chunk = 'y'.repeat(200 * 1024);
    // 41 executions of 200 KiB each exceed 8 MiB; every one is finished except the last.
    const ids: string[] = [];
    for (let i = 0; i < 41; i++) {
      const id = `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`;
      ids.push(id);
      buffer.append(stream(id, chunk));
      if (i < 40) buffer.finish(id);
    }
    expect(buffer.size).toBeLessThanOrEqual(SESSION_BUFFER_BYTES);
    const replay = buffer.replay();
    const held = new Set(replay.events.map((e) => e.executionId));
    expect(held.has(ids[0] as string)).toBe(false);
    expect(held.has(ids[40] as string)).toBe(true);
    expect(replay.truncated).toContain(ids[0]);
  });

  test('when only running executions remain, their oldest events are dropped', () => {
    const buffer = new OutputBuffer({ perExecution: 1024 * 1024, perSession: 300 * 1024 });
    const chunk = 'z'.repeat(100 * 1024);
    for (let i = 0; i < 4; i++) buffer.append(stream(i % 2 ? B : C, chunk));
    expect(buffer.size).toBeLessThanOrEqual(300 * 1024);
    // C's events were the oldest: both are gone, and a replay says so; B's are whole.
    const replay = buffer.replay();
    expect(replay.events.map((e) => e.executionId)).toEqual([B, B]);
    expect(replay.truncated).toEqual([C]);
  });
});
