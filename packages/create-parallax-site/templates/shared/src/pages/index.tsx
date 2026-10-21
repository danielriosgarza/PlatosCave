import { Link, type PageProps } from 'parallax-site/pages';
import Visualization from './_visualization';
import styles from './index.module.css';

// The site's front page, at /. The catalogue is read from the instructor folders when the site is
// built: each instructor, then their courses. The picture under the title is `_visualization.tsx`:
// replace that file to show something of your own, or delete the import above and the element
// below. Delete the section "Make it yours" when the site is ready for students.
export default function Front({ site, catalogue }: PageProps) {
  const courses = catalogue.instructors.flatMap((instructor) =>
    instructor.courses.map((course) => ({ ...course, instructor })),
  );
  return (
    <main id="main" className={styles.front}>
      <section className={styles.hero}>
        <div className={`${styles.inner} ${styles.screen}`}>
          <div className={styles.title}>
            {site.logo && <img className={styles.logo} src={site.logo.src} alt={site.logo.alt} />}
            <h1 className={styles.name}>{site.name}</h1>
            <p className={styles.tagline}>Every topic, seen from five sides.</p>
            <Link className={styles.start} to={site.entry}>
              <svg className={styles.arrow} viewBox="0 0 4 7" aria-hidden="true">
                <path d="M0 0h1v1h1v1h1v1h1v1H3v1H2v1H1v1H0z" />
              </svg>
              Open the courses
            </Link>
          </div>
          <Visualization />
        </div>
      </section>

      <section className={`${styles.inner} ${styles.section}`} aria-labelledby="courses">
        <h2 id="courses" className={styles.heading}>
          Courses
        </h2>
        <ul className={styles.courses}>
          {courses.map(({ slug, title, instructor }) => (
            <li key={`${instructor.slug}/${slug}`} className={`${styles.box} ${styles.course}`}>
              <Item seed={`${instructor.slug}/${slug}`} />
              <div className={styles.courseText}>
                <h3 className={styles.courseTitle}>{title}</h3>
                <p className={styles.instructor}>{instructor.name}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className={`${styles.inner} ${styles.section}`} aria-labelledby="yours">
        <h2 id="yours" className={styles.heading}>
          Make it yours
        </h2>
        <div className={styles.box}>
          <dl className={styles.files}>
            <div className={styles.file}>
              <dt className={styles.path}>parallax.config.ts</dt>
              <dd className={styles.what}>The site's name, logo, sign-in and classes.</dd>
            </div>
            <div className={styles.file}>
              <dt className={styles.path}>src/pages/index.tsx</dt>
              <dd className={styles.what}>
                This page: the title, the tagline and the course list.
              </dd>
            </div>
            <div className={styles.file}>
              <dt className={styles.path}>src/pages/_visualization.tsx</dt>
              <dd className={styles.what}>The picture. Change it, replace it or delete it.</dd>
            </div>
            <div className={styles.file}>
              <dt className={styles.path}>courses/welcome/</dt>
              <dd className={styles.what}>
                A finished course: slides, a reading, an exercise, a notebook and a test. Copy it.
              </dd>
            </div>
          </dl>
          <p className={styles.note}>Delete this section before students arrive.</p>
        </div>
      </section>
    </main>
  );
}

/** The items a course card can show, 12 × 12 pixels each: `#` is a pixel. */
const ITEMS = [
  // A book.
  `
  .##########.
  .#........##
  .#.######.##
  .#........##
  .#.#####..##
  .#........##
  .#.######.##
  .#........##
  .#.####...##
  .#........##
  .##########.
  ..#########.`,
  // A flask.
  `
  ....####....
  .....##.....
  .....##.....
  .....##.....
  ....#..#....
  ...#....#...
  ..#......#..
  .#.##.##..#.
  .##########.
  .##########.
  ..########..
  ............`,
  // A key.
  `
  ............
  ..####......
  .#....#.....
  #..##..#....
  #.#..#.#####
  #..##..#####
  .#....#..#.#
  ..####...#.#
  .........#..
  ............
  ............
  ............`,
  // A scroll.
  `
  .##########.
  #..........#
  .##########.
  .#........#.
  .#.######.#.
  .#........#.
  .#.#####..#.
  .#........#.
  .##########.
  #..........#
  .##########.
  ............`,
  // A gem.
  `
  ............
  ...######...
  ..#..##..#..
  .#..#..#..#.
  ############
  .#...##...#.
  ..#..##..#..
  ...#.##.#...
  ....####....
  .....##.....
  ............
  ............`,
];

/** A course's item, picked by its address: the same for the same course. */
function Item({ seed }: { seed: string }) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const rows = (ITEMS[h % ITEMS.length] ?? '').trim().split('\n');
  const path = rows
    .flatMap((row, y) =>
      [...row.trim()].map((cell, x) => (cell === '#' ? `M${x} ${y}h1v1h-1z` : '')),
    )
    .join('');
  return (
    <svg className={styles.item} viewBox="0 0 12 12" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}
