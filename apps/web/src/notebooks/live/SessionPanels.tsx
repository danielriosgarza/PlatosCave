import { listSessionFiles } from '@parallax/contracts/routes/transfers';
import { getWorkingCopy, type WorkingCopyView } from '@parallax/contracts/routes/workingCopies';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { call } from '../../api/client';
import buttons from '../../components/Buttons.module.css';
import { FilesPanel, SaveControls, SubmitPanel } from '../files';
import { refusalText } from '../files/files';
import type { Notebook } from '../notebooks';
import live from './Live.module.css';

type Json = Record<string, unknown>;

/** The workspace of a session and the files its notebook declares. */
export function useWorkspaceListing(classId: string, sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['files', classId, sessionId, ''],
    queryFn: () => call(listSessionFiles, { params: { classId, sessionId }, query: {} }),
    retry: false,
    enabled,
  });
}
export type WorkspaceListing = ReturnType<typeof useWorkspaceListing>;

/** Whether the notebook declares files and the person has settled copying them in. */
export function useCopyInGate(classId: string, sessionId: string, enabled: boolean) {
  const listing = useWorkspaceListing(classId, sessionId, enabled);
  const [settled, setSettled] = useState(false);
  const declared = listing.data?.declared.length ?? 0;
  const settle = useCallback(() => setSettled(true), []);
  return {
    listing,
    /** Run is offered only when no declared file is waiting to be copied in or skipped. */
    pending: enabled && declared > 0 && !settled,
    declared,
    settle,
  };
}

const sourceText = (source: unknown) =>
  Array.isArray(source) ? source.join('') : typeof source === 'string' ? source : '';

const codeCells = (notebook: Json): Json[] =>
  (Array.isArray(notebook.cells) ? (notebook.cells as Json[]) : []).filter(
    (cell) => cell.cell_type === 'code',
  );

/** The stored code by live cell id: by nbformat id, else by position among code cells. */
export function sourcesFor(stored: Json, live: Notebook): Record<string, string> {
  const out: Record<string, string> = {};
  const theirs = codeCells(stored);
  const liveCode = live.cells.filter((c) => c.type === 'code');
  const byId = new Map(
    theirs.filter((c) => typeof c.id === 'string').map((c) => [c.id as string, c]),
  );
  liveCode.forEach((cell, index) => {
    const match =
      byId.get(cell.id) ?? (theirs[index]?.id === undefined ? theirs[index] : undefined);
    if (match) out[cell.id] = sourceText(match.source);
  });
  return out;
}

/** The stored copy with the code the editor shows for every live code cell written into it. */
export function notebookWith(base: Json, live: Notebook, sources: Record<string, string>): Json {
  const shown = new Map(
    live.cells.filter((c) => c.type === 'code').map((c) => [c.id, sources[c.id] ?? c.source]),
  );
  const cells = Array.isArray(base.cells) ? (base.cells as Json[]) : [];
  return {
    ...base,
    cells: cells.map((cell) => {
      const text =
        cell.cell_type === 'code' && typeof cell.id === 'string' ? shown.get(cell.id) : undefined;
      return text === undefined || text === sourceText(cell.source)
        ? cell
        : { ...cell, source: text };
    }),
  };
}

interface Props {
  classId: string;
  sessionId: string;
  revisionId: string;
  notebook: Notebook;
  sources: Record<string, string>;
  onEdit: (cellId: string, value: string) => void;
  environment: Record<string, string | undefined>;
  listing: WorkspaceListing;
  onCopyInSettled: () => void;
}

/**
 * Files, save and submit for a ready session (spec §10.5, design §11). The working copy is read
 * from Parallax; the panels hold the copy as Parallax last acknowledged it, and the editor's
 * code is laid over it when saving.
 */
function Panels({
  classId,
  sessionId,
  revisionId,
  notebook,
  sources,
  onEdit,
  environment,
  listing,
  onCopyInSettled,
}: Props) {
  const queryClient = useQueryClient();
  const key = ['working-copy', classId, revisionId];
  const stored = useQuery({
    queryKey: key,
    queryFn: () => call(getWorkingCopy, { params: { classId, revisionId }, query: {} }),
    retry: false,
  });
  const copy = stored.data;
  const keep = (next: WorkingCopyView) => queryClient.setQueryData(key, next);

  // The editor shows what the stored copy holds: seeded once, for cells not already edited.
  const seeded = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: seeds once per copy, from what is stored then
  useEffect(() => {
    if (!copy || seeded.current === copy.id) return;
    seeded.current = copy.id;
    for (const [id, source] of Object.entries(sourcesFor(copy.notebook, notebook))) {
      const cell = notebook.cells.find((c) => c.id === id);
      if (cell?.type === 'code' && sources[id] === undefined && source !== cell.source) {
        onEdit(id, source);
      }
    }
  }, [copy?.id]);
  const getNotebook = useCallback(
    () => notebookWith(copy?.notebook ?? {}, notebook, sources),
    [copy?.notebook, notebook, sources],
  );

  if (!copy) {
    if (stored.isPending) return <p role="status">Reading your working copy</p>;
    return (
      <section className={live.panels} aria-label="Files, save and submit">
        <p role="alert">
          {refusalText(stored.error, 'Your working copy could not be read.')} Saving, importing and
          submitting are unavailable.
        </p>
        <button type="button" className={buttons.tool} onClick={() => void stored.refetch()}>
          Try again
        </button>
      </section>
    );
  }

  // An imported notebook replaces the code in the editor: the person asked for that revision.
  const imported = (next: WorkingCopyView) => {
    keep(next);
    for (const [id, source] of Object.entries(sourcesFor(next.notebook, notebook)))
      onEdit(id, source);
  };
  const workspace = listing.data?.workspace;

  return (
    <div className={live.panels}>
      <FilesPanel
        classId={classId}
        sessionId={sessionId}
        workingCopy={copy}
        onWorkingCopy={imported}
        onRevisionConflict={() => void queryClient.invalidateQueries({ queryKey: key })}
        onCopyInSettled={onCopyInSettled}
      />
      {listing.isPending ? null : (
        <SaveControls
          classId={classId}
          sessionId={sessionId}
          workingCopy={copy}
          getNotebook={getNotebook}
          onWorkingCopy={keep}
          onStale={keep}
          workspace={workspace}
          host={listing.data?.host ?? null}
        />
      )}
      <SubmitPanel
        classId={classId}
        sessionId={sessionId}
        workingCopy={copy}
        environment={environment}
      />
    </div>
  );
}

export const SessionPanels = memo(Panels);
