import { COLAB_URL } from '@parallax/contracts/routes/notebookSubmissions';
import styles from '../notebooks/Notebook.module.css';

/**
 * Working in Colab at level 0 (Q19): open and download only. The steps are those of
 * `ColabSubmission` without the submission step; nothing is uploaded and no launch is recorded.
 */
export function OpenColab({ file }: { file: string }) {
  return (
    <section className={styles.colab} aria-labelledby="colab-heading">
      <h2 id="colab-heading">Work in Colab</h2>
      <p className={styles.colabNote}>
        Colab runs on Google’s computers, separately from Parallax.
      </p>
      <ol className={styles.colabSteps}>
        <li>
          Download this notebook with <a href={file}>Download notebook without outputs</a>.
        </li>
        <li>
          <a href={COLAB_URL} target="_blank" rel="noopener noreferrer">
            Open in Colab
          </a>{' '}
          (opens in a new tab) and choose File → Upload notebook.
        </li>
        <li>
          Choose File → Save a copy in Drive. Work in that copy; the course notebook stays as it is.
        </li>
      </ol>
      <p className={styles.colabNote}>Notebooks are handed in in a class.</p>
    </section>
  );
}
