import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cards } from '../courses/queries';
import type { ClassReview } from '../review/classReview';
import { expectNoAxeViolations } from './axe';
import {
  CLASS_A,
  COURSE,
  instructorIn,
  makeMe,
  makeTopics,
  renderApp,
  signedInWithTopics,
  stubApi,
  studentIn,
} from './render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // jsdom has no blob URLs; the tests that need them install their own.
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

const instructor = makeMe({ classes: [instructorIn(CLASS_A, 'Autumn 2026 A')] });

const emptyReview: ClassReview = {
  topics: [],
  assignments: [],
  notebooks: [],
  exercises: [],
  roster: [],
  students: [],
  total: 0,
  page: 1,
  pageSize: 25,
  rows: [],
  assignment: null,
  selected: null,
};

const exported = {
  url: 'https://content.test/exports/results.csv?token=abc',
  expiresAt: '2026-10-09T12:30:00.000Z',
  filename: 'results-autumn-2026-a.csv',
  rows: 4,
};

/** The review page of the class, with the export route answering as `onExport` says. */
function serveReview(onExport: () => { status: number; body?: unknown }) {
  const requests: string[] = [];
  stubApi((url, init) => {
    if (url === '/api/me') return { status: 200, body: instructor };
    if (url.startsWith(`/api/classes/${CLASS_A}/review`)) return { status: 200, body: emptyReview };
    if (url === `/api/classes/${CLASS_A}/exports/results` && init?.method === 'POST') {
      requests.push(url);
      return onExport();
    }
    return { status: 404, body: {} };
  });
  return requests;
}

describe('results export', () => {
  it('A21 Export results (CSV) asks for the selected class only and links the file after the server answered', async () => {
    const user = userEvent.setup();
    const requests = serveReview(() => ({ status: 201, body: exported }));
    renderApp(`/classes/${CLASS_A}/review`);
    const button = await screen.findByRole('button', { name: 'Export results (CSV)' });
    expect(screen.queryByRole('link', { name: /results-autumn/ })).not.toBeInTheDocument();
    await user.click(button);
    const link = await screen.findByRole('link', { name: 'Download results-autumn-2026-a.csv' });
    expect(link).toHaveAttribute('href', exported.url);
    expect(link).toHaveAttribute('download', exported.filename);
    expect(link.closest('p')).toHaveTextContent('4 attempts exported');
    expect(requests).toEqual([`/api/classes/${CLASS_A}/exports/results`]);
  });

  it('A21 a failed export says nothing was downloaded, offers a retry and shows no link', async () => {
    const user = userEvent.setup();
    let answer: { status: number; body?: unknown } = { status: 500, body: {} };
    const requests = serveReview(() => answer);
    renderApp(`/classes/${CLASS_A}/review`);
    await user.click(await screen.findByRole('button', { name: 'Export results (CSV)' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing was downloaded');
    expect(screen.queryByRole('link', { name: /Download results/ })).not.toBeInTheDocument();
    answer = { status: 201, body: exported };
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: /Download results-autumn/ })).toBeVisible();
    expect(requests).toHaveLength(2);
  });

  it('A21 a download link past its expiry is replaced by a prompt to export again', async () => {
    const user = userEvent.setup();
    serveReview(() => ({
      status: 201,
      body: { ...exported, expiresAt: '2020-01-01T00:00:00.000Z' },
    }));
    renderApp(`/classes/${CLASS_A}/review`);
    await user.click(await screen.findByRole('button', { name: 'Export results (CSV)' }));
    expect(await screen.findByText('The download link has expired. Export again.')).toBeVisible();
    expect(screen.queryByRole('link', { name: /Download results/ })).not.toBeInTheDocument();
  });

  it('A21 the export works from the keyboard and the screen has no axe violations', async () => {
    const user = userEvent.setup();
    serveReview(() => ({ status: 201, body: exported }));
    const { container } = renderApp(`/classes/${CLASS_A}/review`);
    const button = await screen.findByRole('button', { name: 'Export results (CSV)' });
    button.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('link', { name: /Download results-autumn/ });
    await expectNoAxeViolations(container);
  });
});

