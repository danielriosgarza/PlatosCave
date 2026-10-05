import type { Anchor } from '@parallax/contracts';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import buttons from '../../components/Buttons.module.css';
import { useSession } from '../../session/useSession';
import { downloadSvg, FIGURE_ASPECT, PAGE_ASPECT, sketchSvg } from '../sketch/exportSvg';
import { FigureSketches, figureLabel } from '../sketch/FigureSketches';
import { type PdfSketch, pdfSketch } from '../sketch/pdf';
import { SketchEntry } from '../sketch/SketchEntry';
import { type Surface, surfaceKey, surfaceOf, useSketches } from '../sketch/useSketches';
import {
  activateMarks,
  applyMarks,
  firstMarkTop,
  type MarkSource,
  marksAt,
  passageFromSelection,
  type SelectedPassage,
  type TextAnchor,
} from './anchors';
import {
  type Annotation,
  type MarginActions,
  type Thread,
  useMarginActions,
  useMarginList,
} from './data';
import {
  beginSend,
  type Draft,
  draftKey,
  listDrafts,
  removeDraft,
  saveDraft,
  sendsSettled,
} from './drafts';
import styles from './Margin.module.css';
import { NoteController, type NoteState } from './notes';
import { shownAnchor } from './placement';
import { ThreadPosts } from './ThreadEntry';

type Tab = 'notes' | 'discussion';
type Audience = 'instructor' | 'class';

interface Ask {
  anchor: Anchor;
  body: string;
  audience: Audience;
  /** What the last attempt to post said; the text is kept either way. */
  problem: 'offline' | 'failed' | null;
  posting: boolean;
}

const NO_ANCHOR: Anchor = { kind: 'none' };

/** The parts of a stored Ask draft that come from the composer. */
const askDraft = (ask: Ask) => ({
  kind: 'ask' as const,
  annotationId: null,
  expectedRevision: null,
  anchor: ask.anchor,
  body: ask.body,
  audience: ask.audience,
  updatedAt: Date.now(),
});
const ASK_ID = 'ask';
/** Side by side below this width the margin stacks under the reading and needs no alignment. */
const WIDE = '(min-width: 1100px)';

const textAnchorOf = (a: Anchor | null | undefined): TextAnchor | null =>
  a?.kind === 'text' ? a : null;

const quoteOf = (a: Anchor): string | null =>
  a.kind === 'text' || a.kind === 'pdf' ? (a.quote ?? null) : null;

export const audienceLabel = (a: 'instructor' | 'class') =>
  a === 'instructor' ? 'Instructor' : 'Class';

interface Props {
  classId: string;
  resourceId: string;
  /** The reading's HTML; marks are drawn again when it changes. Null for a PDF (no text anchors). */
  html: string | null;
  /** The margin is shown; the page's Notes button toggles it. */
  open: boolean;
  onOpen: () => void;
  /** Renders the reader and hands back its root element, where passages are selected and marked. */
  children: (setRoot: (root: HTMLDivElement | null) => void, pdf: PdfSketch) => ReactNode;
}

/**
 * The reading with its margin (§8): the selection toolbar (Highlight, Note, Ask), marks on
 * annotated passages, and the margin's My notes and Discussion lists. Text anchors apply to
 * native readings; a PDF reading takes topic notes and questions without a passage. Figures and
 * PDF pages take Sketch (§8), whose saved drawings are listed under My notes.
 */
