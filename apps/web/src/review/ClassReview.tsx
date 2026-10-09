import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { ApiError } from '../api/client';
import { ClassUnavailable } from '../components/AccessLost';
import { Loading } from '../components/Loading';
import page from '../components/Page.module.css';
import { usePageTitle } from '../components/pageTitle';
import { RetryNotice } from '../components/RetryNotice';
import { Unavailable } from '../components/Unavailable';
import { useClassContext } from '../session/classContext';
import type { SessionClass } from '../session/useSession';
import { BulkRelease } from './BulkRelease';
import styles from './ClassReview.module.css';
import {
  exercisesText,
  gradeSignature,
  parseReviewSearch,
  type ClassReview as Review,
  type ReviewSearch,
  releasable,
  reviewText,
  submittedText,
  testText,
  useClassReview,
} from './classReview';
import grading from './Grading.module.css';
import { useTestGrades } from './grading';
import { StudentWork } from './StudentWork';

/** Class review (§12): a table of the class's real students; filters live in the address. */
export function ClassReview({
  classId,
  search,
}: {
  classId: string;
  search: Record<string, unknown>;
}) {
  const context = useClassContext(classId);
  return context?.role === 'instructor' ? (
    <Table classId={classId} context={context} search={parseReviewSearch(search)} />
  ) : (
    <ClassUnavailable classId={classId} />
  );
}

function Table({
  classId,
  context,
  search,
}: {
  classId: string;
  context: SessionClass;
  search: ReviewSearch;
}) {
  const query = useClassReview(classId, search);
  const navigate = useNavigate();
  const notFound = query.error instanceof ApiError && query.error.status === 404;
  usePageTitle(notFound ? undefined : 'Class review');
  if (notFound) return <Unavailable />;
  const data = query.data;
  const go = (next: ReviewSearch) =>
    void navigate({
      to: '/classes/$classId/review',
      params: { classId },
      search: next,
    });
  return (
    <main id="main" className={page.index}>
      <h1>Class review</h1>
      <p className={`${page.small} ${page.muted} ${styles.context}`}>
        {context.courseTitle} · {context.className}
      </p>
      {query.isPending ? (
        <Loading label="Loading class review" className={page.intro} />
      ) : !data ? (
        <RetryNotice
          message="The class review could not be loaded."
          onRetry={() => void query.refetch()}
        />
      ) : (
        <Body data={data} search={search} go={go} classId={classId} cohort={context.className} />
      )}
    </main>
  );
}

