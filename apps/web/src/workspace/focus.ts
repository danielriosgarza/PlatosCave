import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

/** Focus is shared because the global bar lives outside the topic workspace (§5). */
let focusOn = false;
const listeners = new Set<() => void>();
const setFocusOn = (next: boolean) => {
  if (focusOn === next) return;
  focusOn = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const useFocusActive = () =>
  useSyncExternalStore(
    subscribe,
    () => focusOn,
    () => false,
  );

/** F is ignored in editable fields and when a modifier is held (§5). */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !==
      null
  );
}

/**
 * Whether a modal dialog is open. Keys then belong to the dialog: Escape closes only it, and
 * F does not toggle the workspace behind it (§5, §14).
 */
export function modalOpen(): boolean {
  return document.querySelector('[aria-modal="true"]') !== null;
}

export const FULLSCREEN_FALLBACK =
  'Browser full screen is unavailable. Focus stays on; Escape or Exit focus closes it.';

/**
 * Focus and full screen for one workspace element. State lives outside the material, so the
 * current slide and edits survive every toggle; both modes end when the workspace unmounts.
 */
export function useFocusMode(workspace: RefObject<HTMLElement | null>) {
  const focus = useFocusActive();
  const [fullscreen, setFullscreen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const focusButton = useRef<HTMLButtonElement | null>(null);
  const fullscreenButton = useRef<HTMLButtonElement | null>(null);

  // Whether the workspace itself is in full screen. An element inside it, such as an embedded
  // app's frame, counts as ours only then: the frame's own full screen, entered while only Focus
  // is on, is another element's and must not end Focus when it closes.
  const workspaceFullscreen = useRef(false);
  const isOurs = useCallback(() => {
    const element = document.fullscreenElement;
    const root = workspace.current;
    if (!root || !element) return false;
    return element === root || (workspaceFullscreen.current && root.contains(element));
  }, [workspace]);

  const leaveFullscreen = useCallback(async () => {
    if (isOurs()) {
      try {
        await document.exitFullscreen();
      } catch {
        // The browser already left full screen; the change event settles the state.
      }
    }
  }, [isOurs]);

  const exitFocus = useCallback(async () => {
    setFocusOn(false);
    setNotice(null);
    await leaveFullscreen();
    focusButton.current?.focus({ preventScroll: true });
  }, [leaveFullscreen]);

  const toggleFocus = useCallback(async () => {
    if (focusOn) await exitFocus();
    else setFocusOn(true);
  }, [exitFocus]);

  const toggleFullscreen = useCallback(async () => {
    if (isOurs()) {
      await leaveFullscreen();
      return;
    }
    setFocusOn(true);
    const element = workspace.current;
    if (!element || typeof element.requestFullscreen !== 'function') {
      setNotice(FULLSCREEN_FALLBACK);
      return;
    }
    try {
      await element.requestFullscreen();
      setNotice(null);
    } catch {
      setNotice(FULLSCREEN_FALLBACK);
    }
  }, [isOurs, leaveFullscreen, workspace]);

  // The browser ends full screen itself on Escape: restore the normal workspace.
  useEffect(() => {
    let wasOurs = isOurs();
    const onChange = () => {
      const element = document.fullscreenElement;
      const root = workspace.current;
      if (element !== null && element === root) workspaceFullscreen.current = true;
      else if (!element || !root?.contains(element)) workspaceFullscreen.current = false;
      const active = isOurs();
      const changed = active !== wasOurs;
      wasOurs = active;
      // Another element entering or leaving full screen is not ours to react to.
      if (!changed) return;
      setFullscreen(active);
      if (!active) {
        setFocusOn(false);
        setNotice(null);
        fullscreenButton.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [isOurs, workspace]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || modalOpen()) return;
      if (event.key === 'Escape' && focusOn && !isOurs()) {
        event.preventDefault();
        void exitFocus();
        return;
      }
      if (
        event.key.toLowerCase() === 'f' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        !event.repeat &&
        !isEditable(event.target)
      ) {
        event.preventDefault();
        void toggleFullscreen();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [exitFocus, isOurs, toggleFullscreen]);

  useEffect(
    () => () => {
      setFocusOn(false);
      if (workspace.current?.contains(document.fullscreenElement)) {
        void document.exitFullscreen().catch(() => undefined);
      }
    },
    [workspace],
  );

  return {
    focus,
    fullscreen,
    notice,
    toggleFocus,
    toggleFullscreen,
    focusButton,
    fullscreenButton,
  };
}
