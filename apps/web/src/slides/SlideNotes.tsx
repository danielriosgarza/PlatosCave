import type { Anchor } from '@parallax/contracts';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  type Annotation,
  type Thread,
  useMarginActions,
  useMarginList,
} from '../reading/margin/data';
import {
  allowDrafts,
  type Draft,
  draftKey,
  listDrafts,
  removeDraft,
  saveDraft,
} from '../reading/margin/drafts';
import margin from '../reading/margin/Margin.module.css';
import { NoteController, type NoteState } from '../reading/margin/notes';
import { audienceLabel, ConflictView, SaveLine } from '../reading/margin/ReadingMargin';
import { useSession } from '../session/useSession';

type Tab = 'notes' | 'discussion';
type Audience = 'instructor' | 'class';

interface Ask {
  body: string;
  audience: Audience;
  /** What the last attempt to post said; the text is kept either way. */
  problem: 'offline' | 'failed' | null;
  posting: boolean;
}

const BLANK_ASK: Ask = { body: '', audience: 'instructor', problem: null, posting: false };

/** A slide anchor counts pages from zero (ADR-0003); the viewer counts slides from one. */
const anchorOf = (slide: number): Anchor => ({ kind: 'slide', page: slide - 1 });
const slideOf = (anchor: Anchor | null | undefined): number | null =>
  anchor?.kind === 'slide' ? anchor.page + 1 : null;

/**
 * Where an entry sits in the deck the class studies now: its placement (ADR-0003), or its own
 * anchor when no placement says otherwise. An entry the new revision could not place stays
 * listed, against the slide it was made on, until the instructor maps it.
 */
function whereIs(entry: Annotation | Thread): { slide: number | null; unmapped: boolean } {
  const placement = entry.placement;
  const original = slideOf(entry.anchor);
  if (!placement) return { slide: original, unmapped: false };
  if (placement.status === 'needs_reattachment' || placement.status === 'pending') {
    return { slide: original, unmapped: true };
  }
  return { slide: slideOf(placement.anchor ?? entry.anchor), unmapped: false };
}

const askKey = (slide: number) => `ask-${slide}`;

interface Props {
  classId: string;
  /** The deck's resource: notes and questions belong to it across revisions. */
  resourceId: string;
  /** The slide shown, 1-based. */
  page: number;
}

/**
 * The margin of the slide viewer (§7): private notes and discussion for the slide shown. Each
 * slide keeps its own note and unsent question, so moving on neither saves into the wrong slide
 * nor overwrites the draft of the one left behind.
 */