function Body({
  data,
  search,
  go,
  classId,
  cohort,
}: {
  data: Review;
  search: ReviewSearch;
  go: (next: ReviewSearch) => void;
  classId: string;
  cohort: string;
}) {
  const hasAssignment = data.assignment !== null;
  // Ticks belong to the view they were made in (assignment, filters, page) and to the grade the
  // row showed then: a later override or regrade is not already ticked.
  const view = [
    search.assignment,
    search.topic,
    search.student,
    search.needsReview,
    data.page,
  ].join('|');
  const [ticked, setTicked] = useState<{ view: string; grades: ReadonlyMap<string, string> }>({
    view,
    grades: new Map(),
  });
  const ticks = ticked.view === view ? ticked.grades : new Map<string, string>();
  const grades = useTestGrades(classId, data.assignment?.assignmentId);
  // Removed students are not in the table, but their submissions stay reviewable (§4).
  const removed = (grades.data?.students ?? [])
    .filter((s) => s.removed)
    .map((s) => ({ ...s, attempts: s.attempts.filter((a) => a.state !== 'in_progress') }))
    .filter((s) => s.attempts.length > 0);
  const toRelease = data.rows.filter(
    (r) => releasable(r) && r.attempt && ticks.get(r.attempt.attemptId) === gradeSignature(r),
  );
  const toggle = (row: Review['rows'][number]) =>
    setTicked(() => {
      const next = new Map(ticks);
      const id = row.attempt?.attemptId;
      if (id && !next.delete(id)) next.set(id, gradeSignature(row));
      return { view, grades: next };
    });
  const assignments = search.topic
    ? data.assignments.filter((a) => a.topicId === search.topic)
    : data.assignments;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  // A filter change keeps the selection; `Selection` hides itself while the student is out of the list.
  const change = (patch: ReviewSearch) => go({ ...search, ...patch, page: undefined });
  const empty = data.total === 0;
  const clear = () =>
    go({ selected: search.selected, attempt: search.attempt, assignment: search.assignment });
  return (
    <>
      <section className={styles.filters} aria-label="Review filters">
        <label>
          Topic
          <select
            value={search.topic ?? ''}
            onChange={(e) => change({ topic: e.target.value || undefined, assignment: undefined })}
          >
            <option value="">All topics</option>
            {data.topics.map((t) => (
              <option key={t.topicId} value={t.topicId}>
                {String(t.number).padStart(2, '0')} / {t.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Assignment
          <select
            value={search.assignment ?? ''}
            onChange={(e) => change({ assignment: e.target.value || undefined })}
          >
            <option value="">All assignments</option>
            {assignments.map((a) => (
              <option key={a.assignmentId} value={a.assignmentId}>
                Test · {a.title}
              </option>
            ))}
          </select>
        </label>
        <label>
          Student
          <select
            value={search.student ?? ''}
            onChange={(e) => change({ student: e.target.value || undefined })}
          >
            <option value="">All students</option>
            {data.roster.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Status
          <select
            value={search.needsReview ? 'needs' : 'all'}
            onChange={(e) => change({ needsReview: e.target.value === 'needs' ? true : undefined })}
          >
            <option value="all">All students</option>
            <option value="needs">Needs review</option>
          </select>
        </label>
      </section>
      <Selection
        data={data}
        search={search}
        go={go}
        classId={classId}
        cohort={cohort}
        removed={removed.map((r) => ({ id: r.student.id, name: r.student.name }))}
      />
      {empty ? (
        <section className={styles.empty} aria-label="No students">
          <h2>
            {data.roster.length === 0
              ? 'This class has no students yet.'
              : search.needsReview
                ? 'No students need review.'
                : 'No students match these filters.'}
          </h2>
          {data.roster.length > 0 ? (
            <button type="button" className={page.link} onClick={clear}>
              Show all students
            </button>
          ) : null}
        </section>
      ) : (
        <>
          {hasAssignment && data.assignment ? (
            <BulkRelease
              key={data.assignment.assignmentId}
              classId={classId}
              testTitle={data.assignment.title}
              attemptIds={toRelease.flatMap((r) => (r.attempt ? [r.attempt.attemptId] : []))}
              names={Object.fromEntries(
                data.rows.flatMap((r) => (r.attempt ? [[r.attempt.attemptId, r.name]] : [])),
              )}
            />
          ) : null}
          <section className={styles.wrap} aria-label="Students">
            <table className={styles.table}>
              <thead>
                <tr>
                  {hasAssignment ? (
                    <th scope="col">
                      <span className={grading.srOnly}>Release</span>
                    </th>
                  ) : null}
                  <th scope="col">Student</th>
                  <th scope="col">Exercises</th>
                  <th scope="col">Test</th>
                  <th scope="col">Questions</th>
                  <th scope="col">Last submitted</th>
                  <th scope="col">Review</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row) => (
                  <tr
                    key={row.studentId}
                    className={search.selected === row.studentId ? styles.selected : undefined}
                  >
                    {hasAssignment ? (
                      <td>
                        {releasable(row) && row.attempt ? (
                          <label className={styles.tick}>
                            <input
                              type="checkbox"
                              aria-label={`Select ${row.name} for release`}
                              checked={ticks.get(row.attempt.attemptId) === gradeSignature(row)}
                              onChange={() => toggle(row)}
                            />
                          </label>
                        ) : null}
                      </td>
                    ) : null}
                    <th scope="row">
                      <button
                        type="button"
                        className={styles.pick}
                        aria-current={search.selected === row.studentId ? 'true' : undefined}
                        onClick={() =>
                          go({
                            ...search,
                            selected: row.studentId,
                            attempt: row.attempt?.attemptId,
                          })
                        }
                      >
                        {row.name}
                      </button>
                    </th>
                    <td>{exercisesText(row)}</td>
                    <td>{testText(row, hasAssignment)}</td>
                    <td>{row.openQuestions === 0 ? '—' : row.openQuestions}</td>
                    <td>{submittedText(row)}</td>
                    <td>{reviewText(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {pages > 1 ? (
            <nav className={styles.pages} aria-label="Pages">
              <button
                type="button"
                disabled={data.page <= 1}
                onClick={() =>
                  go({ ...search, page: data.page - 1 > 1 ? data.page - 1 : undefined })
                }
              >
                Previous page
              </button>
              <span>
                Page {data.page} of {pages} · {data.total} students
              </span>
              <button
                type="button"
                disabled={data.page >= pages}
                onClick={() => go({ ...search, page: data.page + 1 })}
              >
                Next page
              </button>
            </nav>
          ) : null}
        </>
      )}
      {removed.length > 0 ? (
        <section className={styles.removed} aria-label="Removed students">
          <h2>Removed students</h2>
          <ul className={page.bareList}>
            {removed.map((r) => (
              <li key={r.student.id}>
                {r.attempts.map((a) => (
                  <button
                    key={a.attemptId}
                    type="button"
                    className={styles.pick}
                    onClick={() =>
                      go({
                        ...search,
                        selected: r.student.id,
                        attempt: a.attemptId,
                        tab: undefined,
                      })
                    }
                  >
                    {r.student.name} · Attempt {a.number}
                  </button>
                ))}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/**
 * The selected student with previous/next over the whole filtered list, and the selected
 * assignment and attempt beside them (§12).
 */
function Selection({
  data,
  search,
  go,
  classId,
  cohort,
  removed,
}: {
  data: Review;
  search: ReviewSearch;
  go: (next: ReviewSearch) => void;
  classId: string;
  cohort: string;
  removed: { id: string; name: string }[];
}) {
  const index = data.students.findIndex((s) => s.id === search.selected);
  const listed = data.students[index];
  const gone = removed.find((r) => r.id === search.selected);
  // A student whose attempt is open stays in view when a release (or a filter) takes them out
  // of the list, so the outcome of what was just done is not lost with them.
  const held =
    search.attempt &&
    data.selected?.attemptId === search.attempt &&
    data.selected.studentId === search.selected
      ? { id: data.selected.studentId, name: data.selected.studentName }
      : undefined;
  const unlisted = gone ?? held;
  const student = listed ?? (unlisted && { ...unlisted, attempt: null });
  if (!search.selected || !student) return null;
  // The attempt that is open, not the newest one: the server resolves it (§12).
  const open =
    search.attempt &&
    data.selected?.attemptId === search.attempt &&
    data.selected.studentId === student.id
      ? data.selected
      : null;
  const attemptNumber = open?.number ?? student.attempt?.number;
  const to = (i: number) => {
    const next = data.students[i];
    if (!next) return;
    // The table moves to the page holding the new student, so the selected row stays on screen.
    const target = Math.floor(i / data.pageSize) + 1;
    go({
      ...search,
      selected: next.id,
      attempt: next.attempt?.attemptId,
      page: target > 1 ? target : undefined,
    });
  };
  return (
    <section className={styles.selection} aria-label="Selected student">
      <div className={page.row}>
        <h2 className={styles.name}>{student.name}</h2>
        <div className={styles.nav}>
          <button type="button" disabled={!listed || index <= 0} onClick={() => to(index - 1)}>
            Previous student
          </button>
          <button
            type="button"
            disabled={!listed || index >= data.students.length - 1}
            onClick={() => to(index + 1)}
          >
            Next student
          </button>
        </div>
      </div>
      <p className={`${page.small} ${page.muted}`}>
        {data.assignment ? `Test · ${data.assignment.title}` : 'All assignments'}
        {attemptNumber !== undefined ? ` · Attempt ${attemptNumber}` : ''}
        {listed
          ? ` · Student ${index + 1} of ${data.students.length}`
          : gone
            ? ' · Removed from the class'
            : ' · Not in the current filter'}
        {` · ${cohort}`}
      </p>
      <StudentWork
        classId={classId}
        cohort={cohort}
        data={data}
        search={search}
        studentId={student.id}
        go={go}
      />
    </section>
  );
}
