import { describe, expect, test } from 'vitest';
import { type DerivedStatus, readDerivedStatus, UNSENT_AFTER_MS } from './derived';

const created = new Date('2026-10-01T08:00:00Z');
const status = (state: DerivedStatus['state']): DerivedStatus => ({
  state,
  job: 'reading.ingest',
  jobId: '00000000-0000-4000-8000-00000000beef',
  updatedAt: '2026-10-01T09:00:00.000Z',
});
const stopped = (state: DerivedStatus['state']) => ({
  ...status(state),
  state: 'failed',
  error: 'Processing stopped without a result',
});

describe('readDerivedStatus', () => {
  test('a pending status whose job ended without writing, or is gone, shows as failed', () => {
    for (const state of ['queued', 'running'] as const) {
      for (const ended of ['completed', 'failed', 'cancelled', null]) {
        expect(readDerivedStatus(status(state), created, ended)).toEqual(stopped(state));
      }
    }
  });

  test('a pending status whose job may still run reads as written, however old', () => {
    for (const state of ['queued', 'running'] as const) {
      for (const live of ['created', 'retry', 'active', undefined]) {
        expect(readDerivedStatus(status(state), created, live)).toEqual(status(state));
      }
    }
  });

  test('a pending status still naming no job a minute after it was marked was never sent, and shows as failed', () => {
    const marked = Date.parse('2026-10-01T09:00:00.000Z');
    for (const state of ['queued', 'running'] as const) {
      const unsent = { ...status(state), jobId: null };
      expect(readDerivedStatus(unsent, created, undefined, marked + UNSENT_AFTER_MS + 1)).toEqual({
        ...unsent,
        state: 'failed',
        error: 'Processing stopped without a result',
      });
      // Within the minute the job is still being sent.
      expect(readDerivedStatus(unsent, created, undefined, marked + 1_000)).toEqual(unsent);
    }
    const failed = { ...status('failed'), jobId: null };
    expect(readDerivedStatus(failed, created, undefined, marked + 3_600_000)).toEqual(failed);
  });

  test('a finished status reads as written whatever the job state', () => {
    expect(readDerivedStatus(status('ready'), created, null)).toEqual(status('ready'));
    expect(readDerivedStatus(status('failed'), created, 'completed')).toEqual(status('failed'));
    expect(readDerivedStatus(undefined, created)).toBeNull();
  });
});
