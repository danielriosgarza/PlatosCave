import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from '../courses/Dialogs';
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
  Object.defineProperty(document, 'exitFullscreen', {
    configurable: true,
    value: exitFullscreen,
  });
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
    expect(screen.getByRole('button', { name: 'Exit focus' })).toHaveAttribute('data-on', 'true');
    expect(screen.getByRole('button', { name: 'Exit focus' })).not.toHaveAttribute('aria-pressed');

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

  it('A04 Escape in a dialog opened from Focus closes only the dialog, and F does nothing behind it', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'Focus' }));
    const onClose = vi.fn();
    render(
      <Dialog title="Remove material" onClose={onClose}>
        <button type="button">Cancel</button>
      </Dialog>,
    );
    await user.keyboard('f');
    expect(requestFullscreen).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(bar()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit focus' })).toBeInTheDocument();
  });

  it('A20 the material panel keeps a name and the status regions stay mounted during Focus', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'Focus' }));
    expect(tabs()).not.toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'Reading' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
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

  it('A04 A20 a dialog opened in full screen is shown inside the full-screen element and can be operated', async () => {
    const user = userEvent.setup();
    await open();
    await user.keyboard('f');
    const exit = await screen.findByRole('button', {
      name: 'Exit full screen',
    });
    const workspace = fullscreenElement as HTMLElement;
    expect(workspace.contains(exit)).toBe(true);
    const onClose = vi.fn();
    render(
      <Dialog title="File conflict" onClose={onClose}>
        <button type="button">Keep mine</button>
      </Dialog>,
    );
    const dialog = screen.getByRole('dialog', { name: 'File conflict' });
    expect(workspace.contains(dialog)).toBe(true);
    expect(dialog.closest('[inert]')).toBeNull();
    expect(workspace.hasAttribute('inert')).toBe(false);
    expect(exit.closest('[inert]')).not.toBeNull();
    const keep = screen.getByRole('button', { name: 'Keep mine' });
    expect(keep).toHaveFocus();
    await user.click(keep);
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('A04 A20 leaving full screen while a dialog is open keeps focus inside the dialog and the restored page inert', async () => {
    const user = userEvent.setup();
    await open();
    await user.keyboard('f');
    await screen.findByRole('button', { name: 'Exit full screen' });
    render(
      <Dialog title="File conflict" onClose={() => undefined}>
        <button type="button">Keep mine</button>
      </Dialog>,
    );
    expect(screen.getByRole('button', { name: 'Keep mine' })).toHaveFocus();
    leaveFullscreen(); // the browser handles Escape itself
    await waitFor(() => expect(bar()).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Keep mine' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Full screen' })).not.toHaveFocus();
    // Page chrome that mounted when full screen ended stays inert behind the dialog.
    const tablist = screen.getByRole('tablist', {
      name: 'Topic materials',
      hidden: true,
    });
    await waitFor(() => expect(tablist.closest('[inert]')).not.toBeNull());
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull();
  });

  it('A04 A20 a second dialog opened in full screen stays operable and the first is operable again after it closes', async () => {
    const user = userEvent.setup();
    await open();
    await user.keyboard('f');
    await screen.findByRole('button', { name: 'Exit full screen' });
    function Two({ second }: { second: boolean }) {
      return (
        <>
          <Dialog title="First" onClose={() => undefined}>
            <button type="button">First action</button>
          </Dialog>
          {second ? (
            <Dialog title="Second" onClose={() => undefined}>
              <button type="button">Second action</button>
            </Dialog>
          ) : null}
        </>
      );
    }
    const { rerender } = render(<Two second={false} />);
    rerender(<Two second />);
    const second = screen.getByRole('button', { name: 'Second action' });
    await waitFor(() => expect(second).toHaveFocus());
    expect(second.closest('[inert]')).toBeNull();
    await user.click(second);
    rerender(<Two second={false} />);
    expect(screen.getByRole('button', { name: 'First action' }).closest('[inert]')).toBeNull();
  });

  it('A04 A20 two stacked dialogs: Tab moves inside the newer one, one Escape closes only it, the page stays inert until both close', async () => {
    const user = userEvent.setup();
    const closed: string[] = [];
    function Host() {
      const [first, setFirst] = useState(true);
      const [second, setSecond] = useState(true);
      return (
        <>
          <main>
            <button type="button">Page action</button>
          </main>
          {first ? (
            <Dialog
              title="First"
              onClose={() => {
                closed.push('first');
                setFirst(false);
              }}
            >
              <button type="button">First action</button>
            </Dialog>
          ) : null}
          {second ? (
            <Dialog
              title="Second"
              onClose={() => {
                closed.push('second');
                setSecond(false);
              }}
            >
              <button type="button">Second one</button>
              <button type="button">Second two</button>
            </Dialog>
          ) : null}
        </>
      );
    }
    render(<Host />);
    const one = screen.getByRole('button', { name: 'Second one' });
    const two = screen.getByRole('button', { name: 'Second two' });
    await waitFor(() => expect(one).toHaveFocus());
    await user.tab();
    expect(two).toHaveFocus();
    await user.tab();
    expect(one).toHaveFocus();
    await user.tab({ shift: true });
    expect(two).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(closed).toEqual(['second']);
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(
      screen.getAllByRole('button', { name: 'Page action' })[0]?.closest('[inert]'),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: 'First action' }).closest('[inert]')).toBeNull();

    await user.keyboard('{Escape}');
    expect(closed).toEqual(['second', 'first']);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('A04 A20 the page stays inert when the older dialog closes first', async () => {
    function Host({ first, second }: { first: boolean; second: boolean }) {
      return (
        <>
          <main>
            <button type="button">Page action</button>
          </main>
          {first ? (
            <Dialog title="First" onClose={() => undefined}>
              <button type="button">First action</button>
            </Dialog>
          ) : null}
          {second ? (
            <Dialog title="Second" onClose={() => undefined}>
              <button type="button">Second action</button>
            </Dialog>
          ) : null}
        </>
      );
    }
    const { rerender } = render(<Host first second={false} />);
    rerender(<Host first second />);
    rerender(<Host first={false} second />);
    expect(
      screen.getByRole('button', { name: 'Page action', hidden: true }).closest('[inert]'),
    ).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Second action' }).closest('[inert]')).toBeNull();
    rerender(<Host first={false} second={false} />);
    expect(document.querySelector('[inert]')).toBeNull();
  });

  it('A04 A20 a dialog opened while a frame is full screen inside the full-screen workspace is shown in the workspace after the frame leaves', async () => {
    const user = userEvent.setup();
    await open();
    await user.keyboard('f');
    await screen.findByRole('button', { name: 'Exit full screen' });
    const workspace = fullscreenElement as HTMLElement;
    const inner = document.createElement('iframe');
    workspace.append(inner);
    enterFullscreen(inner);
    // One exitFullscreen() pops the frame; the browser returns to the workspace.
    exitFullscreen.mockReset().mockImplementation(async () => enterFullscreen(workspace));
    const onClose = vi.fn();
    render(
      <Dialog title="File conflict" onClose={onClose}>
        <button type="button">Keep mine</button>
      </Dialog>,
    );
    const keep = await screen.findByRole('button', { name: 'Keep mine' });
    expect(exitFullscreen).toHaveBeenCalledTimes(1);
    expect(workspace.contains(screen.getByRole('dialog', { name: 'File conflict' }))).toBe(true);
    expect(screen.getByRole('dialog').closest('[inert]')).toBeNull();
    await waitFor(() => expect(keep).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    inner.remove();
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

  it('A11 an element inside the workspace in full screen, such as the Shiny frame, is the workspace’s own', async () => {
    const user = userEvent.setup();
    await open();
    await user.keyboard('f');
    await screen.findByRole('button', { name: 'Exit full screen' });
    const workspace = requestFullscreen.mock.contexts[0] as HTMLElement;
    const inner = document.createElement('iframe');
    workspace.append(inner);

    enterFullscreen(inner); // the app inside asks for its own full screen
    expect(bar()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeVisible();

    enterFullscreen(workspace); // the browser returns to the workspace when the frame exits
    expect(bar()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit full screen' })).toBeVisible();

    leaveFullscreen();
    await waitFor(() => expect(bar()).toBeInTheDocument());
    inner.remove();
  });

  it('A11 the frame’s own full screen, entered with only Focus on, does not end Focus when it closes', async () => {
    const user = userEvent.setup();
    await open();
    await user.click(screen.getByRole('button', { name: 'Focus' }));
    const inner = document.createElement('iframe');
    screen.getByRole('tabpanel').append(inner);

    enterFullscreen(inner);
    leaveFullscreen();
    expect(bar()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit focus' })).toHaveAttribute('data-on', 'true');
    inner.remove();
  });
});
