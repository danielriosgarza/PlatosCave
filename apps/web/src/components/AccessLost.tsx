import { Link } from '@tanstack/react-router';
import { useRevoked } from '../session/revocation';
import styles from './Page.module.css';
import { usePageTitle } from './pageTitle';
import { Unavailable } from './Unavailable';

/** Shown where a class page cannot be used: after a revocation it explains, otherwise it names nothing. */
export function ClassUnavailable({ classId }: { classId: string }) {
  const revoked = useRevoked(classId);
  usePageTitle(revoked ? 'Your access to this class has ended' : undefined);
  if (!revoked) return <Unavailable />;
  return (
    <main id="main" className={styles.index}>
      <h1>Your access to this class has ended</h1>
      <p className={styles.intro}>
        Nothing from the class is shown any more and no further changes will be sent to it. If you
        think this is a mistake, ask the person who runs the class.
      </p>
      <p style={{ marginTop: 20 }}>
        <Link to="/courses" className={styles.link}>
          Go to your courses
        </Link>
      </p>
    </main>
  );
}
