import { useState } from 'react';
import buttons from '../../components/Buttons.module.css';
import live from './Live.module.css';

export type SessionAction = 'restart' | 'disconnect' | 'stop';

interface Props {
  canRun: boolean;
  /** The kernel is running a cell or waiting for input: Interrupt applies. */
  busy: boolean;
  /** Run all is in progress. */
  runningAll: boolean;
  /** Parallax started the Jupyter server, so Stop session is possible (A32). */
  owned: boolean | null;
  /** The session is in a state the session menu can act on. */
  sessionActive: boolean;
  onRunAll: () => void;
  onInterrupt: () => void;
  onAsk: (action: SessionAction) => void;
}

/**
 * The live notebook's controls (design §2, §5.6): Run all stops on an error, Interrupt, and a
 * session menu whose Restart kernel, Disconnect and Stop session each ask first. Disconnect
 * leaves the kernel alone and says so; Stop is offered only for a session Parallax's connector started.
 */
export function LiveToolbar({
  canRun,
  busy,
  runningAll,
  owned,
  sessionActive,
  onRunAll,
  onInterrupt,
  onAsk,
}: Props) {
  const [open, setOpen] = useState(false);
  const choose = (action: SessionAction) => {
    setOpen(false);
    onAsk(action);
  };
  return (
    <>
      <button
        type="button"
        className={buttons.tool}
        disabled={!canRun || runningAll}
        onClick={onRunAll}
      >
        Run all
      </button>
      <button type="button" className={buttons.tool} disabled={!busy} onClick={onInterrupt}>
        Interrupt
      </button>
      <button
        type="button"
        id="live-session-menu"
        className={buttons.tool}
        aria-expanded={open}
        aria-controls="live-session-actions"
        disabled={!sessionActive}
        onClick={() => setOpen(!open)}
      >
        Session
      </button>
      {open ? (
        <span id="live-session-actions" className={live.menu}>
          <button type="button" className={buttons.tool} onClick={() => choose('restart')}>
            Restart kernel
          </button>
          <button type="button" className={buttons.tool} onClick={() => choose('disconnect')}>
            Disconnect
          </button>
          {owned === false ? null : (
            <button type="button" className={buttons.tool} onClick={() => choose('stop')}>
              Stop session
            </button>
          )}
        </span>
      ) : null}
    </>
  );
}
