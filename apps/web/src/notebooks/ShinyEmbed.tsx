import { useEffect, useRef, useState } from 'react';
import buttons from '../components/Buttons.module.css';
import styles from './Shiny.module.css';
import { readShinyMessage } from './shinyMessages';

/** Without a `ready` message in this time the frame is treated as blocked or unresponsive. */
export const BLOCKED_AFTER_MS = 10_000;

interface Props {
  title: string;
  /** The approved address; null when the host has not approved its origin. */
  url: string | null;
  origin: string | null;
  /** Overridable so tests need not wait out the real delay. */
  blockedAfterMs?: number;
}

type FrameState = 'loading' | 'ready' | 'blocked';

const LABEL: Record<FrameState, string> = {
  loading: 'Loading app',
  ready: 'App reported ready',
  blocked: 'No ready message from the app',
};

/**
 * An approved Shiny app in a frame with an external route (§10.7). A cross-origin frame cannot
 * be inspected, so a possibly blocked embed (framing refused, sign-in page, app that never answers)
 * is flagged by the absence of the `ready` message, which many working apps never send; the label
 * says only that none arrived. "Open externally" is always offered. The
 * state label never says "Connected": nothing here verifies a live session, and nothing the
 * frame sends is a result.
 */
export function ShinyEmbed({ title, url, origin, blockedAfterMs = BLOCKED_AFTER_MS }: Props) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const [state, setState] = useState<FrameState>('loading');
  const [height, setHeight] = useState<number | null>(null);
  // Restart replaces the frame, so the app starts again with no state of ours attached.
  const [run, setRun] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `run` restarts the wait
  useEffect(() => {
    if (!url || !origin) return;
    setState('loading');
    const timer = setTimeout(
      () => setState((now) => (now === 'loading' ? 'blocked' : now)),
      blockedAfterMs,
    );
    const onMessage = (event: MessageEvent) => {
      const message = readShinyMessage(event, {
        origin,
        frame: frame.current?.contentWindow ?? null,
      });
      if (!message) return;
      if (message.type === 'ready') {
        clearTimeout(timer);
        setState('ready');
      } else setHeight(message.height);
    };
    window.addEventListener('message', onMessage);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMessage);
    };
  }, [url, origin, run, blockedAfterMs]);

  if (!url || !origin) {
    return (
      <section className={styles.shiny} aria-label={title}>
        <header className={styles.head}>
          <h2>{title}</h2>
          <span className={styles.state}>Preview · no session</span>
        </header>
        <p className={styles.notice} role="status">
          This app’s address is not on an approved origin, so it is not shown or linked. Ask the
          instructor.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.shiny} aria-label={title}>
      <header className={styles.head}>
        <h2>{title}</h2>
        <span className={styles.state} role="status">
          {LABEL[state]}
        </span>
        <button
          type="button"
          className={buttons.tool}
          onClick={() => {
            setHeight(null);
            setRun((n) => n + 1);
          }}
        >
          Restart
        </button>
        <a className={buttons.tool} href={url} target="_blank" rel="noopener noreferrer">
          Open externally
        </a>
      </header>
      {state === 'blocked' ? (
        <p className={styles.notice} role="status">
          If the app does not appear, it may not allow embedding on this site or may need you to
          sign in. Open it in its own tab, or Restart to try again.
        </p>
      ) : null}
      <iframe
        key={run}
        ref={frame}
        className={styles.frame}
        style={height ? { height } : undefined}
        title={title}
        src={url}
        allow="fullscreen"
        allowFullScreen
        referrerPolicy="strict-origin"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
      />
    </section>
  );
}
