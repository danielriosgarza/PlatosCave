import { createTransfer, type TransferView } from '@parallax/contracts/routes/transfers';
import { saveWorkingCopy, type WorkingCopyView } from '@parallax/contracts/routes/workingCopies';
import { useEffect, useMemo, useState } from 'react';
import { ApiError, call } from '../../api/client';
import buttons from '../../components/Buttons.module.css';
import { type Choice, type Conflict, ConflictDialog } from './ConflictDialog';
import styles from './Files.module.css';
import { downloadNotebook, outcomeText, refusalText, when, where } from './files';

interface Props {
  classId: string;
  sessionId: string;
  /** The working copy as Parallax last acknowledged it. */
  workingCopy: WorkingCopyView;
  /** The notebook as it is in the editor now, with edits not yet saved. */
  getNotebook: () => Record<string, unknown>;
  /** Live cells whose edits are not part of the stored copy and are not saved. */
  leftOut?: string[];
  /** Set when an import found a newer copy under the draft: the draft replaces nothing until the person chooses. */
  baseMoved?: { revision: number } | null;
  /** Called with every copy Parallax holds: after each acknowledged save, and with the newer copy when a save found one. */
  onWorkingCopy: (copy: WorkingCopyView) => void;
  /** Absolute workspace and host from the files listing: the destination of Save to computer. */
  workspace?: string;
  /** The workspace listing has not answered yet. */
  workspacePending?: boolean;
  host: string | null;
  /** Where Save to computer writes by default (relative to the workspace). */
  defaultPath?: string;
}

type SaveState =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; revision: number; savedAt: string }
  | { kind: 'failed'; message: string }
  | { kind: 'stale' };

/**
 * The two kinds of save, kept apart (§10.5): **Saved to Parallax** is the working copy stored by
 * the server, and only the server's answer sets it; **Save to computer** writes an `.ipynb` into
 * the workspace and names the exact destination. Kernel memory is saved by neither. A failed
 * save keeps the draft in the page and offers Retry and a download.
 */
