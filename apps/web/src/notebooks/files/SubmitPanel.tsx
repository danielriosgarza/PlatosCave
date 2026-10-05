import type { submissionReceipt } from '@parallax/contracts/routes/notebookSubmissions';
import { listTransfers } from '@parallax/contracts/routes/transfers';
import { submitWorkingCopy, type WorkingCopyView } from '@parallax/contracts/routes/workingCopies';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { ApiError, call } from '../../api/client';
import buttons from '../../components/Buttons.module.css';
import styles from './Files.module.css';
import { refusalText, size, when } from './files';

type Receipt = z.output<typeof submissionReceipt>;

interface Props {
  classId: string;
  sessionId: string;
  workingCopy: WorkingCopyView;
  /** What the session reported about the computer: `os`, `arch`, `interpreter`, `kernel`. */
  environment: Record<string, string | undefined>;
}

/** The environment as one line, worded as reported by the connected computer. */
export function environmentLine(env: Record<string, string | undefined>): string {
  const parts = [env.os, env.arch, env.interpreter, env.kernel].filter(Boolean);
  return parts.length > 0
    ? `${parts.join(' · ')} (reported by the connected computer)`
    : 'Not reported';
}

/**
 * **Submit notebook** (§10.5, design §11). Shows what will be frozen: the acknowledged revision,
 * the copied-out files the person ticked, and the environment the session reported. Only files
 * Parallax has stored (`done` copy-outs) are offered; the receipt appears only with the server's
 * answer.
 */
export function SubmitPanel({ classId, sessionId, workingCopy, environment }: Props) {
  const queryClient = useQueryClient();
  const transfers = useQuery({
    queryKey: ['transfers', classId, sessionId],
    queryFn: () => call(listTransfers, { params: { classId, sessionId } }),
  });
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  // Only a finished copy-out is a file Parallax holds; started, failed and conflicted ones are not.
  const available = (transfers.data?.transfers ?? []).filter(
    (t) => t.kind === 'copy_out' && t.state === 'done',
  );
  const selected = available.filter((t) => picked[t.id]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const sent = await call(submitWorkingCopy, {
        params: { classId, workingCopyId: workingCopy.id },
        body: {
          revision: workingCopy.currentRevision,
          sessionId,
          transferIds: selected.map((t) => t.id),
          submissionKey: key,
        },
      });
      setReceipt(sent);
      setKey(crypto.randomUUID());
      setPicked({});
      void queryClient.invalidateQueries({
        predicate: (q) => String(q.queryKey[1]).includes('/notebook-submissions'),
      });
    } catch (err) {
      const body = err instanceof ApiError ? (err.body as { message?: string } | null) : null;
      setError(
        err instanceof ApiError && err.status === 400
          ? (body?.message ?? 'The server refused this submission.')
          : refusalText(err, 'The notebook was not received. Try again.'),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="submit-heading">
      <h3 id="submit-heading">Submit notebook</h3>
      <p>Submitting freezes the following. Later changes are not part of it.</p>
      <ul className={styles.list} aria-label="What will be frozen">
        <li>
          Notebook: revision {workingCopy.currentRevision}, saved{' '}
          {when(workingCopy.revision.savedAt)} to Parallax
        </li>
        <li>Environment: {environmentLine(environment)}</li>
        <li>
          Files:{' '}
          {selected.length === 0
            ? 'none selected'
            : selected.map((t) => `${t.path} (${size(t.size)})`).join(', ')}
        </li>
      </ul>

      {available.length > 0 ? (
        <fieldset className={styles.fieldset}>
          <legend>Files copied to Parallax to include</legend>
          {available.map((t) => (
            <label key={t.id} className={styles.check}>
              <input
                type="checkbox"
                checked={picked[t.id] === true}
                onChange={() => setPicked((p) => ({ ...p, [t.id]: !p[t.id] }))}
              />{' '}
              {t.path} · {size(t.size)}
            </label>
          ))}
        </fieldset>
      ) : (
        <p className={styles.note}>
          No files have been copied to Parallax. Only files you copy there can be submitted.
        </p>
      )}

      <button
        type="button"
        className={buttons.primary}
        disabled={busy}
        onClick={() => void submit()}
      >
        {busy ? 'Submitting' : 'Submit notebook'}
      </button>
      {error ? <p role="alert">Not submitted. {error}</p> : null}
      {receipt ? (
        <p role="status">
          Received {when(receipt.receivedAt)} · version {receipt.version} · revision{' '}
          {receipt.workingCopyRevision ?? workingCopy.currentRevision} ·{' '}
          {receipt.files?.length ?? 0} {(receipt.files?.length ?? 0) === 1 ? 'file' : 'files'} ·
          checksum {receipt.sha256.slice(0, 12)}
        </p>
      ) : null}
    </section>
  );
}
