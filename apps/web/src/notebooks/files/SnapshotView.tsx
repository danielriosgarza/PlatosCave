import { getSubmissionFileDownload } from '@parallax/contracts/routes/notebookSubmissions';
import { useState } from 'react';
import { call } from '../../api/client';
import buttons from '../../components/Buttons.module.css';
import styles from './Files.module.css';
import { size } from './files';

interface Props {
  classId: string;
  submissionId: string;
  workingCopyRevision: number;
  environment: Record<string, string | number>;
  files: { id: string; path: string; size: number; sha256: string }[];
  /** Who the snapshot is described for (the student's name in the instructor's list). */
  label?: string;
}

/** The environment line of a connected-session snapshot, from what the session reported. */
export function snapshotEnvironment(env: Record<string, string | number>): string {
  const language = env.interpreter ?? env.language;
  const parts = [env.os, env.arch, language, env.kernel].filter(Boolean);
  return parts.length > 0
    ? `${parts.join(' · ')} (reported by the connected computer)`
    : 'Not reported';
}

/**
 * What an instructor sees for a submission made from a connected computer: the frozen revision,
 * the environment line and the manifest of files, each served as an attachment from Parallax's
 * storage. There is no connect action here and nothing asks the student's computer for anything
 * (A35): the snapshot is all there is.
 */
export function SnapshotView({
  classId,
  submissionId,
  workingCopyRevision,
  environment,
  files,
  label,
}: Props) {
  const [failed, setFailed] = useState<string | null>(null);
  async function download(fileId: string) {
    setFailed(null);
    try {
      window.location.assign(
        (await call(getSubmissionFileDownload, { params: { classId, submissionId, fileId } })).url,
      );
    } catch {
      setFailed(fileId);
    }
  }
  return (
    <section className={styles.snapshot} aria-label={`Snapshot${label ? ` of ${label}` : ''}`}>
      <p>Notebook revision {workingCopyRevision} · frozen when submitted</p>
      <p>Environment: {snapshotEnvironment(environment)}</p>
      {files.length === 0 ? (
        <p className={styles.note}>No files were submitted with this notebook.</p>
      ) : (
        <table className={styles.table}>
          <caption className={styles.srOnly}>Files submitted with this notebook</caption>
          <thead>
            <tr>
              <th scope="col">File</th>
              <th scope="col">Size</th>
              <th scope="col">Checksum</th>
              <th scope="col">
                <span className={styles.srOnly}>Download</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <td>
                  <code>{f.path}</code>
                </td>
                <td>{size(f.size)}</td>
                <td>{f.sha256.slice(0, 12)}</td>
                <td>
                  <button
                    type="button"
                    className={buttons.textButton}
                    aria-label={`Download ${f.path}`}
                    onClick={() => void download(f.id)}
                  >
                    Download
                  </button>
                  {failed === f.id ? (
                    <span role="status"> The file could not be downloaded.</span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
