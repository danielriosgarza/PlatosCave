import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLASS_A,
  makeMe,
  makeTopics,
  renderApp,
  signedInWithTopics,
  stubApi,
  studentIn,
  T_ESTIMATION,
  T_SAMPLING,
} from '../test/render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const me = makeMe({ classes: [studentIn(CLASS_A, 'Autumn 2026 A')] });

describe('topic index', () => {
  it('A02 names the cohort and instructor of the class under the course title', async () => {
    stubApi(signedInWithTopics(me));
    renderApp(`/classes/${CLASS_A}/topics`);
    expect(await screen.findByRole('heading', { name: 'Statistical thinking' })).toBeVisible();
    expect(await screen.findByText('Autumn 2026 A · Elena Ruiz')).toBeVisible();
  });

  it('A03 shows one Resume on the current row that opens the saved tab', async () => {
    stubApi(signedInWithTopics(me));
    renderApp(`/classes/${CLASS_A}/topics`);
    const table = await screen.findByRole('table');
    const resume = within(table).getAllByRole('link', { name: 'Resume' });
    expect(resume).toHaveLength(1);
    expect(resume[0]).toHaveAttribute('href', `/classes/${CLASS_A}/topics/${T_SAMPLING}/tests`);
    const row = resume[0]?.closest('tr');
    expect(row).toHaveTextContent('Sampling');
    expect(row).toHaveTextContent('45 min');
  });

  it('A03 a first visit opens Slides when present, else the first populated tab', async () => {
    const topics = makeTopics({ resume: null });
    const first = topics.topics[0];
    if (!first) throw new Error('fixture');
    topics.topics[1] = {
      ...first,
      topicId: T_ESTIMATION,
      number: 2,
      title: 'Estimation',
      presence: { ...first.presence, slides: true },
      firstTab: 'slides',
      state: 'available',
      requires: [],
    };
    stubApi(signedInWithTopics(me, topics));
    renderApp(`/classes/${CLASS_A}/topics`);
    expect(await screen.findByRole('link', { name: 'Sampling' })).toHaveAttribute(
      'href',
      `/classes/${CLASS_A}/topics/${T_SAMPLING}/reading`,
    );
    expect(screen.getByRole('link', { name: 'Estimation' })).toHaveAttribute(
      'href',
      `/classes/${CLASS_A}/topics/${T_ESTIMATION}/slides`,
    );
    expect(screen.queryByRole('link', { name: 'Resume' })).toBeNull();
  });

  it('A02 labels each presence marker, the legend and the reviewed count in text', async () => {
    stubApi(signedInWithTopics(me));
    renderApp(`/classes/${CLASS_A}/topics`);
    await screen.findByRole('table');
    const [sampling] = screen.getAllByRole('row').slice(1);
    expect(
      within(sampling as HTMLElement).getByRole('img', { name: 'Reading: available' }),
    ).toBeVisible();
    expect(
      within(sampling as HTMLElement).getByRole('img', { name: 'Slides: not added' }),
    ).toBeVisible();
    expect(screen.getByText('S · Slides')).toBeVisible();
    expect(screen.getByText('T · Tests')).toBeVisible();
    expect(screen.getByText('0 of 2 topics reviewed')).toBeVisible();
  });

  it('A02 a prerequisite-locked topic names what it needs and is not a link', async () => {
    stubApi(signedInWithTopics(me));
    renderApp(`/classes/${CLASS_A}/topics`);
    const row = (await screen.findByText('Estimation')).closest('tr');
    expect(row).toHaveTextContent('Requires Sampling');
    expect(screen.queryByRole('link', { name: 'Estimation' })).toBeNull();
  });

  it('A02 a scheduled topic shows when it opens', async () => {
    const topics = makeTopics();
    const second = topics.topics[1];
    if (!second) throw new Error('fixture');
    topics.topics[1] = {
      ...second,
      state: 'scheduled',
      availableAt: '2026-10-08T09:00:00Z',
      requires: [],
    };
    stubApi(signedInWithTopics(me, topics));
    renderApp(`/classes/${CLASS_A}/topics`);
    const row = (await screen.findByText('Estimation')).closest('tr');
    expect(row).toHaveTextContent(/Opens \d+ Oct 2026/);
  });

  it('A02 reports a failed load with a retry instead of an empty table', async () => {
    const user = userEvent.setup();
    let fail = true;
    stubApi((url, init) =>
      fail && url.endsWith('/topics')
        ? { status: 500, body: { error: 'boom' } }
        : signedInWithTopics(me)(url, init),
    );
    renderApp(`/classes/${CLASS_A}/topics`);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.queryByRole('table')).toBeNull();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table')).toBeVisible();
  });

  it('A01 a class the person is not in shows the neutral page, not a topic list', async () => {
    stubApi((url) =>
      url === '/api/me'
        ? { status: 200, body: makeMe() }
        : { status: 404, body: { error: 'not found' } },
    );
    renderApp(`/classes/${CLASS_A}/topics`);
    expect(
      await screen.findByRole('heading', { name: 'This page is not available' }),
    ).toBeVisible();
  });
});

