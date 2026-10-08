import { createCourse } from '@parallax/contracts/routes/courses';
import { joinClass } from '@parallax/contracts/routes/members';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { z } from 'zod';
import { ApiError, call } from '../api/client';
import buttons from '../components/Buttons.module.css';
import page from '../components/Page.module.css';
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

/**
 * A modal sheet: focus moves in and stays inside (Tab and Shift+Tab wrap), Escape closes from
 * wherever focus is, and on close focus returns to the opener, or to the page heading when the
 * opener is gone.
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
  // Fixed at open: the browser shows only the full-screen element's subtree (§5).
  // A frame or media element in full screen cannot hold the sheet, so it falls back to <body>.
  const [container] = useState<HTMLElement>(() => {
    const element = document.fullscreenElement;
    return element instanceof HTMLElement &&
      !(element instanceof HTMLIFrameElement || element instanceof HTMLMediaElement)
      ? element
      : document.body;
  });
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement as HTMLElement | null;
    const inside = () => Array.from(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    inside()[0]?.focus();
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !dialog) return;
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
      if (dialog && e.target instanceof Node && !dialog.contains(e.target)) inside()[0]?.focus();
    };
    // The sheet is portalled to the full-screen element when there is one (only its subtree is
    // shown), else to <body>. Everything beside it on the way up to <body> is the page behind it.
    // Nodes that mount while the sheet is open (page chrome restored when full screen ends) are
    // inerted too.
    const background = new Set<HTMLElement>();
    const observer = new MutationObserver(() => sweep());
    const watched = new Set<HTMLElement>();
    const sweep = () => {
      for (let node = dialog?.parentElement; node && node !== document.body; ) {
        const parent: HTMLElement | null = node.parentElement;
        if (parent && !watched.has(parent)) {
          watched.add(parent);
          observer.observe(parent, { childList: true });
        }
        for (const el of Array.from(parent?.children ?? [])) {
          if (el !== node && el instanceof HTMLElement && !el.hasAttribute('inert')) {
            el.setAttribute('inert', '');
            background.add(el);
          }
        }
        node = parent;
      }
    };
    sweep();
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('focusin', onFocusIn);
      observer.disconnect();
      for (const el of background) el.removeAttribute('inert');
      if (opener?.isConnected && opener !== document.body) opener.focus();
      else focusPageAnchor();
    };
  }, []);
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
