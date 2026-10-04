import { Link, useParams } from '@tanstack/react-router';
import styles from './TopicNav.module.css';
import { type ClassTopic, isOpen, lockReason, tabFor, topicNumber, useClassTopics } from './topics';

/**
 * Previous and next topic in the global bar, as its own landmark. A neighbour that is not open stays visible and
 * says why (release time or unmet prerequisite), never silently disabled (§5).
 */
export function TopicNav({
  classId,
  topicId,
  className,
}: {
  classId: string;
  topicId: string;
  className?: string;
}) {
  const { data } = useClassTopics(classId);
  if (!data) return null;
  const index = data.topics.findIndex((t) => t.topicId === topicId);
  if (index < 0) return null;
  const previous = data.topics[index - 1];
  const next = data.topics[index + 1];
  if (!previous && !next) return null;
  const item = (topic: ClassTopic | undefined, label: (t: ClassTopic) => string) => {
    if (!topic) return null;
    if (!isOpen(topic)) {
      return (
        <span className={styles.closed} aria-disabled="true">
          {label(topic)} · {lockReason(topic)}
        </span>
      );
    }
    return (
      <Link
        to="/classes/$classId/topics/$topicId/$tab"
        params={{ classId, topicId: topic.topicId, tab: tabFor(topic) }}
      >
        {label(topic)}
      </Link>
    );
  };
  // The landmark exists only while there is a neighbour to name.
  return (
    <nav className={className} aria-label="Neighbouring topics">
      {item(previous, (t) => `‹ ${topicNumber(t)} ${t.title}`)}
      {item(next, (t) => `${topicNumber(t)} ${t.title} ›`)}
    </nav>
  );
}

/** The route params the bar needs: only a topic workspace address has a neighbouring topic. */
export function useTopicRoute(): { classId: string; topicId: string } | undefined {
  const { classId, topicId } = useParams({ strict: false });
  return classId && topicId ? { classId, topicId } : undefined;
}