export function ReadingMargin({ classId, resourceId, html, open, onOpen, children }: Props) {
  const session = useSession();
  const userId = session.status === 'signed-in' ? session.me.user.id : null;
  const list = useMarginList(classId, resourceId);
  const actions = useMarginActions(classId, resourceId);

  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [tab, setTab] = useState<Tab>('notes');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [deleteProblem, setDeleteProblem] = useState<string | null>(null);
  const [passage, setPassage] = useState<SelectedPassage | null>(null);
  const [toolsProblem, setToolsProblem] = useState<string | null>(null);
  const [highlighting, setHighlighting] = useState(false);
  const [ask, setAsk] = useState<Ask>({
    anchor: NO_ANCHOR,
    body: '',
    audience: 'instructor',
    problem: null,
    posting: false,
  });
  const [, rerender] = useState(0);
  const controllers = useRef(new Map<string, NoteController>());
  const wide = useRef(false);
  const [alignTop, setAlignTop] = useState(0);

  const touch = useCallback(() => rerender((n) => n + 1), []);

  // --- drafts: restore this person's unsent text for this reading, drop it all on sign-out ----
  const restored = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: restores once per person and reading
  useEffect(() => {
    if (!userId) return;
    const scope = `${userId}|${classId}|${resourceId}`;
    if (restored.current === scope) return;
    let current = true;
    // A save or question this reading's earlier visit is still sending is not restored as unsent.
    void sendsSettled(userId, classId, resourceId)
      .then(() => listDrafts(userId, classId, resourceId))
      .then((drafts) => {
        // Marked done only once applied: a StrictMode remount cancels the first read, not the restore.
        if (!current) return;
        restored.current = scope;
        for (const d of drafts) {
          const id = d.key.split('|')[3] ?? d.key;
          if (d.kind === 'ask') {
            setAsk((a) => ({
              ...a,
              anchor: d.anchor,
              body: d.body,
              audience: d.audience ?? 'instructor',
            }));
          } else if (!controllers.current.has(id)) {
            make(id, {
              key: id,
              anchor: d.anchor,
              body: d.body,
              annotationId: d.annotationId,
              revision: d.expectedRevision,
              unsent: true,
            });
          }
        }
        touch();
      });
    return () => {
      current = false;
    };
  }, [userId, classId, resourceId]);

  const noteDraft = (
    scoped: string,
    user: string,
    anchor: Anchor,
    d: { annotationId: string | null; revision: number | null; body: string },
  ): Draft => ({
    key: scoped,
    userId: user,
    classId,
    resourceId,
    kind: 'note',
    annotationId: d.annotationId,
    expectedRevision: d.revision,
    anchor,
    body: d.body,
    audience: null,
    updatedAt: Date.now(),
  });

  const make = (key: string, init: ConstructorParameters<typeof NoteController>[0]) => {
    const scoped = userId ? draftKey(userId, classId, resourceId, key) : null;
    const controller = new NoteController(
      { ...init, draftKey: scoped },
      {
        create: (anchor, body) => actions.createNote(anchor, body),
        save: (id, revision, body, final) => actions.saveNote(id, revision, body, final),
        persist: (d) => {
          if (!scoped || !userId) return;
          if (!d) return void removeDraft(scoped);
          void saveDraft(noteDraft(scoped, userId, init.anchor, d));
        },
        acknowledged: (annotation) => actions.acknowledged(annotation),
        forget: (id) => actions.forget(id),
      },
    );
    controller.subscribe(touch);
    controllers.current.set(key, controller);
    return controller;
  };

  // Pending saves are sent when the reading goes away (another tab, another reading).
  useEffect(() => {
    const held = controllers.current;
    return () => {
      for (const c of held.values()) c.dispose();
    };
  }, []);

  const controllerOf = (annotationId: string) =>
    [...controllers.current.values()].find((c) => c.annotationId === annotationId);

  const editorFor = (annotation: Annotation): NoteController =>
    controllerOf(annotation.id) ??
    make(annotation.id, {
      key: annotation.id,
      anchor: annotation.anchor,
      body: annotation.body ?? '',
      annotationId: annotation.id,
      revision: annotation.revision,
    });

  // --- sketches on figures and pages ------------------------------------------------------------
  const sketches = useSketches(actions, list.data?.annotations ?? []);
  const [showPage, setShowPage] = useState<{ page: number; seq: number } | null>(null);
  const surfaceLabel = (surface: Surface | null) =>
    !surface
      ? 'Figure'
      : surface.kind === 'page'
        ? `Page ${surface.page + 1}`
        : figureLabel(root, surface.figureId);

  // --- what the margin lists ------------------------------------------------------------------
  const annotations = list.data?.annotations ?? [];
  const threads = list.data?.threads ?? [];
  // A controller the server does not list (a new note, or one deleted elsewhere whose text is
  // kept) is an entry of its own, so its text and "Save as a new note" stay reachable.
  const listed = new Set(annotations.map((a) => a.id));
  const drafts = [...controllers.current.values()].filter((c) =>
    c.annotationId === null
      ? c.state.body.trim() !== '' || c.key === activeId
      : !listed.has(c.annotationId) && (c.state.gone || list.data !== undefined),
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the blocks change with the html
  const order = useMemo(() => {
    const ids = new Map<string, number>();
    const blocks = root ? [...root.querySelectorAll<HTMLElement>('[data-block-id]')] : [];
    for (const [i, block] of blocks.entries()) ids.set(block.dataset.blockId ?? '', i);
    return ids;
  }, [root, html]);
  const position = (a: Anchor | null) => {
    const text = textAnchorOf(a);
    return text ? (order.get(text.blockId) ?? 1e6) * 1e4 + text.start : 1e12;
  };

  // Sketches follow the notes: figures in reading order, then pages.
  const sketchEntries = [...sketches.saved].sort((a, b) => {
    const rank = (x: Surface | null) =>
      !x
        ? 1e9
        : x.kind === 'page'
          ? 1e6 + x.page
          : root
            ? [...root.querySelectorAll<HTMLElement>('figure[data-figure-id]')].findIndex(
                (f) => f.dataset.figureId === x.figureId,
              )
            : 0;
    return rank(a.surface) - rank(b.surface);
  });
  const openSketch = (annotation: Annotation, surface: Surface | null) => {
    if (!surface) return;
    sketches.edit(annotation);
    if (surface.kind === 'page') setShowPage({ page: surface.page, seq: Date.now() });
    else
      root
        ?.querySelector<HTMLElement>(`figure[data-figure-id="${surface.figureId}"]`)
        ?.scrollIntoView?.({ block: 'center' });
  };
  const exportSketch = (annotation: Annotation, surface: Surface | null) => {
    const label = surfaceLabel(surface);
    const aspect =
      (surface && sketches.aspects.current.get(surfaceKey(surface))) ||
      (surface?.kind === 'page' ? PAGE_ASPECT : FIGURE_ASPECT);
    downloadSvg(sketchSvg(annotation, label, aspect), label);
  };

  const notes = [
    ...annotations
      .filter((a) => a.kind !== 'sketch')
      .map((a) => ({
        id: a.id,
        annotation: a,
        controller: controllerOf(a.id),
        anchor: shownAnchor(a) ?? a.anchor,
      })),
    ...drafts.map((c) => ({ id: c.key, annotation: null, controller: c, anchor: c.anchor })),
  ].sort((a, b) => position(a.anchor) - position(b.anchor));

  // A new note keeps the key it was made under (so its editor is never remounted while typing);
  // once saved its marks carry the annotation id.
  const isActive = (n: { id: string; controller: NoteController | undefined }) =>
    activeId !== null && (activeId === n.id || activeId === n.controller?.key);
  const activeNote = notes.find(isActive);
  const activeMarkId = activeNote?.id ?? activeId;

  // --- marks ------------------------------------------------------------------------------------
  const sources: MarkSource[] = [];
  for (const n of notes) {
    const a = textAnchorOf(n.annotation ? shownAnchor(n.annotation) : n.anchor);
    if (a) sources.push({ id: n.id, anchor: a });
  }
  for (const t of threads) {
    const a = textAnchorOf(shownAnchor(t));
    if (a) sources.push({ id: t.id, anchor: a });
  }
  const sourcesKey = JSON.stringify(sources);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `sources` is read through its key
  useLayoutEffect(() => {
    if (!root) return;
    applyMarks(root, sources);
    activateMarks(root, activeMarkId);
  }, [root, html, sourcesKey, activeMarkId]);

  // --- the selection toolbar, in the flow after the passage's block -----------------------------
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!root || html === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = () => {
      const selection = window.getSelection();
      const found = selection ? passageFromSelection(root, selection) : null;
      // A click inside the toolbar or the margin keeps what was selected.
      if (!found && selection && !selection.isCollapsed) return;
      setPassage((previous) => {
        if (!found) return null;
        return previous && JSON.stringify(previous.anchor) === JSON.stringify(found.anchor)
          ? previous
          : found;
      });
      setToolsProblem(null);
    };
    const onChange = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(read, 120);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      if (timer) clearTimeout(timer);
      document.removeEventListener('selectionchange', onChange);
    };
  }, [root, html]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the host follows the passage's block
  useLayoutEffect(() => {
    if (!passage?.block.isConnected) return setHost(null);
    const element = document.createElement('div');
    passage.block.after(element);
    setHost(element);
    return () => element.remove();
  }, [passage?.block, passage?.anchor.blockId]);

  const clearSelection = () => {
    window.getSelection()?.removeAllRanges();
    setPassage(null);
  };

  const highlight = async () => {
    if (!passage || highlighting) return;
    setHighlighting(true);
    const result = await actions.highlight(passage.anchor).finally(() => setHighlighting(false));
    if (result.kind === 'ok') {
      clearSelection();
      return;
    }
    setToolsProblem(
      result.kind === 'offline' ? 'Offline · not saved' : 'Could not save the highlight',
    );
  };
  const note = () => {
    if (!passage) return;
    const key = crypto.randomUUID();
    make(key, { key, anchor: passage.anchor, body: '', annotationId: null, revision: null });
    clearSelection();
    onOpen();
    setTab('notes');
    setActiveId(key);
    setFocusId(key);
  };
  const askAbout = () => {
    if (!passage) return;
    setAsk((a) => ({ ...a, anchor: passage.anchor, problem: null }));
    clearSelection();
    onOpen();
    setTab('discussion');
    setFocusId(ASK_ID);
  };
  const topicNote = () => {
    const key = crypto.randomUUID();
    make(key, { key, anchor: NO_ANCHOR, body: '', annotationId: null, revision: null });
    setTab('notes');
    setActiveId(key);
    setFocusId(key);
  };

  // --- a mark opens its entry; an entry scrolls to and marks its passage ------------------------
  const select = useCallback(
    (id: string, scroll: boolean) => {
      const isThread = threads.some((t) => t.id === id);
      setTab(isThread ? 'discussion' : 'notes');
      setActiveId(id);
      if (!isThread) setFocusId(id);
      if (root) {
        const mark = activateMarks(root, id);
        if (scroll) mark?.scrollIntoView({ block: 'center' });
      }
    },
    [root, threads],
  );

  useEffect(() => {
    if (!root) return;
    const open = (target: EventTarget | null) => {
      const ids = marksAt(target);
      const known = new Set([...notes.map((n) => n.id), ...threads.map((t) => t.id)]);
      const first = ids?.find((id) => known.has(id));
      if (!first) return false;
      onOpen();
      select(first, false);
      return true;
    };
    const click = (e: MouseEvent) => {
      // A drag that selects text ends in a click on the mark; only a plain click opens an entry.
      if (window.getSelection()?.isCollapsed === false) return;
      open(e.target);
    };
    const key = (e: KeyboardEvent) => {
      if ((e.key === 'Enter' || e.key === ' ') && open(e.target)) e.preventDefault();
    };
    root.addEventListener('click', click);
    root.addEventListener('keydown', key);
    return () => {
      root.removeEventListener('click', click);
      root.removeEventListener('keydown', key);
    };
  }, [root, notes, threads, onOpen, select]);

  // --- the editor of the selected note sits beside its passage (measured after layout) -----------
  const entriesRef = useRef<HTMLDivElement>(null);
  const measure = useCallback(() => {
    wide.current = typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches;
    const entry = entriesRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    const top = root && activeMarkId ? firstMarkTop(root, activeMarkId) : null;
    if (!entry || top === null || !wide.current || tab !== 'notes') return setAlignTop(0);
    // The entry's own shift is already in its position: take it out to find where it would sit.
    const natural =
      entry.getBoundingClientRect().top - (Number.parseFloat(entry.style.marginTop) || 0);
    setAlignTop(Math.max(0, Math.round(top - natural)));
  }, [root, activeMarkId, tab]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measures after each layout that moves the passage
  useLayoutEffect(() => {
    measure();
  }, [measure, sourcesKey, open, html, notes.length]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: observers follow the shown tab and margin
  useEffect(() => {
    if (!root) return;
    window.addEventListener('resize', measure);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(root);
    if (entriesRef.current) observer?.observe(entriesRef.current);
    root.addEventListener('load', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      observer?.disconnect();
      root.removeEventListener('load', measure, true);
    };
  }, [root, measure, tab, open]);

  // --- Ask drafts -------------------------------------------------------------------------------
  const setAskDraft = (patch: Partial<Ask>) => {
    const next = { ...ask, ...patch };
    setAsk(next);
    if (!userId) return;
    const key = draftKey(userId, classId, resourceId, ASK_ID);
    if (next.body.trim() === '') return void removeDraft(key);
    void saveDraft({ ...askDraft(next), key, userId, classId, resourceId });
  };
  const askRef = useRef(ask);
  askRef.current = ask;
  const post = async () => {
    const posted = ask.body.trim();
    if (posted === '' || ask.posting) return;
    setAsk((a) => ({ ...a, posting: true, problem: null }));
    // The question's draft stays until the server answers; a reading opened again meanwhile waits.
    const sent = userId ? beginSend(draftKey(userId, classId, resourceId, ASK_ID)) : null;
    try {
      await postQuestion(posted);
    } finally {
      sent?.();
    }
  };
  const postQuestion = async (posted: string) => {
    const result = await actions.ask(ask.audience, ask.anchor, posted);
    if ('id' in result) {
      setActiveId(result.id);
      const latest = askRef.current;
      // Text typed while the question was posting was never posted: only that part stays, as a
      // new draft. (The posted text is what the body started with when Post was pressed.)
      const typed = latest.body.startsWith(ask.body) ? latest.body.slice(ask.body.length) : null;
      const next = {
        ...latest,
        anchor: NO_ANCHOR,
        body: latest.body.trim() === posted ? '' : (typed ?? latest.body),
        posting: false,
        problem: null,
      };
      setAsk(next);
      if (userId) {
        const key = draftKey(userId, classId, resourceId, ASK_ID);
        if (next.body.trim() === '') void removeDraft(key);
        else void saveDraft({ ...askDraft(next), key, userId, classId, resourceId });
      }
      return;
    }
    setAsk((a) => ({
      ...a,
      posting: false,
      problem: result.kind === 'offline' ? 'offline' : 'failed',
    }));
  };

  const removeNote = async (entryId: string, controller: NoteController | undefined) => {
    setDeleteProblem(null);
    // A save still running is waited for, so a note it creates is deleted too and cannot return.
    const left = controller ? await controller.discard() : null;
    const stored = left?.id ?? (annotations.some((a) => a.id === entryId) ? entryId : null);
    if (stored && !(await actions.remove(stored))) {
      // The note is still there: bring back its editor with the text as it stood, edits included.
      if (controller && left) {
        if (left.annotation) actions.acknowledged(left.annotation);
        const saved = (left.annotation ?? annotations.find((a) => a.id === stored))?.body ?? '';
        const unsent = left.body !== saved;
        make(controller.key, {
          key: controller.key,
          anchor: controller.anchor,
          body: left.body,
          annotationId: stored,
          revision: left.revision,
          unsent,
        });
        // A save that finished during the delete moved the note on: the device's draft must not
        // keep the old id and revision (it would create the note twice, or open a false conflict).
        if (userId) {
          const scoped = draftKey(userId, classId, resourceId, controller.key);
          if (unsent) {
            void saveDraft(
              noteDraft(scoped, userId, controller.anchor, {
                annotationId: stored,
                revision: left.revision,
                body: left.body,
              }),
            );
          } else void removeDraft(scoped);
        }
      }
      setDeleteProblem(controller?.key ?? entryId);
      touch();
      return;
    }
    if (controller) {
      controllers.current.delete(controller.key);
      if (userId) void removeDraft(draftKey(userId, classId, resourceId, controller.key));
    }
    setActiveId(null);
    touch();
  };

  // Focus follows a new note or question to its editor (selecting a note moves focus to it).
  useEffect(() => {
    if (!focusId) return;
    const entry = notes.find((n) => n.id === focusId || n.controller?.key === focusId);
    // A highlight has no editor to focus.
    if (entry?.annotation?.kind === 'highlight') return setFocusId(null);
    const dom =
      focusId === ASK_ID ? 'margin-question' : `note-${entry?.controller?.key ?? focusId}`;
    const target = document.getElementById(dom);
    if (target) {
      target.focus();
      setFocusId(null);
    }
  });

  const toolbar =
    host && passage
      ? createPortal(
          <Tools
            problem={toolsProblem}
            busy={highlighting}
            onHighlight={() => void highlight()}
            onNote={note}
            onAsk={askAbout}
          />,
          host,
        )
      : null;

  return (
    <div className={`${styles.grid} ${open ? '' : styles.noMargin}`}>
      <div>
        {children(setRoot, pdfSketch(sketches, showPage))}
        {toolbar}
        <FigureSketches root={root} html={html} api={sketches} />
      </div>
      {open ? (
        <aside className={styles.margin} aria-label="Notes and discussion">
          <div className={styles.tabs}>
            <button type="button" aria-pressed={tab === 'notes'} onClick={() => setTab('notes')}>
              My notes
            </button>
            <button
              type="button"
              aria-pressed={tab === 'discussion'}
              onClick={() => setTab('discussion')}
            >
              Discussion <span className={styles.count}>{threads.length}</span>
            </button>
          </div>
          {list.isError && !list.data ? (
            <p role="alert" className={styles.empty}>
              Notes could not be loaded.{' '}
              <button type="button" className={styles.link} onClick={() => void list.refetch()}>
                Try again
              </button>
            </p>
          ) : tab === 'notes' ? (
            <div ref={entriesRef} className={styles.entries}>
              {notes.length === 0 && sketches.saved.length === 0 ? (
                <p className={styles.empty}>
                  {html === null
                    ? 'No notes on this reading yet.'
                    : 'Select text in the reading to highlight it or add a note.'}
                </p>
              ) : null}
              {deleteProblem ? (
                <p role="alert" className={styles.empty}>
                  The note could not be deleted. Your text is kept.{' '}
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => {
                      const entry = notes.find(
                        (n) => (n.controller?.key ?? n.id) === deleteProblem,
                      );
                      if (entry) void removeNote(entry.id, entry.controller);
                    }}
                  >
                    Try again
                  </button>
                </p>
              ) : null}
              {notes.map((n, index) => (
                <NoteEntry
                  key={n.controller?.key ?? n.id}
                  id={n.controller?.key ?? n.id}
                  index={index}
                  annotation={n.annotation}
                  controller={n.controller}
                  anchor={n.anchor}
                  place={surfaceLabel(surfaceOf(n.anchor))}
                  active={isActive(n)}
                  alignTop={isActive(n) ? alignTop : 0}
                  onSelect={() => select(n.id, true)}
                  onEdit={(text) =>
                    (n.annotation ? editorFor(n.annotation) : n.controller)?.edit(text)
                  }
                  onBlur={() => n.controller?.blur()}
                  onRemove={() => void removeNote(n.id, n.controller)}
                  actions={actions}
                />
              ))}
              {sketchEntries.map(({ annotation, surface, editable }) => (
                <SketchEntry
                  key={annotation.id}
                  annotation={annotation}
                  label={surfaceLabel(surface ?? surfaceOf(annotation.anchor))}
                  needsReattachment={surface === null}
                  pending={annotation.placement?.status === 'pending'}
                  editing={sketches.open?.annotationId === annotation.id}
                  blocked={sketches.open !== null}
                  editable={editable}
                  onEdit={() => openSketch(annotation, surface)}
                  onExport={() => exportSketch(annotation, surface ?? surfaceOf(annotation.anchor))}
                  onDelete={() => actions.remove(annotation.id)}
                />
              ))}
              <p>
                <button type="button" className={styles.link} onClick={topicNote}>
                  Add a topic note
                </button>
              </p>
            </div>
          ) : (
            <Discussion
              threads={threads}
              userId={userId}
              actions={actions}
              activeId={activeId}
              onSelect={(id) => select(id, true)}
              ask={ask}
              onAsk={setAskDraft}
              onPost={() => void post()}
            />
          )}
        </aside>
      ) : null}
    </div>
  );
}

