import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLASS_A,
  makeMe,
  renderApp,
  signedInWithTopics,
  stubApi,
  studentIn,
  T_ESTIMATION,
  T_SAMPLING,
} from '../test/render';

const me = makeMe({ classes: [studentIn(CLASS_A, 'Autumn 2026 A')] });
const url = `/classes/${CLASS_A}/topics/${T_SAMPLING}/reading`;

let fullscreenElement: Element | null = null;
const requestFullscreen = vi.fn();
const exitFullscreen = vi.fn();

function enterFullscreen(element: Element) {
  fullscreenElement = element;
  document.dispatchEvent(new Event('fullscreenchange'));
}
function leaveFullscreen() {
  fullscreenElement = null;
  document.dispatchEvent(new Event('fullscreenchange'));
}

beforeEach(() => {
  fullscreenElement = null;
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    get: () => fullscreenElement,
  });
  requestFullscreen.mockReset().mockImplementation(async function (this: Element) {
    enterFullscreen(this);
  });
  exitFullscreen.mockReset().mockImplementation(async () => leaveFullscreen());
  Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
    configurable: true,
    value: requestFullscreen,
  });
  Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen });
  stubApi(signedInWithTopics(me));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const bar = () => screen.queryByRole('button', { name: 'Sign out' });
const tabs = () => screen.queryByRole('tablist', { name: 'Topic materials' });

async function open() {
  renderApp(url);
  await screen.findByRole('heading', { name: 'Sampling' });
}

describe('focus and full screen', () => {
  it('A04 Focus hides the bar, heading and tabs, keeps the toolbar, and Escape restores them', async () => {
    const user = userEvent.setup();
    await open();
    expect(bar()).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Focus' }));
    expect(bar()).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sampling' })).not.toBeInTheDocument();
    expect(tabs()).not.toBeInTheDocument();
    expect(screen.getByRole('toolbar', { name: 'Resource tools' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Exit focus' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.keyboard('{Escape}');
    expect(bar()).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sampling' })).toBeVisible();
    expect(tabs()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Focus' })).toHaveFocus();
  });

  it('A04 Exit focus restores the layout and returns keyboard focus to the control', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'Focus' }));
    await user.click(screen.getByRole('button', { name: 'Exit focus' }));
    expect(tabs()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Focus' })).toHaveFocus();
  });

  it('A04 the material panel stays mounted across Focus toggles', async () => {
    const user = userEvent.setup();
    await open();
    const panel = screen.getByRole('tabpanel');
    await user.click(screen.getByRole('button', { name: 'Focus' }));
    expect(screen.getByRole('tabpanel')).toBe(panel);
    await user.keyboard('{Escape}');
    expect(screen.getByRole('tabpanel')).toBe(panel);
  });

  it('A04 F requests full screen, the control becomes Exit full screen, Escape restores the workspace', async () => {
    const user = userEvent.setup();
    await open();
    await user.keyboard('f');
    expect(requestFullscreen).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole('button', { name: 'Exit full screen' })).toBeVisible();
    expect(bar()).not.toBeInTheDocument();

    leaveFullscreen(); // the browser handles Escape itself
    await waitFor(() => expect(bar()).toBeInTheDocument());
    expect(tabs()).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Full screen' })).toHaveFocus();
  });

  it('A04 Exit focus also leaves full screen', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'Full screen' }));
    await user.click(await screen.findByRole('button', { name: 'Exit focus' }));
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(tabs()).toBeInTheDocument());
  });

  it('A04 F is ignored in editable fields and with modifier keys held', async () => {
    const user = userEvent.setup();
    await open();
    const field = document.createElement('input');
    document.body.append(field);
    field.focus();
    await user.keyboard('f');
    field.remove();
    await user.keyboard('{Control>}f{/Control}');
    await user.keyboard('{Meta>}f{/Meta}');
    await user.keyboard('{Alt>}f{/Alt}');
    await user.keyboard('{Shift>}f{/Shift}');
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(bar()).toBeInTheDocument();
  });

  it('A04 when full screen is denied, Focus stays on with a notice that Escape closes', async () => {
    const user = userEvent.setup();
    requestFullscreen.mockRejectedValue(new Error('denied'));
    await open();
    await user.click(screen.getByRole('button', { name: 'Full screen' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Browser full screen is unavailable',
    );
    expect(bar()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit focus' })).toBeVisible();

    await user.keyboard('{Escape}');
    expect(bar()).toBeInTheDocument();
    expect(screen.queryByText(/Browser full screen is unavailable/)).not.toBeInTheDocument();
  });

  it('A04 without the Fullscreen API Focus remains and the fallback is explained', async () => {
    const user = userEvent.setup();
    Object.defineProperty(HTMLElement.prototype, 'requestFullscreen', {
      configurable: true,
      value: undefined,
    });
    await open();
    await user.keyboard('f');
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Browser full screen is unavailable',
    );
    expect(screen.getByRole('button', { name: 'Exit focus' })).toBeVisible();
  });

  it('A04 F and Escape do nothing on a locked topic, which has no toolbar', async () => {
    const user = userEvent.setup();
    renderApp(`/classes/${CLASS_A}/topics/${T_ESTIMATION}/slides`);
    await screen.findByRole('heading', { name: 'Estimation' });
    await user.keyboard('f');
    expect(requestFullscreen).not.toHaveBeenCalled();
    expect(bar()).toBeInTheDocument();
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument();
  });

  it('A04 another element leaving full screen does not end Focus', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'Focus' }));
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(bar()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit focus' })).toBeVisible();
  });
});
