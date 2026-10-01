import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { canEdit, grantLabel } from '../../authoring/grants';
import { PublishPanel } from '../../authoring/PublishPanel';
import { draftsQuery } from '../../authoring/queries';
import { ResourceSection } from '../../authoring/ResourceSection';
import { TopicForm } from '../../authoring/TopicForm';
import styles from '../../components/Page.module.css';
import { Unavailable } from '../../components/Unavailable';
import { PreviewButton } from '../../preview/PreviewButton';
import { useSession } from '../../session/useSession';

export const Route = createFileRoute('/_authed/courses/$courseId/edit/$topicId')({
  component: EditTopic,
});

function EditTopic() {
  const { courseId, topicId } = Route.useParams();
  const session = useSession();
  const drafts = useQuery({ ...draftsQuery(courseId), enabled: session.status === 'signed-in' });
  if (session.status !== 'signed-in') return <main className={styles.index} aria-busy="true" />;
  const grant = session.me.courses.find((c) => c.courseId === courseId);
  if (!grant || !canEdit(grant)) return <Unavailable />;

  const topics = drafts.data?.topics ?? [];
  const topic = topics.find((t) => t.id === topicId);
  return (
    <main className={styles.index}>
      <p className={`${styles.small} ${styles.muted}`}>
        <Link to="/courses/$courseId/edit" params={{ courseId }} className={styles.link}>
          {grant.title}
        </Link>
      </p>
      {drafts.isError ? (
        <>
          <h1 style={{ marginTop: 8 }}>Edit topic</h1>
          <p role="alert" style={{ marginTop: 16 }}>
            The topic could not be loaded.{' '}
            <button
              type="button"
              className={styles.textButton}
              onClick={() => void drafts.refetch()}
            >
              Retry
            </button>
          </p>
        </>
      ) : !drafts.data ? (
        <p className={styles.muted} aria-busy="true" style={{ marginTop: 16 }}>
          Loading the topic…
        </p>
      ) : !topic ? (
        <>
          <h1 style={{ marginTop: 8 }}>Edit topic</h1>
          <p className={styles.intro}>This topic is not in the course draft.</p>
        </>
      ) : (
        <>
          <h1 style={{ marginTop: 8 }}>Edit topic</h1>
          <p className={`${styles.small} ${styles.muted}`} style={{ marginTop: 8 }}>
            Topic {topics.filter((t) => !t.archived).findIndex((t) => t.id === topic.id) + 1 || '–'}{' '}
            of the course draft · your permission: {grantLabel(grant)}
          </p>
          <div style={{ marginTop: 16 }}>
            <PreviewButton courseId={courseId} topicId={topic.id} resources={topic.resources} />
          </div>
          <div className={styles.editGrid}>
            <div>
              {/* A new copy from the server remounts the form only when the topic itself changes. */}
              <TopicForm
                key={topic.id}
                courseId={courseId}
                topic={topic}
                // An archived topic stays listed while it is a prerequisite, so it can be unticked.
                others={topics.filter(
                  (t) => t.id !== topic.id && (!t.archived || topic.prerequisites.includes(t.id)),
                )}
                requirable={topic.resources
                  .filter((r) => !r.archived && (r.type === 'test' || r.type === 'exercise'))
                  .map((r) => ({ id: r.id, title: r.title }))}
              />
              <ResourceSection courseId={courseId} topicId={topic.id} resources={topic.resources} />
            </div>
            <PublishPanel courseId={courseId} grant={grant} />
          </div>
        </>
      )}
    </main>
  );
}
