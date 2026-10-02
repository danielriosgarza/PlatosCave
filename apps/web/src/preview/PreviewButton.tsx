import { startPreview } from '@parallax/contracts/routes/preview';
import { useState } from 'react';
import { call } from '../api/client';
import page from '../components/Page.module.css';
import { announceSessionChange } from '../session/broadcast';
import { teachingContexts, useSession } from '../session/useSession';
import { leavePage } from './navigate';

/**
 * "Preview student view" of the topic being edited (§12): opens the course draft as a student of
 * a class the instructor teaches, in a separate preview session (ADR-0002).
 */
export function PreviewButton({ courseId, topicId }: { courseId: string; topicId: string }) {
  const session = useSession();
  const classes =
    session.status === 'signed-in'
      ? teachingContexts(session.me).classes.filter((c) => c.courseId === courseId)
      : [];
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const classId = chosen ?? classes[0]?.classId;

  if (!classId) {
    return <p className={`${page.small} ${page.muted}`}>You teach no class of this course.</p>;
  }

  const start = async () => {
    setFailed(false);
    setStarting(true);
    try {
      const { landing } = await call(startPreview, {
        params: { courseId },
        body: { classId, topicId },
      });
      announceSessionChange();
      leavePage(landing);
    } catch {
      setFailed(true);
      setStarting(false);
    }
  };

  return (
    <div className={page.row}>
      {classes.length > 1 ? (
        <label className={page.small}>
          Preview as a student of{' '}
          <select value={classId} onChange={(e) => setChosen(e.target.value)}>
            {classes.map((c) => (
              <option key={c.classId} value={c.classId}>
                {c.className}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <button type="button" className={page.outline} disabled={starting} onClick={start}>
        Preview student view
      </button>
      {classes.length === 1 ? (
        <span className={`${page.small} ${page.muted}`}>
          as a student of {classes[0]?.className}
        </span>
      ) : null}
      {failed ? <span role="alert">The preview could not be started. Try again.</span> : null}
    </div>
  );
}