function Tools({
  problem,
  busy,
  onHighlight,
  onNote,
  onAsk,
}: {
  problem: string | null;
  busy: boolean;
  onHighlight: () => void;
  onNote: () => void;
  onAsk: () => void;
}) {
  // A press on the toolbar keeps the passage selected.
  const keep = (e: { preventDefault: () => void }) => e.preventDefault();
  return (
    <div className={styles.tools} role="toolbar" aria-label="Selected passage" onMouseDown={keep}>
      <button type="button" disabled={busy} onClick={onHighlight}>
        Highlight
      </button>
      <button type="button" onClick={onNote}>
        Note
      </button>
      <button type="button" onClick={onAsk}>
        Ask
      </button>
      {problem ? <span role="status">{problem}</span> : null}
    </div>
  );
}

interface EntryProps {
  id: string;
  index: number;
  annotation: Annotation | null;
  controller: NoteController | undefined;
  anchor: Anchor;
  /** Where a figure or page note sits: `Figure 2`, `Page 4`. */
  place: string;
  active: boolean;
  alignTop: number;
  onSelect: () => void;
  onEdit: (text: string) => void;
  onBlur: () => void;
  onRemove: () => void;
  actions: MarginActions;
}

const idleState: NoteState = {
  body: '',
  status: 'idle',
  conflict: null,
  created: true,
  reason: null,
  gone: false,
};
const noop = () => () => {};

