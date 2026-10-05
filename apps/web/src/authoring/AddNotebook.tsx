import { createResource } from '@parallax/contracts/routes/drafts';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { ApiError, call } from '../api/client';
import buttons from '../components/Buttons.module.css';
import styles from '../components/Page.module.css';
import local from './Authoring.module.css';
import { failureMessage, fileProblem, NOTEBOOK_ACCEPT, uploadFile } from './upload';
import {
  declareFiles,
  MAX_WORKSPACE_FILES,
  pathProblems,
  type UploadedWorkspaceFile,
  uploadWorkspaceData,
  type WorkspaceEntry,
} from './workspaceFiles';

interface Props {
  courseId: string;
  topicId: string;
  onAdded: () => void;
  onCancel: () => void;
}

/**
 * Adds a rendered notebook to a topic from an `.ipynb` file (§10.1, §10.7). The server checks
 * the file against nbformat 4 before keeping it, and imports it without running any cell. Data
 * files added here are released with the notebook and declared in its metadata
 * (`metadata.parallax.files`) so that a learner's workspace receives them (§10.5).
 */
export function AddNotebook({ courseId, topicId, onAdded, onCancel }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [fileKey, setFileKey] = useState(0);
  const nextId = useId();
  const problems = pathProblems(entries);
  const tooMany = entries.length > MAX_WORKSPACE_FILES;

  const add = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('no file');
      const data: UploadedWorkspaceFile[] = [];
      for (const entry of entries) data.push(await uploadWorkspaceData(courseId, entry.file));
      const declared = entries.map((entry, i) => ({
        path: entry.path,
        resourceId: data[i]?.id ?? '',
      }));
      // The declaration is written into the notebook that is kept, so the stored file is the
      // single place that names the files (the copy-in reads it from there).
      const source =
        entries.length === 0
          ? file
          : new File([declareFiles(await file.text(), declared)], file.name, {
              type: file.type,
            });
      const stored = await uploadFile(courseId, source);
      return call(createResource, {
        params: { courseId, topicId },
        body: {
          type: 'notebook',
          title: title.trim() || stored.filename.replace(/\.ipynb$/i, ''),
          content: {
            sourceKey: stored.key,
            // What the draft view lists; the notebook's own metadata stays the declaration.
            ...(entries.length > 0 && {
              workspaceFiles: entries.map((entry, i) => ({
                path: entry.path,
                resourceId: data[i]?.id ?? '',
                size: data[i]?.size ?? 0,
              })),
            }),
          },
          objectKeys: [stored.key, ...data.map((d) => d.key)],
        },
      });
    },
    onSuccess: onAdded,
  });

  const pick = (picked: File | null) => {
    setFile(picked);
    setProblem(picked ? (fileProblem(picked, 'notebook') ?? null) : null);
    if (picked && !title) setTitle(picked.name.replace(/\.[^.]+$/, ''));
  };

  const addData = (picked: FileList | null) => {
    if (!picked) return;
    setEntries((current) => [
      ...current,
      ...[...picked].map((f, i) => ({
        id: `${nextId}-${current.length + i}-${f.name}`,
        file: f,
        path: f.name,
      })),
    ]);
    // Clearing the input lets the same file be chosen again after it is removed.
    setFileKey((k) => k + 1);
  };

  return (
    <form
      className={styles.feedback}
      aria-label="Add notebook"
      onSubmit={(e) => {
        e.preventDefault();
        if (file && !problem && problems.size === 0 && !tooMany) add.mutate();
      }}
    >
      <h4 className={styles.subheading}>Add notebook</h4>
      <label className={local.field}>
        File (Jupyter notebook)
        <input
          type="file"
          accept={NOTEBOOK_ACCEPT}
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
      </label>
      {problem ? (
        <p className={`${styles.small} ${local.failure} ${styles.mt8}`} role="alert">
          {problem}
        </p>
      ) : null}
      <label className={local.field}>
        Title
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <fieldset className={local.field}>
        <legend>Workspace files</legend>
        <p className={`${styles.small} ${styles.muted}`}>
          Data files copied into a learner’s workspace on their computer. Each path is relative to
          the workspace.
        </p>
        <label className={local.field}>
          Add data files
          <input key={fileKey} type="file" multiple onChange={(e) => addData(e.target.files)} />
        </label>
        {entries.length === 0 ? (
          <p className={`${styles.small} ${styles.muted}`}>No workspace files.</p>
        ) : (
          <ul aria-label="Workspace files">
            {entries.map((entry) => {
              const why = problems.get(entry.id);
              const errorId = `${entry.id}-error`;
              return (
                <li key={entry.id} className={styles.mt8}>
                  <label className={local.field}>
                    {`Workspace path of ${entry.file.name}`}
                    <input
                      type="text"
                      value={entry.path}
                      aria-invalid={why ? true : undefined}
                      aria-describedby={why ? errorId : undefined}
                      onChange={(e) =>
                        setEntries((current) =>
                          current.map((o) =>
                            o.id === entry.id ? { ...o, path: e.target.value } : o,
                          ),
                        )
                      }
                    />
                  </label>
                  {why ? (
                    <p id={errorId} className={`${styles.small} ${local.failure}`} role="alert">
                      {why}
                    </p>
                  ) : null}
                  <button
                    type="button"
                    className={buttons.textButton}
                    onClick={() =>
                      setEntries((current) => current.filter((o) => o.id !== entry.id))
                    }
                  >
                    {`Remove ${entry.file.name}`}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {tooMany ? (
          <p className={`${styles.small} ${local.failure}`} role="alert">
            A notebook declares at most {MAX_WORKSPACE_FILES} files.
          </p>
        ) : null}
      </fieldset>
      <div className={`${styles.row} ${styles.mt20}`}>
        <button
          type="submit"
          className={buttons.primary}
          disabled={!file || problem !== null || problems.size > 0 || tooMany || add.isPending}
        >
          {add.isPending ? 'Uploading…' : 'Add notebook'}
        </button>
        <button type="button" className={buttons.textButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {add.isError ? (
        <p className={`${styles.small} ${local.failure} ${styles.mt12}`} role="alert">
          The notebook was not added.{' '}
          {add.error instanceof Error && !(add.error instanceof ApiError)
            ? add.error.message
            : failureMessage(add.error)}
        </p>
      ) : null}
    </form>
  );
}
