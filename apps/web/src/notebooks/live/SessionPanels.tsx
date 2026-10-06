import { listSessionFiles } from '@parallax/contracts/routes/transfers';
import { getWorkingCopy, type WorkingCopyView } from '@parallax/contracts/routes/workingCopies';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { call } from '../../api/client';
import buttons from '../../components/Buttons.module.css';
import { FilesPanel, SaveControls, SubmitPanel } from '../files';
import { refusalText } from '../files/files';
import type { Notebook } from '../notebooks';
import live from './Live.module.css';

type Json = Record<string, unknown>;

/** The files the notebook declares and whether the person has settled copying them in. */
export function useCopyInGate(classId: string, sessionId: string, enabled: boolean) {
  const listing = useQuery({
    queryKey: ['files', classId, sessionId, ''],
    queryFn: () => call(listSessionFiles, { params: { classId, sessionId }, query: {} }),
    retry: false,
    enabled,
  });
  const [settled, setSettled] = useState(false);
  const declared = listing.data?.declared.length ?? 0;
  return {
    /** Run is offered only when no declared file is waiting to be copied in or skipped. */
    pending: enabled && declared > 0 && !settled,
    declared,
    settle: () => setSettled(true),
  };
}

const sourceText = (source: unknown) =>
  Array.isArray(source) ? source.join('') : typeof source === 'string' ? source : '';

/** The editor's code by cell id, from an nbformat notebook. */
export function sourcesOf(notebook: Json): Record<string, string> {
  const out: Record<string, string> = {};
  const cells = Array.isArray(notebook.cells) ? (notebook.cells as Json[]) : [];
  for (const cell of cells) {
    if (cell.cell_type === 'code' && typeof cell.id === 'string') {
      out[cell.id] = sourceText(cell.source);
    }
  }
  return out;
}

/** The stored copy with the editor's unsaved code laid over it. */
export function notebookWith(base: Json, sources: Record<string, string>): Json {
  const cells = Array.isArray(base.cells) ? (base.cells as Json[]) : [];
  return {
    ...base,
    cells: cells.map((cell) =>
      cell.cell_type === 'code' && typeof cell.id === 'string' && cell.id in sources
        ? { ...cell, source: sources[cell.id] }
        : cell,
    ),
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
  onCopyInSettled: () => void;
}

/**
 * Files, save and submit for a ready session (spec §10.5, design §11). The working copy is read
 * from Parallax; the panels hold the copy as Parallax last acknowledged it, and the editor's
 * code is laid over it when saving.
 */
export function SessionPanels({
  classId,
  sessionId,
  revisionId,
  notebook,
  sources,
  onEdit,
  environment,
  onCopyInSettled,
}: Props) {
  const queryClient = useQueryClient();
  const listing = useQuery({
    queryKey: ['files', classId, sessionId, ''],
    queryFn: () => call(listSessionFiles, { params: { classId, sessionId }, query: {} }),
    retry: false,
  });
  const key = ['working-copy', classId, revisionId];
  const stored = useQuery({
    queryKey: key,
    queryFn: () => call(getWorkingCopy, { params: { classId, revisionId }, query: {} }),
    retry: false,
  });
  const copy = stored.data;
  const keep = (next: WorkingCopyView) => queryClient.setQueryData(key, next);

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
    for (const [id, source] of Object.entries(sourcesOf(next.notebook))) {
      if (notebook.cells.some((c) => c.id === id && c.type === 'code')) onEdit(id, source);
    }
  };
  const getNotebook = () => notebookWith(copy.notebook, sources);
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
      {listing.data && workspace ? (
        <SaveControls
          classId={classId}
          sessionId={sessionId}
          workingCopy={copy}
          getNotebook={getNotebook}
          onWorkingCopy={keep}
          onStale={keep}
          workspace={workspace}
          host={listing.data.host}
        />
      ) : null}
      <SubmitPanel
        classId={classId}
        sessionId={sessionId}
        workingCopy={copy}
        environment={environment}
      />
    </div>
  );
}
