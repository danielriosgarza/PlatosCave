import { useQuery } from '@tanstack/react-query';
import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { canEdit, grantLabel } from '../../authoring/grants';
import buttons from '../../components/Buttons.module.css';
import { Loading } from '../../components/Loading';
import page from '../../components/Page.module.css';
import { usePageTitle } from '../../components/pageTitle';
import { RetryNotice } from '../../components/RetryNotice';
import { CourseMark } from '../../courses/CourseMark';
import styles from '../../courses/Courses.module.css';
import { CreateCourseForm, Dialog, type Joined, JoinForm } from '../../courses/Dialogs';
import { ArchiveControl } from '../../courses/Lifecycle';
import { type Cards, type ClassCard, type CourseCard, coursesQuery } from '../../courses/queries';
import { loadSessionOrCached, usableClasses, useSession } from '../../session/useSession';

type View = 'student' | 'instructor';
type Filter = 'all' | 'progress' | 'archived';

export const Route = createFileRoute('/_authed/courses/')({
  validateSearch: (search: Record<string, unknown>): { view?: View } => ({
    view:
      search.view === 'instructor'
        ? 'instructor'
        : search.view === 'student'
          ? 'student'
          : undefined,
  }),
  // A draft preview studies one class and can join none: its Courses page is that class.
  beforeLoad: async ({ context }) => {
    const me = await loadSessionOrCached(context.queryClient);
    const preview = me?.user.kind === 'preview' ? usableClasses(me)[0] : undefined;
    if (preview) {
      throw redirect({ to: '/classes/$classId/topics', params: { classId: preview.classId } });
    }
  },
  component: Courses,
});

type CoursesView = 'student' | 'instructor' | undefined;

/** The title is shown only when the address already decides which context opens (§14). */
function ViewTitle({ view }: { view: CoursesView }) {
  if (!view) return null;
  return <h1>{view === 'instructor' ? 'Courses you teach' : 'Your courses'}</h1>;
}

function CoursesLoading({ view }: { view: CoursesView }) {
  return (
    <main id="main" className={page.index}>
      <ViewTitle view={view} />
      <Loading
        label={view === 'instructor' ? 'Loading courses you teach' : 'Loading your courses'}
      />
    </main>
  );
}

function Courses() {
  const session = useSession();
  const { view } = Route.useSearch();
  const cards = useQuery(coursesQuery);
  if (session.status !== 'signed-in') return <CoursesLoading view={view} />;
  if (cards.isError && !cards.data) {
    return (
      <main id="main" className={page.index}>
        {/* Nothing says which context the person holds, so an unset view keeps the default title. */}
        <ViewTitle view={view ?? 'student'} />
        <RetryNotice
          message="Your courses could not be loaded."
          onRetry={() => void cards.refetch()}
        />
      </main>
    );
  }
  if (!cards.data) return <CoursesLoading view={view} />;
  // Without an explicit view, open the context the person actually holds: someone who only
  // teaches (or may create a course) starts on Courses you teach, everyone else on Your courses (§3).
  const studying = cards.data.classes.some((c) => c.role === 'student');
  return (
    <CoursesFor
      cards={cards.data}
      view={view ?? (instructs(cards.data) && !studying ? 'instructor' : 'student')}
    />
  );
}

const teachesAnything = (cards: Cards) =>
  cards.courses.length > 0 || cards.classes.some((c) => c.role === 'instructor');

/** Holds an instructor context: teaches, or the server would let them create a course. */
const instructs = (cards: Cards) => teachesAnything(cards) || cards.canCreateCourse;