export function SlideNotes({ classId, resourceId, page }: Props) {
  const session = useSession();
  const userId = session.status === 'signed-in' ? session.me.user.id : null;
  const list = useMarginList(classId, resourceId);
  const actions = useMarginActions(classId, resourceId);

  const [tab, setTab] = useState<Tab>('notes');
  const [asks, setAsks] = useState<Record<number, Ask>>({});
  const [deleteProblem, setDeleteProblem] = useState<string | null>(null);
  const [, rerender] = useState(0);
  const controllers = useRef(new Map<string, NoteController>());
  const touch = useCallback(() => rerender((n) => n + 1), []);

  const make = (
    key: string,
    slide: number,
    init: Partial<ConstructorParameters<typeof NoteController>[0]>,
  ) => {
    const anchor = anchorOf(slide);
    const scoped = userId ? draftKey(userId, classId, resourceId, key) : null;
    const controller = new NoteController(
      { key, anchor, body: '', annotationId: null, revision: null, ...init },
      {
        create: (a, body) => actions.createNote(a, body),
        save: (id, revision, body, final) => actions.saveNote(id, revision, body, final),
        persist: (d) => {
          if (!scoped || !userId) return;
          if (!d) return void removeDraft(scoped);
          const draft: Draft = {
            key: scoped,
            userId,
            classId,
            resourceId,
            kind: 'note',
            annotationId: d.annotationId,
            expectedRevision: d.revision,
            anchor,
            body: d.body,
            audience: null,
            updatedAt: Date.now(),
          };
          void saveDraft(draft);
        },
        acknowledged: (annotation) => actions.acknowledged(annotation),
        forget: (id) => actions.forget(id),
      },
    );
    controller.subscribe(touch);
    controllers.current.set(key, controller);
    return controller;
  };

  // Unsent text of this person for this deck comes back after a reload, whichever slide it was on.
  // No editor is made before it has: an editor made first would hold the server's text, and the
  // next keystroke would overwrite the draft kept on the device.
  const scope = `${userId ?? 'anonymous'}|${classId}|${resourceId}`;
  const [restoredFor, setRestoredFor] = useState<string | null>(null);
  const ready = restoredFor === scope;
  // biome-ignore lint/correctness/useExhaustiveDependencies: restores once per person and deck
  useEffect(() => {
    if (!userId) return setRestoredFor(scope);
    void allowDrafts(userId);
    let current = true;
    void listDrafts(userId, classId, resourceId).then((drafts) => {
      if (!current) return;
      for (const d of drafts) {
        const id = d.key.split('|')[3] ?? d.key;
        const slide = slideOf(d.anchor);
        if (slide === null) continue;
        if (d.kind === 'ask') {
          setAsks((all) => ({
            ...all,
            [slide]: { ...BLANK_ASK, body: d.body, audience: d.audience ?? 'instructor' },
          }));
        } else if (!controllers.current.has(id)) {
          make(id, slide, {
            body: d.body,
            annotationId: d.annotationId,
            revision: d.expectedRevision,
            unsent: true,
          });
        }
      }
      setRestoredFor(scope);
    });
    return () => {
      current = false;
    };
  }, [userId, classId, resourceId]);

  // Pending saves are sent when the margin goes away (it is hidden, or another tab opens).
  useEffect(() => {
    const held = controllers.current;
    return () => {
      for (const c of held.values()) c.dispose();
    };
  }, []);

  const controllerOf = (annotationId: string) =>
    [...controllers.current.values()].find((c) => c.annotationId === annotationId);

  const annotations = (list.data?.annotations ?? []).filter((a) => a.kind === 'note');
  const threads = list.data?.threads ?? [];

  const here = annotations.filter((a) => {
    const where = whereIs(a);
    return !where.unmapped && where.slide === page;
  });
  const earlier = annotations.filter((a) => whereIs(a).unmapped);
  const threadsHere = threads.filter((t) => {
    const where = whereIs(t);
    return !where.unmapped && where.slide === page;
  });
  const earlierThreads = threads.filter((t) => whereIs(t).unmapped);

  // Each note has its editor once the drafts are back: one for every note on the slide shown, and,
  // on a slide with none, an empty one that creates the note only once something is typed.
  const fresh = (slide: number) =>
    [...controllers.current.values()].find(
      (c) => c.annotationId === null && slideOf(c.anchor) === slide,
    );
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the notes on the slide shown
  useEffect(() => {
    if (!ready || list.isLoading) return;
    let made = false;
    for (const a of here) {
      if (controllerOf(a.id)) continue;
      make(a.id, page, { body: a.body ?? '', annotationId: a.id, revision: a.revision });
      made = true;
    }
    if (here.length === 0 && !fresh(page)) {
      make(`slide-${page}`, page, {});
      made = true;
    }
    if (made) touch();
  });

  const removeNote = async (
    key: string,
    controller: NoteController | undefined,
    id: string | null,
  ) => {
    setDeleteProblem(null);
    const left = controller ? await controller.discard() : null;
    const stored = left?.id ?? id;
    if (stored && !(await actions.remove(stored))) {
      if (controller && left) {
        if (left.annotation) actions.acknowledged(left.annotation);
        const saved = (left.annotation ?? annotations.find((a) => a.id === stored))?.body ?? '';
        make(controller.key, slideOf(controller.anchor) ?? page, {
          body: left.body,
          annotationId: stored,
          revision: left.revision,
          unsent: left.body !== saved,
        });
      }
      setDeleteProblem(key);
      touch();
      return;
    }
    if (controller) {
      controllers.current.delete(controller.key);
      if (userId) void removeDraft(draftKey(userId, classId, resourceId, controller.key));
    }
    touch();
  };

  const ask = asks[page] ?? BLANK_ASK;
  const askRef = useRef(asks);
  askRef.current = asks;
  const setAsk = (slide: number, patch: Partial<Ask>) => {
    const next = { ...(askRef.current[slide] ?? BLANK_ASK), ...patch };
    setAsks((all) => ({ ...all, [slide]: next }));
    if (!userId) return;
    const key = draftKey(userId, classId, resourceId, askKey(slide));
    if (next.body.trim() === '') return void removeDraft(key);
    void saveDraft({
      key,
      userId,
      classId,
      resourceId,
      kind: 'ask',
      annotationId: null,
      expectedRevision: null,
      anchor: anchorOf(slide),
      body: next.body,
      audience: next.audience,
      updatedAt: Date.now(),
    });
  };
  const post = async () => {
    // The slide is read now: the answer may come back after the viewer has moved on.
    const slide = page;
    const posted = ask.body.trim();
    if (posted === '' || ask.posting) return;
    setAsks((all) => ({ ...all, [slide]: { ...ask, posting: true, problem: null } }));
    const result = await actions.ask(ask.audience, anchorOf(slide), posted);
    const latest = askRef.current[slide] ?? BLANK_ASK;
    if ('id' in result) {
      // Text typed while the question was posting was never posted: it stays, as a new draft.
      const next =
        latest.body.trim() === posted
          ? { ...latest, body: '', posting: false, problem: null }
          : { ...latest, posting: false, problem: null };
      setAsks((all) => ({ ...all, [slide]: next }));
      if (userId) {
        const key = draftKey(userId, classId, resourceId, askKey(slide));
        if (next.body.trim() === '') void removeDraft(key);
      }
      return;
    }
    setAsks((all) => ({
      ...all,
      [slide]: {
        ...latest,
        posting: false,
        problem: result.kind === 'offline' ? 'offline' : 'failed',
      },
    }));
  };

  const notesHere = [
    ...here.map((a) => ({ key: a.id, annotation: a, controller: controllerOf(a.id) })),
    ...[...controllers.current.values()]
      .filter((c) => c.annotationId === null && slideOf(c.anchor) === page)
      .map((c) => ({ key: c.key, annotation: null, controller: c })),
  ];

  return (
    <div className={margin.margin}>
      <div className={margin.tabs}>
        <button type="button" aria-pressed={tab === 'notes'} onClick={() => setTab('notes')}>
          My notes
        </button>
        <button
          type="button"
          aria-pressed={tab === 'discussion'}
          onClick={() => setTab('discussion')}
        >
          Discussion <span className={margin.count}>{threadsHere.length}</span>
        </button>
      </div>
      {list.isError && !list.data ? (
        <p role="alert" className={margin.empty}>
          Notes could not be loaded.{' '}
          <button type="button" className={margin.link} onClick={() => void list.refetch()}>
            Try again
          </button>
        </p>
      ) : tab === 'notes' ? (
        <div className={margin.entries}>
          {deleteProblem ? (
            <p role="alert" className={margin.empty}>
              The note could not be deleted. It is still saved, with your changes.
            </p>
          ) : null}
          {notesHere.map((n) => {
            const controller = n.controller;
            if (!controller) return null;
            return (
              <SlideNote
                key={controller.key}
                slide={page}
                controller={controller}
                onRemove={() => void removeNote(n.key, controller, n.annotation?.id ?? null)}
              />
            );
          })}
          {earlier.length > 0 ? (
            <section aria-label="Notes on an earlier version of this deck">
              <h4 className={margin.small}>Earlier version of this deck</h4>
              {earlier.map((a) => (
                <div key={a.id} className={margin.entry}>
                  <div className={margin.entryHead}>
                    <span>Slide {slideOf(a.anchor) ?? '?'}</span>
                    <span className={margin.muted}>
                      {a.placement?.status === 'pending'
                        ? 'Waiting to be placed'
                        : 'Needs reattachment'}
                    </span>
                  </div>
                  {a.body ? <p className={margin.preview}>{a.body}</p> : null}
                </div>
              ))}
            </section>
          ) : null}
        </div>
      ) : (
        <div className={margin.entries}>
          {threadsHere.length === 0 ? (
            <p className={margin.empty}>No questions or comments on this slide yet.</p>
          ) : null}
          {threadsHere.map((t) => (
            <ThreadEntry key={t.id} thread={t} userId={userId} />
          ))}
          {earlierThreads.length > 0 ? (
            <section aria-label="Discussion on an earlier version of this deck">
              <h4 className={margin.small}>Earlier version of this deck</h4>
              {earlierThreads.map((t) => (
                <ThreadEntry
                  key={t.id}
                  thread={t}
                  userId={userId}
                  note={`Slide ${slideOf(t.anchor) ?? '?'} · ${t.placement?.status === 'pending' ? 'Waiting to be placed' : 'Needs reattachment'}`}
                />
              ))}
            </section>
          ) : null}
          <div className={margin.composer}>
            <label className={margin.field}>
              Visible to
              <select
                value={ask.audience}
                onChange={(e) => setAsk(page, { audience: e.target.value as Audience })}
              >
                <option value="instructor">Instructor</option>
                <option value="class">Class</option>
              </select>
            </label>
            <label className={margin.field}>
              Comment or question
              <textarea
                id="slide-question"
                rows={3}
                placeholder={`Ask about slide ${page}`}
                value={ask.body}
                onChange={(e) => setAsk(page, { body: e.target.value })}
              />
            </label>
            <div className={margin.saveLine} role="status">
              {ask.problem === 'offline'
                ? 'Offline · your text is kept on this device. Post when you are back online.'
                : ask.problem === 'failed'
                  ? 'Could not post. Your text is kept.'
                  : null}
            </div>
            <button
              type="button"
              className={margin.outline}
              disabled={ask.body.trim() === '' || ask.posting}
              onClick={() => void post()}
            >
              {ask.problem ? 'Retry' : 'Post'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const idleState: NoteState = {
  body: '',
  status: 'idle',
  conflict: null,
  created: true,
  reason: null,
  gone: false,
};

function SlideNote({
  slide,
  controller,
  onRemove,
}: {
  slide: number;
  controller: NoteController;
  onRemove: () => void;
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot) ?? idleState;
  return (
    <div className={margin.entry} data-active="true">
      <div className={margin.entryHead}>
        <span>Slide {slide}</span>
        <span className={margin.muted}>Private</span>
      </div>
      {state.status === 'conflict' && state.conflict ? (
        <ConflictView controller={controller} mine={state.body} saved={state.conflict.body ?? ''} />
      ) : (
        <label className={margin.field}>
          {`Your note on slide ${slide}`}
          <textarea
            rows={6}
            value={state.body}
            onChange={(e) => controller.edit(e.target.value)}
            onBlur={() => controller.blur()}
          />
        </label>
      )}
      <SaveLine
        state={state}
        onRetry={() => controller.retry()}
        onSaveAsNew={() => controller.saveAsNew()}
      />
      {state.created || state.body.trim() !== '' ? (
        <button type="button" className={margin.link} onClick={onRemove}>
          Delete note
        </button>
      ) : null}
    </div>
  );
}

function ThreadEntry({
  thread,
  userId,
  note,
}: {
  thread: Thread;
  userId: string | null;
  note?: string;
}) {
  const mine = thread.author.id === userId;
  return (
    <div className={`${margin.entry} ${margin.thread}`}>
      <div className={margin.entryHead}>
        <span>
          {mine ? 'You' : thread.author.name} → {audienceLabel(thread.audience)}
        </span>
        <span>{thread.status === 'open' ? 'Open' : 'Resolved'}</span>
      </div>
      {note ? <div className={margin.small}>{note}</div> : null}
      {thread.posts.map((p) => (
        <p key={p.id}>
          {p.body ?? (p.deleted ? 'This post was deleted.' : 'This post was removed.')}
        </p>
      ))}
    </div>
  );
}
