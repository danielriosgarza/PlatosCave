import { Link } from '@tanstack/react-router';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import buttons from '../components/Buttons.module.css';
import { Loading } from '../components/Loading';
import page from '../components/Page.module.css';
import { RetryNotice } from '../components/RetryNotice';
import { SourceDownload } from '../reading/SourceDownload';
import { useSession } from '../session/useSession';
import { ResourceTools } from '../workspace/ResourceTools';
import { ColabSubmission } from './ColabSubmission';
import { isOpenState, useConnections, useSessions } from './connect/api';
import { ConnectPanel } from './connect/ConnectPanel';
import { LiveNotebook } from './live';
import styles from './Notebook.module.css';
import { NotebookView } from './NotebookView';
import { type NotebookSummary, useNotebookContent, useNotebooks, useShiny } from './notebooks';
import { ShinyEmbed } from './ShinyEmbed';

interface Props {
  classId: string;
  courseId: string;
  topicId: string;
  instructor: boolean;
  /** The notebook the address names, if any. */
  resource: string | undefined;
  /** Moves the address to another notebook: a new history entry. */
  onResource: (revisionId: string, mode: 'push' | 'replace') => void;
}

/**
 * The Notebooks tab (§10.1, §10.7): the picked notebook rendered with its saved outputs. No
 * computer is connected in this mode, so the toolbar says so ("Saved outputs") and every output
 * group is labelled as stored, with the kernel that produced it.
 */
export function NotebooksTab({
  classId,
  courseId,
  topicId,
  instructor,
  resource,
  onResource,
}: Props) {
  const list = useNotebooks(classId, topicId);
  const session = useSession();
  const canAdd =
    instructor &&
    session.status === 'signed-in' &&
    session.me.courses.some((c) => c.courseId === courseId && (c.editor || c.owner));

  const notebooks = list.data?.notebooks ?? [];
  const chosen = notebooks.find((n) => n.revisionId === resource) ?? notebooks[0];
  // An entry opened without a notebook in its address is pinned to the one shown, so Back returns to it.
  const shownId = chosen?.revisionId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `onResource` is a new function every render
  useEffect(() => {
    if (shownId && resource === undefined) onResource(shownId, 'replace');
  }, [shownId, resource]);

  if (!list.data) {
    return (
      <div className={styles.status}>
        {list.isError ? (
          <RetryNotice
            message="The notebooks could not be loaded."
            onRetry={() => void list.refetch()}
          />
        ) : (
          <Loading label="Loading notebooks" />
        )}
      </div>
    );
  }
  const add = canAdd ? (
    <Link
      to="/courses/$courseId/edit/$topicId"
      params={{ courseId, topicId }}
      className={page.link}
    >
      Add notebook
    </Link>
  ) : null;
  if (!chosen) {
    return (
      <div className={styles.status}>
        <p className={styles.empty}>No notebook has been added</p>
        {add && <p>{add}</p>}
      </div>
    );
  }
  const picker =
    notebooks.length > 1 ? (
      <label className={styles.picker}>
        <span className={styles.label}>Notebook</span>
        <select value={chosen.revisionId} onChange={(e) => onResource(e.target.value, 'push')}>
          {notebooks.map((n) => (
            <option key={n.revisionId} value={n.revisionId}>
              {n.title}
            </option>
          ))}
        </select>
      </label>
    ) : (
      <span className={styles.label}>{chosen.title}</span>
    );
  if (chosen.type === 'shiny') {
    return (
      <ShinyPanel
        key={chosen.revisionId}
        classId={classId}
        notebook={chosen}
        picker={picker}
        add={add}
      />
    );
  }
  return (
    <NotebookPanel
      key={chosen.revisionId}
      classId={classId}
      instructor={instructor}
      notebook={chosen}
      picker={picker}
      add={add}
    />
  );
}

/** A Shiny app: embedded from an approved origin, with an external route (§10.7). */
function ShinyPanel({
  classId,
  notebook,
  picker,
  add,
}: {
  classId: string;
  notebook: NotebookSummary;
  picker: ReactNode;
  add: ReactNode;
}) {
  const shiny = useShiny(classId, notebook.revisionId);
  let body: ReactNode;
  if (shiny.error instanceof ApiError && shiny.error.status === 404) {
    body = (
      <div className={`${page.feedback} ${styles.status}`} role="alert">
        <p>This app is not available.</p>
      </div>
    );
  } else if (!shiny.data) {
    body = shiny.isError ? (
      <div className={styles.status}>
        <RetryNotice message="This app could not be loaded." onRetry={() => void shiny.refetch()} />
      </div>
    ) : (
      <Loading label="Loading app" className={styles.status} />
    );
  } else {
    body = <ShinyEmbed title={shiny.data.title} url={shiny.data.url} origin={shiny.data.origin} />;
  }
  return (
    <>
      <ResourceTools>
        {picker}
        {add}
      </ResourceTools>
      {body}
    </>
  );
}

