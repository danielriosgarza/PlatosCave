import {
  createTransfer,
  listSessionFiles,
  type TransferView,
} from '@parallax/contracts/routes/transfers';
import type { WorkingCopyView } from '@parallax/contracts/routes/workingCopies';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { ApiError, call } from '../../api/client';
import buttons from '../../components/Buttons.module.css';
import { type Conflict, ConflictDialog } from './ConflictDialog';
import styles from './Files.module.css';
import {
  MAX_COPY_OUT_FILE_BYTES,
  MAX_COPY_OUT_SESSION_BYTES,
  outcomeText,
  refusalText,
  size,
  when,
  where,
} from './files';

type Listing = z.output<typeof listSessionFiles.response>;
type Entry = Listing['entries'][number];

interface Props {
  classId: string;
  sessionId: string;
  workingCopy: WorkingCopyView;
  /** Called with the working copy an import created, so the editor can offer it. */
  onWorkingCopy: (copy: WorkingCopyView) => void;
  /** Called once the declared files are on the computer (or the person kept the existing ones). */
  onCopyInSettled?: () => void;
}

/**
 * The files of the session's workspace and nothing above it (design §11): the files the course
 * notebook declares, copied in only after the person confirms the exact destination; the
 * workspace listing; Import of a notebook edited there; and the selection of output files to
 * copy out to Parallax. Every outcome is worded from the acknowledged transfer, never from the
 * click.
 */
export function FilesPanel({
  classId,
  sessionId,
  workingCopy,
  onWorkingCopy,
  onCopyInSettled,
}: Props) {
  const queryClient = useQueryClient();
  const [dir, setDir] = useState('');
  const listing = useQuery({
    queryKey: ['files', classId, sessionId, dir],
    queryFn: () =>
      call(listSessionFiles, {
        params: { classId, sessionId },
        query: dir ? { dir } : {},
      }),
    retry: false,
  });
  const data = listing.data;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['files', classId, sessionId] });

  if (listing.isPending) return <p role="status">Reading the workspace</p>;
  if (listing.isError || !data) {
    return (
      <section className={styles.panel} aria-labelledby="files-heading">
        <h3 id="files-heading">Files</h3>
        <p role="alert">
          {refusalText(listing.error, 'The workspace could not be read.')} Nothing on the computer
          was changed.
        </p>
        <button type="button" className={buttons.tool} onClick={() => void listing.refetch()}>
          Try again
        </button>
      </section>
    );
  }

  return (
    <section className={styles.panel} aria-labelledby="files-heading">
      <h3 id="files-heading">Files</h3>
      <p>
        Workspace: <code>{data.workspace}</code> on {where(data.host)}. Only this folder is listed
        or changed; the rest of the computer is never read.
      </p>
      {data.declared.length > 0 ? (
        <CopyIn
          classId={classId}
          sessionId={sessionId}
          workspace={data.workspace}
          host={data.host}
          declared={data.declared}
          onDone={() => {
            void refresh();
            onCopyInSettled?.();
          }}
        />
      ) : null}
      <Workspace
        classId={classId}
        sessionId={sessionId}
        listing={data}
        dir={dir}
        setDir={setDir}
        workingCopy={workingCopy}
        onWorkingCopy={onWorkingCopy}
        onChanged={() => void refresh()}
      />
    </section>
  );
}

