import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLASS_A,
  instructorIn,
  makeMe,
  makeTopics,
  renderApp,
  signedInWithTopics,
  stubApi,
  studentIn,
  T_SAMPLING,
} from '../test/render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const READING = '00000000-0000-4000-8000-000000000401';
const QUIZ = '00000000-0000-4000-8000-000000000402';
const sheetUrl = `/api/classes/${CLASS_A}/topics/${T_SAMPLING}/reviews`;

const sheet = (reviewed: boolean) => ({
  topicId: T_SAMPLING,
  complete: reviewed,
  items: [
    {
      resourceId: READING,
      title: 'Why samples vary',
      tab: 'reading',
      graded: false,
      reviewed,
      submitted: false,
      required: 'review',
    },
    {
      resourceId: QUIZ,
      title: 'Sampling quiz',
      tab: 'tests',
      graded: true,
      reviewed: false,
      submitted: false,
      required: null,
    },
  ],
});

function stubReviews(options: { putStatus?: number } = {}) {
  const puts: unknown[] = [];
  const base = signedInWithTopics(makeMe({ classes: [studentIn(CLASS_A, 'Autumn 2026 A')] }));
  const fetchMock = stubApi((url, init) => {
    if (url === sheetUrl) return { status: 200, body: sheet(false) };
    if (url === `${sheetUrl}/${READING}` && init?.method === 'PUT') {
      puts.push(JSON.parse(String(init.body)));
      return options.putStatus && options.putStatus !== 200
        ? { status: options.putStatus, body: { error: 'class_archived' } }
        : { status: 200, body: sheet(true) };
    }
    return base(url, init);
  });
  return { puts, fetchMock };
}

describe('reviewed marks', () => {
  it('a student marks ungraded material reviewed and sees graded work apart', async () => {
    const { puts } = stubReviews();
    const user = userEvent.setup();
    renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/reading`);
    const box = await screen.findByRole('checkbox', { name: /Why samples vary/ });
    expect(box).not.toBeChecked();
    expect(await screen.findByText('This topic is not complete yet.')).toBeVisible();
    // Graded work has no checkbox: it shows whether it was submitted.
    expect(screen.queryByRole('checkbox', { name: /Sampling quiz/ })).toBeNull();
    expect(screen.getByText(/Not submitted/)).toBeVisible();

    await user.click(box);
    await waitFor(() => expect(box).toBeChecked());
    expect(puts).toEqual([{ reviewed: true }]);
    expect(await screen.findByText('This topic is complete.')).toBeVisible();
  });

  it('a refused mark stays unchecked and says why', async () => {
    stubReviews({ putStatus: 409 });
    const user = userEvent.setup();
    renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/reading`);
    const box = await screen.findByRole('checkbox', { name: /Why samples vary/ });
    await user.click(box);
    expect(
      await screen.findByText('This class is archived, so reviewed marks can no longer change.'),
    ).toBeVisible();
    expect(box).not.toBeChecked();
  });

  it('an instructor sees no reviewed marks and the sheet is never requested', async () => {
    const me = makeMe({ classes: [instructorIn(CLASS_A, 'Autumn 2026 A')] });
    const base = signedInWithTopics(me, makeTopics());
    const urls: string[] = [];
    stubApi((url, init) => {
      urls.push(url);
      return base(url, init);
    });
    renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/reading`);
    await screen.findByRole('heading', { name: 'Sampling' });
    expect(screen.queryByRole('heading', { name: 'Reviewed' })).toBeNull();
    expect(urls).not.toContain(sheetUrl);
  });
});
