import {
  createResource,
  type draftResource,
  getResource,
  updateResource,
} from '@parallax/contracts/routes/drafts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { z } from 'zod';
import { call } from '../api/client';
import styles from '../components/Page.module.css';
import local from './Authoring.module.css';
import { useAutosave } from './autosave';
import { ConflictView } from './ConflictView';
import { authoringKey } from './queries';
import { SaveStatus } from './SaveStatus';
import { failureMessage } from './upload';

type Full = z.output<typeof draftResource>;

const FORMAT_HINT =
  'Markdown. A line holding only --- (or *** or ___) starts the next slide. Images are not shown; describe diagrams in text.';

interface AddProps {
  courseId: string;
  topicId: string;
  onAdded: () => void;
  onCancel: () => void;
}

/** Adds a web deck to a topic from Markdown typed into a textarea (§7, §12). */
export function AddWebSlides({ courseId, topicId, onAdded, onCancel }: AddProps) {
  const [title, setTitle] = useState('');
  const [markdown, setMarkdown] = useState('');
  const add = useMutation({
    mutationFn: () =>
      call(createResource, {
        params: { courseId, topicId },
        body: { type: 'slides_web', title: title.trim(), content: { markdown } },
      }),
    onSuccess: onAdded,
  });
  const ready = title.trim() !== '' && markdown.trim() !== '';
  return (
    <form
      className={styles.feedback}
      aria-label="Add web slides"
      onSubmit={(e) => {
        e.preventDefault();
        if (ready) add.mutate();
      }}
    >
      <h4 style={{ fontSize: 16 }}>Add web slides</h4>
      <label className={local.field}>
        Title
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className={local.field}>
        <label htmlFor="add-web-slides-markdown">Slides (Markdown)</label>
        <textarea
          id="add-web-slides-markdown"
          aria-describedby="add-web-slides-hint"
          rows={14}
          spellCheck
          value={markdown}
          onChange={(e) => setMarkdown(e.target.value)}
        />
        <span id="add-web-slides-hint" className={local.hint}>
          {FORMAT_HINT}
        </span>
      </div>
      <div className={styles.row} style={{ marginTop: 20 }}>
        <button type="submit" className={styles.primary} disabled={!ready || add.isPending}>
          {add.isPending ? 'Adding…' : 'Add web slides'}
        </button>
        <button type="button" className={styles.textButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
      {add.isError ? (
        <p className={`${styles.small} ${local.failure}`} role="alert" style={{ marginTop: 12 }}>
          The slides were not added. {failureMessage(add.error)}
        </p>
      ) : null}
    </form>
  );
}

interface Values {
  title: string;
  visibility: 'visible' | 'hidden';
  markdown: string;
  archived: boolean;
}

const markdownOf = (r: Full): string => {
  const markdown = r.head?.content.markdown;
  return typeof markdown === 'string' ? markdown : '';
};

const toValues = (r: Full): Values => ({
  title: r.title,
  visibility: r.visibility,
  markdown: markdownOf(r),
  archived: r.archived,
});

/** The Markdown and settings of one web deck, saved as the editor types (§12). */
export function WebSlidesEditor({
  courseId,
  resourceId,
  onSaved,
}: {
  courseId: string;
  resourceId: string;
  onSaved: () => void;
}) {
  const loaded = useQuery({
    queryKey: [...authoringKey(courseId), 'resource', resourceId],
    queryFn: () => call(getResource, { params: { courseId, resourceId } }),
    gcTime: 0,
  });
  if (loaded.isError) {
    return (
      <p role="alert" className={styles.small}>
        These slides could not be loaded.
      </p>
    );
  }
  if (!loaded.data) return <p className={`${styles.small} ${styles.muted}`}>Loading…</p>;
  return <WebSlidesFields courseId={courseId} server={loaded.data} onSaved={onSaved} />;
}

function WebSlidesFields({
  courseId,
  server,
  onSaved,
}: {
  courseId: string;
  server: Full;
  onSaved: () => void;
}) {
  const { values, change, state, retry, takeTheirs, keepMine } = useAutosave({
    server,
    toValues,
    delayMs: 1500,
    save: (v, expectedRevision) =>
      call(updateResource, {
        params: { courseId, resourceId: server.id },
        body: {
          expectedRevision,
          title: v.title.trim() || server.title,
          visibility: v.visibility,
          archived: v.archived,
          // Always sent: the server keeps the head when the content is unchanged, and after a
          // conflict the copy this form started from is stale, so no comparison here is safe.
          content: { markdown: v.markdown },
        },
      }),
    onSaved,
  });
  const rows = (theirs: Full) => {
    const t = toValues(theirs);
    return (
      [
        ['Title', values.title, t.title],
        ['Visibility', values.visibility, t.visibility],
        ['Slides', values.markdown, t.markdown],
      ] as const
    )
      .filter(([, a, b]) => a !== b)
      .map(([label, mine, other]) => ({ label, mine, theirs: other }));
  };
  const textarea = `slides-markdown-${server.id}`;
  return (
    <div>
      <SaveStatus state={state} onRetry={retry} />
      {state.kind === 'conflict' ? (
        <ConflictView
          what="deck"
          rows={rows(state.current)}
          onKeepMine={() => keepMine(state.current)}
          onUseTheirs={() => takeTheirs(state.current)}
        />
      ) : null}
      <label className={local.field}>
        Slides title
        <input
          type="text"
          value={values.title}
          onChange={(e) => change({ title: e.target.value })}
        />
      </label>
      <label className={local.field}>
        Visibility
        <select
          value={values.visibility}
          onChange={(e) => change({ visibility: e.target.value as 'visible' | 'hidden' })}
        >
          <option value="visible">Visible to students</option>
          <option value="hidden">Hidden from students</option>
        </select>
      </label>
      <div className={local.field}>
        <label htmlFor={textarea}>Slides (Markdown)</label>
        <textarea
          id={textarea}
          aria-describedby={`${textarea}-hint`}
          rows={14}
          spellCheck
          value={values.markdown}
          onChange={(e) => change({ markdown: e.target.value })}
        />
        <span id={`${textarea}-hint`} className={local.hint}>
          {FORMAT_HINT}
        </span>
      </div>
      <div className={styles.row} style={{ marginTop: 16 }}>
        <button
          type="button"
          className={styles.textButton}
          onClick={() => change({ archived: !values.archived })}
        >
          {values.archived ? 'Restore these slides' : 'Archive these slides'}
        </button>
      </div>
    </div>
  );
}
