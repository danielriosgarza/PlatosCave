import { Link } from '@tanstack/react-router';
import styles from './Page.module.css';

/** Neutral page for any address the signed-in person cannot use; it names nothing (§2). */
export function Unavailable() {
  return (
    <main className={styles.index}>
      <h1>This page is not available</h1>
      <p className={styles.intro}>
        The address may be wrong, or your account may not have access to it.
      </p>
      <p style={{ marginTop: 20 }}>
        <Link to="/courses" className={styles.link}>
          Go to your courses
        </Link>
      </p>
    </main>
  );
}