export function SaveControls({
  classId,
  sessionId,
  workingCopy,
  getNotebook,
  leftOut = [],
  baseMoved = null,
  onWorkingCopy,
  workspace,
  workspacePending = false,
  host,
  defaultPath = 'notebook.ipynb',
}: Props) {
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [path, setPath] = useState(defaultPath);
  const [pathProblem, setPathProblem] = useState<string | null>(null);
  const [result, setResult] = useState<{ transfer: TransferView } | { error: string } | null>(null);
  const [conflict, setConflict] = useState<Conflict[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function saveToParallax(base: number) {
    setSave({ kind: 'saving' });
    try {
      const copy = await call(saveWorkingCopy, {
        params: { classId, workingCopyId: workingCopy.id },
        body: { baseRevision: base, notebook: getNotebook() },
      });
      onWorkingCopy(copy);
      setSave({ kind: 'saved', revision: copy.currentRevision, savedAt: copy.revision.savedAt });
    } catch (err) {
      const body =
        err instanceof ApiError ? (err.body as { error?: string; current?: unknown }) : null;
      if (err instanceof ApiError && err.status === 409 && body?.error === 'revision_conflict') {
        setSave({ kind: 'stale' });
        onWorkingCopy(body.current as WorkingCopyView);
      } else if (err instanceof ApiError && err.status === 413) {
        setSave({ kind: 'failed', message: 'The notebook is too large to store.' });
      } else if (err instanceof ApiError && err.status === 400) {
        setSave({ kind: 'failed', message: 'The notebook is not a valid Jupyter notebook.' });
      } else {
        setSave({ kind: 'failed', message: refusalText(err, 'The server did not answer.') });
      }
    }
  }

  async function saveToComputer(choice?: Choice) {
    if (workspace === undefined) return;
    if (!/\.ipynb$/i.test(path) || path.split('/').some((s) => s === '' || s.startsWith('.'))) {
      setPathProblem('Use a relative file name ending in .ipynb, without hidden or empty parts');
      return;
    }
    setPathProblem(null);
    setBusy(true);
    setResult(null);
    try {
      const { transfers } = await call(createTransfer, {
        params: { classId, sessionId },
        body: {
          kind: 'save',
          revision: workingCopy.currentRevision,
          path,
          ...(choice && { choice }),
        },
      });
      const transfer = transfers[0];
      if (!transfer) setResult({ error: 'The computer did not acknowledge the file.' });
      else if (transfer.state === 'conflict') {
        setConflict([
          {
            path: transfer.path,
            remoteSize: transfer.remote?.size ?? null,
            localSize: transfer.size,
          },
        ]);
      } else setResult({ transfer });
    } catch (err) {
      setResult({ error: refusalText(err, 'The notebook was not written to the computer.') });
    } finally {
      setBusy(false);
    }
  }

  // The panel re-renders with every message of a running notebook; compare only when an input moved.
  const storedJson = useMemo(() => JSON.stringify(workingCopy.notebook), [workingCopy.notebook]);
  const unsaved = useMemo(
    () => JSON.stringify(getNotebook()) !== storedJson,
    [getNotebook, storedJson],
  );

  // A newer copy found by an import puts the save in the same state as a stale save.
  useEffect(() => {
    if (baseMoved) setSave({ kind: 'stale' });
  }, [baseMoved]);
  const stale = save.kind === 'stale';

  return (
    <section className={styles.panel} aria-labelledby="save-heading">
      <h3 id="save-heading">Save</h3>

      <div className={styles.row}>
        <h4>Your copy in Parallax</h4>
        <p>
          Latest revision stored: {workingCopy.revision.revision},{' '}
          {when(workingCopy.revision.savedAt)}.
          {unsaved ? ' The editor has changes that are not saved yet.' : ''} Kernel memory is never
          saved.
        </p>
        {leftOut.length > 0 ? (
          <p role="status">
            Edits to {leftOut.length === 1 ? 'a cell' : `${leftOut.length} cells`} are not saved:
            the stored copy holds another kind of cell under{' '}
            {leftOut.length === 1 ? 'its' : 'their'} id. Copy the code from the editor before you
            leave this page.
          </p>
        ) : null}
        {stale ? null : (
          <button
            type="button"
            className={buttons.tool}
            disabled={save.kind === 'saving'}
            onClick={() => void saveToParallax(workingCopy.currentRevision)}
          >
            {save.kind === 'saving' ? 'Saving' : 'Save to Parallax'}
          </button>
        )}
        {save.kind === 'saved' ? (
          <p role="status">
            Saved to Parallax as revision {save.revision} · {when(save.savedAt)}
          </p>
        ) : null}
        {save.kind === 'failed' ? (
          <div role="alert">
            <p>Not saved to Parallax. {save.message} Your draft is still in this page.</p>
            <button
              type="button"
              className={buttons.tool}
              onClick={() => void saveToParallax(workingCopy.currentRevision)}
            >
              Retry
            </button>{' '}
            <button
              type="button"
              className={buttons.tool}
              onClick={() => downloadNotebook(getNotebook(), 'notebook.ipynb')}
            >
              Download .ipynb
            </button>
          </div>
        ) : null}
        {stale ? (
          <div role="alert">
            <p>
              Parallax now holds revision {workingCopy.currentRevision} from another save or import;
              your draft is still in this page and nothing was overwritten.
            </p>
            <button
              type="button"
              className={buttons.tool}
              onClick={() => void saveToParallax(workingCopy.currentRevision)}
            >
              Save my draft as revision {workingCopy.currentRevision + 1}
            </button>{' '}
            <button
              type="button"
              className={buttons.tool}
              onClick={() => downloadNotebook(getNotebook(), 'notebook.ipynb')}
            >
              Download .ipynb
            </button>
          </div>
        ) : null}
      </div>

      {workspace === undefined ? (
        <div className={styles.row}>
          <h4>Save to computer</h4>
          <p role="status">
            {workspacePending
              ? 'Reading the workspace on the computer. Saving to Parallax does not wait for it.'
              : 'The workspace on the computer could not be read, so saving to the computer is unavailable. Saving to Parallax is not affected.'}
          </p>
        </div>
      ) : (
        <div className={styles.row}>
          <h4>Save to computer</h4>
          <p>
            Writes revision {workingCopy.currentRevision} (the last one saved to Parallax) as an{' '}
            <code>.ipynb</code> file in <code>{workspace}</code> on {where(host)}.
          </p>
          <label className={styles.label} htmlFor="save-path">
            File name in the workspace
          </label>
          <input
            id="save-path"
            className={styles.input}
            value={path}
            onChange={(e) => setPath(e.target.value)}
            aria-invalid={pathProblem ? true : undefined}
          />
          {pathProblem ? <p role="alert">{pathProblem}</p> : null}
          <button
            type="button"
            className={buttons.tool}
            disabled={busy}
            onClick={() => void saveToComputer()}
          >
            {busy ? 'Writing' : 'Save to computer'}
          </button>
          {result && 'transfer' in result ? (
            result.transfer.state === 'done' ? (
              <p role="status">
                {result.transfer.outcome === 'kept_theirs' ||
                result.transfer.outcome === 'unchanged'
                  ? outcomeText(result.transfer, host)
                  : `Saved to ${where(host)}: ${result.transfer.path} in ${workspace}`}
              </p>
            ) : (
              <p role="alert">Not saved to computer. {outcomeText(result.transfer, host)}.</p>
            )
          ) : null}
          {result && 'error' in result ? (
            <p role="alert">Not saved to computer. {result.error}</p>
          ) : null}
        </div>
      )}

      {conflict && workspace !== undefined ? (
        <ConflictDialog
          conflicts={conflict}
          host={host}
          workspace={workspace}
          onCancel={() => {
            setConflict(null);
            setResult({ error: 'The existing file was left as it is.' });
          }}
          onResolve={(choices) => {
            setConflict(null);
            const choice = choices[0]?.choice;
            if (choice) void saveToComputer(choice);
          }}
        />
      ) : null}
    </section>
  );
}
