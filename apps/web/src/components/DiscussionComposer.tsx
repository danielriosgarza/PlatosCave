import type { ReactNode } from 'react';
import buttons from './Buttons.module.css';
import styles from './DiscussionComposer.module.css';

export type Audience = 'instructor' | 'class';

/**
 * What the last attempt to post said; the text is kept either way. `open`: the server refused it
 * because the class is open (§13, N10), which no retry changes.
 */
export type PostProblem = 'offline' | 'failed' | 'open' | null;

/** Shown where the composer would be in an open class, where nobody posts (§13, N10). */
export const POSTING_OFF = 'Questions and comments are off in this open class.';

interface DiscussionComposerProps {
  /** An open class (§13, N10): what is said instead of the composer. */
  off?: boolean;
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
  off = false,
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
  if (off) return <p className={`${styles.composer} ${styles.status}`}>{POSTING_OFF}</p>;
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
            : problem === 'open'
              ? `${POSTING_OFF} Your text is kept on this device.`
              : null}
      </div>
      <button
        type="button"
        className={buttons.outline}
        disabled={body.trim() === '' || posting || problem === 'open'}
        onClick={onPost}
      >
        {problem && problem !== 'open' ? 'Retry' : 'Post'}
      </button>
    </div>
  );
}
