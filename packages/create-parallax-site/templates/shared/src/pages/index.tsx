import { Link, type PageProps } from 'parallax-site/pages';
import Visualization from './_visualization';
import styles from './index.module.css';

// The site's front page, at /. The catalogue is read from the instructor folders when the site is
// built: each instructor, then their courses. The scene beside the title is `_visualization.tsx`:
// replace that file to show something of your own, or delete the import above and the element
// below. The section "Make this site yours" is for you as the author: delete it when the site is
// ready for students.
export default function Front({ site, catalogue }: PageProps) {
  const courses = catalogue.instructors.flatMap((instructor) =>
    instructor.courses.map((course) => ({ ...course, instructor })),
  );
  return (
    <main id="main" className={styles.front}>
      <section className={styles.hero}>
        <div className={`${styles.inner} ${styles.heroInner}`}>
          <div className={styles.intro}>
            {site.logo && <img className={styles.logo} src={site.logo.src} alt={site.logo.alt} />}
            <h1 className={styles.title}>{site.name}</h1>
            <p className={styles.tagline}>
              Course material for students, one topic at a time, in five kinds.
            </p>
            <Link className={styles.open} to={site.entry}>
              Open the courses
            </Link>
            <ul className={styles.kinds}>
              {['Slides', 'Reading', 'Exercises', 'Notebooks', 'Tests'].map((kind) => (
                <li key={kind} className={styles.kind}>
                  {kind}
                </li>
              ))}
            </ul>
          </div>
          <Visualization />
        </div>
      </section>

      <section className={`${styles.inner} ${styles.section}`} aria-labelledby="start">
        <h2 id="start" className={styles.heading}>
          Make this site yours
        </h2>
        <p className={styles.lead}>For the site's author: three steps before students arrive.</p>
        <ol className={styles.steps}>
          <li className={styles.step}>
            <span className={styles.eyebrow} aria-hidden="true">
              Step 1
            </span>
            <h3 className={styles.cardTitle}>Name the site</h3>
            <p className={styles.cardText}>
              In <code className={styles.code}>parallax.config.ts</code> set the site's name and
              logo, its two host names, how students sign in, and the classes of each course.
            </p>
          </li>
          <li className={styles.step}>
            <span className={styles.eyebrow} aria-hidden="true">
              Step 2
            </span>
            <h3 className={styles.cardTitle}>Change this page</h3>
            <p className={styles.cardText}>
              This page is <code className={styles.code}>src/pages/index.tsx</code> and the cave is{' '}
              <code className={styles.code}>_visualization.tsx</code> beside it. Change the cave's
              constants, put a component of your own in its place, or remove it.
            </p>
          </li>
          <li className={styles.step}>
            <span className={styles.eyebrow} aria-hidden="true">
              Step 3
            </span>
            <h3 className={styles.cardTitle}>Add your material</h3>
            <p className={styles.cardText}>
              Each folder in <code className={styles.code}>courses/</code> is a course. The course{' '}
              <strong>Welcome to Parallax</strong> fills all five tabs and explains each of its
              files: copy it to start a course of your own.
            </p>
          </li>
        </ol>
      </section>

      <section className={`${styles.inner} ${styles.section}`} aria-labelledby="courses">
        <h2 id="courses" className={styles.heading}>
          Courses
        </h2>
        <ul className={styles.courses}>
          {courses.map(({ slug, title, instructor }) => (
            <li key={`${instructor.slug}/${slug}`} className={styles.course}>
              <CourseMark seed={`${instructor.slug}/${slug}`} />
              <div className={styles.courseText}>
                <h3 className={styles.cardTitle}>{title}</h3>
                <p className={styles.meta}>{instructor.name}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

/* The subject marks of the course cards of Parallax (DESIGN.md, Course catalog): one small line
   drawing per card, the same for the same course. */
const marks = [
  <path key="distribution" d="M3 45H73M5 44C24 44 26 7 38 7S52 44 71 44" />,
  <g key="growth">
    <path d="M5 48V6M5 48H74M8 45C26 45 23 40 33 27S41 10 70 10" />
    <path d="M8 41C25 38 39 33 52 20S66 11 70 10" strokeDasharray="2 4" />
  </g>,
  <path
    key="sequence"
    d="M6 43H72M10 43V30M18 43V17M26 43V25M34 43V8M42 43V15M50 43V34M58 43V24M66 43V11"
  />,
  <g key="network">
    <path d="M13 27L35 9 64 23 47 46 13 27 64 23M35 9L47 46" />
    <circle cx="13" cy="27" r="4" />
    <circle cx="35" cy="9" r="4" />
    <circle cx="64" cy="23" r="4" />
    <circle cx="47" cy="46" r="4" />
  </g>,
  <g key="phase">
    <ellipse cx="39" cy="28" rx="31" ry="18" />
    <ellipse cx="39" cy="28" rx="22" ry="12" />
    <ellipse cx="39" cy="28" rx="10" ry="6" />
    <path d="M3 51H75M5 51V4" />
  </g>,
  <path
    key="measure"
    d="M8 45H72M8 45V5M16 37L27 29 39 26 51 16 64 9M16 32V42M27 24V34M39 21V31M51 11V21M64 5V14"
  />,
];

function CourseMark({ seed }: { seed: string }) {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={styles.mark}>
      <svg
        viewBox="0 0 78 56"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {marks[h % marks.length]}
      </svg>
    </span>
  );
}
