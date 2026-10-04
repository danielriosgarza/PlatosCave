import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link } from '@tanstack/react-router';
import { canEdit, grantLabel } from '../../authoring/grants';
import { PublishPanel } from '../../authoring/PublishPanel';
import { draftsQuery } from '../../authoring/queries';
import { ResourceSection } from '../../authoring/ResourceSection';
import { TopicForm } from '../../authoring/TopicForm';
import { Loading } from '../../components/Loading';
import styles from '../../components/Page.module.css';
import { usePageTitle } from '../../components/pageTitle';
import { RetryNotice } from '../../components/RetryNotice';
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
  const editedTopic = drafts.data?.topics.find((t) => t.id === topicId);
  const allowed =
    session.status === 'signed-in' &&
    session.me.courses.some((c) => c.courseId === courseId && canEdit(c));
  usePageTitle(allowed && editedTopic ? `Edit ${editedTopic.title}` : undefined);
  if (session.status !== 'signed-in') {
    return (
      <main id="main" className={styles.index}>
        <Loading label="Loading the topic" />
      </main>
    );
  }
  const grant = session.me.courses.find((c) => c.courseId === courseId);
  if (!grant || !canEdit(grant)) return <Unavailable />;

  const topics = drafts.data?.topics ?? [];
  const topic = topics.find((t) => t.id === topicId);
  return (
    <main id="main" className={styles.index}>
      <p className={`${styles.small} ${styles.muted}`}>
        <Link to="/courses/$courseId/edit" params={{ courseId }} className={styles.link}>
          {grant.title}
        </Link>
      </p>
      {drafts.isError ? (
        <>
          <h1 className={styles.mt8}>Edit topic</h1>
          <RetryNotice
            message="The topic could not be loaded."
            retryLabel="Retry"
            onRetry={() => void drafts.refetch()}
          />
        </>
      ) : !drafts.data ? (
        <Loading label="Loading the topic…" />
      ) : !topic ? (
        <>
          <h1 className={styles.mt8}>Edit topic</h1>
          <p className={styles.intro}>This topic is not in the course draft.</p>
        </>
      ) : (
        <>
          <h1 className={styles.mt8}>Edit topic</h1>
          <p className={`${styles.small} ${styles.muted} ${styles.mt8}`}>
            Topic {topics.filter((t) => !t.archived).findIndex((t) => t.id === topic.id) + 1 || '–'}{' '}
            of the course draft · your permission: {grantLabel(grant)}
          </p>
          <div className={styles.mt16}>
            <PreviewButton courseId={courseId} topicId={topic.id} />
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
