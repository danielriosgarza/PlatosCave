import { renderLiveOutput } from '@parallax/contracts/routes/notebookSessions';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { call } from '../../api/client';
import buttons from '../../components/Buttons.module.css';
import { errorCode } from '../connect/api';
import styles from '../Notebook.module.css';
import { Output } from '../NotebookView';
import type { CellOutput } from '../notebooks';
import live from './Live.module.css';

interface Props {
  classId: string;
  sessionId: string;
  executionId: string;
  /** The output event the item shows; with the execution, its identity. */
  eventSeq: number;
  data: Record<string, unknown>;
  executionCount: number | null;
  /** The output's `text/plain` alternative, shown when the output itself cannot be. */
  text: string | null;
}

/**
 * A number per output bundle as the channel delivered it. Event numbers restart with a relay's
 * epoch, so the query key names the bundle itself too, without hashing megabytes on each render.
 */
const bundles = new WeakMap<object, number>();
let lastBundle = 0;
const bundleId = (data: object): number => {
  let id = bundles.get(data);
  if (id === undefined) {
    id = ++lastBundle;
    bundles.set(data, id);
  }
  return id;
};

/** Why a rich output is not shown, in the words the cell uses. */
function failure(error: unknown): string {
  switch (errorCode(error)) {
    case 'storage_limit':
      return 'This output is not shown: this session has stored as much output as it may.';
    case 'not_rendered':
      return 'This output could not be rendered.';
    default:
      return (error as { status?: number }).status === 413
        ? 'This output is too large to show.'
        : 'This output could not be loaded.';
  }
}

/**
 * One rich live output, shown exactly as stored output is (docs/design/connector.md §14, spec
 * §10.4): the server renders it with the stored-output rules, and HTML, SVG and images come from
 * the content origin, HTML in a frame with every sandbox restriction. Its links last five minutes,
 * so they are minted each time the output is shown (nothing is kept once the cell unmounts); a
 * load that fails says so and offers to try again rather than leaving an empty rectangle.
 */
export function RichOutput({
  classId,
  sessionId,
  executionId,
  eventSeq,
  data,
  executionCount,
  text,
}: Props) {
  const query = useQuery({
    queryKey: [
      renderLiveOutput.method,
      renderLiveOutput.path,
      sessionId,
      executionId,
      eventSeq,
      bundleId(data),
    ],
    queryFn: () =>
      call(renderLiveOutput, { params: { classId, sessionId }, body: { data, executionCount } }),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  // The image link that failed to load; only a newly minted link is tried again.
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const output = query.data?.output;
  const retry = () => void query.refetch();

  if (query.isPending || (query.isFetching && !output)) {
    return <div className={styles.provenance}>Loading output…</div>;
  }
  if (!output) {
    return <Unavailable message={failure(query.error)} text={text} onRetry={retry} />;
  }
  if (output.type === 'image' && output.url && output.url === brokenUrl) {
    return <Unavailable message="This image could not be loaded." text={text} onRetry={retry} />;
  }
  if (output.type === 'image' && output.url) {
    return (
      <>
        <img
          className={styles.image}
          src={output.url}
          alt={output.alt}
          referrerPolicy="no-referrer"
          onError={() => setBrokenUrl(output.url)}
        />
        {output.scriptsRemoved ? (
          <div className={styles.provenance}>Scripts in this output were removed and not run</div>
        ) : null}
      </>
    );
  }
  if (output.type === 'html' && output.url) {
    return (
      <>
        <div className={styles.frameBox} style={{ height: output.height }}>
          <iframe
            className={styles.frame}
            // Every sandbox restriction: no script, no same origin, no forms, popups or
            // navigation of this page. The content origin's own CSP says the same. Not lazy:
            // the link is minted now and lasts five minutes.
            sandbox=""
            src={output.url}
            title={`Output of cell [${output.executionCount ?? ' '}]`}
            referrerPolicy="no-referrer"
          />
        </div>
        {output.scriptsRemoved ? (
          <div className={styles.provenance}>Scripts in this output were removed and not run</div>
        ) : null}
      </>
    );
  }
  if ((output.type === 'image' || output.type === 'html') && !output.url) {
    return <Unavailable message="This output could not be loaded." text={text} onRetry={retry} />;
  }
  // Tables, Markdown and text render as stored output does, inside this cell's output box.
  return (
    <div className={live.stored}>
      <Output output={output as CellOutput} cellCount={executionCount} />
    </div>
  );
}

function Unavailable({
  message,
  text,
  onRetry,
}: {
  message: string;
  text: string | null;
  onRetry: () => void;
}) {
  return (
    <>
      {text !== null ? <pre className={styles.text}>{text}</pre> : null}
      <p className={live.notice}>
        {message}{' '}
        <button type="button" className={buttons.textButton} onClick={onRetry}>
          Try again
        </button>
      </p>
    </>
  );
}