function CopyIn({
  classId,
  sessionId,
  workspace,
  host,
  declared,
  onDone,
}: {
  classId: string;
  sessionId: string;
  workspace: string;
  host: string | null;
  declared: Listing['declared'];
  onDone: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<TransferView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[] | null>(null);

  async function copy(
    resolutions: { path: string; choice: 'keep_theirs' | 'replace' | 'save_copy' }[],
  ) {
    setBusy(true);
    setError(null);
    try {
      const { transfers } = await call(createTransfer, {
        params: { classId, sessionId },
        body: { kind: 'copy_in', resolutions },
      });
      setResults(transfers);
      const waiting = transfers.filter((t) => t.state === 'conflict');
      if (waiting.length > 0) {
        setConflicts(
          waiting.map((t) => ({
            path: t.path,
            remoteSize: t.remote?.size ?? null,
            localSize: t.size,
          })),
        );
      } else if (transfers.every((t) => t.state === 'done')) {
        setOpen(false);
        onDone();
      }
    } catch (err) {
      setError(refusalText(err, 'The files were not copied.'));
    } finally {
      setBusy(false);
    }
  }

  const total = declared.reduce((sum, f) => sum + f.size, 0);
  return (
    <div className={styles.row}>
      <h4>Files for this notebook</h4>
      {open ? (
        <>
          <p>
            Copy {declared.length} {declared.length === 1 ? 'file' : 'files'} to{' '}
            <code>{workspace}</code> on {where(host)} ({size(total)}). A file that is already there
            and different is never overwritten without your choice.
          </p>
          <ul className={styles.list}>
            {declared.map((f) => (
              <li key={f.path}>
                <code>{f.path}</code> · {size(f.size)}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={buttons.tool}
            disabled={busy}
            onClick={() => void copy([])}
          >
            {busy
              ? 'Copying'
              : `Copy ${declared.length} ${declared.length === 1 ? 'file' : 'files'} to ${workspace}`}
          </button>
        </>
      ) : (
        <p role="status">
          The notebook’s files are in <code>{workspace}</code> on {where(host)}.
        </p>
      )}
      {error ? <p role="alert">{error}</p> : null}
      {results ? (
        <ul className={styles.list} aria-label="Copy results">
          {results.map((t) => (
            <li key={t.id}>
              <code>{t.path}</code> · {outcomeText(t, host)}
            </li>
          ))}
        </ul>
      ) : null}
      {conflicts ? (
        <ConflictDialog
          conflicts={conflicts}
          host={host}
          workspace={workspace}
          onCancel={() => {
            setConflicts(null);
            setError('The existing files were left as they are.');
          }}
          onResolve={(choices) => {
            setConflicts(null);
            void copy(choices);
          }}
        />
      ) : null}
    </div>
  );
}

function Workspace({
  classId,
  sessionId,
  listing,
  dir,
  setDir,
  workingCopy,
  onWorkingCopy,
  onChanged,
}: {
  classId: string;
  sessionId: string;
  listing: Listing;
  dir: string;
  setDir: (dir: string) => void;
  workingCopy: WorkingCopyView;
  onWorkingCopy: (copy: WorkingCopyView) => void;
  onChanged: () => void;
}) {
  const [selected, setSelected] = useState<Record<string, number>>({});
  const [importing, setImporting] = useState<Entry | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'status' | 'alert'; text: string } | null>(null);
  const [copied, setCopied] = useState<TransferView[]>([]);

  const chosen = Object.entries(selected);
  const chosenBytes = chosen.reduce((sum, [, bytes]) => sum + bytes, 0);
  const overSession = chosenBytes > MAX_COPY_OUT_SESSION_BYTES;

  const toggle = (path: string, bytes: number) =>
    setSelected((s) => {
      const next = { ...s };
      if (path in next) delete next[path];
      else next[path] = bytes;
      return next;
    });

  async function copyOut() {
    setBusy(true);
    setMessage(null);
    try {
      const { transfers } = await call(createTransfer, {
        params: { classId, sessionId },
        body: { kind: 'copy_out', paths: chosen.map(([path]) => path) },
      });
      setCopied((previous) => [...transfers, ...previous]);
      setSelected({});
      const done = transfers.filter((t) => t.state === 'done').length;
      setMessage({
        kind: done === transfers.length ? 'status' : 'alert',
        text: `${done} of ${transfers.length} files copied to Parallax. The others stay on ${where(listing.host)}.`,
      });
    } catch (err) {
      setMessage({ kind: 'alert', text: refusalText(err, 'The files were not copied.') });
    } finally {
      setBusy(false);
    }
  }

  async function runImport(entry: Entry) {
    setBusy(true);
    setMessage(null);
    try {
      const { workingCopy: copy } = await call(createTransfer, {
        params: { classId, sessionId },
        body: { kind: 'import', path: entry.path, baseRevision: workingCopy.currentRevision },
      });
      setImporting(null);
      if (copy) {
        onWorkingCopy(copy);
        setMessage({
          kind: 'status',
          text: `Imported ${entry.name} as revision ${copy.currentRevision} of your working copy. Earlier revisions are kept.`,
        });
      } else {
        setMessage({ kind: 'alert', text: `${entry.name} was not imported.` });
      }
      onChanged();
    } catch (err) {
      setImporting(null);
      const body = err instanceof ApiError ? (err.body as { error?: string } | null) : null;
      setMessage({
        kind: 'alert',
        text:
          body?.error === 'revision_conflict'
            ? 'Your working copy changed since you opened it. Nothing was imported; reload the copy and try again.'
            : refusalText(err, `${entry.name} was not imported.`),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.row}>
      <h4>In the workspace{dir ? `: ${dir}` : ''}</h4>
      {dir ? (
        <button
          type="button"
          className={buttons.textButton}
          onClick={() => setDir(dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '')}
        >
          Up one folder
        </button>
      ) : null}
      {listing.entries.length === 0 ? (
        <p className={styles.note}>This folder is empty.</p>
      ) : (
        <table className={styles.table}>
          <caption className={styles.srOnly}>Files in {listing.dir || listing.workspace}</caption>
          <thead>
            <tr>
              <th scope="col">
                <span className={styles.srOnly}>Copy to Parallax</span>
              </th>
              <th scope="col">Name</th>
              <th scope="col">Size</th>
              <th scope="col">Modified</th>
              <th scope="col">
                <span className={styles.srOnly}>Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {listing.entries.map((e) => {
              const tooBig = e.size !== null && e.size > MAX_COPY_OUT_FILE_BYTES;
              return (
                <tr key={e.path}>
                  <td>
                    {e.type !== 'directory' ? (
                      <input
                        type="checkbox"
                        aria-label={`Copy ${e.name} to Parallax`}
                        checked={e.path in selected}
                        disabled={tooBig || e.size === null}
                        onChange={() => toggle(e.path, e.size ?? 0)}
                      />
                    ) : null}
                  </td>
                  <td>
                    {e.type === 'directory' ? (
                      <button
                        type="button"
                        className={buttons.textButton}
                        onClick={() => setDir(e.path)}
                      >
                        {e.name}/
                      </button>
                    ) : (
                      e.name
                    )}
                  </td>
                  <td>
                    {e.size === null ? '' : size(e.size)}
                    {tooBig ? ` · over ${size(MAX_COPY_OUT_FILE_BYTES)}, cannot be copied` : ''}
                  </td>
                  <td>{e.modified ? when(e.modified) : ''}</td>
                  <td>
                    {e.type === 'notebook' ? (
                      <button
                        type="button"
                        className={buttons.textButton}
                        disabled={busy}
                        aria-label={`Import ${e.name}`}
                        onClick={() => setImporting(e)}
                      >
                        Import
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {importing ? (
        <section className={styles.confirm} aria-label={`Import ${importing.name}`}>
          <p>
            Import <code>{importing.path}</code> as revision {workingCopy.currentRevision + 1} of
            your working copy? Revision {workingCopy.currentRevision} stays in the revision list.
          </p>
          <button
            type="button"
            className={buttons.tool}
            disabled={busy}
            onClick={() => void runImport(importing)}
          >
            Import as revision {workingCopy.currentRevision + 1}
          </button>{' '}
          <button type="button" className={buttons.tool} onClick={() => setImporting(null)}>
            Cancel
          </button>
        </section>
      ) : null}

      <div className={styles.copyOut}>
        <p>
          {chosen.length === 0
            ? `Select files to copy to Parallax. Files you do not copy stay on ${where(listing.host)}.`
            : `${chosen.length} ${chosen.length === 1 ? 'file' : 'files'} selected · ${size(chosenBytes)}`}
        </p>
        {overSession ? (
          <p role="alert">
            The selection is over {size(MAX_COPY_OUT_SESSION_BYTES)}, the most one session can copy.
          </p>
        ) : null}
        <button
          type="button"
          className={buttons.tool}
          disabled={chosen.length === 0 || chosen.length > 50 || overSession || busy}
          onClick={() => void copyOut()}
        >
          {busy ? 'Copying' : 'Copy selected files to Parallax'}
        </button>
      </div>
      {message ? <p role={message.kind}>{message.text}</p> : null}
      {copied.length > 0 ? (
        <ul className={styles.list} aria-label="Files copied to Parallax">
          {copied.map((t) => (
            <li key={t.id}>
              <code>{t.path}</code> · {size(t.size)} · {outcomeText(t, listing.host)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