const COURSE_CARD: Cards['courses'][number] = {
  courseId: COURSE,
  title: 'Statistical thinking',
  owner: true,
  editor: true,
  publisher: true,
  archived: false,
  topicCount: 2,
  classCount: 1,
};
const CLASS_CARD: Cards['classes'][number] = {
  classId: CLASS_A,
  className: 'Autumn 2026 A',
  courseId: COURSE,
  courseTitle: 'Statistical thinking',
  role: 'instructor',
  archived: false,
  topicCount: 5,
  reviewed: { count: 0, total: 5 },
  resume: null,
  studentCount: 3,
};

/** Serves the cards from mutable state, so a refetch after an archive shows the new state. */
function serveCards(
  cards: Cards,
  call: (url: string) => { status: number; body?: unknown } | undefined,
) {
  const posts: string[] = [];
  stubApi((url, init) => {
    if (url === '/api/me') return { status: 200, body: instructor };
    if (url === '/api/courses' && init?.method === 'GET') return { status: 200, body: cards };
    if (init?.method === 'POST') {
      posts.push(url);
      return call(url) ?? { status: 404, body: {} };
    }
    return { status: 404, body: {} };
  });
  return posts;
}

describe('archive and restore', () => {
  it('A21 the course owner archives a class after confirming, and sees the archived state only once the server answered', async () => {
    const user = userEvent.setup();
    const cards: Cards = { classes: [CLASS_CARD], courses: [COURSE_CARD], canCreateCourse: true };
    const posts = serveCards(cards, (url) => {
      if (url !== `/api/classes/${CLASS_A}/archive`) return undefined;
      cards.classes = [{ ...CLASS_CARD, archived: true }];
      return { status: 200, body: { id: CLASS_A, archived: true } };
    });
    renderApp('/courses?view=instructor');
    await user.click(
      await screen.findByRole('button', {
        name: 'Archive class Statistical thinking · Autumn 2026 A',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Archive class?' });
    expect(posts).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Archive class' }));
    expect(
      await screen.findByText('Statistical thinking · Autumn 2026 A was archived.'),
    ).toBeVisible();
    expect(posts).toEqual([`/api/classes/${CLASS_A}/archive`]);
    expect(await screen.findByText(/Archived · 3 students/)).toBeVisible();
    expect(
      screen.getByRole('button', { name: 'Restore class Statistical thinking · Autumn 2026 A' }),
    ).toBeVisible();
  });

  it('A21 restoring a class of an archived course says to restore the course first and changes nothing', async () => {
    const user = userEvent.setup();
    const cards: Cards = {
      classes: [{ ...CLASS_CARD, archived: true }],
      courses: [{ ...COURSE_CARD, archived: true }],
      canCreateCourse: true,
    };
    serveCards(cards, () => ({ status: 409, body: { error: 'course_archived' } }));
    renderApp('/courses?view=instructor');
    await user.click(
      await screen.findByRole('button', {
        name: 'Restore class Statistical thinking · Autumn 2026 A',
      }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Restore class?' });
    await user.click(within(dialog).getByRole('button', { name: 'Restore class' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Restore the course first.');
    expect(screen.queryByText(/was restored/)).not.toBeInTheDocument();
  });

  it('A21 a 409 on archive reloads the cards so the stale action is replaced', async () => {
    const user = userEvent.setup();
    const cards: Cards = { classes: [], courses: [COURSE_CARD], canCreateCourse: true };
    serveCards(cards, () => {
      cards.courses = [{ ...COURSE_CARD, archived: true }];
      return { status: 409, body: { error: 'course_archived' } };
    });
    renderApp('/courses?view=instructor');
    await user.click(
      await screen.findByRole('button', { name: 'Archive course Statistical thinking' }),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Archive course?' });
    await user.click(within(dialog).getByRole('button', { name: 'Archive course' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('is archived already.');
    expect(
      await screen.findByRole('button', { name: 'Restore course Statistical thinking' }),
    ).toBeInTheDocument();
  });

  it('A21 the owner archives and restores the course from its card, by keyboard, without axe violations', async () => {
    const user = userEvent.setup();
    const cards: Cards = { classes: [], courses: [COURSE_CARD], canCreateCourse: true };
    serveCards(cards, (url) => {
      const archive = url === `/api/courses/${COURSE}/archive`;
      if (!archive && url !== `/api/courses/${COURSE}/restore`) return undefined;
      cards.courses = [{ ...COURSE_CARD, archived: archive }];
      return { status: 200, body: { id: COURSE, archived: archive } };
    });
    const { container } = renderApp('/courses?view=instructor');
    const archive = await screen.findByRole('button', {
      name: 'Archive course Statistical thinking',
    });
    archive.focus();
    await user.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'Archive course?' });
    await expectNoAxeViolations(container);
    await user.click(within(dialog).getByRole('button', { name: 'Archive course' }));
    const restore = await screen.findByRole('button', {
      name: 'Restore course Statistical thinking',
    });
    expect(screen.getByText('Statistical thinking was archived.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Archived' }));
    expect(screen.getByText(/Archived · Owner/)).toBeVisible();
    restore.focus();
    await user.keyboard('{Enter}');
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Restore course?' })).getByRole('button', {
        name: 'Restore course',
      }),
    );
    await waitFor(() =>
      expect(screen.getByText('Statistical thinking was restored.')).toBeVisible(),
    );
  });

  it('A21 an editor who does not own the course gets no archive control', async () => {
    const cards: Cards = {
      classes: [CLASS_CARD],
      courses: [{ ...COURSE_CARD, owner: false }],
      canCreateCourse: true,
    };
    serveCards(cards, () => undefined);
    renderApp('/courses?view=instructor');
    await screen.findByRole('link', { name: 'Class review' });
    expect(
      screen.queryByRole('button', { name: /^Archive (class|course)/ }),
    ).not.toBeInTheDocument();
  });
});

describe('annotation export', () => {
  const data = {
    exportedAt: '2026-10-09T10:00:00.000Z',
    class: { id: CLASS_A, name: 'Autumn 2026 A' },
    course: { id: COURSE, title: 'Statistical thinking' },
    annotations: [],
    posts: [],
  };

  function serveStudent(answer: () => { status: number; body?: unknown }) {
    const student = makeMe({ classes: [studentIn(CLASS_A, 'Autumn 2026 A')] });
    const base = signedInWithTopics(student, makeTopics());
    const requests: string[] = [];
    stubApi((url, init) => {
      if (url === `/api/classes/${CLASS_A}/export/annotations`) {
        requests.push(url);
        return answer();
      }
      return base(url, init);
    });
    return requests;
  }

  it('A21 Download my annotations saves the caller’s own file and reports it only after the server answered', async () => {
    const user = userEvent.setup();
    const saved: Blob[] = [];
    URL.createObjectURL = (b: Blob) => {
      saved.push(b);
      return 'blob:annotations';
    };
    URL.revokeObjectURL = () => undefined;
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => undefined);
    const requests = serveStudent(() => ({
      status: 200,
      body: { ...data, annotations: [], posts: [] },
    }));
    const { container } = renderApp(`/classes/${CLASS_A}/topics`);
    const button = await screen.findByRole('button', { name: 'Download my annotations' });
    expect(saved).toHaveLength(0);
    button.focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(
        screen.getByText('Your file with 0 annotations and 0 posts was handed to the browser.'),
      ).toBeVisible(),
    );
    expect(requests).toEqual([`/api/classes/${CLASS_A}/export/annotations`]);
    expect(saved).toHaveLength(1);
    expect(JSON.parse((await saved[0]?.text()) ?? '')).toMatchObject({ class: { id: CLASS_A } });
    expect(click).toHaveBeenCalled();
    await expectNoAxeViolations(container);
  });

  it('A21 a failed annotation download says so, saves nothing and offers a retry', async () => {
    const user = userEvent.setup();
    const created = vi.fn(() => 'blob:x');
    URL.createObjectURL = created;
    URL.revokeObjectURL = () => undefined;
    serveStudent(() => ({ status: 500, body: {} }));
    renderApp(`/classes/${CLASS_A}/topics`);
    await user.click(await screen.findByRole('button', { name: 'Download my annotations' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be downloaded');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
    expect(created).not.toHaveBeenCalled();
  });

  it('A21 instructors are not offered the student annotation download', async () => {
    stubApi(signedInWithTopics(instructor, makeTopics()));
    renderApp(`/classes/${CLASS_A}/topics`);
    await screen.findByRole('table');
    expect(
      screen.queryByRole('button', { name: 'Download my annotations' }),
    ).not.toBeInTheDocument();
  });
});
