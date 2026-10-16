import { type OpenCatalogue, openPaths } from '@parallax/contracts';
import type { UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId } from 'react';
import { Loading } from '../components/Loading';
import page from '../components/Page.module.css';
import { usePageTitle } from '../components/pageTitle';
import { RetryNotice } from '../components/RetryNotice';
import styles from '../topics/TopicIndex.module.css';
import { minutes, TAB_LEGEND, tabFor, topicNumber } from '../topics/topics';
import { Missing, useCatalogue, useCourse } from './data';
import { OpenUnavailable } from './OpenUnavailable';
import { asClassTopics } from './Topic';

/** A screen whose data file has not arrived: loading, Try again, or for a 404 the page that says so. */
function Waiting({ file, label, failed }: { file: UseQueryResult; label: string; failed: string }) {
  if (file.error instanceof Missing) return <OpenUnavailable />;
  const retry = () => void file.refetch();
  return (
    <main id="main" className={page.index}>
      {file.isError ? <RetryNotice message={failed} onRetry={retry} /> : <Loading label={label} />}
    </main>
  );
}

type Courses = OpenCatalogue['instructors'][number]['courses'];
const CourseList = ({ courses }: { courses: Courses }) => (
  <ul className={page.list}>
    {courses.map(({ ref, title }) => (
      <li key={ref}>
        <Link to={openPaths.course(ref) as never} className={page.link}>
          {title}
        </Link>
      </li>
    ))}
  </ul>
);

/**
 * The catalogue at `/courses` (docs/design/open-site.md §6): in school mode each instructor's name,
 * then that instructor's courses (Q6), else the courses; each a link to its topic index.
 */
export function Catalogue() {
  const file = useCatalogue();
  const id = useId();
  usePageTitle('Courses');
  if (!file.data) {
    return (
      <Waiting file={file} label="Loading courses" failed="The courses could not be loaded." />
    );
  }
  const { mode, instructors } = file.data;
  const teaching = instructors.filter(({ courses }) => courses.length > 0);
  return (
    <main id="main" className={page.index}>
      <h1>Courses</h1>
      {teaching.length === 0 ? (
        <p className={page.intro}>No course has been published on this site.</p>
      ) : mode === 'school' ? (
        teaching.map(({ name, courses }, i) => (
          // A course reference is unique on the site, so the first one names the instructor's entry.
          <section key={courses[0]?.ref} aria-labelledby={`${id}-${i}`} className={page.mt40}>
            <h2 id={`${id}-${i}`} className={page.sectionTitle}>
              {name}
            </h2>
            <CourseList courses={courses} />
          </section>
        ))
      ) : (
        <CourseList courses={teaching.flatMap(({ courses }) => courses)} />
      )}
    </main>
  );
}

/**
 * A course's topic index (§6): number, title, presence of the five tabs and time, the title a link
 * to the first tab (Slides where none, as at level 1). No Resume, Reviewed, lock or download.
 */
export function CourseIndex({ course }: { course: string }) {
  const file = useCourse(course);
  usePageTitle(file.data?.title);
  if (!file.data) {
    const failed = 'The topic list could not be loaded.';
    return <Waiting file={file} label="Loading topics" failed={failed} />;
  }
  const data = asClassTopics(file.data);
  const present = (on: boolean) => (on ? 'available' : 'not added');
  return (
    <main id="main" className={page.index}>
      <h1>{data.course.title}</h1>
      <p className={`${page.small} ${page.muted} ${styles.context}`}>
        {[data.cohort, ...data.instructors].join(' · ')}
      </p>
      {data.topics.length === 0 ? (
        <p className={page.intro}>No topics have been published for this course.</p>
      ) : (
        <>
          <section className={styles.wrap} aria-label="Topic syllabus">
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">No.</th>
                  <th scope="col">Topic</th>
                  {TAB_LEGEND.map((tab) => (
                    <th key={tab.id} scope="col" className={styles.presence}>
                      <abbr title={tab.label}>{tab.letter}</abbr>
                    </th>
                  ))}
                  <th scope="col">Time</th>
                </tr>
              </thead>
              <tbody>
                {data.topics.map((topic) => (
                  <tr key={topic.topicId}>
                    <td>{topicNumber(topic)}</td>
                    <td>
                      <Link to={openPaths.topic(course, topic.topicId, tabFor(topic)) as never}>
                        {topic.title}
                      </Link>
                    </td>
                    {TAB_LEGEND.map(({ id, label }) => (
                      <td key={id} className={styles.presence}>
                        <span
                          className={`${styles.dot} ${topic.presence[id] ? styles.available : ''}`}
                          role="img"
                          aria-label={`${label}: ${present(topic.presence[id])}`}
                        />
                      </td>
                    ))}
                    <td className={`${page.small} ${page.muted}`}>{minutes(topic)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div className={styles.legend}>
            {TAB_LEGEND.map((tab) => (
              <span key={tab.id}>
                {tab.letter} · {tab.label}
              </span>
            ))}
          </div>
        </>
      )}
    </main>
  );
}
