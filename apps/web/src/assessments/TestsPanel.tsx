import { useState } from 'react';
import { ApiError } from '../api/client';
import buttons from '../components/Buttons.module.css';
import { Loading } from '../components/Loading';
import pageStyles from '../components/Page.module.css';
import { RetryNotice } from '../components/RetryNotice';
import { type ReleasedResource, useClassRelease } from '../exercises/attempt';
import { formatOpens } from '../topics/topics';
import { AttemptWorkspace } from './AttemptWorkspace';
import { type AttemptView, startAttempt, type TestOverview, useTestOverview } from './api';
import { formatInZone, TermsPanel } from './TermsPanel';
import styles from './Test.module.css';

const INELIGIBLE: Record<string, string> = {
  not_open: 'This test has not opened yet.',
  closed: 'This test has closed.',
  no_attempts_left: 'You have used every attempt.',
  class_archived: 'This class is archived, so no new attempt can start.',
  in_progress: 'An attempt is already in progress.',
};

const STATE_LABEL: Record<string, string> = {
  in_progress: 'In progress',
  submitted: 'Submitted',
  grading: 'Submitted · being graded',
  needs_review: 'Submitted · awaiting instructor review',
  graded: 'Submitted · graded, not yet released',
  released: 'Results released',
};

/** The Tests tab of a topic (§11): the released tests, their terms, and the attempts of the student. */
export function TestsPanel(props: {
  classId: string;
  topicId: string;
  role: 'student' | 'instructor';
}) {
  return <TopicTests key={props.topicId} {...props} />;
}

function TopicTests({
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
    return <p className={pageStyles.intro}>Tests are not available for this class.</p>;
  }
  if (!query.data) {
    return query.isError ? (
      <RetryNotice message="Tests could not be loaded." onRetry={() => void query.refetch()} />
    ) : (
      <Loading label="Loading tests" className={pageStyles.intro} />
    );
  }
  const topic = query.data.topics.find((t) => t.topicId === topicId);
  const tests = (topic?.resources ?? []).filter((r) => r.type === 'test');
  if (tests.length === 0) {
    return <p className={pageStyles.intro}>Nothing is available under Tests for this topic yet.</p>;
  }
  const only = tests.length === 1 ? tests[0] : undefined;
  const selected = tests.find((r) => r.resourceId === (chosen ?? only?.resourceId ?? null));
  const now = Date.now();
  const locked = (r: ReleasedResource) =>
    role === 'student' && r.releaseAt !== null && Date.parse(r.releaseAt) > now
      ? r.releaseAt
      : null;
  if (selected && !locked(selected)) {
    if (role === 'instructor') {
      return (
        <p className={pageStyles.intro}>
          {selected.title}: students take this test here. Attempts and results are reviewed under
          Class review.
        </p>
      );
    }
    return (
      <TestEntry
        key={selected.resourceId}
        classId={classId}
        resource={selected}
        onAll={tests.length > 1 ? () => setChosen(null) : undefined}
      />
    );
  }
  return (
    <ul className={styles.attempts} aria-label="Tests in this topic">
      {tests.map((r) => {
        const until = locked(r);
        return (
          <li key={r.resourceId}>
            <span>
              <strong>{r.title}</strong>
              <br />
              <span className={`${styles.small} ${styles.muted}`}>
                {until ? `Opens ${formatOpens(until)}` : 'Open'}
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
                Open
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** Terms, attempts and Start or Resume for one test; an attempt opens in the working view. */
function TestEntry({
  classId,
  resource,
  onAll,
}: {
  classId: string;
  resource: ReleasedResource;
  onAll?: () => void;
}) {
  const overview = useTestOverview(classId, resource.resourceId);
  const [open, setOpen] = useState<AttemptView | null>(null);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (open) {
    return (
      <AttemptWorkspace
        key={open.id}
        classId={classId}
        title={resource.title}
        initial={open}
        onLeave={() => {
          setOpen(null);
          void overview.refetch();
        }}
      />
    );
  }
  if (!overview.data) {
    return overview.error instanceof ApiError && overview.error.status === 404 ? (
      <p className={pageStyles.intro}>This test is no longer open to you.</p>
    ) : overview.isError ? (
      <RetryNotice
        message="The test could not be loaded."
        onRetry={() => void overview.refetch()}
      />
    ) : (
      <Loading label="Loading test" className={pageStyles.intro} />
    );
  }
  const data: TestOverview = overview.data;
  const running = data.attempts.find((a) => a.state === 'in_progress');
  async function start() {
    if (starting) return;
    setStarting(true);
    setProblem(null);
    try {
      setOpen(await startAttempt(classId, resource.resourceId));
    } catch (error) {
      const body = error instanceof ApiError ? (error.body as { reason?: string } | null) : null;
      setProblem(
        (body?.reason ? INELIGIBLE[body.reason] : undefined) ??
          'The attempt could not be started. Check your connection and try again.',
      );
      void overview.refetch();
    } finally {
      setStarting(false);
    }
  }
  const reason = data.eligibility.reason;
  return (
    <div className={styles.stage}>
      {onAll ? (
        <p>
          <button type="button" className={buttons.textButton} onClick={onAll}>
            All tests
          </button>
        </p>
      ) : null}
      <h2 style={{ margin: '0 0 8px', font: 'var(--pc-text-section)' }}>{resource.title}</h2>
      <p className={`${styles.small} ${styles.muted}`}>
        {data.questionCount} {data.questionCount === 1 ? 'question' : 'questions'} · attempts used{' '}
        {data.eligibility.attemptsUsed} of {data.eligibility.attemptsAllowed}
      </p>
      <div style={{ maxWidth: 640, margin: '20px 0' }}>
        <TermsPanel terms={data.terms} />
      </div>
      {problem ? (
        <p className={styles.error} role="alert">
          {problem}
        </p>
      ) : null}
      {running ? (
        <div className={styles.row}>
          <button
            type="button"
            className={buttons.primary}
            onClick={() => void start()}
            disabled={starting}
          >
            Resume attempt {running.number}
          </button>
          <span className={`${styles.small} ${styles.muted}`}>
            Started {formatInZone(running.startedAt, data.terms.timeZone)}
            {running.deadlineAt
              ? ` · closes ${formatInZone(running.deadlineAt, data.terms.timeZone)}`
              : ''}
          </span>
        </div>
      ) : data.eligibility.canStart ? (
        <button
          type="button"
          className={buttons.primary}
          onClick={() => void start()}
          disabled={starting}
        >
          {starting ? 'Starting…' : `Start attempt ${data.eligibility.attemptsUsed + 1}`}
        </button>
      ) : (
        <p>{reason ? (INELIGIBLE[reason] ?? 'You cannot start an attempt now.') : ''}</p>
      )}
      {data.attempts.length > 0 ? (
        <ul className={styles.attempts} aria-label="Your attempts">
          {data.attempts.map((a) => (
            <li key={a.id}>
              <span>
                <strong>Attempt {a.number}</strong>
                <br />
                <span className={`${styles.small} ${styles.muted}`}>
                  {STATE_LABEL[a.state] ?? a.state}
                  {a.receipt?.autoSubmitted ? ' · submitted by the server at the deadline' : ''}
                </span>
              </span>
              {a.receipt ? (
                <span className={`${styles.small} ${styles.muted}`}>
                  Receipt {a.receipt.submissionId.slice(0, 8)} ·{' '}
                  {formatInZone(a.receipt.submittedAt, data.terms.timeZone)}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
