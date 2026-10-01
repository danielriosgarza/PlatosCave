import { health } from '@parallax/contracts/routes/health';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, call } from './client';

afterEach(() => vi.unstubAllGlobals());

describe('call', () => {
  it('throws ApiError, never resolves null, when a 2xx JSON response has a malformed body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('{not json', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );
    const error = await call(health).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(200);
  });
});
