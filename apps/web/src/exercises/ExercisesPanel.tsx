import { useState } from 'react';
import { ApiError } from '../api/client';
import buttons from '../components/Buttons.module.css';
import { Loading } from '../components/Loading';
import pageStyles from '../components/Page.module.css';
import { RetryNotice } from '../components/RetryNotice';
import { formatInstant } from '../format/format';
import { type ReleasedResource, useAttempt, useClassRelease } from './attempt';
import { creditText } from './credit';
import styles from './Exercise.module.css';
import { ExerciseRunner } from './ExerciseRunner';

/** A resource a student cannot study yet: its release time is still ahead (§4). */
const lockedUntil = (resource: ReleasedResource, role: 'student' | 'instructor', now: number) =>
  role === 'student' && resource.releaseAt !== null && Date.parse(resource.releaseAt) > now
    ? resource.releaseAt
    : null;

/** What an exercise card says about its audience and state. */
const practiceLabel = (resource: ReleasedResource, credit = resource.credit) =>
  resource.visibility === 'hidden'
    ? `Hidden from students · ${creditText(credit)}`
    : creditText(credit);

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
      <RetryNotice message="Exercises could not be loaded." onRetry={() => void query.refetch()} />
    ) : (
      <Loading label="Loading exercises" className={pageStyles.intro} />
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
      <OpenExercise
        classId={classId}
        selected={selected}
        onAll={exercises.length > 1 ? () => setChosen(null) : undefined}
      />
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
                {until ? `Opens ${formatInstant(until)}` : practiceLabel(r)}
              </span>
            </span>
            {until ? (
              <span className={`${styles.small} ${styles.muted}`}>Locked</span>
            ) : (
              <button
                type="button"
                className={buttons.outline}
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

/**
 * The open exercise. The attempt is pinned to the revision it started on, so once it has
 * loaded its credit states the terms the student is working under; the release listing's
 * credit (the class's current revision) is shown only until then.
 */
function OpenExercise({
  classId,
  selected,
  onAll,
}: {
  classId: string;
  selected: ReleasedResource;
  onAll?: () => void;
}) {
  const attempt = useAttempt(classId, selected.resourceId);
  return (
    <div>
      <header className={styles.toolbar}>
        <h2>{selected.title}</h2>
        <span className={`${styles.small} ${styles.muted}`}>
          {practiceLabel(selected, attempt.data ? attempt.data.credit : selected.credit)}
        </span>
      </header>
      {onAll && (
        <p className={styles.allExercises}>
          <button type="button" className={buttons.textButton} onClick={onAll}>
            All exercises
          </button>
        </p>
      )}
      <ExerciseRunner classId={classId} resourceId={selected.resourceId} title={selected.title} />
    </div>
  );
}
