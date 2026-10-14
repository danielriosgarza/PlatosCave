import { Link, type PageProps } from 'parallax-site/pages';
import styles from './index.module.css';

export const title = 'Courses';

export default function Front({ site, catalogue }: PageProps) {
  const names = catalogue.instructors.map((instructor) => instructor.name);
  return (
    <main className={styles.front}>
      <h1>Courses at {site.name}</h1>
      <p>{names.join(', ')}</p>
      <Link to={site.entry}>Open Parallax</Link>
    </main>
  );
}
