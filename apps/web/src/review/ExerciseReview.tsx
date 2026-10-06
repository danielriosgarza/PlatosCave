import { Loading } from '../components/Loading';
import page from '../components/Page.module.css';
import { RetryNotice } from '../components/RetryNotice';
import type { ClassReview } from './classReview';
import styles from './Grading.module.css';
import { type ExerciseAttempts, stamp, useExerciseAttempts } from './grading';

type Attempt = ExerciseAttempts[number];
type Step = Attempt['steps'][number];

const COMPLETION: Record<NonNullable<Attempt['completion']>, string> = {
  independent: 'Completed independently',
  with_hints: 'Completed with hints',
  solution_shown: 'Completed with the solution shown',
};

const HELP: Record<NonNullable<Step['help']>, string> = {
  independent: 'independently',
  with_hints: 'with hints',
  solution_shown: 'with the solution shown',
};

/** A recorded response as text: strings as written, everything else as JSON. */
const shown = (value: unknown) =>
  value === undefined || value === null
    ? 'none'
    : typeof value === 'string'
      ? value
      : JSON.stringify(value);

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The Exercises tab of one student's work (§9, A08): every practice attempt on each exercise of
 * the class, with the help used shown as separate facts so "completed with hints" and "solution
 * shown" are never folded into a percentage.
 */
export function ExerciseReview({
  classId,
  exercises,
  studentId,
}: {
  classId: string;
  exercises: ClassReview['exercises'];
  studentId: string;
}) {
  if (exercises.length === 0) {
    return <p className={page.muted}>This class has no exercises in this view.</p>;
  }
  return (
    <>
      {exercises.map((e) => (
        <ExerciseAttemptsList
          key={e.exerciseId}
          classId={classId}
          exerciseId={e.exerciseId}
          title={e.title}
          studentId={studentId}
        />
      ))}
    </>
  );
}

function ExerciseAttemptsList({
  classId,
  exerciseId,
  title,
  studentId,
}: {
  classId: string;
  exerciseId: string;
  title: string;
  studentId: string;
}) {
  const query = useExerciseAttempts(classId, exerciseId);
  const mine = (query.data?.attempts ?? [])
    .filter((a) => a.student.id === studentId)
    .sort((a, b) => a.number - b.number);
  return (
    <section aria-label={`Exercise · ${title}`}>
      <h3>Exercise · {title}</h3>
      {query.isPending ? (
        <Loading label="Loading exercise attempts" className={page.intro} />
      ) : query.isError ? (
        <RetryNotice
          message="The exercise attempts could not be loaded."
          onRetry={() => void query.refetch()}
        />
      ) : mine.length === 0 ? (
        <p className={page.muted}>No practice attempts.</p>
      ) : (
        mine.map((a) => <AttemptCard key={a.id} attempt={a} />)
      )}
    </section>
  );
}

function AttemptCard({ attempt: a }: { attempt: Attempt }) {
  return (
    <div className={styles.question}>
      <div className={page.small}>
        <strong>Attempt {a.number}</strong> ·{' '}
        {a.completion ? COMPLETION[a.completion] : 'Not completed'}
        {a.completedAt ? ` · ${stamp(a.completedAt)}` : ''}
        {a.restarted ? ' · started again afterwards' : ''}
        {a.removed ? ' · student removed from the class' : ''}
      </div>
      <p className={`${page.small} ${page.muted}`}>
        Started {stamp(a.startedAt)} · seed {a.seed} · exercise version {a.resourceRevisionId}
      </p>
      <ol className={styles.checks} aria-label={`Steps of attempt ${a.number}`}>
        {a.steps.map((s) => (
          <li key={s.id}>
            <strong>{s.title}</strong> ·{' '}
            {s.status === 'completed' && s.help ? `Completed ${HELP[s.help]}` : 'Not completed'}
            <ul aria-label={`Attempt ${a.number} ${s.title} evidence`}>
              <li>Final answer: {shown(s.finalResponse)}</li>
              <li>Checks made: {s.checks.length}</li>
              <li>Hints shown: {s.hintsShown}</li>
              <li>Solution shown: {s.solutionShown ? 'Yes' : 'No'}</li>
              {s.checks.length > 0 ? (
                <li>
                  {count(s.checks.length, 'check', 'checks')}:{' '}
                  {s.checks
                    .map((c) => `${shown(c.response)} (${c.correct ? 'correct' : 'incorrect'})`)
                    .join(' → ')}
                </li>
              ) : null}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}
