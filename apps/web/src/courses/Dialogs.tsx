import { createCourse } from '@parallax/contracts/routes/courses';
import { joinClass } from '@parallax/contracts/routes/members';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { z } from 'zod';
import { ApiError, call } from '../api/client';
import buttons from '../components/Buttons.module.css';
import page from '../components/Page.module.css';
import { MODAL_SELECTOR } from '../workspace/focus';
import styles from './Courses.module.css';
import { refreshContexts } from './queries';

export type Joined = z.output<typeof joinClass.response>;

/** What the person is told for each reason a code cannot be used (§4: the cause is shown). */
const joinCause: Record<string, string> = {
  invite_not_found: 'This code is not valid. Check it and try again.',
  invite_revoked: 'This code was withdrawn by the instructor.',
  invite_expired: 'This code has expired. Ask the instructor for a new one.',
  invite_full: 'This class has reached its enrolment limit.',
  class_archived: 'This class is archived and no longer takes new students.',
};

function failureText(error: unknown, causes: Record<string, string>, fallback: string): string {
  if (error instanceof ApiError) {
    const body = error.body as { error?: unknown } | null;
    const known = typeof body?.error === 'string' ? causes[body.error] : undefined;
    if (known) return known;
  }
  return fallback;
}

/** The enrolment-code form, used in the dialog and as the empty-account state. */
export function JoinForm({
  onJoined,
  onDone,
}: {
  onJoined: (joined: Joined) => void;
  onDone?: () => void;
}) {
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const join = useMutation({
    mutationFn: (value: string) => call(joinClass, { body: { code: value } }),
    onSuccess: async (joined) => {
      await refreshContexts(queryClient);
      onJoined(joined);
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (code.trim() && !join.isPending) join.mutate(code.trim());
  };
  const fieldId = useId();

  return (
    <form onSubmit={submit}>
      <div className={styles.field}>
        <label htmlFor={fieldId}>Invitation code</label>
        <input
          id={fieldId}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={join.isError ? `${fieldId}-error` : undefined}
        />
      </div>
      {join.isError ? (
        <p id={`${fieldId}-error`} className={styles.error} role="alert">
          {failureText(join.error, joinCause, 'The class could not be joined. Try again.')}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button type="submit" className={buttons.primary} disabled={!code.trim() || join.isPending}>
          Join class
        </button>
        {join.isError && onDone ? (
          <button type="button" className={buttons.outline} onClick={onDone}>
            Back to your courses
          </button>
        ) : null}
      </div>
    </form>
  );
}

export function CreateCourseForm({
  onCreated,
  onDone,
}: {
  onCreated: (created: { id: string; title: string }) => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const create = useMutation({
    mutationFn: (value: string) => call(createCourse, { body: { title: value } }),
    onSuccess: async (created) => {
      await refreshContexts(queryClient);
      onCreated(created);
    },
  });
  const fieldId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() && !create.isPending) create.mutate(title.trim());
  };

  return (
    <form onSubmit={submit}>
      <div className={styles.field}>
        <label htmlFor={fieldId}>Course title</label>
        <input
          id={fieldId}
          value={title}
          maxLength={160}
          onChange={(e) => setTitle(e.target.value)}
          aria-describedby={create.isError ? `${fieldId}-error` : undefined}
        />
      </div>
      {create.isError ? (
        <p id={`${fieldId}-error`} className={styles.error} role="alert">
          {failureText(
            create.error,
            { not_instructor: 'Only instructors can create courses.' },
            'The course was not created. Try again.',
          )}
        </p>
      ) : null}
      <div className={styles.actions}>
        <button
          type="submit"
          className={buttons.primary}
          disabled={!title.trim() || create.isPending}
        >
          Create course
        </button>
        <button type="button" className={buttons.outline} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Where focus goes when the opener has unmounted: the page heading, else the main region. */
function focusPageAnchor() {
  const anchor =
    document.querySelector<HTMLElement>('main h1') ??
    document.querySelector<HTMLElement>('h1') ??
    document.querySelector('main');
  if (!anchor) return;
  if (!anchor.hasAttribute('tabindex')) anchor.setAttribute('tabindex', '-1');
  anchor.focus();
}

/** Open sheets, oldest first. Only the newest handles keys; the ones beneath it stay inert. */
const openSheets: object[] = [];

/** How many open sheets hide each element, so the page stays inert until the last one closes. */
const hiddenBy = new Map<HTMLElement, number>();

function hide(el: Node) {
  if (!(el instanceof HTMLElement)) return null;
  const count = hiddenBy.get(el);
  // Inert set by something else is not ours to set or clear.
  if (count === undefined && el.hasAttribute('inert')) return null;
  hiddenBy.set(el, (count ?? 0) + 1);
  el.setAttribute('inert', '');
  return el;
}

function reveal(el: HTMLElement) {
  const count = (hiddenBy.get(el) ?? 1) - 1;
  if (count > 0) {
    hiddenBy.set(el, count);
    return;
  }
  hiddenBy.delete(el);
  el.removeAttribute('inert');
}

/** The element that shows the sheet: the full-screen element (only its subtree is shown), else <body>. */
function sheetContainer(): HTMLElement {
  const element = document.fullscreenElement;
  return element instanceof HTMLElement && !isEmbeddedFullscreen(element) ? element : document.body;
}

/** A frame or media element in full screen cannot hold the sheet. */
function isEmbeddedFullscreen(element: Element) {
  return element instanceof HTMLIFrameElement || element instanceof HTMLMediaElement;
}

/**
 * A modal sheet: focus moves in and stays inside (Tab and Shift+Tab wrap), Escape closes from
 * wherever focus is, and on close focus returns to the opener, or to the page heading when the
 * opener is gone. With several sheets open, only the newest handles keys.
 */
export function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const headingId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  // Fixed once known. While a frame is full screen the sheet waits (null) for it to leave full
  // screen, then joins the element that is still full screen (the workspace) or <body>.
  const [container, setContainer] = useState<HTMLElement | null>(() => {
    const element = document.fullscreenElement;
    return element && isEmbeddedFullscreen(element) ? null : sheetContainer();
  });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
  }, []);
  useEffect(() => {
    if (container) return;
    let cancelled = false;
    void (async () => {
      try {
        await document.exitFullscreen();
      } catch {
        // The browser already left full screen.
      }
      if (!cancelled) setContainer(sheetContainer());
    })();
    return () => {
      cancelled = true;
    };
  }, [container]);
  useEffect(() => {
    const dialog = ref.current;
    if (!container || !dialog) return;
    const token = {};
    openSheets.push(token);
    const newest = () => openSheets[openSheets.length - 1] === token;
    const inside = () => Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    inside()[0]?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (!newest()) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = inside();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      // Focus inside another, newer sheet is that sheet's to keep.
      if (!newest() || !(e.target instanceof Element) || e.target.closest(MODAL_SELECTOR)) return;
      if (!dialog.contains(e.target)) inside()[0]?.focus();
    };
    // Everything beside the sheet on the way up to <body> is the page behind it (and any older
    // sheet). Nodes that mount while the sheet is open (page chrome restored when full screen
    // ends) are inerted too, except another sheet, which its own dialog keeps operable.
    const background = new Set<HTMLElement>();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const added of Array.from(record.addedNodes)) {
          const isSheet =
            added instanceof Element &&
            (added.matches(MODAL_SELECTOR) || added.querySelector(MODAL_SELECTOR));
          const hidden = isSheet ? null : hide(added);
          if (hidden) background.add(hidden);
        }
      }
    });
    for (let node: HTMLElement | null = dialog.parentElement; node && node !== document.body; ) {
      const parent: HTMLElement | null = node.parentElement;
      if (parent) observer.observe(parent, { childList: true });
      for (const el of Array.from(parent?.children ?? [])) {
        const hidden = el === node ? null : hide(el);
        if (hidden) background.add(hidden);
      }
      node = parent;
    }
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      observer.disconnect();
      openSheets.splice(openSheets.indexOf(token), 1);
      for (const el of background) reveal(el);
      const from = opener.current;
      if (from?.isConnected && from !== document.body) from.focus();
      else focusPageAnchor();
    };
  }, [container]);
  if (!container) return null;
  return createPortal(
    <div className={styles.backdrop}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className={styles.dialog}
      >
        <h2 id={headingId}>{title}</h2>
        {children}
      </div>
    </div>,
    container,
  );
}
