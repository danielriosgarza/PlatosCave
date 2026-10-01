import { Link } from '@tanstack/react-router';
import { ApiError } from '../api/client';
import page from '../components/Page.module.css';
import { Unavailable } from '../components/Unavailable';
import { useClassContext } from '../session/classContext';
import styles from './TopicIndex.module.css';
import {
  type ClassTopic,
  type ClassTopics,
  isOpen,
  lockReason,
  minutes,
  TAB_LEGEND,
  tabFor,
  topicNumber,
  useClassTopics,
} from './topics';

/** Compact syllabus for one class (§4): five presence columns, one Resume, legend and count. */
export function TopicIndex({ classId }: { classId: string }) {
  const context = useClassContext(classId);
  const query = useClassTopics(classId);
  if (!context) return <Unavailable />;
  if (query.error instanceof ApiError && query.error.status === 404) return <Unavailable />;
  const data = query.data;
  return (
    <main className={page.index}>
      <h1>{context.courseTitle}</h1>
      {data ? (
        <p className={`${page.small} ${page.muted} ${styles.context}`}>
          {[data.cohort, ...data.instructors].join(' · ')}
        </p>
      ) : null}
      {query.isPending ? (
        <p className={page.intro} role="status">
          Loading topics
        </p>
      ) : !data ? (
        <div className={page.feedback} role="alert">
          <p>The topic list could not be loaded.</p>
          <button type="button" className={page.outline} onClick={() => void query.refetch()}>
            Try again
          </button>
        </div>
      ) : data.topics.length === 0 ? (
        <p className={page.intro}>No topics have been published for this class yet.</p>
      ) : (
        <Syllabus classId={classId} data={data} showReviewed={context.role === 'student'} />
      )}
    </main>
  );
}

function Syllabus({
  classId,
  data,
  showReviewed,
}: {
  classId: string;
  data: ClassTopics;
  showReviewed: boolean;
}) {
  return (
    <>
      <section className={styles.wrap} aria-label="Topic syllabus">
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">No.</th>
              <th scope="col">Topic</th>
              {TAB_LEGEND.map((tab) => (
                <th key={tab.id} scope="col" className={styles.presence}>
                  <abbr title={tab.label}>{tab.letter}</abbr>
                </th>
              ))}
              <th scope="col">Time</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {data.topics.map((topic) => (
              <Row key={topic.topicId} classId={classId} topic={topic} resume={data.resume} />
            ))}
          </tbody>
        </table>
      </section>
      <div className={styles.legend}>
        {TAB_LEGEND.map((tab) => (
          <span key={tab.id}>
            {tab.letter} · {tab.label}
          </span>
        ))}
        {showReviewed ? (
          <span className={styles.reviewed}>
            {data.reviewed.count} of {data.reviewed.total} topics reviewed
          </span>
        ) : null}
      </div>
    </>
  );
}

function Row({
  classId,
  topic,
  resume,
}: {
  classId: string;
  topic: ClassTopic;
  resume: ClassTopics['resume'];
}) {
  const open = isOpen(topic);
  const current = open && resume?.topicId === topic.topicId;
  const reason = lockReason(topic);
  const params = { classId, topicId: topic.topicId, tab: tabFor(topic) };
  return (
    <tr className={current ? styles.current : open ? undefined : styles.closed}>
      <td>{topicNumber(topic)}</td>
      <td>
        {open ? (
          <Link to="/classes/$classId/topics/$topicId/$tab" params={params}>
            {topic.title}
          </Link>
        ) : (
          topic.title
        )}
      </td>
      {TAB_LEGEND.map((tab) => (
        <td key={tab.id} className={styles.presence}>
          <span
            className={`${styles.dot} ${topic.presence[tab.id] ? styles.available : ''}`}
            role="img"
            aria-label={`${tab.label}: ${topic.presence[tab.id] ? 'available' : 'not added'}`}
          />
        </td>
      ))}
      <td className={`${page.small} ${page.muted}`}>{minutes(topic)}</td>
      <td>
        {current ? (
          <Link to="/classes/$classId/topics/$topicId/$tab" params={params}>
            {resume?.saved ? 'Resume' : 'Start'}
          </Link>
        ) : (
          <span className={page.muted}>
            {reason ?? (topic.state === 'complete' ? 'Reviewed' : 'Available')}
          </span>
        )}
      </td>
    </tr>
  );
}
