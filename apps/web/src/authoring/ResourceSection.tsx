import { type processingEntry, retryProcessing } from '@parallax/contracts/routes/authoring';
import {
  type draftResource,
  type draftResourceSummary,
  getResource,
  updateResource,
} from '@parallax/contracts/routes/drafts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { z } from 'zod';
import { call } from '../api/client';
import styles from '../components/Page.module.css';
import { AddReading } from './AddReading';
import local from './Authoring.module.css';
import { useAutosave } from './autosave';
import { ConflictView } from './ConflictView';
import { authoringKey, processingQuery } from './queries';
import { SaveStatus } from './SaveStatus';

export type ResourceSummary = z.output<typeof draftResourceSummary>;
type Type = ResourceSummary['type'];

export const tabs = [
  { name: 'Slides', types: ['slides_pdf', 'slides_web'] },
  { name: 'Reading', types: ['reading_native', 'reading_pdf'] },
  { name: 'Exercises', types: ['exercise'] },
  { name: 'Notebooks', types: ['notebook', 'shiny'] },
  { name: 'Tests', types: ['test'] },
] as const satisfies { name: string; types: readonly Type[] }[];

const typeNames: Record<Type, string> = {
  slides_pdf: 'PDF slides',
  slides_web: 'Web slides',
  reading_native: 'Reading',
  reading_pdf: 'PDF reading',
  exercise: 'Exercise',
  notebook: 'Notebook',
  shiny: 'Shiny app',
  test: 'Test',
};

const isReading = (t: Type) => t === 'reading_native' || t === 'reading_pdf';

interface Props {
  courseId: string;
  topicId: string;
  resources: ResourceSummary[];
}

