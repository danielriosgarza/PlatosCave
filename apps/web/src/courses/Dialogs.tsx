import { createCourse } from '@parallax/contracts/routes/courses';
import { joinClass } from '@parallax/contracts/routes/members';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { z } from 'zod';
import { ApiError, call } from '../api/client';
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
        <button type="submit" className={page.primary} disabled={!code.trim() || join.isPending}>
          Join class
        </button>
        {join.isError && onDone ? (
          <button type="button" className={page.outline} onClick={onDone}>
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
        <button type="submit" className={page.primary} disabled={!title.trim() || create.isPending}>
          Create course
        </button>
        <button type="button" className={page.outline} onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** A modal sheet: focus moves in, Escape closes, and focus returns to the opener. */
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
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, button, a')?.focus();
    return () => opener?.focus();
  }, []);
  return (
    <div className={styles.backdrop}>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: Escape handling for the modal sheet */}
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className={styles.dialog}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
      >
        <h2 id={headingId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
