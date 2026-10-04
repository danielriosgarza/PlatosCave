import { cleanup, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cards } from '../courses/queries';
import {
  CLASS_A,
  CLASS_B,
  COURSE,
  cardsFor,
  instructorIn,
  makeMe,
  renderApp,
  stubApi,
  studentIn,
} from './render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TOPIC = '00000000-0000-4000-8000-000000000301';
const card = (over: Partial<Cards['classes'][number]> = {}): Cards['classes'][number] => ({
  classId: CLASS_A,
  className: 'Autumn 2026 A',
  courseId: COURSE,
  courseTitle: 'Statistical thinking',
  role: 'student',
  archived: false,
  topicCount: 5,
  reviewed: { count: 2, total: 5 },
  resume: null,
  studentCount: null,
  ...over,
});

/** Serves /api/me for the given contexts and /api/courses with the given cards. */
type Extra = (url: string, init?: RequestInit) => { status: number; body?: unknown } | undefined;

function serve(me: ReturnType<typeof makeMe>, cards: Cards, extra?: Extra) {
  return stubApi((url, init) => {
    if (url === '/api/me') return { status: 200, body: me };
    if (url === '/api/courses' && init?.method === 'GET') return { status: 200, body: cards };
    return extra?.(url, init) ?? { status: 404, body: {} };
  });
}

