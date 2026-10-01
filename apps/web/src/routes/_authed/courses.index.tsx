import { createFileRoute, Link } from '@tanstack/react-router';
import styles from '../../components/Page.module.css';
import { type Me, studyingClasses, teachingContexts, useSession } from '../../session/useSession';

type View = 'student' | 'instructor';

export const Route = createFileRoute('/_authed/courses/')({
  validateSearch: (search: Record<string, unknown>): { view?: View } => ({
    view:
      search.view === 'instructor'
        ? 'instructor'
        : search.view === 'student'
          ? 'student'
          : undefined,
  }),
  component: Courses,
});

function Courses() {
  const session = useSession();
  const { view = 'student' } = Route.useSearch();
  if (session.status !== 'signed-in') return <main className={styles.index} aria-busy="true" />;
  return <CoursesFor me={session.me} view={view} />;
}

function CoursesFor({ me, view }: { me: Me; view: View }) {
  const studying = studyingClasses(me);
  const teaching = teachingContexts(me);
  const teachesAnything = teaching.classes.length > 0 || teaching.courses.length > 0;
  // A person holding both roles can switch between the two contexts (§3).
  const canSwitch = teachesAnything && studying.length > 0;

  return (
    <main className={styles.index}>
      <div className={`${styles.row} ${styles.between}`}>
        <h1>{view === 'instructor' ? 'Courses you teach' : 'Your courses'}</h1>
        {canSwitch ? (
          <fieldset className={`${styles.row} ${styles.group}`} aria-label="Context">
            <Link
              to="/courses"
              search={{ view: 'student' }}
              className={styles.link}
              aria-current={view === 'student' ? 'page' : undefined}
            >
              Student view
            </Link>
            <Link
              to="/courses"
              search={{ view: 'instructor' }}
              className={styles.link}
              aria-current={view === 'instructor' ? 'page' : undefined}
            >
              Instructor view
            </Link>
          </fieldset>
        ) : null}
      </div>
      {view === 'instructor' ? (
        <InstructorView me={me} teachesAnything={teachesAnything} />
      ) : (
        <ClassList heading={null} classes={studying} empty="You are not enrolled in a class." />
      )}
    </main>
  );
}

function InstructorView({ me, teachesAnything }: { me: Me; teachesAnything: boolean }) {
  const teaching = teachingContexts(me);
  const studying = studyingClasses(me);
  if (!teachesAnything) {
    return (
      <>
        <div className={styles.feedback} role="status">
          <h2>This account has no instructor access</h2>
          <p>
            Instructor access comes from an invitation by a course owner. Signing in through the
            instructor entrance does not grant it.
          </p>
        </div>
        <h2 style={{ marginTop: 32 }}>Your enrolled classes</h2>
        <ClassList heading={null} classes={studying} empty="You are not enrolled in a class." />
      </>
    );
  }
  return (
    <>
      <ClassList heading="Classes" classes={teaching.classes} empty="You teach no class yet." />
      {teaching.courses.length > 0 ? (
        <>
          <h2 style={{ marginTop: 32 }}>Courses</h2>
          <ul className={styles.list}>
            {teaching.courses.map((c) => (
              <li key={c.courseId}>
                <span>{c.title}</span>
                <span className={`${styles.small} ${styles.muted}`}>
                  {c.owner ? 'Owner' : c.editor ? 'Editor' : 'Publisher'}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </>
  );
}

function ClassList({
  heading,
  classes,
  empty,
}: {
  heading: string | null;
  classes: Me['classes'];
  empty: string;
}) {
  return (
    <>
      {heading ? <h2 style={{ marginTop: 32 }}>{heading}</h2> : null}
      {classes.length === 0 ? (
        <p className={styles.intro}>{empty}</p>
      ) : (
        <ul className={styles.list}>
          {classes.map((c) => (
            <li key={c.classId}>
              <Link
                to="/classes/$classId/topics"
                params={{ classId: c.classId }}
                className={styles.link}
              >
                {c.courseTitle} · {c.className}
              </Link>
              {c.role === 'instructor' ? (
                <Link
                  to="/classes/$classId/review"
                  params={{ classId: c.classId }}
                  className={styles.link}
                >
                  Class review
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
