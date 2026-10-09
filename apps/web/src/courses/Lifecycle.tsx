import {
  archiveClass,
  archiveCourse,
  restoreClass,
  restoreCourse,
} from '@parallax/contracts/routes/lifecycle';
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { ApiError, call } from '../api/client';
import buttons from '../components/Buttons.module.css';
import styles from './Courses.module.css';
import { Dialog } from './Dialogs';
import { refreshContexts } from './queries';

export interface Target {
  kind: 'class' | 'course';
  id: string;
  /** The name shown in the question and the outcome, e.g. "Statistical thinking · Autumn A". */
  name: string;
  archived: boolean;
}

const run = (target: Target) =>
  target.kind === 'class'
    ? call(target.archived ? restoreClass : archiveClass, { params: { classId: target.id } })
    : call(target.archived ? restoreCourse : archiveCourse, { params: { courseId: target.id } });

function refusal(error: unknown, target: Target): string {
  const verb = target.archived ? 'restored' : 'archived';
  if (error instanceof ApiError) {
    const code = (error.body as { error?: unknown } | null)?.error;
    if (code === 'course_archived') {
      if (target.kind === 'course') return `${target.name} is archived already.`;
      return target.archived
        ? `${target.name} was not restored: its course is archived. Restore the course first.`
        : `${target.name} was not archived: its course is archived already.`;
    }
    if (code === 'class_archived') return `${target.name} is archived already.`;
    if (code === 'not_archived')
      return `${target.name} is not archived, so there is nothing to restore.`;
  }
  return `${target.name} was not ${verb}. Try again.`;
}

/**
 * Archive or restore a class or a course (§13). The button opens a confirmation that says what
 * changes; the outcome is reported only after the server answered.
 */
export function ArchiveControl({
  target,
  onDone,
}: {
  target: Target;
  onDone: (text: string) => void;
}) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Bumped on every open and close, so an answer that arrives after the dialog was closed (or
  // reopened) is ignored: the person cancelled it, and the cards still reload to the real state.
  const round = useRef(0);
  const noun = target.kind;
  const label = `${target.archived ? 'Restore' : 'Archive'} ${noun}`;
  const confirm = async () => {
    const mine = ++round.current;
    const current = () => round.current === mine;
    setBusy(true);
    setError(null);
    try {
      await run(target);
      if (!current()) {
        void refreshContexts(queryClient);
        return;
      }
      // Close first, so the title cannot flip to the opposite action while the cards reload.
      setOpen(false);
      await refreshContexts(queryClient);
      onDone(`${target.name} was ${target.archived ? 'restored' : 'archived'}.`);
    } catch (e) {
      if (!current()) {
        void refreshContexts(queryClient);
        return;
      }
      const text = refusal(e, target);
      if (e instanceof ApiError && e.status === 409) {
        // The card is out of date (the state changed elsewhere). Closing keeps the dialog from
        // flipping to the opposite action under the reload; the refusal is said on the page.
        setOpen(false);
        void refreshContexts(queryClient);
        onDone(text);
      } else {
        setError(text);
      }
    } finally {
      if (current()) setBusy(false);
    }
  };
  const close = () => {
    round.current++;
    setBusy(false);
    setOpen(false);
    setError(null);
  };
  return (
    <>
      <button
        type="button"
        className={buttons.outline}
        aria-label={`${label} ${target.name}`}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
      {open ? (
        <Dialog title={`${label}?`} onClose={close}>
          <p>
            {target.archived
              ? `${target.name} becomes editable again.`
              : `${target.name} stays readable for everyone in it, and ${
                  noun === 'course' ? 'its classes and draft take' : 'it takes'
                } no further changes until restored.`}
          </p>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <div className={styles.actions}>
            <button
              type="button"
              className={buttons.primary}
              disabled={busy}
              onClick={() => void confirm()}
            >
              {label}
            </button>
            <button type="button" className={buttons.outline} onClick={close}>
              Cancel
            </button>
          </div>
        </Dialog>
      ) : null}
    </>
  );
}
