import styles from './TopicHeading.module.css';
import { type ClassTopic, type ClassTopics, minutes } from './topics';

/** Title, one-line objective, then course, position, study time, cohort and instructor (§4). */
export function TopicHeading({ data, topic }: { data: ClassTopics; topic: ClassTopic }) {
  const parts = [
    data.course.title,
    `Topic ${topic.number} of ${data.topics.length}`,
    ...(topic.estimatedMinutes === null ? [] : [minutes(topic)]),
    data.cohort,
    ...data.instructors,
  ];
  return (
    <header className={styles.heading}>
      <h1>{topic.title}</h1>
      {topic.objective ? <p className={styles.objective}>{topic.objective}</p> : null}
      <p className={styles.context}>{parts.join(' · ')}</p>
    </header>
  );
}
