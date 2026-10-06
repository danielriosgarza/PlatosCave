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
  /** Whether a cell can be run now (Run again is offered only then). */
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
 * grows in place; rich output (HTML, SVG, images) is withheld until it can be served from the
 * content origin (P3-08a), and the cell says so. A disconnect is
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
          <Shown item={item} />
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

function Shown({ item }: { item: ReturnType<typeof groupOutputs>['shown'][number] }) {
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
    case 'withheld':
      return (
        <>
          {item.text !== null ? <pre className={styles.text}>{item.text}</pre> : null}
          <div className={styles.provenance}>
            {item.mimeTypes.length > 0
              ? `Rich output (${item.mimeTypes.join(', ')}) is not shown in a live notebook yet`
              : 'Rich output is not shown in a live notebook yet'}
          </div>
        </>
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
