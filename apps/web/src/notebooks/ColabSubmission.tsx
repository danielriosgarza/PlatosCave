import { type ChangeEvent, useRef, useState } from 'react';
import styles from './Notebook.module.css';
import {
  COLAB_URL,
  downloadSubmission,
  type Receipt,
  type ReviewedSubmission,
  recordLaunch,
  sendSubmission,
  submissionFailure,
  submissionProblem,
  useOwnSubmissions,
  useRefreshSubmissions,
  useReviewedSubmissions,
} from './submissions';

interface Props {
  classId: string;
  resourceId: string;
  instructor: boolean;
}

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const kilobytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024))} KB`;

/**
 * Working in Colab and handing the notebook back (§10.1, §10.5, §10.7). Opening Colab is an
 * external launch: nothing returns from it, and nothing is graded. The way back is an uploaded
 * `.ipynb`; "Received" is shown only with the receipt the server returned.
 */
export function ColabSubmission({ classId, resourceId, instructor }: Props) {
  const own = useOwnSubmissions(classId, resourceId);
  const reviewed = useReviewedSubmissions(classId, resourceId, instructor);
  const refresh = useRefreshSubmissions();
  const input = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<{ file: File; key: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const choose = (e: ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0];
    setReceipt(null);
    if (!chosen) {
      setFile(null);
      setProblem(null);
      return;
    }
    const refused = submissionProblem(chosen);
    setProblem(refused ?? null);
    // One key per chosen file: a retry after a lost answer is the same submission.
    setFile(refused ? null : { file: chosen, key: crypto.randomUUID() });
  };

  async function submit() {
    if (!file) return;
    setBusy(true);
    setProblem(null);
    try {
      setReceipt(await sendSubmission(classId, resourceId, file.file, file.key));
      setFile(null);
      if (input.current) input.current.value = '';
      void refresh();
    } catch (err) {
      setProblem(submissionFailure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.colab} aria-labelledby="colab-heading">
      <h2 id="colab-heading">Work in Colab</h2>
      <p className={styles.colabNote}>
        Colab runs on Google’s computers, separately from Parallax. Nothing is sent back from it and
        nothing is graded until you submit a notebook file here.
      </p>
      <ol className={styles.colabSteps}>
        <li>Download this notebook with Download in the toolbar.</li>
        <li>
          <a
            href={COLAB_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => void recordLaunch(classId, resourceId)}
          >
            Open in Colab
          </a>{' '}
          (opens in a new tab) and choose File → Upload notebook.
        </li>
        <li>
          Choose File → Save a copy in Drive. Work in that copy; the course notebook stays as it is.
        </li>
        <li>
          When you finish, choose File → Download → Download .ipynb, then submit that file below.
        </li>
      </ol>

      <div className={styles.submit}>
        <label className={styles.label} htmlFor="notebook-file">
          Notebook file (.ipynb)
        </label>
        <input
          id="notebook-file"
          ref={input}
          type="file"
          accept=".ipynb"
          onChange={choose}
          disabled={busy}
        />
        <button
          type="button"
          className={styles.button}
          disabled={!file || busy}
          onClick={() => void submit()}
        >
          {busy ? 'Submitting' : 'Submit notebook'}
        </button>
        {problem ? <p role="alert">{problem}</p> : null}
        {receipt ? (
          <p role="status">
            Received {when(receipt.receivedAt)} · version {receipt.version} · {receipt.filename} ·{' '}
            {kilobytes(receipt.size)} · checksum {receipt.sha256.slice(0, 12)}
          </p>
        ) : null}
      </div>

      {own.data && own.data.submissions.length > 0 ? (
        <Submissions
          title="Your submissions"
          classId={classId}
          rows={own.data.submissions}
          withStudent={false}
        />
      ) : null}
      {instructor && reviewed.data ? (
        reviewed.data.submissions.length > 0 ? (
          <Submissions
            title="Student submissions"
            classId={classId}
            rows={reviewed.data.submissions}
            withStudent
          />
        ) : (
          <p className={styles.colabNote}>No student has submitted this notebook.</p>
        )
      ) : null}
    </section>
  );
}

function Submissions({
  title,
  classId,
  rows,
  withStudent,
}: {
  title: string;
  classId: string;
  rows: (Receipt | ReviewedSubmission)[];
  withStudent: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  async function download(id: string) {
    setFailed(null);
    try {
      window.location.assign((await downloadSubmission(classId, id)).url);
    } catch {
      setFailed(id);
    }
  }
  return (
    <div className={styles.submissions}>
      <h3>{title}</h3>
      <table>
        <thead>
          <tr>
            {withStudent ? <th scope="col">Student</th> : null}
            <th scope="col">Version</th>
            <th scope="col">File</th>
            <th scope="col">Received</th>
            <th scope="col">Environment</th>
            <th scope="col">
              <span className={styles.srOnly}>Download</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {withStudent ? <td>{'student' in row ? row.student.name : null}</td> : null}
              <td>{row.version}</td>
              <td>
                {row.filename} · {kilobytes(row.size)}
              </td>
              <td>{when(row.receivedAt)}</td>
              <td>{environmentText(row.environment)}</td>
              <td>
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => void download(row.id)}
                  aria-label={`Download version ${row.version}${'student' in row ? ` of ${row.student.name}` : ''}`}
                >
                  Download
                </button>
                {failed === row.id ? (
                  <span role="status"> The file could not be downloaded.</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** What the file declares about where it was made; labelled so it is not read as verified. */
function environmentText(env: Record<string, string | number>): string {
  const parts = [
    env.runtime === 'colab' ? 'Colab' : null,
    env.kernel,
    env.language && env.languageVersion ? `${env.language} ${env.languageVersion}` : env.language,
  ].filter(Boolean);
  return parts.length > 0 ? `${parts.join(' · ')} (as declared by the file)` : 'Not declared';
}
