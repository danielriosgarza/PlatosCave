import type { ReactNode } from 'react';
import buttons from './Buttons.module.css';
import styles from './DiscussionComposer.module.css';

export type Audience = 'instructor' | 'class';

/** What the last attempt to post said; the text is kept either way. */
export type PostProblem = 'offline' | 'failed' | null;

interface DiscussionComposerProps {
  audience: Audience;
  onAudience: (audience: Audience) => void;
  body: string;
  onBody: (body: string) => void;
  problem: PostProblem;
  posting: boolean;
  onPost: () => void;
  textareaId: string;
  placeholder: string;
  /** What the question is about (a quoted passage), shown above the text. */
  context?: ReactNode;
}

/** Visible-to choice, question text, post status and Post/Retry, shared by reading and slides. */
export function DiscussionComposer({
  audience,
  onAudience,
  body,
  onBody,
  problem,
  posting,
  onPost,
  textareaId,
  placeholder,
  context,
}: DiscussionComposerProps) {
  return (
    <div className={styles.composer}>
      <label className={styles.field}>
        Visible to
        <select value={audience} onChange={(e) => onAudience(e.target.value as Audience)}>
          <option value="instructor">Instructor</option>
          <option value="class">Class</option>
        </select>
      </label>
      {context}
      <label className={styles.field}>
        Comment or question
        <textarea
          id={textareaId}
          rows={3}
          placeholder={placeholder}
          value={body}
          onChange={(e) => onBody(e.target.value)}
        />
      </label>
      <div className={styles.status} role="status">
        {problem === 'offline'
          ? 'Offline · your text is kept on this device. Post when you are back online.'
          : problem === 'failed'
            ? 'Could not post. Your text is kept.'
            : null}
      </div>
      <button
        type="button"
        className={buttons.outline}
        disabled={body.trim() === '' || posting}
        onClick={onPost}
      >
        {problem ? 'Retry' : 'Post'}
      </button>
    </div>
  );
}
