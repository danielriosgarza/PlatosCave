import styles from '../notebooks/Notebook.module.css';

/**
 * Running a notebook in Jupyter on one's own computer at level 0: download only, as `OpenColab`.
 * `data` is the zip of the notebook file with its data files, or null when it declares none; then
 * the notebook file alone is offered. Nothing on the page connects to the computer.
 */
export function OpenLocal({
  file,
  data,
  language,
}: {
  file: string;
  data: string | null;
  language: string | null;
}) {
  return (
    <section className={styles.colab} aria-labelledby="local-heading">
      <h2 id="local-heading">Work on your computer</h2>
      <p className={styles.colabNote}>
        Jupyter runs on your own computer, separately from Parallax.
      </p>
      <ol className={styles.colabSteps}>
        {data ? (
          <li>
            Download <a href={data}>the notebook with its data files</a> (zip) and unzip it. Keep
            the files where they are: the notebook opens them by those paths.
          </li>
        ) : (
          <li>
            Download this notebook with <a href={file}>Download notebook without outputs</a>.
          </li>
        )}
        <li>
          Open it in JupyterLab, Jupyter Notebook or VS Code
          {language ? `, with a ${language} kernel` : ''}. To install JupyterLab, run{' '}
          <code>pip install jupyterlab</code>; then <code>jupyter lab</code> in that folder starts
          it.
        </li>
      </ol>
    </section>
  );
}