describe('course cards', () => {
  it('A02 a student card shows topic count, term, reviewed text and a Resume link into the saved resource', async () => {
    const me = makeMe({ classes: [studentIn(CLASS_A, 'Autumn 2026 A')] });
    serve(me, {
      classes: [
        card({
          resume: {
            topicId: TOPIC,
            topicTitle: 'Sampling',
            tab: 'reading',
            resourceTitle: 'Why samples vary',
          },
        }),
      ],
      courses: [],
      canCreateCourse: false,
    });
    renderApp('/courses');
    const item = (await screen.findByRole('heading', { name: 'Statistical thinking' })).closest(
      'li',
    ) as HTMLElement;
    expect(within(item).getByText('5 topics · Autumn 2026 A')).toBeInTheDocument();
    expect(within(item).getByText('2 of 5 reviewed')).toBeInTheDocument();
    expect(within(item).getByRole('img', { name: '2 of 5 reviewed' })).toBeInTheDocument();
    expect(within(item).getByRole('link', { name: /^Open Statistical thinking/ })).toHaveAttribute(
      'href',
      `/classes/${CLASS_A}/topics`,
    );
    expect(
      within(item).getByRole('link', { name: 'Resume Why samples vary · Sampling' }),
    ).toHaveAttribute('href', `/classes/${CLASS_A}/topics/${TOPIC}/reading`);
    expect(screen.queryByRole('button', { name: 'Create course' })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Class review' })).toBeNull();
  });

  it('A02 an instructor card shows class context without a link to the unfinished Class review, and the page offers Create course', async () => {
    const me = makeMe({ classes: [instructorIn(CLASS_A, 'Autumn 2026 A')] });
    serve(me, {
      classes: [card({ role: 'instructor', studentCount: 3 })],
      courses: [],
      canCreateCourse: true,
    });
    renderApp('/courses');
    expect(await screen.findByRole('heading', { name: 'Courses you teach' })).toBeInTheDocument();
    expect(screen.getByText('3 students')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Class review' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Create course' })).toBeInTheDocument();
    expect(screen.queryByText(/reviewed/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Join a class' })).toBeNull();
  });

  it('P1-14a course cards open the editor and name the grant as the editor does', async () => {
    const me = makeMe({ classes: [instructorIn(CLASS_A, 'Autumn 2026 A')] });
    const course = (n: number, grant: object) => ({
      courseId: `00000000-0000-4000-8000-00000000010${n}`,
      title: `Course ${n}`,
      topicCount: 2,
      classCount: 1,
      owner: false,
      editor: false,
      publisher: false,
      ...grant,
    });
    serve(me, {
      classes: [card({ role: 'instructor', studentCount: 3 })],
      courses: [
        course(1, { owner: true, editor: true, publisher: true }),
        course(2, { editor: true, publisher: true }),
        course(3, { publisher: true }),
        course(4, { editor: true }),
      ],
      canCreateCourse: true,
    } as Cards);
    renderApp('/courses?view=instructor');
    const list = await screen.findByRole('list', { name: 'Courses you hold' });
    const item = (title: string) =>
      within(list).getByRole('heading', { name: title }).closest('li') as HTMLElement;
    for (const [n, label] of [
      [1, 'Owner'],
      [2, 'Editor and publisher'],
      [3, 'Publisher'],
      [4, 'Editor'],
    ] as const) {
      expect(within(item(`Course ${n}`)).getByText(label)).toBeInTheDocument();
    }
    expect(within(item('Course 1')).getByRole('link', { name: 'Edit Course 1' })).toHaveAttribute(
      'href',
      '/courses/00000000-0000-4000-8000-000000000101/edit',
    );
    expect(
      within(item('Course 2')).getByRole('link', { name: 'Edit Course 2' }),
    ).toBeInTheDocument();
    expect(
      within(item('Course 4')).getByRole('link', { name: 'Edit Course 4' }),
    ).toBeInTheDocument();
    // A publisher without edit rights cannot open the editor, so the card is not a link.
    expect(within(item('Course 3')).queryByRole('link')).toBeNull();
  });

  it('A02 the filters and the title search narrow the cards', async () => {
    const user = userEvent.setup();
    const me = makeMe({
      classes: [studentIn(CLASS_A, 'A'), studentIn(CLASS_B, 'B')],
    });
    serve(me, {
      classes: [
        card({
          courseId: '00000000-0000-4000-8000-000000000101',
          courseTitle: 'Statistical thinking',
        }),
        card({
          classId: CLASS_B,
          courseId: '00000000-0000-4000-8000-000000000102',
          courseTitle: 'Lab methods',
          archived: true,
          reviewed: { count: 6, total: 6 },
        }),
      ],
      courses: [],
      canCreateCourse: false,
    });
    renderApp('/courses');
    expect(await screen.findByRole('heading', { name: 'Lab methods' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Archived' }));
    expect(screen.queryByRole('heading', { name: 'Statistical thinking' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Lab methods' })).toBeInTheDocument();
    expect(screen.getByText('Archived · 6 of 6 reviewed')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'In progress' }));
    expect(screen.queryByRole('heading', { name: 'Lab methods' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Statistical thinking' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'All' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'lab');
    expect(screen.queryByRole('heading', { name: 'Statistical thinking' })).toBeNull();
    await user.clear(screen.getByRole('searchbox', { name: 'Search' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'zzz');
    expect(screen.getByRole('heading', { name: 'No matching courses' })).toBeInTheDocument();
  });

  it('A02 two enrolments in one course share a card with a class chooser', async () => {
    const user = userEvent.setup();
    const me = makeMe({ classes: [studentIn(CLASS_A, 'A'), studentIn(CLASS_B, 'B')] });
    serve(me, {
      classes: [
        card({ className: 'Autumn 2026 A' }),
        card({ classId: CLASS_B, className: 'Autumn 2026 B', reviewed: { count: 0, total: 5 } }),
      ],
      courses: [],
      canCreateCourse: false,
    });
    renderApp('/courses');
    await screen.findByRole('heading', { name: 'Statistical thinking' });
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: /Autumn 2026 B/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Choose class' }));
    const list = screen.getByRole('list', { name: 'Classes of Statistical thinking' });
    expect(within(list).getByRole('link', { name: 'Autumn 2026 A' })).toHaveAttribute(
      'href',
      `/classes/${CLASS_A}/topics`,
    );
    expect(within(list).getByRole('link', { name: 'Autumn 2026 B' })).toHaveAttribute(
      'href',
      `/classes/${CLASS_B}/topics`,
    );
  });

  it('A02 shows an error with a retry when the cards cannot be loaded', async () => {
    const user = userEvent.setup();
    let fail = true;
    const me = makeMe({ classes: [studentIn(CLASS_A, 'A')] });
    stubApi((url) =>
      url === '/api/me'
        ? { status: 200, body: me }
        : fail
          ? { status: 500, body: { error: 'boom' } }
          : { status: 200, body: cardsFor(me) },
    );
    renderApp('/courses');
    expect(await screen.findByRole('alert')).toHaveTextContent('Your courses could not be loaded.');
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { name: 'Statistical thinking' }),
    ).toBeInTheDocument();
  });
});

describe('join a class', () => {
  it('A02 an empty account shows the invitation code field and no cards', async () => {
    serve(makeMe(), { classes: [], courses: [], canCreateCourse: false });
    renderApp('/courses');
    expect(await screen.findByRole('heading', { name: 'Join a class' })).toBeInTheDocument();
    expect(screen.getByLabelText('Invitation code')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create course' })).toBeNull();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  const refusal = (error: string, status: number) => (url: string, init?: RequestInit) =>
    url === '/api/join' && init?.method === 'POST' ? { status, body: { error } } : undefined;

  it.each([
    ['invite_expired', 410, 'This code has expired. Ask the instructor for a new one.'],
    ['invite_full', 409, 'This class has reached its enrolment limit.'],
    ['invite_not_found', 404, 'This code is not valid. Check it and try again.'],
  ])('A02 a %s code states its cause', async (error, status, text) => {
    const user = userEvent.setup();
    serve(makeMe(), { classes: [], courses: [], canCreateCourse: false }, refusal(error, status));
    renderApp('/courses');
    await user.type(await screen.findByLabelText('Invitation code'), 'ABCDE-FGHJK');
    await user.click(screen.getByRole('button', { name: 'Join class' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(text);
  });

  it('A02 a valid code joins, reloads the cards and links to the class', async () => {
    const user = userEvent.setup();
    let joined = false;
    const me = makeMe({ classes: [studentIn(CLASS_A, 'Autumn 2026 A')] });
    stubApi((url, init) => {
      if (url === '/api/join' && init?.method === 'POST') {
        joined = true;
        expect(JSON.parse(String(init.body))).toEqual({ code: 'ABCDE-FGHJK' });
        return {
          status: 200,
          body: {
            classId: CLASS_A,
            className: 'Autumn 2026 A',
            courseId: COURSE,
            courseTitle: 'Statistical thinking',
            role: 'student',
            alreadyMember: false,
          },
        };
      }
      if (url === '/api/me') return { status: 200, body: joined ? me : makeMe() };
      if (url === '/api/courses')
        return {
          status: 200,
          body: joined
            ? { classes: [card()], courses: [], canCreateCourse: false }
            : { classes: [], courses: [], canCreateCourse: false },
        };
      return { status: 404, body: {} };
    });
    renderApp('/courses');
    await user.type(await screen.findByLabelText('Invitation code'), 'ABCDE-FGHJK');
    await user.click(screen.getByRole('button', { name: 'Join class' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'You joined Statistical thinking · Autumn 2026 A.',
    );
    expect(screen.getByRole('link', { name: 'Open the course' })).toHaveAttribute(
      'href',
      `/classes/${CLASS_A}/topics`,
    );
  });

  it('A02 the dialog from the header closes with a route back to the courses', async () => {
    const user = userEvent.setup();
    const me = makeMe({ classes: [studentIn(CLASS_A, 'A')] });
    serve(me, cardsFor(me), (url, init) =>
      url === '/api/join' && init?.method === 'POST'
        ? { status: 410, body: { error: 'invite_revoked' } }
        : undefined,
    );
    renderApp('/courses');
    await user.click(await screen.findByRole('button', { name: 'Join a class' }));
    const dialog = screen.getByRole('dialog', { name: 'Join a class' });
    await user.type(within(dialog).getByLabelText('Invitation code'), 'x');
    await user.click(within(dialog).getByRole('button', { name: 'Join class' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This code was withdrawn by the instructor.',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Back to your courses' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Your courses' })).toBeInTheDocument();
  });
});

describe('create course', () => {
  it('A02 an instructor creates a course from the dialog', async () => {
    const user = userEvent.setup();
    const me = makeMe({ classes: [instructorIn(CLASS_A, 'A')] });
    const fetchMock = serve(me, cardsFor(me), (url, init) =>
      url === '/api/courses' && init?.method === 'POST'
        ? { status: 200, body: { id: COURSE, title: 'Bayesian methods' } }
        : undefined,
    );
    renderApp('/courses');
    await user.click(await screen.findByRole('button', { name: 'Create course' }));
    const dialog = screen.getByRole('dialog', { name: 'Create course' });
    await user.type(within(dialog).getByLabelText('Course title'), 'Bayesian methods');
    await user.click(within(dialog).getByRole('button', { name: 'Create course' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Bayesian methods was created. You own it.',
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ title: 'Bayesian methods' });
  });
});

describe('who is offered Create course', () => {
  it('A02 an allow-listed account that teaches nothing opens Courses you teach with Create course', async () => {
    serve(makeMe(), { classes: [], courses: [], canCreateCourse: true });
    renderApp('/courses');
    expect(await screen.findByRole('button', { name: 'Create course' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Courses you teach' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'No courses yet' })).toBeInTheDocument();
    expect(screen.queryByText('This account has no instructor access')).toBeNull();
  });

  it('A02 an allow-listed student can switch to the instructor view, which offers Create course', async () => {
    const user = userEvent.setup();
    const me = makeMe({ classes: [studentIn(CLASS_A, 'Autumn 2026 A')] });
    serve(me, { classes: [card()], courses: [], canCreateCourse: true });
    renderApp('/courses');
    await screen.findByRole('heading', { name: 'Statistical thinking' });
    expect(screen.queryByRole('button', { name: 'Create course' })).toBeNull();
    await user.click(screen.getByRole('link', { name: 'Instructor view' }));
    expect(await screen.findByRole('button', { name: 'Create course' })).toBeInTheDocument();
  });

  it('A02 an account the server would refuse is not offered Create course, even on the instructor view', async () => {
    serve(makeMe(), { classes: [], courses: [], canCreateCourse: false });
    renderApp('/courses?view=instructor');
    expect(await screen.findByText('This account has no instructor access')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create course' })).toBeNull();
  });
});
