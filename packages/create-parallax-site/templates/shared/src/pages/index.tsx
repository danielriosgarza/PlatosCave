import { Link, type PageProps } from 'parallax-site/pages';
import styles from './index.module.css';

// The site's front page, at /. The catalogue is read from the instructor folders when the site is
// built: each instructor, then their courses.
export default function Front({ site, catalogue }: PageProps) {
  return (
    <main id="main" className={styles.front}>
      {site.logo && <img className={styles.logo} src={site.logo.src} alt={site.logo.alt} />}
      <h1 className={styles.title}>{site.name}</h1>
      <p className={styles.audience}>Course material for the students of these courses.</p>
      {catalogue.instructors.map((instructor) => (
        <section key={instructor.slug} className={styles.instructor}>
          <h2 className={styles.name}>{instructor.name}</h2>
          <ul className={styles.courses}>
            {instructor.courses.map((course) => (
              <li key={course.slug}>{course.title}</li>
            ))}
          </ul>
        </section>
      ))}
      <Link className={styles.open} to={site.entry}>
        Open the courses
      </Link>
    </main>
  );
}
