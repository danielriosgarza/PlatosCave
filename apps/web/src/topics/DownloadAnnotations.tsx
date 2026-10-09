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

/**
 * A file name made of the course title and class name, with the characters that are unsafe in
 * file names removed (as for the results CSV), or the class UUID when nothing usable is left.
 */
export function annotationsFileName(data: {
  course: { title: string };
  class: { id: string; name: string };
}): string {
  const clean = (text: string) => text.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').trim();
  const name = [clean(data.course.title), clean(data.class.name)].filter(Boolean).join(' - ');
  // Keep well under common file system limits (255 bytes), cutting on a character boundary.
  let base = '';
  for (const char of name) {
    if (new TextEncoder().encode(base + char).length > 120) break;
    base += char;
  }
  return `annotations-${base.trim() || data.class.id}.json`;
}

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
      downloadText(JSON.stringify(data, null, 2), annotationsFileName(data), 'application/json');
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
