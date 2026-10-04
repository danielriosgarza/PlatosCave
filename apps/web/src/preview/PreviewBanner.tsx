import { exitPreview } from '@parallax/contracts/routes/preview';
import { useState } from 'react';
import { call } from '../api/client';
import buttons from '../components/Buttons.module.css';
import page from '../components/Page.module.css';
import { announceSessionChange } from '../session/broadcast';
import { usableClasses, useSession } from '../session/useSession';
import { useFocusActive } from '../workspace/focus';
import { leavePage } from './navigate';
import styles from './PreviewBanner.module.css';

/**
 * Shown on every page of a draft-preview session (§12): what is being previewed, for which
 * class, that the work stays apart from the class, and the way back to the editor.
 */
export function PreviewBanner() {
  const session = useSession();
  const focus = useFocusActive();
  const [leaving, setLeaving] = useState(false);
  const [failed, setFailed] = useState(false);
  if (session.status !== 'signed-in' || session.me.user.kind !== 'preview' || focus) return null;
  const membership = usableClasses(session.me)[0];

  const exit = async () => {
    setFailed(false);
    setLeaving(true);
    try {
      const { returnTo } = await call(exitPreview);
      announceSessionChange();
      leavePage(returnTo);
    } catch {
      setFailed(true);
      setLeaving(false);
    }
  };

  return (
    <section className={styles.banner} aria-label="Draft preview">
      <p>
        <strong>Draft preview</strong>
        {membership ? ` · ${membership.courseTitle} as a student of ${membership.className}` : ''}.
        Notes and attempts made here stay out of the class.
      </p>
      {failed ? (
        <p className={styles.error} role="alert">
          Could not leave the preview. Try again.
        </p>
      ) : null}
      <button type="button" className={buttons.outline} disabled={leaving} onClick={exit}>
        Exit draft preview
      </button>
    </section>
  );
}
