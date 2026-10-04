import { createResource } from '@parallax/contracts/routes/drafts';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { call } from '../api/client';
import styles from '../components/Page.module.css';
import local from './Authoring.module.css';
import { failureMessage, fileProblem, NOTEBOOK_ACCEPT, uploadFile } from './upload';

interface Props {
  courseId: string;
  topicId: string;
  onAdded: () => void;
  onCancel: () => void;
}

/**
 * Adds a rendered notebook to a topic from an `.ipynb` file (§10.1, §10.7). The server checks
 * the file against nbformat 4 before keeping it, and imports it without running any cell.
 */
export function AddNotebook({ courseId, topicId, onAdded, onCancel }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('no file');
      const stored = await uploadFile(courseId, file);
      return call(createResource, {
        params: { courseId, topicId },
        body: {
          type: 'notebook',
          title: title.trim() || stored.filename.replace(/\.ipynb$/i, ''),
          content: { sourceKey: stored.key },
          objectKeys: [stored.key],
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

  return (
    <form
      className={styles.feedback}
      aria-label="Add notebook"
      onSubmit={(e) => {
        e.preventDefault();
        if (file && !problem) add.mutate();
      }}
    >
      <h3 className={styles.subheading}>Add notebook</h3>
      <label className={local.field}>
        File (Jupyter notebook)
        <input
          type="file"
          accept={NOTEBOOK_ACCEPT}
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
      </label>
      {problem ? (
        <p className={`${styles.small} ${local.failure}`} role="alert" style={{ marginTop: 8 }}>
          {problem}
        </p>
      ) : null}
      <label className={local.field}>
        Title
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className={styles.row} style={{ marginTop: 20 }}>
        <button
          type="submit"
          className={styles.primary}
          disabled={!file || problem !== null || add.isPending}
        >
          {add.isPending ? 'Uploading…' : 'Add notebook'}
        </button>
        <button type="button" className={styles.textButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {add.isError ? (
        <p className={`${styles.small} ${local.failure}`} role="alert" style={{ marginTop: 12 }}>
          The notebook was not added. {failureMessage(add.error)}
        </p>
      ) : null}
    </form>
  );
}
