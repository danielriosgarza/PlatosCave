import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Loading } from '../components/Loading';
import { StatePage } from '../components/StatePage';
import { CLASS_A, makeMe, renderApp, stubApi, studentIn } from './render';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'test' ? [] : sources(path);
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });

describe('loading, failure and unavailable states', () => {
  it('Loading is a status region with a visible label', () => {
    render(<Loading label="Loading topics" />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading topics');
  });

  it('StatePage names itself with a heading and keeps its action', () => {
    render(
      <StatePage title="This page is not available" action={<a href="/courses">Courses</a>}>
        The address may be wrong.
      </StatePage>,
    );
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      'This page is not available',
    );
    expect(screen.getByRole('link', { name: 'Courses' })).toBeInTheDocument();
  });

  const holdCards = () => {
    const me = makeMe({ classes: [studentIn(CLASS_A, 'A')] });
    const base = stubApi((url) =>
      url === '/api/me' ? { status: 200, body: me } : { status: 500, body: undefined },
    );
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
      String(input) === '/api/me' ? base(input, init) : new Promise<Response>(() => {}),
    );
  };

  it('A19 course selection shows a labelled loading state with no title until the context is known', async () => {
    holdCards();
    renderApp('/courses');
    expect(await screen.findByRole('status')).toHaveTextContent('Loading your courses');
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  });

  it('A19 the loading state for ?view=instructor already carries the title the page will have', async () => {
    holdCards();
    renderApp('/courses?view=instructor');
    expect(await screen.findByRole('status')).toHaveTextContent('Loading courses you teach');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Courses you teach');
  });

  it('A19 a failed ?view=instructor load keeps the Courses you teach title and offers Retry', async () => {
    const me = makeMe({ classes: [studentIn(CLASS_A, 'A')] });
    stubApi((url) =>
      url === '/api/me' ? { status: 200, body: me } : { status: 500, body: { error: 'boom' } },
    );
    renderApp('/courses?view=instructor');
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Courses you teach');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('A19 no source file marks a region busy without announcing it', () => {
    const offenders = sources(join(__dirname, '..')).filter((file) =>
      /aria-busy/.test(readFileSync(file, 'utf8')),
    );
    // A busy attribute is allowed only on an element that is itself a status region.
    for (const file of offenders) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/<[^<>]*aria-busy[^<>]*>/g)) {
        expect(match[0], file).toContain('role="status"');
      }
    }
  });

  it('A19 shared styles replace inline heading sizes in the authoring forms', () => {
    for (const file of ['ConflictView', 'PublishPanel', 'WebSlides', 'AddNotebook', 'AddReading']) {
      const text = readFileSync(join(__dirname, '..', 'authoring', `${file}.tsx`), 'utf8');
      expect(text, file).not.toMatch(/<h[34] style=/);
    }
  });
});
