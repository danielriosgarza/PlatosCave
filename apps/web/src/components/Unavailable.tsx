import { Link } from '@tanstack/react-router';
import styles from './Page.module.css';
import { usePageTitle } from './pageTitle';
import { StatePage } from './StatePage';

/** Neutral page for any address the signed-in person cannot use; it names nothing (§2). */
export function Unavailable() {
  usePageTitle('This page is not available');
  return (
    <StatePage
      title="This page is not available"
      action={
        <Link to="/courses" className={styles.link}>
          Go to your courses
        </Link>
      }
    >
      The address may be wrong, or your account may not have access to it.
    </StatePage>
  );
}
