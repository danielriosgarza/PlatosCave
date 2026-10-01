import { createFileRoute } from '@tanstack/react-router';
import styles from '../../components/Page.module.css';
import { Unavailable } from '../../components/Unavailable';
import { useClassContext } from '../../session/classContext';

export const Route = createFileRoute('/_authed/classes/$classId/review')({ component: Review });

function Review() {
  const { classId } = Route.useParams();
  const context = useClassContext(classId);
  if (context?.role !== 'instructor') return <Unavailable />;
  return (
    <main className={styles.index}>
      <h1>Class review</h1>
      <p className={`${styles.small} ${styles.muted}`} style={{ marginTop: 12 }}>
        {context.courseTitle} · {context.className}
      </p>
      <p className={styles.intro}>Class review is not available yet.</p>
    </main>
  );
}
