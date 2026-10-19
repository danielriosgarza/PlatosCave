import { Link, type PageProps } from 'parallax-site/pages';
import styles from './page.module.css';

export const title = 'Example School of Marine Biology';

// The front page of the open site: whom the material is for, the instructors with their courses
// from the catalogue, and the one link to the courses.
export default function Front({ site, catalogue }: PageProps) {
  return (
    <main id="main" className={styles.page}>
      <h1>{site.name}</h1>
      <p>Course material in marine biology, open to everyone.</p>
      {catalogue.instructors.map(({ slug, name, courses }) => (
        <section key={slug} aria-labelledby={`by-${slug}`}>
          <h2 id={`by-${slug}`}>{name}</h2>
          <ul>
            {courses.map((course) => (
              <li key={course.slug}>{course.title}</li>
            ))}
          </ul>
        </section>
      ))}
      <Link to={site.entry}>Open the courses</Link>
    </main>
  );
}
