import { useState } from 'react';
import { ApiError } from '../api/client';
import pageStyles from '../components/Page.module.css';
import { formatOpens } from '../topics/topics';
import { type ReleasedResource, useClassRelease } from './attempt';
import { creditText } from './credit';
import styles from './Exercise.module.css';
import { ExerciseRunner } from './ExerciseRunner';

/** A resource a student cannot study yet: its release time is still ahead (§4). */
const lockedUntil = (resource: ReleasedResource, role: 'student' | 'instructor', now: number) =>
  role === 'student' && resource.releaseAt !== null && Date.parse(resource.releaseAt) > now
    ? resource.releaseAt
    : null;

/** What an exercise card says about its audience and state. */
const practiceLabel = (resource: ReleasedResource) =>
  resource.visibility === 'hidden'
    ? `Hidden from students · ${creditText(resource.credit)}`
    : creditText(resource.credit);

/** The Exercises tab of a topic: its released exercises, scheduled ones locked with their date. */
export function ExercisesPanel(props: {
  classId: string;
  topicId: string;
  role: 'student' | 'instructor';
}) {
  // A choice made in one topic must not carry into the next.
  return <TopicExercises key={props.topicId} {...props} />;
}

function TopicExercises({
  classId,
  topicId,
  role,
}: {
  classId: string;
  topicId: string;
  role: 'student' | 'instructor';
}) {
  const query = useClassRelease(classId);
  const [chosen, setChosen] = useState<string | null>(null);
  if (query.error instanceof ApiError && query.error.status === 404) {
    return <p className={pageStyles.intro}>Exercises are not available for this class.</p>;
  }
  if (!query.data) {
    return query.isError ? (
      <div className={pageStyles.feedback} role="alert">
        <p>Exercises could not be loaded.</p>
        <button type="button" className={pageStyles.outline} onClick={() => void query.refetch()}>
          Try again
        </button>
      </div>
    ) : (
      <p className={pageStyles.intro} role="status">
        Loading exercises
      </p>
    );
  }
  const topic = query.data.topics.find((t) => t.topicId === topicId);
  const exercises = (topic?.resources ?? []).filter((r) => r.type === 'exercise');
  if (exercises.length === 0) {
    return (
      <p className={pageStyles.intro}>Nothing is available under Exercises for this topic yet.</p>
    );
  }
  const now = Date.now();
  const only = exercises.length === 1 ? exercises[0] : undefined;
  const selected = exercises.find((r) => r.resourceId === (chosen ?? only?.resourceId));
  if (selected && !lockedUntil(selected, role, now)) {
    return (
      <div>
        <header className={styles.toolbar}>
          <h2>{selected.title}</h2>
          <span className={`${styles.small} ${styles.muted}`}>{practiceLabel(selected)}</span>
        </header>
        {exercises.length > 1 && (
          <p className={styles.allExercises}>
            <button type="button" className={styles.textButton} onClick={() => setChosen(null)}>
              All exercises
            </button>
          </p>
        )}
        <ExerciseRunner classId={classId} resourceId={selected.resourceId} title={selected.title} />
      </div>
    );
  }
  return (
    <ul className={styles.exerciseList} aria-label="Exercises in this topic">
      {exercises.map((r) => {
        const until = lockedUntil(r, role, now);
        return (
          <li key={r.resourceId}>
            <span>
              <strong>{r.title}</strong>
              <br />
              <span className={`${styles.small} ${styles.muted}`}>
                {until ? `Opens ${formatOpens(until)}` : practiceLabel(r)}
              </span>
            </span>
            {until ? (
              <span className={`${styles.small} ${styles.muted}`}>Locked</span>
            ) : (
              <button
                type="button"
                className={styles.outline}
                onClick={() => setChosen(r.resourceId)}
              >
                Start
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
