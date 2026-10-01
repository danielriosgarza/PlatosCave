import { signOut } from '@parallax/contracts/routes/auth';
import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { call } from '../api/client';
import { sessionQuery, studyingClasses, useSession } from '../session/useSession';
import styles from './GlobalBar.module.css';

export function GlobalBar() {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { classId: routeClassId } = useParams({ strict: false });

  const me = session.status === 'signed-in' ? session.me : null;
  // Topics opens the class being viewed, else the first class the person studies or teaches.
  const topicsClassId =
    me && (me.classes.some((c) => c.classId === routeClassId) ? routeClassId : undefined);
  const fallback = me
    ? (studyingClasses(me)[0] ?? me.classes.find((c) => !c.isPreview))
    : undefined;
  const classId = topicsClassId ?? fallback?.classId;

  const handleSignOut = async () => {
    try {
      await call(signOut);
    } finally {
      queryClient.clear();
      queryClient.setQueryData(sessionQuery.queryKey, null);
      await navigate({ to: '/signin' });
    }
  };

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
      <nav className={styles.topicNav} aria-label="Neighbouring topics" />
      {me ? (
        <div className={styles.account}>
          <span className={styles.who}>{me.user.name}</span>
          <button type="button" className={styles.signOut} onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      ) : null}
    </header>
  );
}