/** The topic's resources grouped by destination tab, with Add reading on the Reading tab (§12). */
export function ResourceSection({ courseId, topicId, resources }: Props) {
  const queryClient = useQueryClient();
  const processing = useQuery(processingQuery(courseId));
  const [adding, setAdding] = useState(false);
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: authoringKey(courseId) }),
    [queryClient, courseId],
  );
  const stateOf = (id: string) => processing.data?.resources.find((r) => r.resourceId === id);

  return (
    <div>
      <h2 style={{ fontSize: 20, marginTop: 40 }}>Resources</h2>
      {tabs.map((tab) => {
        const here = resources.filter((r) => (tab.types as readonly Type[]).includes(r.type));
        return (
          <section key={tab.name} aria-label={`${tab.name} resources`}>
            <h3 className={local.tabHeading}>{tab.name}</h3>
            {here.length === 0 ? (
              <div className={local.empty}>No {tab.name.toLowerCase()} yet.</div>
            ) : null}
            {here.map((r) => (
              <ResourceRow
                key={r.id}
                courseId={courseId}
                resource={r}
                status={stateOf(r.id)}
                onChanged={() => void refresh()}
              />
            ))}
            {tab.name === 'Reading' ? (
              adding ? (
                <AddReading
                  courseId={courseId}
                  topicId={topicId}
                  onCancel={() => setAdding(false)}
                  onAdded={() => {
                    setAdding(false);
                    void refresh();
                  }}
                />
              ) : (
                <div style={{ marginTop: 12 }}>
                  <button type="button" className={styles.outline} onClick={() => setAdding(true)}>
                    Add reading
                  </button>
                </div>
              )
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

type Status = z.output<typeof processingEntry>;

function StatusLine({
  courseId,
  resource,
  status,
}: {
  courseId: string;
  resource: ResourceSummary;
  status?: Status;
}) {
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => call(retryProcessing, { params: { courseId, resourceId: resource.id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authoringKey(courseId) }),
  });
  if (!isReading(resource.type) || resource.archived) return null;
  const state = status?.state ?? null;
  const labels = {
    queued: 'Waiting to be processed',
    running: 'Processing',
    ready: 'Ready to publish',
    failed: `Processing failed${status?.error ? `: ${status.error}` : ''}`,
  } as const;
  const text = state ? labels[state] : 'Not processed yet';
  return (
    <div
      className={`${local.resourceMeta} ${state === 'ready' ? local.success : state === 'failed' ? local.failure : ''}`}
      role="status"
    >
      {text}
      {state === 'failed' || state === null ? (
        <>
          {' '}
          <button
            type="button"
            className={styles.textButton}
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
          >
            Retry processing
          </button>
        </>
      ) : null}
      {retry.isError ? ' Could not queue processing.' : null}
    </div>
  );
}

function ResourceRow({
  courseId,
  resource,
  status,
  onChanged,
}: {
  courseId: string;
  resource: ResourceSummary;
  status?: Status;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={local.resource} data-archived={resource.archived}>
      <div className={local.resourceHead}>
        <div>
          <div>{resource.title}</div>
          <div className={local.resourceMeta}>
            {typeNames[resource.type]} ·{' '}
            {resource.visibility === 'hidden' ? 'Hidden from students' : 'Visible to students'}
            {resource.archived ? ' · Archived' : ''}
          </div>
          <StatusLine courseId={courseId} resource={resource} status={status} />
        </div>
        {isReading(resource.type) ? (
          <button
            type="button"
            className={styles.textButton}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Close' : `Edit ${resource.title}`}
          </button>
        ) : null}
      </div>
      {open ? (
        <ReadingEditor courseId={courseId} resourceId={resource.id} onSaved={onChanged} />
      ) : null}
    </div>
  );
}

type Full = z.output<typeof draftResource>;

interface ReadingValues {
  title: string;
  visibility: 'visible' | 'hidden';
  alternative: string;
  archived: boolean;
}

const alternativeText = (r: Full): string => {
  const alt = r.head?.accessibleAlternative as { text?: unknown } | null | undefined;
  return typeof alt?.text === 'string' ? alt.text : '';
};

function ReadingEditor({
  courseId,
  resourceId,
  onSaved,
}: {
  courseId: string;
  resourceId: string;
  onSaved: () => void;
}) {
  const loaded = useQuery({
    queryKey: [...authoringKey(courseId), 'resource', resourceId],
    queryFn: () => call(getResource, { params: { courseId, resourceId } }),
    gcTime: 0,
  });
  if (loaded.isError)
    return (
      <p role="alert" className={styles.small}>
        This reading could not be loaded.
      </p>
    );
  if (!loaded.data) return <p className={`${styles.small} ${styles.muted}`}>Loading…</p>;
  return <ReadingFields courseId={courseId} server={loaded.data} onSaved={onSaved} />;
}

const toReadingValues = (r: Full): ReadingValues => ({
  title: r.title,
  visibility: r.visibility,
  alternative: alternativeText(r),
  archived: r.archived,
});

function ReadingFields({
  courseId,
  server,
  onSaved,
}: {
  courseId: string;
  server: Full;
  onSaved: () => void;
}) {
  const { values, change, state, retry, takeTheirs, keepMine } = useAutosave({
    server,
    toValues: toReadingValues,
    save: (v, expectedRevision) =>
      call(updateResource, {
        params: { courseId, resourceId: server.id },
        body: {
          expectedRevision,
          title: v.title.trim() || server.title,
          visibility: v.visibility,
          archived: v.archived,
          // Only a changed alternative makes a new revision (and a new processing job).
          ...(v.alternative.trim() !== alternativeText(server).trim() && {
            accessibleAlternative: v.alternative.trim() ? { text: v.alternative.trim() } : null,
          }),
        },
      }),
    onSaved,
  });
  const rows = (theirs: Full) => {
    const t = toReadingValues(theirs);
    return (
      [
        ['Title', values.title, t.title],
        ['Visibility', values.visibility, t.visibility],
        ['Accessible alternative', values.alternative, t.alternative],
      ] as const
    )
      .filter(([, a, b]) => a !== b)
      .map(([label, mine, other]) => ({ label, mine, theirs: other }));
  };
  return (
    <div>
      <SaveStatus state={state} onRetry={retry} />
      {state.kind === 'conflict' ? (
        <ConflictView
          what="reading"
          rows={rows(state.current)}
          onKeepMine={() => keepMine(state.current)}
          onUseTheirs={() => takeTheirs(state.current)}
        />
      ) : null}
      <label className={local.field}>
        Reading title
        <input
          type="text"
          value={values.title}
          onChange={(e) => change({ title: e.target.value })}
        />
      </label>
      <label className={local.field}>
        Visibility
        <select
          value={values.visibility}
          onChange={(e) => change({ visibility: e.target.value as 'visible' | 'hidden' })}
        >
          <option value="visible">Visible to students</option>
          <option value="hidden">Hidden from students</option>
        </select>
      </label>
      <div className={local.field}>
        <label htmlFor={`alternative-${server.id}`}>Accessible alternative</label>
        <textarea
          id={`alternative-${server.id}`}
          value={values.alternative}
          onChange={(e) => change({ alternative: e.target.value })}
        />
      </div>
      <div className={styles.row} style={{ marginTop: 16 }}>
        <button
          type="button"
          className={styles.textButton}
          onClick={() => change({ archived: !values.archived })}
        >
          {values.archived ? 'Restore this reading' : 'Archive this reading'}
        </button>
      </div>
    </div>
  );
}
