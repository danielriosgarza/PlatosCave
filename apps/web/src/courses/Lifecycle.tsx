import {
  archiveClass,
  archiveCourse,
  restoreClass,
  restoreCourse,
} from '@parallax/contracts/routes/lifecycle';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
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
      return target.kind === 'course' || !target.archived
        ? `${target.name} is archived already.`
        : 'This course is archived. Restore the course first.';
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
  const noun = target.kind;
  const label = `${target.archived ? 'Restore' : 'Archive'} ${noun}`;
  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await run(target);
      await refreshContexts(queryClient);
      setOpen(false);
      onDone(`${target.name} was ${target.archived ? 'restored' : 'archived'}.`);
    } catch (e) {
      setError(refusal(e, target));
      // A 409 means the card is out of date (someone else changed the state): reload it.
      if (e instanceof ApiError && e.status === 409) void refreshContexts(queryClient);
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
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
