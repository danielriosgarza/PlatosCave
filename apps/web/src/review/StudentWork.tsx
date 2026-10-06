import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import buttons from '../components/Buttons.module.css';
import { Loading } from '../components/Loading';
import page from '../components/Page.module.css';
import { RetryNotice } from '../components/RetryNotice';
import { type TabDef, TabRow } from '../components/TabRow';
import type { ClassReview, ReviewSearch, ReviewTab } from './classReview';
import styles from './Grading.module.css';
import { GradingWorkspace } from './GradingWorkspace';
import {
  downloadLink,
  points,
  stamp,
  useDiscussions,
  useStudentSubmissions,
  useTestGrades,
} from './grading';

const TABS = [
  { id: 'results', label: 'Results' },
  { id: 'submissions', label: 'Submissions' },
  { id: 'comments', label: 'Comments & questions' },
] as const satisfies readonly TabDef<ReviewTab>[];

const STATE: Record<string, string> = {
  in_progress: 'In progress',
  submitted: 'Submitted',
  grading: 'Grading',
  needs_review: 'Needs review',
  graded: 'Graded',
  released: 'Released',
};

/**
 * The selected student's work (§12): Results (immutable attempts and the grading workspace),
 * Submissions (what was handed in, notebook snapshots included) and Comments & questions.
 * Private study notes never reach this page.
 */
export function StudentWork({
  classId,
  cohort,
  data,
  search,
  studentId,
  go,
}: {
  classId: string;
  cohort: string;
  data: ClassReview;
  search: ReviewSearch;
  studentId: string;
  go: (next: ReviewSearch) => void;
}) {
  const tab = search.tab ?? 'results';
  const assignments = search.assignment
    ? data.assignments.filter((a) => a.assignmentId === search.assignment)
    : data.assignments;
  const open = (attempt: string) => go({ ...search, tab: 'results', attempt });
  return (
    <div className={styles.tabs}>
      <TabRow
        label="Student work"
        tabs={TABS}
        selected={tab}
        onSelect={(next) => go({ ...search, tab: next === 'results' ? undefined : next })}
        panelId="pc-student-panel"
        idPrefix="pc-student-tab"
      />
      <div
        id="pc-student-panel"
        role="tabpanel"
        aria-labelledby={`pc-student-tab-${tab}`}
        className={styles.panel}
      >
        {tab === 'results' ? (
          <>
            {assignments.length === 0 ? (
              <p className={page.muted}>This class has no tests in this view.</p>
            ) : null}
            {assignments.map((a) => (
              <Attempts
                key={a.assignmentId}
                classId={classId}
                assignmentId={a.assignmentId}
                title={a.title}
                studentId={studentId}
                open={search.attempt}
                onOpen={open}
                mode="results"
              />
            ))}
            {search.attempt ? (
              <GradingWorkspace
                classId={classId}
                attemptId={search.attempt}
                studentId={studentId}
                cohort={cohort}
                testTitle={
                  data.assignments.find((a) => a.assignmentId === data.selected?.assignmentId)
                    ?.title ??
                  data.assignment?.title ??
                  'Test'
                }
              />
            ) : assignments.length > 0 ? (
              <p className={`${page.small} ${page.muted}`}>
                Open an attempt to grade it. Draft grades are visible to instructors only.
              </p>
            ) : null}
          </>
        ) : null}
        {tab === 'submissions' ? (
          <>
            <h3>Tests</h3>
            {assignments.length === 0 ? <p className={page.muted}>No tests in this view.</p> : null}
            {assignments.map((a) => (
              <Attempts
                key={a.assignmentId}
                classId={classId}
                assignmentId={a.assignmentId}
                title={a.title}
                studentId={studentId}
                open={search.attempt}
                onOpen={open}
                mode="submissions"
              />
            ))}
            <h3>Notebooks</h3>
            {data.notebooks.length === 0 ? (
              <p className={page.muted}>No notebooks in this view.</p>
            ) : null}
            {data.notebooks.map((n) => (
              <Notebook
                key={n.notebookId}
                classId={classId}
                notebookId={n.notebookId}
                title={n.title}
                studentId={studentId}
              />
            ))}
          </>
        ) : null}
        {tab === 'comments' ? <Comments classId={classId} studentId={studentId} /> : null}
      </div>
    </div>
  );
}

