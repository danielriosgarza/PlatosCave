import { createFileRoute } from '@tanstack/react-router';
import styles from '../../components/Page.module.css';
import { Unavailable } from '../../components/Unavailable';
import { useClassContext } from '../../session/classContext';

export const Route = createFileRoute('/_authed/classes/$classId/topics/')({ component: Topics });

function Topics() {
  const { classId } = Route.useParams();
  const context = useClassContext(classId);
  if (!context) return <Unavailable />;
  return (
    <main className={styles.index}>
      <h1>{context.courseTitle}</h1>
      <p className={`${styles.small} ${styles.muted}`} style={{ marginTop: 12 }}>
        {context.className}
      </p>
      <p className={styles.intro}>The topic list for this class is not available yet.</p>
    </main>
  );
}
