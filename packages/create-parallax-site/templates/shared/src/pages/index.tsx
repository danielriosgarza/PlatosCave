import { Link, type PageProps } from 'parallax-site/pages';
import Visualization from './_visualization';
import styles from './index.module.css';

// The site's front page, at /. The catalogue is read from the instructor folders when the site is
// built: each instructor, then their courses. The picture in the banner is `_visualization.tsx`:
// replace that file to show something of your own, or delete the import above and the element
// below. Change the tagline to suit your site, and delete the section
// "Edit this site" when the site is ready for students.

/** The five tabs of every topic, in their order. */
const KINDS = [
  { name: 'Slides', picture: 5 },
  { name: 'Reading', picture: 0 },
  { name: 'Exercises', picture: 6 },
  { name: 'Notebooks', picture: 1 },
  { name: 'Tests', picture: 7 },
];

export default function Front({ site, catalogue }: PageProps) {
  const courses = catalogue.instructors.flatMap((instructor) =>
    instructor.courses.map((course) => ({ ...course, instructor })),
  );
  return (
    <main id="main" className={styles.front}>
      <section className={styles.banner}>
        <div className={`${styles.inner} ${styles.bannerInner}`}>
          {site.logo && <img className={styles.logo} src={site.logo.src} alt={site.logo.alt} />}
          <h1 className={styles.name}>{site.name}</h1>
          <p className={styles.tagline}>Build your online courses</p>
          <Link className={styles.start} to={site.entry}>
            Browse courses
          </Link>
          <div className={styles.picture}>
            <Visualization />
          </div>
        </div>
      </section>

      <section className={`${styles.inner} ${styles.section}`} aria-labelledby="kinds">
        <h2 id="kinds" className={styles.heading}>
          For each topic you can create:
        </h2>
        <ul className={styles.kinds}>
          {KINDS.map(({ name, picture }) => (
            <li key={name} className={styles.kind}>
              <Pixels drawing={picture} className={styles.kindPicture} />
              <h3 className={styles.kindName}>{name}</h3>
            </li>
          ))}
        </ul>
      </section>

      <section className={`${styles.inner} ${styles.section}`} aria-labelledby="courses">
        <h2 id="courses" className={styles.heading}>
          Courses
        </h2>
        <ul className={styles.courses}>
          {courses.map(({ slug, title, instructor }) => (
            <li key={`${instructor.slug}/${slug}`} className={styles.course}>
              <Pixels drawing={pick(`${instructor.slug}/${slug}`)} className={styles.mark} />
              <h3 className={styles.courseTitle}>{title}</h3>
              <p className={styles.meta}>{instructor.name}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className={`${styles.inner} ${styles.section}`} aria-labelledby="yours">
        <div className={styles.note}>
          <h2 id="yours" className={styles.noteTitle}>
            Edit this site
          </h2>
          <dl className={styles.files}>
            <dt>
              <code>parallax.config.ts</code>
            </dt>
            <dd>The site's name, logo, sign-in and classes.</dd>
            <dt>
              <code>src/pages/index.tsx</code>
            </dt>
            <dd>This page.</dd>
            <dt>
              <code>src/pages/_visualization.tsx</code>
            </dt>
            <dd>The banner.</dd>
            <dt>
              <code>courses/welcome/</code>
            </dt>
            <dd>An example course with all five tabs.</dd>
          </dl>
        </div>
      </section>
    </main>
  );
}

/** Small 1-bit drawings, 12 × 12 pixels each: `#` is a pixel. */
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
  // A screen on a stand.
  `
  ############
  #..........#
  #.####.....#
  #..........#
  #.######...#
  #.#####....#
  #..........#
  ############
  .....##.....
  ....####....
  ...##..##...
  ..##....##..`,
  // A pencil.
  `
  .........##.
  ........#..#
  .......#..#.
  ......#..#..
  .....#..#...
  ....#..#....
  ...#..#.....
  ..#..#......
  .##.#.......
  .###........
  ####........
  ............`,
  // A checklist.
  `
  .##########.
  .#........#.
  .#..#.###.#.
  .#.#......#.
  .##.......#.
  .#..#.###.#.
  .#.#......#.
  .##.......#.
  .#..#.###.#.
  .#.#......#.
  .##########.
  ............`,
];

/** A drawing for a course, picked by its address among the first five: the same for the same course. */
function pick(seed: string): number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h % 5;
}

/** One of the drawings, as crisp squares in the text colour. */
function Pixels({ drawing, className }: { drawing: number; className?: string }) {
  const rows = (ITEMS[drawing] ?? '').trim().split('\n');
  const path = rows
    .flatMap((row, y) =>
      [...row.trim()].map((cell, x) => (cell === '#' ? `M${x} ${y}h1v1h-1z` : '')),
    )
    .join('');
  return (
    <svg className={className} viewBox="0 0 12 12" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}