describe('topic heading and neighbours', () => {
  const open = () => {
    const topics = makeTopics();
    const second = topics.topics[1];
    if (!second) throw new Error('fixture');
    topics.topics[1] = {
      ...second,
      state: 'available',
      requires: [],
      firstTab: 'reading',
      presence: { ...second.presence, reading: true },
    };
    return topics;
  };

  it('A02 the heading carries objective, course, position, time, cohort and instructor', async () => {
    stubApi(signedInWithTopics(me));
    renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/reading`);
    expect(await screen.findByRole('heading', { name: 'Sampling' })).toBeVisible();
    expect(screen.getByText('Separate patterns from variation.')).toBeVisible();
    expect(
      screen.getByText('Statistical thinking · Topic 1 of 2 · 45 min · Autumn 2026 A · Elena Ruiz'),
    ).toBeVisible();
  });

  it('A03 Courses → Topics → Resume lands on the saved tab', async () => {
    const user = userEvent.setup();
    stubApi(signedInWithTopics(me));
    const { router } = renderApp('/courses');
    await user.click(await screen.findByRole('link', { name: 'Topics' }));
    await user.click(await screen.findByRole('link', { name: 'Resume' }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/classes/${CLASS_A}/topics/${T_SAMPLING}/tests`),
    );
    expect(await screen.findByRole('tab', { name: 'Tests' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
  });

  it('A02 the next topic shows its lock reason instead of a link while it is locked', async () => {
    stubApi(signedInWithTopics(me));
    renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/reading`);
    const nav = await screen.findByRole('navigation', { name: 'Neighbouring topics' });
    await waitFor(() => expect(nav).toHaveTextContent('02 Estimation › · Requires Sampling'));
    expect(within(nav).queryByRole('link')).toBeNull();
  });

  it('A02 previous and next topic links open the neighbour on its first-visit tab', async () => {
    const user = userEvent.setup();
    stubApi(signedInWithTopics(me, open()));
    const { router } = renderApp(`/classes/${CLASS_A}/topics/${T_SAMPLING}/reading`);
    const next = await screen.findByRole('link', { name: '02 Estimation ›' });
    await user.click(next);
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(
        `/classes/${CLASS_A}/topics/${T_ESTIMATION}/reading`,
      ),
    );
    expect(await screen.findByRole('link', { name: '‹ 01 Sampling' })).toBeVisible();
  });

  it('A02 opening a locked topic by address shows its reason, with no tabs', async () => {
    stubApi(signedInWithTopics(me));
    renderApp(`/classes/${CLASS_A}/topics/${T_ESTIMATION}/reading`);
    expect(await screen.findByRole('heading', { name: 'Estimation' })).toBeVisible();
    expect(screen.getByText('Requires Sampling', { selector: 'p' })).toBeVisible();
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('A01 a topic that is not in the class release shows the neutral page', async () => {
    stubApi(signedInWithTopics(me));
    renderApp(`/classes/${CLASS_A}/topics/00000000-0000-4000-8000-0000000009ff/reading`);
    expect(
      await screen.findByRole('heading', { name: 'This page is not available' }),
    ).toBeVisible();
  });
});
