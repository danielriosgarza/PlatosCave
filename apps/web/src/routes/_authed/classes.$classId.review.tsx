import { createFileRoute } from '@tanstack/react-router';
import { ClassUnavailable } from '../../components/AccessLost';
import styles from '../../components/Page.module.css';
import { usePageTitle } from '../../components/pageTitle';
import { useClassContext } from '../../session/classContext';

export const Route = createFileRoute('/_authed/classes/$classId/review')({ component: Review });

function Review() {
  const { classId } = Route.useParams();
  const context = useClassContext(classId);
  usePageTitle(context?.role === 'instructor' ? 'Class review' : undefined);
  if (context?.role !== 'instructor') return <ClassUnavailable classId={classId} />;
  return (
    <main id="main" className={styles.index}>
      <h1>Class review</h1>
      <p className={`${styles.small} ${styles.muted}`} style={{ marginTop: 12 }}>
        {context.courseTitle} · {context.className}
      </p>
      <p className={styles.intro}>Class review is not available yet.</p>
    </main>
  );
}
