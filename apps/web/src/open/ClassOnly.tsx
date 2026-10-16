import type { OpenTopic } from '@parallax/contracts';
import page from '../components/Page.module.css';
import styles from '../exercises/Exercise.module.css';
import { EMPTY } from './panels';

const WHERE = { exercises: 'Exercises are done in a class.', tests: 'Tests are taken in a class.' };
const NAME = { exercises: 'Exercises', tests: 'Tests' };

/**
 * The Exercises and Tests tabs at level 0 (Q17, Q19): their titles from `topic.json`, and where the
 * work is done. A build writes no file for an exercise or a test, so nothing starts and nothing more
 * is requested.
 */
export function ClassOnly({ tab, items }: { tab: keyof typeof WHERE; items: OpenTopic['tests'] }) {
  if (items.length === 0) return <p className={page.intro}>{EMPTY[tab]}</p>;
  return (
    <>
      <p className={page.intro}>{WHERE[tab]}</p>
      <ul className={styles.exerciseList} aria-label={`${NAME[tab]} in this topic`}>
        {items.map(({ resourceId, title }) => (
          <li key={resourceId}>{title}</li>
        ))}
      </ul>
    </>
  );
}