function CoursesFor({ cards, view }: { cards: Cards; view: View }) {
  usePageTitle(view === 'instructor' ? 'Courses you teach' : 'Your courses');
  const studying = cards.classes.filter((c) => c.role === 'student');
  const teaching = cards.classes.filter((c) => c.role === 'instructor');
  const teaches = teachesAnything(cards);
  const instructor = instructs(cards);
  // A person holding both roles can switch between the two contexts (§3).
  const canSwitch = instructor && studying.length > 0;
  const [dialog, setDialog] = useState<'join' | 'create' | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  // The outcome stays on the page after the dialog closes and the cards reload.
  const [notice, setNotice] = useState<{ text: string; classId?: string } | null>(null);

  const onJoined = (joined: Joined) => {
    setNotice({
      text: joined.alreadyMember
        ? `You are already in ${joined.courseTitle} · ${joined.className}.`
        : `You joined ${joined.courseTitle} · ${joined.className}.`,
      classId: joined.classId,
    });
    setDialog(null);
  };

  // An empty student account shows the join form itself rather than a dialog (§4).
  const emptyStudent = view === 'student' && studying.length === 0;
  const hasContent = view === 'instructor' ? teaches : studying.length > 0;

  return (
    <main id="main" className={page.index}>
      <div className={`${page.row} ${page.between}`}>
        <h1>{view === 'instructor' ? 'Courses you teach' : 'Your courses'}</h1>
        <div className={page.row}>
          {canSwitch ? (
            <fieldset className={`${page.row} ${page.group}`} aria-label="Context">
              <Link
                to="/courses"
                search={{ view: 'student' }}
                className={page.link}
                aria-current={view === 'student' ? 'page' : undefined}
              >
                Student view
              </Link>
              <Link
                to="/courses"
                search={{ view: 'instructor' }}
                className={page.link}
                aria-current={view === 'instructor' ? 'page' : undefined}
              >
                Instructor view
              </Link>
            </fieldset>
          ) : null}
          {view === 'student' && !emptyStudent ? (
            <button type="button" className={buttons.outline} onClick={() => setDialog('join')}>
              Join a class
            </button>
          ) : null}
          {view === 'instructor' && cards.canCreateCourse ? (
            <button type="button" className={buttons.outline} onClick={() => setDialog('create')}>
              Create course
            </button>
          ) : null}
        </div>
      </div>

      {notice ? (
        <div className={`${page.feedback} ${page.row}`} role="status">
          <span>{notice.text}</span>
          {notice.classId ? (
            <Link
              to="/classes/$classId/topics"
              params={{ classId: notice.classId }}
              className={page.link}
            >
              Open the course
            </Link>
          ) : null}
        </div>
      ) : null}

      {view === 'student' && instructor && !canSwitch ? (
        <p className={page.intro}>
          <Link to="/courses" search={{ view: 'instructor' }} className={page.link}>
            Go to the courses you teach
          </Link>
        </p>
      ) : null}

      {view === 'instructor' && !teaches && cards.canCreateCourse ? (
        <div className={page.feedback} role="status">
          <h2>No courses yet</h2>
          <p>Courses you create appear here.</p>
        </div>
      ) : null}

      {view === 'instructor' && !instructor ? (
        <div className={page.feedback} role="status">
          <h2>This account has no instructor access</h2>
          <p>
            Instructor access comes from an invitation by a course owner. Signing in through the
            instructor entrance does not grant it.
          </p>
        </div>
      ) : null}

      {emptyStudent ? (
        <section className={page.feedback} aria-labelledby="join-heading">
          <h2 id="join-heading">Join a class</h2>
          <p>Enter the invitation code from your instructor to see the class here.</p>
          <JoinForm onJoined={onJoined} />
        </section>
      ) : null}

      {hasContent ? (
        <>
          <Tools filter={filter} onFilter={setFilter} search={search} onSearch={setSearch} />
          {view === 'instructor' ? (
            <InstructorCards
              classes={teaching}
              courses={cards.courses}
              filter={filter}
              search={search}
              onDone={(text) => setNotice({ text })}
            />
          ) : (
            <StudentCards classes={studying} filter={filter} search={search} />
          )}
        </>
      ) : null}

      {view === 'instructor' && !instructor && studying.length > 0 ? (
        <>
          <h2 className={styles.sectionHeading}>Your enrolled classes</h2>
          <div className={page.mt20}>
            <StudentCards classes={studying} filter="all" search="" />
          </div>
        </>
      ) : null}

      {dialog === 'join' ? (
        <Dialog title="Join a class" onClose={() => setDialog(null)}>
          <JoinForm onJoined={onJoined} onDone={() => setDialog(null)} />
        </Dialog>
      ) : null}
      {dialog === 'create' ? (
        <Dialog title="Create course" onClose={() => setDialog(null)}>
          <CreateCourseForm
            onCreated={(created) => {
              setNotice({ text: `${created.title} was created. You own it.` });
              setDialog(null);
            }}
            onDone={() => setDialog(null)}
          />
        </Dialog>
      ) : null}
    </main>
  );
}

const FILTERS: [Filter, string][] = [
  ['all', 'All'],
  ['progress', 'In progress'],
  ['archived', 'Archived'],
];

