import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLASS_A,
  makeMe,
  makeTopics,
  renderApp,
  stubApi,
  studentIn,
  T_SAMPLING,
} from '../test/render';
import { ShinyEmbed } from './ShinyEmbed';
import { MAX_FRAME_HEIGHT, MIN_FRAME_HEIGHT, readShinyMessage } from './shinyMessages';

const REV = '00000000-0000-4000-8000-000000000801';
const RES = '00000000-0000-4000-8000-000000000411';
const ORIGIN = 'https://shiny.example.org';
const URL_ = `${ORIGIN}/sampling-lab/`;
const NOTEBOOKS = `/classes/${CLASS_A}/topics/${T_SAMPLING}/notebooks`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function api(shiny: { status: 'ready' | 'unapproved'; url: string | null; origin: string | null }) {
  const calls: string[] = [];
  stubApi((url) => {
    calls.push(url);
    if (url === '/api/me') {
      return { status: 200, body: makeMe({ classes: [studentIn(CLASS_A, 'Class A')] }) };
    }
    if (url === `/api/classes/${CLASS_A}/topics`) return { status: 200, body: makeTopics() };
    if (url === `/api/classes/${CLASS_A}/topics/${T_SAMPLING}/notebooks`) {
      return {
        status: 200,
        body: {
          notebooks: [{ resourceId: RES, revisionId: REV, title: 'Sampling lab', type: 'shiny' }],
        },
      };
    }
    if (url === `/api/classes/${CLASS_A}/resources/${REV}/shiny`) {
      return { status: 200, body: { revisionId: REV, title: 'Sampling lab', ...shiny } };
    }
    return { status: 404, body: {} };
  });
  return calls;
}

function post(frame: HTMLElement, data: unknown, origin = ORIGIN, source?: Window | null) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        origin,
        source: source === undefined ? (frame as HTMLIFrameElement).contentWindow : source,
      }),
    );
  });
}

const embed = () =>
  render(<ShinyEmbed title="Sampling lab" url={URL_} origin={ORIGIN} blockedAfterMs={60} />);

describe('Shiny embed', () => {
  it('A11 the app is framed from its approved address with Restart and Open externally', async () => {
    api({ status: 'ready', url: URL_, origin: ORIGIN });
    renderApp(NOTEBOOKS);
    const frame = await screen.findByTitle('Sampling lab');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame).toHaveAttribute('src', URL_);
    const link = screen.getByRole('link', { name: 'Open externally' });
    expect(link).toHaveAttribute('href', URL_);
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByRole('button', { name: 'Restart' })).toBeVisible();
    // Nothing verifies a live session, so the label never says Connected.
    expect(screen.queryByText(/Connected/)).toBeNull();
  });

  it('A11 a blocked iframe, which never answers, shows the external-open route', async () => {
    embed();
    expect(screen.getByRole('status')).toHaveTextContent('Loading app');
    expect(await screen.findByText(/may not allow embedding/)).toBeVisible();
    expect(screen.getByText('No ready message from the app')).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('link', { name: 'Open externally' })).toHaveAttribute('href', URL_);
  });

  it('A11 a ready message from the approved origin and the frame ends the wait', async () => {
    embed();
    post(screen.getByTitle('Sampling lab'), { type: 'ready' });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('App reported ready'));
    await new Promise((r) => setTimeout(r, 120));
    expect(screen.queryByText(/may not allow embedding/)).toBeNull();
  });

  it('A11 a message from another origin or another window is ignored', async () => {
    embed();
    const frame = screen.getByTitle('Sampling lab');
    post(frame, { type: 'ready' }, 'https://evil.example.org');
    post(frame, { type: 'ready' }, ORIGIN, window);
    post(frame, { type: 'ready' }, ORIGIN, null);
    expect(screen.getByRole('status')).toHaveTextContent('Loading app');
    await screen.findByText(/may not allow embedding/);
  });

  it('A11 a resize message sets the frame height within limits', () => {
    embed();
    const frame = screen.getByTitle('Sampling lab');
    post(frame, { type: 'resize', height: 700 });
    expect(frame).toHaveStyle({ height: '700px' });
    post(frame, { type: 'resize', height: 99999 });
    expect(frame).toHaveStyle({ height: `${MAX_FRAME_HEIGHT}px` });
  });

  it('A11 a grade, score or completion message sets nothing, from the approved origin or any other', async () => {
    const calls = api({ status: 'ready', url: URL_, origin: ORIGIN });
    renderApp(NOTEBOOKS);
    const frame = await screen.findByTitle('Sampling lab');
    const before = calls.length;
    for (const data of [
      { type: 'grade', score: 100 },
      { type: 'score', value: 100 },
      { type: 'complete', completed: true, grade: 'A' },
      { type: 'ready', score: 100 },
    ]) {
      post(frame, data);
      post(frame, data, 'https://evil.example.org');
    }
    expect(screen.queryByText(/100|grade|score|complete/i)).toBeNull();
    // The one accepted message is readiness; no request carries a result to the server.
    expect(calls.length).toBe(before);
    expect(calls.every((u) => !/grade|score|progress|attempt/.test(u))).toBe(true);
    expect(within(screen.getByRole('tabpanel')).getByRole('status')).toHaveTextContent(
      'App reported ready',
    );
  });

  it('A11 Restart reloads the app and waits for readiness again', async () => {
    embed();
    const frame = screen.getByTitle('Sampling lab');
    post(frame, { type: 'ready' });
    await screen.findByText('App reported ready');
    act(() => screen.getByRole('button', { name: 'Restart' }).click());
    expect(screen.getByRole('status')).toHaveTextContent('Loading app');
    expect(screen.getByTitle('Sampling lab')).not.toBe(frame);
  });

  it('A11 an app on an origin the host has not approved is neither framed nor linked, labelled Preview · no session', async () => {
    api({ status: 'unapproved', url: null, origin: null });
    renderApp(NOTEBOOKS);
    expect(await screen.findByText('Preview · no session')).toBeVisible();
    expect(screen.queryByTitle('Sampling lab')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open externally' })).toBeNull();
  });
});

describe('Shiny messages', () => {
  const frame = {} as Window;
  const approved = { origin: ORIGIN, frame };
  const from = (data: unknown, origin = ORIGIN, source: unknown = frame) =>
    readShinyMessage({ data, origin, source: source as MessageEventSource }, approved);

  it('A11 accepts only ready and resize, and clamps the height', () => {
    expect(from({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(from({ type: 'resize', height: 10 })).toEqual({
      type: 'resize',
      height: MIN_FRAME_HEIGHT,
    });
    expect(from({ type: 'resize', height: '700' })).toBeNull();
    expect(from({ type: 'resize', height: Number.NaN })).toBeNull();
    expect(from({ type: 'grade', score: 1 })).toBeNull();
    expect(from('ready')).toBeNull();
    expect(from(null)).toBeNull();
  });

  it('A11 refuses a wrong origin, a wrong window, and a missing frame', () => {
    expect(from({ type: 'ready' }, 'https://shiny.example.org.evil.test')).toBeNull();
    expect(from({ type: 'ready' }, 'null')).toBeNull();
    expect(from({ type: 'ready' }, ORIGIN, {})).toBeNull();
    expect(
      readShinyMessage({ data: { type: 'ready' }, origin: ORIGIN, source: null }, approved),
    ).toBeNull();
    expect(
      readShinyMessage(
        { data: { type: 'ready' }, origin: ORIGIN, source: frame },
        { origin: ORIGIN, frame: null },
      ),
    ).toBeNull();
  });
});
