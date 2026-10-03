import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OfflineBanner } from '../components/OfflineBanner';
import { RetryNotice } from '../components/RetryNotice';
import { TabRow } from '../components/TabRow';
import { createQueryClient, revokeClass } from '../session/revocation';
import {
  CLASS_A,
  makeMe,
  makeTopics,
  renderApp,
  signedInWithTopics,
  stubApi,
  studentIn,
  T_SAMPLING,
} from './render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('permission revoked', () => {
  it('A01 explains lost access, stops reading and purges the class from the cache', async () => {
    const me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] });
    let revoked = false;
    const fetchMock = stubApi((url, init) => {
      if (revoked && url !== '/api/me') return { status: 404, body: { error: 'not_found' } };
      if (revoked && url === '/api/me') return { status: 200, body: { ...me, classes: [] } };
      return signedInWithTopics(me)(url, init);
    });
    const { queryClient } = renderApp(`/classes/${CLASS_A}/topics`);
    expect(await screen.findByText('Sampling')).toBeInTheDocument();

    revoked = true;
    await act(() => queryClient.refetchQueries({ predicate: (q) => q.queryKey[0] !== 'session' }));

    expect(
      await screen.findByRole('heading', { name: 'Your access to this class has ended' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Sampling')).toBeNull();
    expect(screen.queryByText('Elena Ruiz')).toBeNull();
    const cached = queryClient
      .getQueryCache()
      .findAll()
      .filter(
        (q) => JSON.stringify(q.queryKey).includes(CLASS_A) && q.queryKey[0] !== 'access-revoked',
      );
    expect(cached).toEqual([]);

    const callsAfter = fetchMock.mock.calls.length;
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(fetchMock.mock.calls.length).toBe(callsAfter);
  });

  it('A01 explains lost access when only the session refresh sees the loss, and lets a rejoin back in', async () => {
    const me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] });
    let member = true;
    stubApi((url, init) =>
      url === '/api/me'
        ? { status: 200, body: member ? me : { ...me, classes: [] } }
        : signedInWithTopics(me)(url, init),
    );
    const { queryClient } = renderApp(`/classes/${CLASS_A}/topics`);
    expect(await screen.findByText('Sampling')).toBeInTheDocument();

    member = false;
    await act(() => queryClient.refetchQueries({ queryKey: ['session'] }));
    expect(
      await screen.findByRole('heading', { name: 'Your access to this class has ended' }),
    ).toBeInTheDocument();
    const cached = () =>
      queryClient
        .getQueryCache()
        .findAll()
        .filter(
          (q) => JSON.stringify(q.queryKey).includes(CLASS_A) && q.queryKey[0] !== 'access-revoked',
        );
    expect(cached()).toEqual([]);

    member = true;
    await act(() => queryClient.refetchQueries({ queryKey: ['session'] }));
    expect(await screen.findByText('Sampling')).toBeInTheDocument();
  });

  it('A01 keeps the page when a class request fails but the person is still a member', async () => {
    const me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] });
    let broken = false;
    stubApi((url, init) =>
      broken && url !== '/api/me'
        ? { status: 404, body: {} }
        : signedInWithTopics(me, makeTopics())(url, init),
    );
    const { queryClient } = renderApp(`/classes/${CLASS_A}/topics`);
    expect(await screen.findByText('Sampling')).toBeInTheDocument();
    broken = true;
    await act(() => queryClient.refetchQueries({ predicate: (q) => q.queryKey[0] !== 'session' }));
    await waitFor(() =>
      expect(screen.queryByText('Your access to this class has ended')).toBeNull(),
    );
  });
});

describe('session check failure', () => {
  it('keeps the bar, says the session could not be checked and retries', async () => {
    const me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] });
    let down = true;
    stubApi((url, init) =>
      url === '/api/me' && down
        ? { status: 500, body: { error: 'boom' } }
        : signedInWithTopics(me)(url, init),
    );
    renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/reading`);
    expect(await screen.findByText(/Your session could not be checked/)).toBeInTheDocument();
    expect(screen.getByRole('banner')).toBeInTheDocument();
    down = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.queryByText(/could not be checked/)).toBeNull());
  });
});

describe('session check on navigation', () => {
  it('keeps the page when a stale session cannot be re-checked once and one is cached', async () => {
    const me = makeMe({ classes: [studentIn(CLASS_A, 'Class A')] });
    let down = false;
    stubApi((url, init) =>
      url === '/api/me' && down
        ? { status: 500, body: { error: 'boom' } }
        : signedInWithTopics(me)(url, init),
    );
    const { queryClient, router } = renderApp(`/classes/${CLASS_A}/topics`);
    expect(await screen.findByText('Sampling')).toBeInTheDocument();
    // The cached session goes stale; the next navigation's re-check fails once.
    queryClient.invalidateQueries({ queryKey: ['session'], refetchType: 'none' });
    down = true;
    await act(() => router.navigate({ to: '/courses' }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(await screen.findByRole('heading', { name: 'Your courses' })).toBeInTheDocument();
    expect(screen.queryByText(/could not be checked/)).toBeNull();
    expect(screen.queryByText(/could not be shown/)).toBeNull();
    expect(router.state.location.pathname).toBe('/courses');
  });
});

describe('revoked flag', () => {
  it('A01 outlives garbage collection of its cache entry', async () => {
    const client = createQueryClient();
    revokeClass(client, CLASS_A);
    const entry = client.getQueryCache().find({ queryKey: ['access-revoked', CLASS_A] });
    expect(entry?.gcTime).toBe(Number.POSITIVE_INFINITY);
    client.clear();
  });
});

describe('retry pattern', () => {
  it('offers Retry and a download of what was written', async () => {
    const onRetry = vi.fn();
    URL.createObjectURL = vi.fn(() => 'blob:draft');
    URL.revokeObjectURL = vi.fn();
    render(
      <RetryNotice
        message="Your answer was not saved."
        onRetry={onRetry}
        retryLabel="Retry save"
        recovery={{ filename: 'answer.txt', text: 'long answer' }}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Your answer was not saved.');
    await userEvent.click(screen.getByRole('button', { name: 'Retry save' }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole('link', { name: 'Download what you wrote' })).toHaveAttribute(
      'download',
      'answer.txt',
    );
  });
});

describe('offline banner', () => {
  it('appears only while the browser is offline and leaves with the connection', () => {
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    render(<OfflineBanner>You are offline.</OfflineBanner>);
    expect(screen.queryByRole('status')).toBeNull();
    online.mockReturnValue(false);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('status')).toHaveTextContent('You are offline.');
    online.mockReturnValue(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('tab strip', () => {
  const tabs = [
    { id: 'a', label: 'Alpha' },
    { id: 'b', label: 'Beta' },
  ] as const;

  it('marks the edge that has more tabs only when the strip overflows', () => {
    const width = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get');
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(200);
    width.mockReturnValue(200);
    const { container, rerender } = render(
      <TabRow label="t" tabs={tabs} selected="a" onSelect={() => {}} panelId="p" />,
    );
    expect(container.firstElementChild).toHaveAttribute('data-more', 'false');
    width.mockReturnValue(400);
    rerender(<TabRow label="t" tabs={tabs} selected="b" onSelect={() => {}} panelId="p" />);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(container.firstElementChild).toHaveAttribute('data-more', 'true');
  });
});
