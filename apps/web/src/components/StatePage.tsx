import type { ReactNode } from 'react';
import styles from './Page.module.css';

interface StatePageProps {
  title: string;
  children?: ReactNode;
  /** The action below the text, such as a link back to the courses. */
  action?: ReactNode;
}

/** A page that only states something: a title, what is true, and one way out. */
export function StatePage({ title, children, action }: StatePageProps) {
  return (
    <main id="main" className={styles.index}>
      <h1>{title}</h1>
      <p className={styles.intro}>{children}</p>
      {action ? <p className={styles.stateAction}>{action}</p> : null}
    </main>
  );
}
