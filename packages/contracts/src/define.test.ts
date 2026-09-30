import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineRoute } from './define';
import { health } from './routes/health';

describe('defineRoute', () => {
  it('rejects a contract without scope at compile time', () => {
    defineRoute(
      // @ts-expect-error scope is required
      {
        method: 'GET',
        path: '/api/x',
        summary: 'x',
        response: z.object({}),
        examples: {},
      },
    );
  });

  it('health response rejects a wrong shape and accepts a right one', () => {
    expect(() => health.response.parse({ status: 'bad' })).toThrow();
    expect(health.response.parse({ status: 'ok', version: '0.0.0', db: 'skipped' }).db).toBe(
      'skipped',
    );
  });
});
