import { describe, expect, test } from 'vitest';
import { type DerivedStatus, readDerivedStatus, STALE_STATUS_MS } from './derived';

const created = new Date('2026-10-01T08:00:00Z');
const at = (iso: string) => new Date(iso);
const status = (state: DerivedStatus['state'], updatedAt: string): DerivedStatus => ({
  state,
  job: 'reading.ingest',
  jobId: '00000000-0000-4000-8000-00000000beef',
  updatedAt,
});

describe('readDerivedStatus', () => {
  test('a job that stayed queued or running past the bound shows as failed, so Retry is offered', () => {
    const updated = '2026-10-01T09:00:00.000Z';
    const later = new Date(Date.parse(updated) + STALE_STATUS_MS + 1);
    for (const state of ['queued', 'running'] as const) {
      expect(readDerivedStatus(status(state, updated), created, later)).toEqual({
        ...status(state, updated),
        state: 'failed',
        error: 'Processing stopped without a result',
      });
    }
  });

  test('a recent pending status and any finished one read as written', () => {
    const updated = '2026-10-01T09:00:00.000Z';
    const soon = at('2026-10-01T09:30:00Z');
    const muchLater = at('2026-10-09T09:00:00Z');
    expect(readDerivedStatus(status('running', updated), created, soon)?.state).toBe('running');
    expect(readDerivedStatus(status('queued', updated), created, soon)?.state).toBe('queued');
    expect(readDerivedStatus(status('ready', updated), created, muchLater)?.state).toBe('ready');
    expect(readDerivedStatus(status('failed', updated), created, muchLater)).toEqual(
      status('failed', updated),
    );
    expect(readDerivedStatus(undefined, created)).toBeNull();
  });
});
