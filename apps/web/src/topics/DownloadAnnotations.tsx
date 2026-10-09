import { exportAnnotations } from '@parallax/contracts/routes/lifecycle';
import { useState } from 'react';
import { call } from '../api/client';
import { downloadText } from '../api/downloadText';
import buttons from '../components/Buttons.module.css';
import page from '../components/Page.module.css';
import { RetryNotice } from '../components/RetryNotice';

type State =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; annotations: number; posts: number }
  | { kind: 'error' };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The person's own annotations and posts in this class (§8, §12), downloaded as JSON. "Downloaded"
 * is never claimed: the page says only what is known, that the server answered and the file was handed to the browser.
 */
export function DownloadAnnotations({ classId, cohort }: { classId: string; cohort: string }) {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const start = async () => {
    setState({ kind: 'sending' });
    try {
      const data = await call(exportAnnotations, { params: { classId } });
      downloadText(
        JSON.stringify(data, null, 2),
        `annotations-${classId}.json`,
        'application/json',
      );
      setState({ kind: 'done', annotations: data.annotations.length, posts: data.posts.length });
    } catch {
      setState({ kind: 'error' });
    }
  };
  return (
    <section aria-label="Your annotations">
      <div className={page.row}>
        <button
          type="button"
          className={buttons.outline}
          disabled={state.kind === 'sending'}
          onClick={() => void start()}
        >
          Download my annotations
        </button>
        <span className={`${page.small} ${page.muted}`}>
          Your notes, highlights, sketches and posts in {cohort}.
        </span>
      </div>
      <p className={page.small} aria-live="polite">
        {state.kind === 'sending' ? 'Preparing your annotations…' : null}
        {state.kind === 'done'
          ? `Your file with ${plural(state.annotations, 'annotation', 'annotations')} and ${plural(state.posts, 'post', 'posts')} was handed to the browser.`
          : null}
      </p>
      {state.kind === 'error' ? (
        <RetryNotice
          message="Your annotations could not be downloaded."
          onRetry={() => void start()}
        />
      ) : null}
    </section>
  );
}