function Attempts({
  classId,
  assignmentId,
  title,
  studentId,
  open,
  onOpen,
  mode,
}: {
  classId: string;
  assignmentId: string;
  title: string;
  studentId: string;
  open: string | undefined;
  onOpen: (attemptId: string) => void;
  mode: 'results' | 'submissions';
}) {
  const query = useTestGrades(classId, assignmentId);
  const student = query.data?.students.find((s) => s.student.id === studentId);
  const attempts = (student?.attempts ?? []).filter(
    (a) => mode === 'results' || a.state !== 'in_progress',
  );
  return (
    <section aria-label={`Test · ${title}`}>
      <h3>Test · {title}</h3>
      {query.isPending ? (
        <Loading label="Loading attempts" className={page.intro} />
      ) : query.isError ? (
        <RetryNotice
          message="The attempts could not be loaded."
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          {student?.reported && mode === 'results' ? (
            <p className={page.small}>
              Reported grade: {points(student.reported.points)} /{' '}
              {points(student.reported.possible)} ({query.data?.rule.replace('_', ' ')} attempt
              rule)
            </p>
          ) : null}
          {attempts.length === 0 ? (
            <p className={page.muted}>
              {mode === 'results' ? 'No attempts.' : 'Nothing has been submitted.'}
            </p>
          ) : null}
          {attempts.map((a) => (
            <div key={a.attemptId} className={styles.attemptRow}>
              <span>
                Attempt {a.number} · {STATE[a.state] ?? a.state}
                {a.released
                  ? ` · released ${points(a.released.points)} / ${points(a.released.possible)}`
                  : ''}
                {a.current && a.current.state === 'draft'
                  ? ` · draft ${points(a.current.points)} / ${points(a.current.possible)}${a.released ? ' (not released)' : ''}`
                  : ''}
              </span>
              <button
                type="button"
                className={buttons.textButton}
                aria-current={open === a.attemptId ? 'true' : undefined}
                onClick={() => onOpen(a.attemptId)}
              >
                {mode === 'results' ? 'Open grading' : 'Open attempt'} {a.number}
              </button>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function Notebook({
  classId,
  notebookId,
  title,
  studentId,
}: {
  classId: string;
  notebookId: string;
  title: string;
  studentId: string;
}) {
  const query = useStudentSubmissions(classId, notebookId);
  const mine = (query.data?.submissions ?? []).filter((s) => s.student.id === studentId);
  // A resource that takes no submissions answers an error; it has nothing to show here.
  if (query.isError) return null;
  return (
    <section aria-label={`Notebook · ${title}`}>
      <h4>Notebook · {title}</h4>
      {query.isPending ? (
        <Loading label="Loading submissions" className={page.intro} />
      ) : mine.length === 0 ? (
        <p className={page.muted}>Nothing has been submitted.</p>
      ) : (
        mine.map((s) => <Snapshot key={s.id} classId={classId} submission={s} />)
      )}
    </section>
  );
}

type Submission = NonNullable<
  ReturnType<typeof useStudentSubmissions>['data']
>['submissions'][number];

/** One submitted snapshot, read from Parallax: no computer is contacted to inspect it (A35). */
function Snapshot({ classId, submission: s }: { classId: string; submission: Submission }) {
  const [problem, setProblem] = useState<string | null>(null);
  const fetchLink = async (fileId?: string) => {
    setProblem(null);
    try {
      const link = await downloadLink(classId, s.id, fileId);
      window.location.assign(link.url);
    } catch {
      setProblem('The download link could not be made. Try again.');
    }
  };
  const environment = Object.entries(s.environment);
  return (
    <div className={styles.question}>
      <div className={page.small}>
        Version {s.version} · {s.filename} · {Math.max(1, Math.round(s.size / 1024))} KiB · received{' '}
        {stamp(s.receivedAt)}
        {s.removed ? ' · student removed from the class' : ''}
      </div>
      {environment.length > 0 ? (
        <p className={`${page.small} ${page.muted}`}>
          Declared by the file, not verified:{' '}
          {environment.map(([k, v]) => `${k} ${String(v)}`).join(' · ')}
        </p>
      ) : null}
      {s.workingCopyRevision !== undefined ? (
        <p className={page.small}>
          Frozen from the saved working copy, revision {s.workingCopyRevision}. Kernel memory is not
          part of a snapshot.
        </p>
      ) : null}
      {s.files && s.files.length > 0 ? (
        <ul className={styles.checks} aria-label={`Files in version ${s.version}`}>
          {s.files.map((f) => (
            <li key={f.id}>
              {f.path} · {f.size} bytes ·{' '}
              <button
                type="button"
                className={buttons.textButton}
                onClick={() => void fetchLink(f.id)}
              >
                Download {f.path}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" className={buttons.outline} onClick={() => void fetchLink()}>
        Download snapshot
      </button>
      {problem ? (
        <span className={`${page.small} ${styles.error}`} role="alert">
          {' '}
          {problem}
        </span>
      ) : null}
    </div>
  );
}

function Comments({ classId, studentId }: { classId: string; studentId: string }) {
  const query = useDiscussions(classId, studentId);
  if (query.isPending) return <Loading label="Loading comments" className={page.intro} />;
  if (!query.data) {
    return (
      <RetryNotice
        message="The comments and questions could not be loaded."
        onRetry={() => void query.refetch()}
      />
    );
  }
  const list = query.data.discussions;
  if (list.length === 0) {
    return <p className={page.muted}>No shared questions or comments.</p>;
  }
  return (
    <>
      {list.map(({ thread, resource }) => {
        const first = thread.posts.find((p) => p.parentId === null) ?? thread.posts[0];
        return (
          <div key={thread.id} className={styles.thread}>
            <div className={`${page.row} ${page.between}`}>
              <span className={page.small}>
                {thread.audience === 'instructor'
                  ? 'Shared with instructors'
                  : 'Shared with the class'}{' '}
                · {thread.status === 'open' ? 'Open' : 'Resolved'}
              </span>
              <span className={`${page.small} ${page.muted}`}>{stamp(thread.createdAt)}</span>
            </div>
            <p>{first?.body ?? 'This post is not available.'}</p>
            {thread.posts
              .filter((p) => p.id !== first?.id)
              .map((p) => (
                <p key={p.id} className={page.muted}>
                  {p.author.name}
                  {p.authorRole === 'instructor' ? ' · Instructor' : ''}:{' '}
                  {p.body ?? 'Not available.'}
                </p>
              ))}
            {resource ? (
              <Link
                className={page.link}
                to="/classes/$classId/topics/$topicId/$tab"
                params={{ classId, topicId: resource.topicId, tab: resource.tab }}
                search={{ resource: thread.resourceId }}
              >
                Open source passage · {resource.title}
              </Link>
            ) : (
              <span className={`${page.small} ${page.muted}`}>
                The class's release no longer includes the resource this was about.
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}
