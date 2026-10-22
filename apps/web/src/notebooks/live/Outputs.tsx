import { type ReactNode, useId, useMemo, useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import styles from '../Notebook.module.css';
import type { LiveExecution } from './executionState';
import live from './Live.module.css';
import { groupOutputs } from './liveOutput';

/** One rich output of an execution, as the page that shows the notebook renders it. */
export interface RichItem {
  executionId: string;
  eventSeq: number;
  data: Record<string, unknown>;
  executionCount: number | null;
  text: string | null;
}

interface Props {
  execution: LiveExecution;
  /** Renders a rich output: from the server at level 1 (`RichOutput`), in the page at level 0. */
  renderRich: (item: RichItem) => ReactNode;
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
 * grows in place; rich output (HTML, SVG, images, tables, Markdown) is shown by `renderRich`: at
 * level 1 the server renders it and it is shown as stored output is, from the content origin
 * (`RichOutput`); at level 0 the page frames it (`LocalRichOutput`). A disconnect is never
 * described as completion: an execution with no confirmed reply is `Unconfirmed` or
 * `Incomplete`, and the person chooses whether to run the cell again; nothing runs it for them.
 */
export function LiveOutputs({
  execution,
  renderRich,
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
          {item.kind === 'rich' ? (
            renderRich({
              executionId: execution.executionId,
              eventSeq: item.eventSeq,
              data: item.data,
              executionCount: item.executionCount,
              text: item.text,
            })
          ) : (
            <Shown item={item} />
          )}
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
    case 'rich':
      return null;
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