function Tools({
  filter,
  onFilter,
  search,
  onSearch,
}: {
  filter: Filter;
  onFilter: (f: Filter) => void;
  search: string;
  onSearch: (s: string) => void;
}) {
  return (
    <div className={styles.tools}>
      <fieldset className={styles.filters} aria-label="Filter courses">
        {FILTERS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={filter === value}
            onClick={() => onFilter(value)}
          >
            {label}
          </button>
        ))}
      </fieldset>
      <label className={styles.search}>
        Search
        <input
          type="search"
          placeholder="Course title"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
        />
      </label>
    </div>
  );
}

const matchesTitle = (title: string, search: string) =>
  title.toLowerCase().includes(search.trim().toLowerCase());

/** "In progress" is anything not archived the person has started: a saved place or reviewed topic. */
function matchesFilter(c: ClassCard, filter: Filter): boolean {
  if (filter === 'archived') return c.archived;
  if (filter === 'progress') {
    return !c.archived && (c.role === 'instructor' || c.resume !== null || c.reviewed.count > 0);
  }
  return true;
}

function Empty() {
  return (
    <li className={styles.empty}>
      <h2>No matching courses</h2>
      <p className={`${page.muted} ${page.mt12}`}>Try a different title or choose All.</p>
    </li>
  );
}

function StudentCards({
  classes,
  filter,
  search,
}: {
  classes: ClassCard[];
  filter: Filter;
  search: string;
}) {
  const visible = classes.filter(
    (c) => matchesFilter(c, filter) && matchesTitle(c.courseTitle, search),
  );
  // Several enrolments in one course share a card with a class chooser.
  const groups = new Map<string, ClassCard[]>();
  for (const c of visible) groups.set(c.courseId, [...(groups.get(c.courseId) ?? []), c]);
  return (
    <ul className={styles.grid} aria-label="Your courses">
      {groups.size === 0 ? <Empty /> : null}
      {[...groups.values()].map((group) => (
        <StudentCard key={group[0]?.courseId} group={group} />
      ))}
    </ul>
  );
}

const reviewedText = (c: ClassCard) => `${c.reviewed.count} of ${c.reviewed.total} reviewed`;

function resumeLabel(c: ClassCard): string | null {
  return c.resume ? `${c.resume.resourceTitle} · ${c.resume.topicTitle}` : null;
}

function ResumeLink({ c }: { c: ClassCard }) {
  if (!c.resume) return null;
  return (
    <Link
      to="/classes/$classId/topics/$topicId/$tab"
      params={{ classId: c.classId, topicId: c.resume.topicId, tab: c.resume.tab }}
    >
      Resume {resumeLabel(c)}
    </Link>
  );
}

function StudentCard({ group }: { group: ClassCard[] }) {
  const [choosing, setChoosing] = useState(false);
  const first = group[0];
  if (!first) return null;
  const single = group.length === 1;
  return (
    <li className={styles.card}>
      {single ? (
        <Link
          to="/classes/$classId/topics"
          params={{ classId: first.classId }}
          className={styles.open}
          aria-label={`Open ${first.courseTitle} · ${first.className}`}
        >
          <CourseMark seed={first.courseId} className={styles.mark} />
          <h2>{first.courseTitle}</h2>
          <span className={styles.meta}>
            {first.topicCount} topics · {first.className}
          </span>
        </Link>
      ) : (
        <div className={styles.open}>
          <CourseMark seed={first.courseId} className={styles.mark} />
          <h2>{first.courseTitle}</h2>
          <span className={styles.meta}>
            {first.topicCount} topics · {group.length} classes
          </span>
        </div>
      )}
      <div className={styles.status}>
        {single ? (
          <>
            <span>
              {first.archived ? 'Archived · ' : ''}
              {reviewedText(first)}
            </span>
            {first.resume ? <ResumeLink c={first} /> : <span>Not started</span>}
          </>
        ) : (
          <button type="button" aria-expanded={choosing} onClick={() => setChoosing((v) => !v)}>
            Choose class
          </button>
        )}
      </div>
      {!single && choosing ? (
        <ul className={styles.chooser} aria-label={`Classes of ${first.courseTitle}`}>
          {group.map((c) => (
            <li key={c.classId}>
              <Link to="/classes/$classId/topics" params={{ classId: c.classId }}>
                {c.className}
              </Link>
              <span className={styles.meta}>
                {c.archived ? 'Archived · ' : ''}
                {reviewedText(c)}
              </span>
              <ResumeLink c={c} />
            </li>
          ))}
        </ul>
      ) : null}
      {single ? <Progress c={first} /> : null}
    </li>
  );
}