function NoteEntry({
  id,
  index,
  annotation,
  controller,
  anchor,
  place,
  active,
  alignTop,
  onSelect,
  onEdit,
  onBlur,
  onRemove,
}: EntryProps) {
  const state = useSyncExternalStore(
    controller ? controller.subscribe : noop,
    controller ? controller.getSnapshot : () => idleState,
  );
  const highlight = annotation?.kind === 'highlight';
  const body = controller ? state.body : (annotation?.body ?? '');
  const quote = quoteOf(anchor) ?? quoteOf(annotation?.anchor ?? anchor);
  const needs = annotation?.placement?.status === 'needs_reattachment';
  const pending = annotation?.placement?.status === 'pending';
  const label = highlight
    ? 'Highlight'
    : anchor.kind === 'none'
      ? 'Topic note · no anchor'
      : anchor.kind === 'figure' || anchor.kind === 'pdf'
        ? `Description · ${place}`
        : `Note ${index + 1}`;
  return (
    <div
      className={styles.entry}
      data-active={active}
      style={active && alignTop ? { marginTop: alignTop } : undefined}
    >
      <button
        type="button"
        className={styles.entryHead}
        onClick={onSelect}
        aria-expanded={active}
        aria-label={`${label}${quote ? `: ${quote}` : ''}`}
      >
        <span>{label}</span>
        <span className={styles.muted}>
          {pending ? 'Waiting to be placed' : needs ? 'Needs reattachment' : 'Private'}
        </span>
      </button>
      {quote ? <blockquote className={styles.quote}>{quote}</blockquote> : null}
      {highlight ? (
        active ? (
          <button type="button" className={styles.link} onClick={onRemove}>
            Remove highlight
          </button>
        ) : null
      ) : active ? (
        <>
          {state.status === 'conflict' && state.conflict ? (
            <ConflictView
              controller={controller}
              mine={state.body}
              saved={state.conflict.body ?? ''}
            />
          ) : (
            <label className={styles.field}>
              Your note
              <textarea
                id={`note-${id}`}
                rows={6}
                value={body}
                onChange={(e) => onEdit(e.target.value)}
                onBlur={onBlur}
              />
            </label>
          )}
          <SaveLine
            state={state}
            onRetry={() => controller?.retry()}
            onSaveAsNew={() => controller?.saveAsNew()}
          />
          <button type="button" className={styles.link} onClick={onRemove}>
            Delete note
          </button>
        </>
      ) : body ? (
        <p className={styles.preview}>{body}</p>
      ) : null}
    </div>
  );
}

