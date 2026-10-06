import { EditorView } from '@codemirror/view';
import { act, cleanup, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CLASS_A,
  makeMe,
  makeTopics,
  renderApp,
  stubApi,
  studentIn,
  T_SAMPLING,
} from '../../test/render';
import { session } from '../connect/fixtures';
import type { Notebook } from '../notebooks';

const REV = '00000000-0000-4000-8000-000000000701';
const RES = '00000000-0000-4000-8000-000000000401';
const NOTEBOOKS = `/classes/${CLASS_A}/topics/${T_SAMPLING}/notebooks`;

const notebook: Notebook = {
  kernel: 'Python 3',
  language: 'python',
  outline: [],
  cells: [
    {
      id: 'draw',
      type: 'code',
      source: 'means.std(ddof=1)',
      executionCount: 2,
      sourceHidden: false,
      outputsHidden: false,
      outputs: [{ type: 'text', executionCount: 2, stream: null, text: '0.60', truncated: false }],
    },
  ],
};

class IdleSocket {
  static OPEN = 1;
  static all: IdleSocket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  constructor(public url: string) {
    IdleSocket.all.push(this);
  }
  send() {}
  close() {
    this.readyState = 3;
  }
}

beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SESSION_B = '00000000-0000-4000-8000-0000000d0002';

function serve(sessions: () => unknown[]) {
  IdleSocket.all = [];
  vi.stubGlobal('WebSocket', IdleSocket);
  stubApi((url) => {
    if (url === '/api/me') {
      return { status: 200, body: makeMe({ classes: [studentIn(CLASS_A, 'Class A')] }) };
    }
    if (url === `/api/classes/${CLASS_A}/topics`) return { status: 200, body: makeTopics() };
    if (url === `/api/classes/${CLASS_A}/topics/${T_SAMPLING}/notebooks`) {
      return {
        status: 200,
        body: {
          notebooks: [
            { resourceId: RES, revisionId: REV, title: 'Repeated samples', type: 'notebook' },
          ],
        },
      };
    }
    if (url === `/api/classes/${CLASS_A}/resources/${REV}/notebook`) {
      return {
        status: 200,
        body: {
          revisionId: REV,
          title: 'Repeated samples',
          status: 'ready',
          error: null,
          sourceKey: null,
          notebook,
        },
      };
    }
    if (url === `/api/classes/${CLASS_A}/notebook-sessions`) {
      return { status: 200, body: sessions() };
    }
    if (url === '/api/me/connections') return { status: 200, body: [] };
    return { status: 404, body: {} };
  });
}

describe('Notebooks tab live mode', () => {
  it('A27 a session that becomes ready turns the saved notebook into the live one without a reload', async () => {
    let state: 'starting' | 'ready' = 'starting';
    serve(() => [session({ state, resourceRevisionId: REV })]);
    renderApp(NOTEBOOKS);
    const panel = await screen.findByRole('tabpanel');
    // While the session starts, the notebook shows its saved outputs.
    await within(panel).findByText('Stored output · Python 3');
    expect(screen.queryByRole('article', { name: 'Live notebook' })).not.toBeInTheDocument();
    state = 'ready';
    // The list is read again by itself; no remount or focus change is needed.
    await screen.findByRole('article', { name: 'Live notebook' }, { timeout: 8000 });
    expect(IdleSocket.all).toHaveLength(1);
    expect(IdleSocket.all[0]?.url).toContain('/notebook-sessions/');
  }, 15000);

  it('A36 edits are kept when the session is forgotten and when a new one is opened', async () => {
    let list: unknown[] = [session({ state: 'ready', resourceRevisionId: REV })];
    serve(() => list);
    renderApp(NOTEBOOKS);
    await screen.findByRole('article', { name: 'Live notebook' });
    const editor = () => document.querySelector('.cm-editor') as HTMLElement;
    const view = EditorView.findFromDOM(editor()) as EditorView;
    act(() => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'my_edit = 1' } });
    });
    // The session leaves the list. The notebook stays, with the edit, and cannot run; Parallax
    // says it has no news of the session and does not claim it stopped.
    list = [];
    await screen.findByText('Parallax no longer has news of this session.', undefined, {
      timeout: 8000,
    });
    expect(screen.queryByText('This session has stopped.')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('last read as ready');
    expect((EditorView.findFromDOM(editor()) as EditorView).state.doc.toString()).toBe(
      'my_edit = 1',
    );
    expect(screen.getByRole('button', { name: /Run cell/ })).toBeDisabled();
    // A new session for the same notebook keeps the edit too.
    list = [session({ id: SESSION_B, state: 'ready', resourceRevisionId: REV })];
    // Connect refreshes the list when it opens a session; here the window regaining focus does.
    act(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(
      () => expect(screen.queryByText('Parallax no longer has news of this session.')).toBeNull(),
      { timeout: 8000 },
    );
    expect((EditorView.findFromDOM(editor()) as EditorView).state.doc.toString()).toBe(
      'my_edit = 1',
    );
  }, 30000);
});