function Progress({ c }: { c: ClassCard }) {
  const share = c.reviewed.total > 0 ? (100 * c.reviewed.count) / c.reviewed.total : 0;
  return (
    <span className={styles.progress} role="img" aria-label={reviewedText(c)}>
      <span style={{ width: `${share}%` }} />
    </span>
  );
}

function InstructorCards({
  classes,
  courses,
  filter,
  search,
  onDone,
}: {
  classes: ClassCard[];
  courses: CourseCard[];
  filter: Filter;
  search: string;
  onDone: (text: string) => void;
}) {
  // The server accepts the class archive from a course owner and from a membership manager of the
  // class (§3, §13), so the control follows either, and is hidden while the class's course is
  // archived (the class then shows archived and only the course can be restored).
  const session = useSession();
  const managed = new Set(
    session.status === 'signed-in'
      ? session.me.classes.filter((c) => c.manageMembers).map((c) => c.classId)
      : [],
  );
  const owned = new Set(courses.filter((c) => c.owner).map((c) => c.courseId));
  const canArchiveClass = (c: ClassCard) =>
    (owned.has(c.courseId) || managed.has(c.classId)) && !c.courseArchived;
  const visibleClasses = classes.filter(
    (c) => matchesFilter(c, filter) && matchesTitle(c.courseTitle, search),
  );
  const visibleCourses = courses.filter(
    (c) =>
      matchesTitle(c.title, search) &&
      (filter === 'archived' ? c.archived : filter === 'all' || !c.archived),
  );
  const nothing = visibleClasses.length === 0 && visibleCourses.length === 0;
  return (
    <>
      {nothing ? (
        <ul className={styles.grid}>
          <Empty />
        </ul>
      ) : null}
      {visibleClasses.length > 0 ? (
        <ul className={styles.grid} aria-label="Classes you teach">
          {visibleClasses.map((c) => (
            <li key={c.classId} className={styles.card}>
              <Link
                to="/classes/$classId/topics"
                params={{ classId: c.classId }}
                className={styles.open}
                aria-label={`Open ${c.courseTitle} · ${c.className}`}
              >
                <CourseMark seed={c.courseId} className={styles.mark} />
                <h2>{c.courseTitle}</h2>
                <span className={styles.meta}>
                  {c.topicCount} topics · {c.className}
                </span>
              </Link>
              <div className={styles.status}>
                <span>
                  {c.archived ? 'Archived · ' : ''}
                  {c.studentCount ?? 0} {c.studentCount === 1 ? 'student' : 'students'}
                </span>
                <Link to="/classes/$classId/review" params={{ classId: c.classId }}>
                  Class review
                </Link>
                {canArchiveClass(c) ? (
                  <ArchiveControl
                    target={{
                      kind: 'class',
                      id: c.classId,
                      name: `${c.courseTitle} · ${c.className}`,
                      archived: c.archived,
                    }}
                    onDone={onDone}
                  />
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      {visibleCourses.length > 0 ? (
        <>
          <h2 className={styles.sectionHeading}>Courses</h2>
          <ul className={`${styles.grid} ${styles.gridSpaced}`} aria-label="Courses you hold">
            {visibleCourses.map((c) => {
              const body = (
                <>
                  <CourseMark seed={c.courseId} className={styles.mark} />
                  <h2>{c.title}</h2>
                  <span className={styles.meta}>
                    {c.topicCount} draft topics · {c.classCount}{' '}
                    {c.classCount === 1 ? 'class' : 'classes'}
                  </span>
                </>
              );
              return (
                <li key={c.courseId} className={styles.card}>
                  {canEdit(c) ? (
                    <Link
                      to="/courses/$courseId/edit"
                      params={{ courseId: c.courseId }}
                      className={styles.open}
                      aria-label={`Edit ${c.title}`}
                    >
                      {body}
                    </Link>
                  ) : (
                    <div className={styles.open}>{body}</div>
                  )}
                  <div className={styles.status}>
                    <span>
                      {c.archived ? 'Archived · ' : ''}
                      {grantLabel(c)}
                    </span>
                    {c.owner ? (
                      <ArchiveControl
                        target={{
                          kind: 'course',
                          id: c.courseId,
                          name: c.title,
                          archived: c.archived,
                        }}
                        onDone={onDone}
                      />
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </>
  );
}
