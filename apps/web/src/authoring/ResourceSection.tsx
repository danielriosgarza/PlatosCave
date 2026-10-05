import { type processingEntry, retryProcessing } from '@parallax/contracts/routes/authoring';
import {
  createResource,
  type draftResource,
  type draftResourceSummary,
  getResource,
  updateResource,
} from '@parallax/contracts/routes/drafts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import type { z } from 'zod';
import { call } from '../api/client';
import buttons from '../components/Buttons.module.css';
import styles from '../components/Page.module.css';
import { AddNotebook } from './AddNotebook';
import { AddReading } from './AddReading';
import local from './Authoring.module.css';
import { useAutosave } from './autosave';
import { ConflictView } from './ConflictView';
import { ExerciseEditor } from './ExerciseEditor';
import { authoringKey, processingQuery } from './queries';
import { SaveStatus } from './SaveStatus';
import { AddShiny, ShinyEditor } from './ShinyApp';
import { TestEditor } from './TestEditor';
import { AddWebSlides, WebSlidesEditor } from './WebSlides';

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

const isExercise = (t: Type) => t === 'exercise';
const isReading = (t: Type) => t === 'reading_native' || t === 'reading_pdf';
const isWebSlides = (t: Type) => t === 'slides_web';
const isTest = (t: Type) => t === 'test';
const isShiny = (t: Type) => t === 'shiny';

interface Props {
  courseId: string;
  topicId: string;
  resources: ResourceSummary[];
}

/**
 * The topic's resources grouped by destination tab, with Add reading on the Reading tab and Add
 * notebook on the Notebooks tab (§12).
 */
