import { createResource } from '@parallax/contracts/routes/drafts';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { call } from '../api/client';
import styles from '../components/Page.module.css';
import local from './Authoring.module.css';
import { ACCEPT, failureMessage, fileProblem, uploadReadingFile } from './upload';

interface Props {
  courseId: string;
  topicId: string;
  onAdded: () => void;
  onCancel: () => void;
}

/** Adds a reading to a topic from a Markdown, HTML or PDF file (§8, §12). */
export function AddReading({ courseId, topicId, onAdded, onCancel }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [alternative, setAlternative] = useState('');
  const [problem, setProblem] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('no file');
      const stored = await uploadReadingFile(courseId, file);
      const pdf = stored.format === 'pdf';
      return call(createResource, {
        params: { courseId, topicId },
        body: {
          type: pdf ? 'reading_pdf' : 'reading_native',
          title: title.trim() || stored.filename,
          content: pdf
            ? { objectKey: stored.key }
            : { sourceKey: stored.key, format: stored.format },
          objectKeys: [stored.key],
          ...(alternative.trim() && { accessibleAlternative: { text: alternative.trim() } }),
        },
      });
    },
    onSuccess: onAdded,
  });

  const pick = (picked: File | null) => {
    setFile(picked);
    setProblem(picked ? (fileProblem(picked) ?? null) : null);
    if (picked && !title) setTitle(picked.name.replace(/\.[^.]+$/, ''));
  };

  return (
    <form
      className={styles.feedback}
      aria-label="Add reading"
      onSubmit={(e) => {
        e.preventDefault();
        if (file && !problem) add.mutate();
      }}
    >
      <h4 style={{ fontSize: 16 }}>Add reading</h4>
      <label className={local.field}>
        File (Markdown, HTML or PDF)
        <input type="file" accept={ACCEPT} onChange={(e) => pick(e.target.files?.[0] ?? null)} />
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
      <div className={local.field}>
        <label htmlFor="add-reading-alternative">Accessible alternative</label>
        <textarea
          id="add-reading-alternative"
          aria-describedby="add-reading-alternative-hint"
          value={alternative}
          onChange={(e) => setAlternative(e.target.value)}
        />
        <span id="add-reading-alternative-hint" className={local.hint}>
          Text for readers who cannot use the file as it is, for example a PDF of scanned pages.
        </span>
      </div>
      <div className={styles.row} style={{ marginTop: 20 }}>
        <button
          type="submit"
          className={styles.primary}
          disabled={!file || problem !== null || add.isPending}
        >
          {add.isPending ? 'Uploading…' : 'Add reading'}
        </button>
        <button type="button" className={styles.textButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {add.isError ? (
        <p className={`${styles.small} ${local.failure}`} role="alert" style={{ marginTop: 12 }}>
          The reading was not added. {failureMessage(add.error)}
        </p>
      ) : null}
    </form>
  );
}