function NotebookPanel({
  classId,
  instructor,
  notebook,
  picker,
  add,
}: {
  classId: string;
  instructor: boolean;
  notebook: NotebookSummary;
  picker: ReactNode;
  add: ReactNode;
}) {
  const { revisionId } = notebook;
  const content = useNotebookContent(classId, revisionId);
  const [showCode, setShowCode] = useState(true);
  const [showOutputs, setShowOutputs] = useState(true);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [connectOpen, setConnectOpen] = useState(false);
  const target = useRef<HTMLButtonElement>(null);
  const data = content.data;
  const ready = data?.status === 'ready' ? data.notebook : null;

  // The notebook runs live while this person has an open session for it. A session that was live
  // on this page stays on it after it ends, so the edits and the cause stay in view.
  const sessions = useSessions(classId);
  const connections = useConnections();
  const [liveId, setLiveId] = useState<string>();
  const open = sessions.data?.find(
    (s) => s.resourceRevisionId === revisionId && isOpenState(s.state) && s.state !== 'starting',
  );
  useEffect(() => {
    if (open) setLiveId(open.id);
  }, [open]);
  const liveSession =
    open ?? sessions.data?.find((s) => s.id === liveId && s.resourceRevisionId === revisionId);

  const targetButton = (label: string) => (
    <button
      type="button"
      ref={target}
      className={buttons.tool}
      aria-expanded={connectOpen}
      aria-controls="connect-panel"
      onClick={() => setConnectOpen(!connectOpen)}
    >
      {label}
    </button>
  );
  const outlineButton =
    ready && ready.outline.length > 0 ? (
      <button
        type="button"
        className={buttons.tool}
        aria-expanded={outlineOpen}
        onClick={() => setOutlineOpen(!outlineOpen)}
      >
        Outline
      </button>
    ) : null;
  const sourceDownload = data?.sourceKey ? (
    <SourceDownload
      classId={classId}
      revisionId={revisionId}
      sourceKey={data.sourceKey}
      className={buttons.tool}
    />
  ) : null;

  const tools = (
    // In the toolbar whatever the notebook's state, so another notebook stays reachable.
    <ResourceTools>
      {picker}
      {/* The mode: no computer is connected, so these are the outputs the file was saved with. */}
      {targetButton('Saved outputs')}
      {ready ? (
        <>
          {outlineButton}
          <button type="button" className={buttons.tool} onClick={() => setShowCode(!showCode)}>
            {showCode ? 'Hide code' : 'Show code'}
          </button>
          <button
            type="button"
            className={buttons.tool}
            onClick={() => setShowOutputs(!showOutputs)}
          >
            {showOutputs ? 'Hide outputs' : 'Show outputs'}
          </button>
        </>
      ) : null}
      {sourceDownload}
      {add}
    </ResourceTools>
  );

  let body: ReactNode;
  if (content.error instanceof ApiError && content.error.status === 404) {
    body = (
      <div className={`${page.feedback} ${styles.status}`} role="alert">
        <p>This notebook is not available.</p>
      </div>
    );
  } else if (!data) {
    body = content.isError ? (
      <div className={styles.status}>
        <RetryNotice
          message="This notebook could not be loaded."
          onRetry={() => void content.refetch()}
        />
      </div>
    ) : (
      <Loading label="Loading notebook" className={styles.status} />
    );
  } else if (data.status === 'pending') {
    body = <Loading label={`${data.title} is being prepared`} className={styles.status} />;
  } else if (!ready) {
    body = (
      <div className={`${page.feedback} ${styles.status}`} role="alert">
        <p>
          {data.title} could not be imported{data.error ? `: ${data.error}` : ''}
        </p>
      </div>
    );
  } else if (liveSession) {
    body = (
      <div className={styles.stage}>
        <LiveNotebook
          key={liveSession.id}
          classId={classId}
          session={liveSession}
          connectionName={connections.data?.find((c) => c.id === liveSession.connectionId)?.name}
          notebook={ready}
          outlineOpen={outlineOpen}
          lead={(label) => (
            <>
              {picker}
              {targetButton(label)}
            </>
          )}
          trail={
            <>
              {outlineButton}
              {sourceDownload}
              {add}
            </>
          }
          onOpenConnect={() => setConnectOpen(true)}
        />
        <ColabSubmission
          classId={classId}
          resourceId={notebook.resourceId}
          instructor={instructor}
        />
      </div>
    );
  } else {
    body = (
      <div className={styles.stage}>
        <NotebookView
          notebook={ready}
          showCode={showCode}
          showOutputs={showOutputs}
          outlineOpen={outlineOpen}
        />
        <ColabSubmission
          classId={classId}
          resourceId={notebook.resourceId}
          instructor={instructor}
        />
      </div>
    );
  }
  return (
    <>
      {liveSession && ready ? null : tools}
      {connectOpen ? (
        <div id="connect-panel">
          <ConnectPanel
            classId={classId}
            revisionId={revisionId}
            instructor={instructor}
            onClose={() => {
              setConnectOpen(false);
              target.current?.focus();
            }}
          />
        </div>
      ) : null}
      {body}
    </>
  );
}