export function ResourceSection({ courseId, topicId, resources }: Props) {
  const queryClient = useQueryClient();
  const processing = useQuery(processingQuery(courseId));
  const [adding, setAdding] = useState(false);
  const [addingNotebook, setAddingNotebook] = useState(false);
  const [addingSlides, setAddingSlides] = useState(false);
  const [addingShiny, setAddingShiny] = useState(false);
  const refresh = useCallback(
    () => queryClient.invalidateQueries({ queryKey: authoringKey(courseId) }),
    [queryClient, courseId],
  );
  const lookup: Lookup = processing.data
    ? { kind: 'known' }
    : processing.isError
      ? { kind: 'error', reload: () => void processing.refetch() }
      : { kind: 'loading' };
  const stateOf = (id: string) => processing.data?.resources.find((r) => r.resourceId === id);

  return (
    <div>
      <h2 className={`${styles.sectionTitle} ${styles.mt40}`}>Resources</h2>
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
                lookup={lookup}
                onChanged={() => void refresh()}
              />
            ))}
            {tab.name === 'Slides' ? (
              addingSlides ? (
                <AddWebSlides
                  courseId={courseId}
                  topicId={topicId}
                  onCancel={() => setAddingSlides(false)}
                  onAdded={() => {
                    setAddingSlides(false);
                    void refresh();
                  }}
                />
              ) : (
                <div className={styles.mt12}>
                  <button
                    type="button"
                    className={buttons.outline}
                    onClick={() => setAddingSlides(true)}
                  >
                    Add web slides
                  </button>
                </div>
              )
            ) : null}
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
                <div className={styles.mt12}>
                  <button type="button" className={buttons.outline} onClick={() => setAdding(true)}>
                    Add reading
                  </button>
                </div>
              )
            ) : null}
            {tab.name === 'Notebooks' ? (
              addingNotebook ? (
                <AddNotebook
                  courseId={courseId}
                  topicId={topicId}
                  onCancel={() => setAddingNotebook(false)}
                  onAdded={() => {
                    setAddingNotebook(false);
                    void refresh();
                  }}
                />
              ) : (
                <div className={styles.mt12}>
                  <button
                    type="button"
                    className={buttons.outline}
                    onClick={() => setAddingNotebook(true)}
                  >
                    Add notebook
                  </button>
                </div>
              )
            ) : null}
            {tab.name === 'Notebooks' ? (
              addingShiny ? (
                <AddShiny
                  courseId={courseId}
                  topicId={topicId}
                  onCancel={() => setAddingShiny(false)}
                  onAdded={() => {
                    setAddingShiny(false);
                    void refresh();
                  }}
                />
              ) : (
                <div className={styles.mt12}>
                  <button
                    type="button"
                    className={buttons.outline}
                    onClick={() => setAddingShiny(true)}
                  >
                    Add Shiny app
                  </button>
                </div>
              )
            ) : null}
            {tab.name === 'Exercises' ? (
              <AddExercise courseId={courseId} topicId={topicId} onAdded={() => void refresh()} />
            ) : null}
            {tab.name === 'Tests' ? (
              <AddExercise
                courseId={courseId}
                topicId={topicId}
                type="test"
                onAdded={() => void refresh()}
              />
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

type Status = z.output<typeof processingEntry>;

/** What is known about a reading's processing: the server's entry, or why there is none yet. */
type Lookup = { kind: 'loading' } | { kind: 'error'; reload: () => void } | { kind: 'known' };

function StatusLine({
  courseId,
  resource,
  status,
  lookup,
}: {
  courseId: string;
  resource: ResourceSummary;
  status?: Status;
  lookup: Lookup;
}) {
  const queryClient = useQueryClient();
  const retry = useMutation({
    mutationFn: () => call(retryProcessing, { params: { courseId, resourceId: resource.id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: authoringKey(courseId) }),
  });
  const processed =
    isReading(resource.type) ||
    isWebSlides(resource.type) ||
    resource.type === 'slides_pdf' ||
    resource.type === 'notebook';
  if (!processed || resource.archived) {
    return null;
  }
  if (lookup.kind !== 'known') {
    return (
      <div className={local.resourceMeta} role="status" aria-busy={lookup.kind === 'loading'}>
        {lookup.kind === 'loading' ? (
          'Checking processing…'
        ) : (
          <>
            Processing status could not be loaded.{' '}
            <button type="button" className={buttons.textButton} onClick={lookup.reload}>
              Reload status
            </button>
          </>
        )}
      </div>
    );
  }
  const state = status?.state ?? null;
  const labels = {
    queued: 'Waiting to be processed',
    running: 'Processing',
    // A deck can still be blocked at publication (raster-only without a text alternative).
    ready: resource.type === 'slides_pdf' ? 'Processed' : 'Ready to publish',
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
            className={buttons.textButton}
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
  lookup,
  onChanged,
}: {
  courseId: string;
  resource: ResourceSummary;
  status?: Status;
  lookup: Lookup;
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
          <StatusLine courseId={courseId} resource={resource} status={status} lookup={lookup} />
        </div>
        {isReading(resource.type) ||
        isWebSlides(resource.type) ||
        isShiny(resource.type) ||
        isExercise(resource.type) ||
        isTest(resource.type) ? (
          <button
            type="button"
            className={buttons.textButton}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            {open ? 'Close' : `Edit ${resource.title}`}
          </button>
        ) : null}
      </div>
      {open && isExercise(resource.type) ? (
        <ExerciseEditor courseId={courseId} resourceId={resource.id} onSaved={onChanged} />
      ) : null}
      {open && isTest(resource.type) ? (
        <TestEditor courseId={courseId} resourceId={resource.id} onSaved={onChanged} />
      ) : null}
      {open && isWebSlides(resource.type) ? (
        <WebSlidesEditor courseId={courseId} resourceId={resource.id} onSaved={onChanged} />
      ) : null}
      {open && isShiny(resource.type) ? (
        <ShinyEditor courseId={courseId} resourceId={resource.id} onSaved={onChanged} />
      ) : null}
      {open && isReading(resource.type) ? (
        <ReadingEditor courseId={courseId} resourceId={resource.id} onSaved={onChanged} />
      ) : null}
    </div>
  );
}

/** Creates an exercise or test without content; the editor's first valid save makes its first revision. */
function AddExercise({
  courseId,
  topicId,
  type = 'exercise',
  onAdded,
}: {
  courseId: string;
  topicId: string;
  type?: 'exercise' | 'test';
  onAdded: () => void;
}) {
  const noun = type === 'test' ? 'test' : 'exercise';
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const create = useMutation({
    mutationFn: () =>
      call(createResource, {
        params: { courseId, topicId },
        body: { type, title: title.trim() },
      }),
    onSuccess: () => {
      setAdding(false);
      setTitle('');
      onAdded();
    },
  });
  if (!adding) {
    return (
      <div className={styles.mt12}>
        <button type="button" className={buttons.outline} onClick={() => setAdding(true)}>
          Add {noun}
        </button>
      </div>
    );
  }
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (title.trim()) create.mutate();
      }}
    >
      <label className={local.field}>
        New {noun} title
        <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <div className={`${styles.row} ${styles.mt12}`}>
        <button
          type="submit"
          className={buttons.outline}
          disabled={!title.trim() || create.isPending}
        >
          Create {noun}
        </button>
        <button type="button" className={buttons.textButton} onClick={() => setAdding(false)}>
          Cancel
        </button>
      </div>
      {create.isError ? (
        <p role="alert" className={styles.small}>
          Could not create the {noun}.
        </p>
      ) : null}
    </form>
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
      <div className={`${styles.row} ${styles.mt16}`}>
        <button
          type="button"
          className={buttons.textButton}
          onClick={() => change({ archived: !values.archived })}
        >
          {values.archived ? 'Restore this reading' : 'Archive this reading'}
        </button>
      </div>
    </div>
  );
}
