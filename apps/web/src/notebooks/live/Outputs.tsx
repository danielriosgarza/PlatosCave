import { useId, useMemo, useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import styles from '../Notebook.module.css';
import type { LiveExecution } from './executionState';
import live from './Live.module.css';
import { groupOutputs } from './liveOutput';

interface Props {
  execution: LiveExecution;
  /** The kernel's current generation: output of an older one belongs to the previous kernel. */
  kernelGeneration: number | undefined;
  /** Why a new run is not possible now, or null. */
  canRun: boolean;
  onRunAgain: () => void;
  onInputReply: (value: string) => boolean;
}

const STATUS: Record<LiveExecution['state'], string> = {
  sent: 'Queued',
  running: 'Running',
  ok: 'Finished',
  error: 'Finished with an error',
  aborted: 'Stopped before it finished',
  incomplete: 'Incomplete',
  unconfirmed: 'Unconfirmed',
};

/**
 * The outputs of one execution, streamed as they arrive (docs/design/connector.md §10.6). Text
 * grows in place; HTML is shown only in a frame with every sandbox restriction. A disconnect is
 * never described as completion: an execution with no confirmed reply is `Unconfirmed` or
 * `Incomplete`, and the person chooses whether to run the cell again; nothing runs it for them.
 */
export function LiveOutputs({
  execution,
  kernelGeneration,
  canRun,
  onRunAgain,
  onInputReply,
}: Props) {
  const { shown, truncated } = useMemo(() => groupOutputs(execution.outputs), [execution.outputs]);
  const state = execution.state;
  const previous = kernelGeneration !== undefined && execution.generation < kernelGeneration;
  const showRunAgain =
    state === 'unconfirmed' ||
    state === 'incomplete' ||
    (state === 'ok' && execution.outputsIncomplete);
  const incomplete = state === 'incomplete' || execution.outputsIncomplete;

  return (
    <div className={styles.outputs} data-execution-state={state}>
      <div className={live.status} role="status">
        <span>{STATUS[state]}</span>
        {previous ? <span> · From a previous kernel session</span> : null}
      </div>
      {state === 'unconfirmed' ? (
        <p className={live.notice}>
          Unconfirmed: this cell may or may not have reached the kernel. Parallax does not run it
          again by itself.
        </p>
      ) : null}
      {incomplete && state !== 'unconfirmed' ? (
        <p className={live.notice}>
          Incomplete: some output or the result of this cell is unknown. Parallax cannot tell
          whether it finished.
        </p>
      ) : null}
      {state === 'aborted' ? (
        <p className={live.notice}>
          The kernel was restarted or replaced before this cell finished. Its variables are gone.
        </p>
      ) : null}
      {shown.map((item) => (
        <div
          key={item.key}
          className={`${styles.output} ${
            kernelGeneration !== undefined && item.generation < kernelGeneration ? live.old : ''
          }`}
        >
          <Shown item={item} cellCount={execution.executionCount ?? null} />
        </div>
      ))}
      {truncated || execution.truncated ? (
        <div className={styles.provenance}>Output truncated</div>
      ) : null}
      {execution.prompt ? (
        <InputPrompt
          prompt={execution.prompt.prompt}
          password={execution.prompt.password}
          onReply={onInputReply}
        />
      ) : null}
      {showRunAgain ? (
        <div>
          <button type="button" className={buttons.outline} disabled={!canRun} onClick={onRunAgain}>
            Run again
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Shown({
  item,
  cellCount,
}: {
  item: ReturnType<typeof groupOutputs>['shown'][number];
  cellCount: number | null;
}) {
  switch (item.kind) {
    case 'text':
      return (
        <pre className={`${styles.text} ${item.stream === 'stderr' ? styles.stderr : ''}`}>
          {item.text}
        </pre>
      );
    case 'error':
      return (
        <div className={styles.error}>
          <div className={styles.errorName}>
            {item.name}: {item.value}
          </div>
          {item.traceback ? <pre className={styles.text}>{item.traceback}</pre> : null}
        </div>
      );
    case 'image':
      return <img className={styles.image} src={item.url} alt={item.alt} />;
    case 'html':
      return (
        <>
          <div className={styles.frameBox} style={{ height: 240 }}>
            <iframe
              className={styles.frame}
              // Every sandbox restriction: no script, no same origin, no forms, popups or
              // navigation. The document is sanitised first and carries its own policy.
              sandbox=""
              srcDoc={item.doc}
              title={`Live output of cell [${cellCount ?? ' '}]`}
              referrerPolicy="no-referrer"
            />
          </div>
          {item.scriptsRemoved ? (
            <div className={styles.provenance}>Scripts in this output were removed and not run</div>
          ) : null}
        </>
      );
    case 'unsupported':
      return (
        <p className={styles.label}>Interactive output not shown ({item.mimeTypes.join(', ')})</p>
      );
  }
}

function InputPrompt({
  prompt,
  password,
  onReply,
}: {
  prompt: string;
  password: boolean;
  onReply: (value: string) => boolean;
}) {
  const id = useId();
  const [value, setValue] = useState('');
  return (
    <form
      className={live.prompt}
      onSubmit={(e) => {
        e.preventDefault();
        if (onReply(value)) setValue('');
      }}
    >
      <label htmlFor={id}>{prompt || 'Input requested'}</label>
      <input
        id={id}
        type={password ? 'password' : 'text'}
        value={value}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="submit" className={buttons.outline}>
        Send
      </button>
    </form>
  );
}
