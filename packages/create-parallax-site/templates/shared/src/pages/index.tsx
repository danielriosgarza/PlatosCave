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
        <div className={styles.intro}>
          {site.logo && <img className={styles.logo} src={site.logo.src} alt={site.logo.alt} />}
          <h1 className={styles.title}>{site.name}</h1>
          <p className={styles.tagline}>
            Slides, readings, exercises, notebooks and tests for the students of these courses.
          </p>
          <Link className={styles.open} to={site.entry}>
            Open the courses
          </Link>
        </div>
        <Visualization />
      </section>

      <section className={styles.section} aria-labelledby="start">
        <h2 id="start" className={styles.heading}>
          Make this site yours
        </h2>
        <ol className={styles.grid}>
          <li className={styles.card}>
            <h3 className={styles.cardTitle}>Name the site</h3>
            <p className={styles.cardText}>
              Edit <code className={styles.code}>parallax.config.ts</code>: the site's name and
              logo, its two host names, how students sign in, and the classes of each course.
            </p>
          </li>
          <li className={styles.card}>
            <h3 className={styles.cardTitle}>Change this page</h3>
            <p className={styles.cardText}>
              The cave is drawn by <code className={styles.code}>src/pages/_visualization.tsx</code>
              . Change its constants, put your own component in its place, or remove it from{' '}
              <code className={styles.code}>src/pages/index.tsx</code>.
            </p>
          </li>
          <li className={styles.card}>
            <h3 className={styles.cardTitle}>Add your material</h3>
            <p className={styles.cardText}>
              Each folder in <code className={styles.code}>courses/</code> is a course. The course
              Welcome to Parallax fills all five tabs and explains each file: copy it to start one
              of your own.
            </p>
          </li>
        </ol>
      </section>

      <section className={styles.section} aria-labelledby="courses">
        <h2 id="courses" className={styles.heading}>
          Courses
        </h2>
        <ul className={styles.grid}>
          {courses.map(({ slug, title, instructor }) => (
            <li key={`${instructor.slug}/${slug}`} className={styles.card}>
              <h3 className={styles.cardTitle}>{title}</h3>
              <p className={styles.meta}>{instructor.name}</p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