export function SaveLine({
  state,
  onRetry,
  onSaveAsNew,
}: {
  state: NoteState;
  onRetry: () => void;
  onSaveAsNew: () => void;
}) {
  let text: ReactNode = null;
  if (state.status === 'saving') text = 'Saving';
  else if (state.status === 'saved') text = 'Saved';
  else if (state.status === 'offline') text = 'Offline · changes on this device';
  else if (state.gone) {
    text = (
      <>
        This note was deleted elsewhere ·{' '}
        <button type="button" className={styles.link} onClick={onSaveAsNew}>
          Save as a new note
        </button>
      </>
    );
  } else if (state.status === 'failed') {
    text = (
      <>
        {state.reason ?? 'Could not save'} ·{' '}
        <button type="button" className={styles.link} onClick={onRetry}>
          Retry
        </button>
      </>
    );
  }
  return (
    <div className={styles.saveLine} role="status">
      {text}
    </div>
  );
}

export function ConflictView({
  controller,
  mine,
  saved,
}: {
  controller: NoteController | undefined;
  mine: string;
  saved: string;
}) {
  return (
    <div className={styles.conflict} role="alert">
      <h3>This note changed somewhere else</h3>
      <div className={styles.small}>Your text on this device</div>
      <pre>{mine}</pre>
      <div className={styles.small}>Saved version</div>
      <pre>{saved}</pre>
      <div className={styles.row}>
        <button type="button" className={buttons.outline} onClick={() => controller?.keepMine()}>
          Keep my text
        </button>
        <button type="button" className={buttons.outline} onClick={() => controller?.takeSaved()}>
          Use the saved version
        </button>
      </div>
    </div>
  );
}

