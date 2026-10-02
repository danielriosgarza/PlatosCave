import { signOut } from '@parallax/contracts/routes/auth';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError, call } from '../api/client';
import { clearDrafts } from '../reading/margin/drafts';
import { endSession, studyingClasses, usableClasses, useSession } from '../session/useSession';
import { TopicNav, useTopicRoute } from '../topics/TopicNav';
import { useFocusActive } from '../workspace/focus';
import styles from './GlobalBar.module.css';

export function GlobalBar() {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const { classId: routeClassId } = useParams({ strict: false });
  const topicRoute = useTopicRoute();
  const focus = useFocusActive();

  const me = session.status === 'signed-in' ? session.me : null;
  // Topics opens the class being viewed, else the first class the person studies or teaches.
  const topicsClassId =
    me && (usableClasses(me).some((c) => c.classId === routeClassId) ? routeClassId : undefined);
  const fallback = me ? (studyingClasses(me)[0] ?? usableClasses(me)[0]) : undefined;
  const classId = topicsClassId ?? fallback?.classId;

  const handleSignOut = async () => {
    setSignOutFailed(false);
    setSigningOut(true);
    try {
      await call(signOut);
    } catch (error) {
      // 401 means the session is already gone; anything else leaves the person signed in.
      if (!(error instanceof ApiError && error.status === 401)) {
        setSignOutFailed(true);
        return;
      }
    } finally {
      setSigningOut(false);
    }
    // Leave the guarded pages first so the signed-out guard does not add a `next` to /signin.
    await navigate({ to: '/signin' });
    // Unsent notes on this device belong to the account that just left (§8).
    await clearDrafts(me?.user.id ?? null);
    endSession(queryClient);
  };

  if (focus) return null;
  return (
    <header className={styles.top}>
      <div className={styles.left}>
        <Link className={styles.brand} to="/">
          Parallax
        </Link>
        <span aria-hidden="true" className={styles.divider} />
        {me ? (
          <>
            <Link to="/courses">Courses</Link>
            {classId ? (
              <Link to="/classes/$classId/topics" params={{ classId }}>
                Topics
              </Link>
            ) : null}
          </>
        ) : session.status === 'signed-out' ? (
          <Link to="/signin">Sign in</Link>
        ) : null}
      </div>
      <nav className={styles.topicNav} aria-label="Neighbouring topics">
        {me && topicRoute ? <TopicNav {...topicRoute} /> : null}
      </nav>
      {me ? (
        <div className={styles.account}>
          <span className={styles.who}>{me.user.name}</span>
          {signOutFailed ? <span role="alert">Sign-out failed. Try again.</span> : null}
          <button
            type="button"
            className={styles.signOut}
            disabled={signingOut}
            onClick={handleSignOut}
          >
            Sign out
          </button>
        </div>
      ) : null}
    </header>
  );
}
