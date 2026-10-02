import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubApi } from '../test/render';
import { useReadingContent } from './readings';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const pending = {
  revisionId: '00000000-0000-4000-8000-000000000401',
  title: 'Notes',
  kind: 'native',
  status: 'pending',
  error: null,
  sourceKey: null,
  html: null,
  pdf: null,
};

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('pending reading poll', () => {
  it('keeps polling after a transient failure and stops on a 404', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const answers = [
      { status: 200, body: pending },
      { status: 500, body: {} },
      { status: 200, body: pending },
      { status: 404, body: {} },
    ];
    const fetchMock = stubApi(() => answers.shift() ?? { status: 404, body: {} });
    renderHook(
      () =>
        useReadingContent(
          '00000000-0000-4000-8000-000000000201',
          '00000000-0000-4000-8000-000000000401',
        ),
      {
        wrapper: wrapper(),
      },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    for (let i = 2; i <= 4; i++) {
      await vi.advanceTimersByTimeAsync(3100);
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(i));
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
