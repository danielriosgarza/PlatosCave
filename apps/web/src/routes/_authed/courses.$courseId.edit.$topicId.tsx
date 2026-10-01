import { createFileRoute } from '@tanstack/react-router';
import styles from '../../components/Page.module.css';
import { Unavailable } from '../../components/Unavailable';
import { useSession } from '../../session/useSession';

export const Route = createFileRoute('/_authed/courses/$courseId/edit/$topicId')({
  component: EditTopic,
});

function EditTopic() {
  const { courseId } = Route.useParams();
  const session = useSession();
  if (session.status !== 'signed-in') return <main className={styles.index} aria-busy="true" />;
  const course = session.me.courses.find((c) => c.courseId === courseId);
  if (!course) return <Unavailable />;
  return (
    <main className={styles.index}>
      <h1>{course.title}</h1>
      <p className={styles.intro}>The topic editor is not available yet.</p>
    </main>
  );
}
