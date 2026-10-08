import { useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import composer from '../../components/DiscussionComposer.module.css';
import type { MarginActions, Thread, ThreadAction } from './data';
import styles from './Margin.module.css';

type Post = Thread['posts'][number];

/** One open form under a post: editing it, or replying to it. Only one at a time per thread. */
type Form = { kind: 'edit' | 'moderate'; postId: string } | { kind: 'reply'; parentId?: string };

const removedText = (p: Post) =>
  p.moderated ? 'An instructor removed this post.' : 'The author deleted this post.';

/**
 * The posts of one thread with their actions (§8): reply, edit (marked "edited"), delete (a
 * post that replies depend on stays as a tombstone), instructor moderation with a reason,
 * Resolve / Reopen. Each action shows the server's answer; nothing is claimed before it.
 */
export function ThreadPosts({
  thread,
  userId,
  actions,
}: {
  thread: Thread;
  userId: string | null;
  actions: MarginActions;
}) {
  const [form, setForm] = useState<Form | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (action: ThreadAction, done?: () => void) => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await actions.thread(action);
    setBusy(false);
    if (result.ok) done?.();
    else setProblem(result.message);
  };
  const close = () => {
    setForm(null);
    setText('');
  };
  const open = (next: Form, initial = '') => {
    setForm(next);
    setText(initial);
    setProblem(null);
  };

  const submit = () => {
    if (!form || text.trim() === '') return;
    if (form.kind === 'reply') {
      void run({ kind: 'reply', threadId: thread.id, body: text, parentId: form.parentId }, close);
    } else if (form.kind === 'edit') {
      void run({ kind: 'edit', postId: form.postId, body: text }, close);
    } else {
      void run({ kind: 'moderate', postId: form.postId, reason: text }, close);
    }
  };

  return (
    <div>
      {thread.posts.map((p) => {
        const removed = p.body === null;
        const mine = p.author.id === userId;
        const here = form && 'postId' in form && form.postId === p.id ? form : null;
        return (
          <div key={p.id} data-post={p.id} className={p.parentId ? styles.reply : undefined}>
            <p className={removed ? styles.muted : undefined}>
              {removed ? removedText(p) : p.body}
            </p>
            <p className={styles.small}>
              {mine ? 'You' : p.author.name}
              {p.authorRole === 'instructor' ? ' · Instructor' : ''}
              {p.edited && !removed ? ' · Edited' : ''}
            </p>
            {!removed ? (
              <div className={styles.postActions}>
                {thread.can.reply ? (
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => open({ kind: 'reply', parentId: p.id })}
                  >
                    Reply
                  </button>
                ) : null}
                {p.can.edit ? (
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => open({ kind: 'edit', postId: p.id }, p.body ?? '')}
                  >
                    Edit
                  </button>
                ) : null}
                {p.can.delete ? (
                  <button
                    type="button"
                    className={styles.link}
                    disabled={busy}
                    onClick={() => void run({ kind: 'delete', postId: p.id })}
                  >
                    Delete
                  </button>
                ) : null}
                {p.can.moderate ? (
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => open({ kind: 'moderate', postId: p.id })}
                  >
                    Remove as instructor
                  </button>
                ) : null}
              </div>
            ) : null}
            {here ? (
              <Form
                label={here.kind === 'edit' ? 'Edit post' : 'Reason for removing this post'}
                action={here.kind === 'edit' ? 'Save edit' : 'Remove post'}
                text={text}
                busy={busy}
                onText={setText}
                onSubmit={submit}
                onCancel={close}
              />
            ) : null}
            {form?.kind === 'reply' && form.parentId === p.id ? (
              <Form
                label={`Reply to ${mine ? 'your post' : p.author.name}`}
                action="Post reply"
                text={text}
                busy={busy}
                onText={setText}
                onSubmit={submit}
                onCancel={close}
              />
            ) : null}
          </div>
        );
      })}
      {thread.can.reply && thread.posts.every((p) => p.body === null) ? (
        // Every post is removed, so there is nothing to answer: reply to the thread itself.
        <div className={styles.postActions}>
          <button type="button" className={styles.link} onClick={() => open({ kind: 'reply' })}>
            Reply to this discussion
          </button>
        </div>
      ) : null}
      {form?.kind === 'reply' && form.parentId === undefined ? (
        <Form
          label="Reply to this discussion"
          action="Post reply"
          text={text}
          busy={busy}
          onText={setText}
          onSubmit={submit}
          onCancel={close}
        />
      ) : null}
      <div className={styles.postActions}>
        {thread.can.resolve ? (
          <button
            type="button"
            className={buttons.outline}
            disabled={busy}
            onClick={() => void run({ kind: 'status', threadId: thread.id, status: 'resolved' })}
          >
            Mark resolved
          </button>
        ) : null}
        {thread.can.reopen ? (
          <button
            type="button"
            className={buttons.outline}
            disabled={busy}
            onClick={() => void run({ kind: 'status', threadId: thread.id, status: 'open' })}
          >
            Reopen
          </button>
        ) : null}
      </div>
      <div className={styles.saveLine} role="status">
        {problem}
      </div>
    </div>
  );
}

function Form({
  label,
  action,
  text,
  busy,
  onText,
  onSubmit,
  onCancel,
}: {
  label: string;
  action: string;
  text: string;
  busy: boolean;
  onText: (t: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <div className={composer.composer}>
      <label className={styles.field}>
        {label}
        <textarea rows={3} value={text} onChange={(e) => onText(e.target.value)} />
      </label>
      <div className={styles.postActions}>
        <button
          type="button"
          className={buttons.outline}
          disabled={text.trim() === '' || busy}
          onClick={onSubmit}
        >
          {action}
        </button>
        <button type="button" className={styles.link} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