function Discussion({
  threads,
  userId,
  actions,
  activeId,
  onSelect,
  ask,
  onAsk,
  onPost,
}: {
  threads: Thread[];
  userId: string | null;
  actions: MarginActions;
  activeId: string | null;
  onSelect: (id: string) => void;
  ask: Ask;
  onAsk: (patch: Partial<Ask>) => void;
  onPost: () => void;
}) {
  const quote = quoteOf(ask.anchor);
  return (
    <div className={styles.entries}>
      {threads.length === 0 ? <p className={styles.empty}>No questions or comments yet.</p> : null}
      {threads.map((t) => {
        const mine = t.author.id === userId;
        const text = quoteOf(t.anchor);
        return (
          <div
            key={t.id}
            className={`${styles.entry} ${styles.thread}`}
            data-active={activeId === t.id}
          >
            <button type="button" className={styles.entryHead} onClick={() => onSelect(t.id)}>
              <span>
                {mine ? 'You' : t.author.name} → {audienceLabel(t.audience)}
              </span>
              <span>{t.status === 'open' ? 'Open' : 'Resolved'}</span>
            </button>
            {text ? <blockquote className={styles.quote}>{text}</blockquote> : null}
            {text ? (
              <button type="button" className={styles.link} onClick={() => onSelect(t.id)}>
                Show in reading
              </button>
            ) : null}
            <ThreadPosts thread={t} userId={userId} actions={actions} />
          </div>
        );
      })}
      <div className={styles.composer}>
        <label className={styles.field}>
          Visible to
          <select
            value={ask.audience}
            onChange={(e) => onAsk({ audience: e.target.value as Audience })}
          >
            <option value="instructor">Instructor</option>
            <option value="class">Class</option>
          </select>
        </label>
        {quote ? (
          <blockquote className={styles.quote}>
            {quote}{' '}
            <button
              type="button"
              className={styles.link}
              onClick={() => onAsk({ anchor: NO_ANCHOR })}
            >
              Ask about the whole reading
            </button>
          </blockquote>
        ) : null}
        <label className={styles.field}>
          Comment or question
          <textarea
            id="margin-question"
            rows={3}
            placeholder={quote ? 'Ask about this passage' : 'Ask about this reading'}
            value={ask.body}
            onChange={(e) => onAsk({ body: e.target.value })}
          />
        </label>
        <div className={styles.saveLine} role="status">
          {ask.problem === 'offline'
            ? 'Offline · your text is kept on this device. Post when you are back online.'
            : ask.problem === 'failed'
              ? 'Could not post. Your text is kept.'
              : null}
        </div>
        <button
          type="button"
          className={buttons.outline}
          disabled={ask.body.trim() === '' || ask.posting}
          onClick={onPost}
        >
          {ask.problem ? 'Retry' : 'Post'}
        </button>
      </div>
    </div>
  );
}
