import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useRef } from 'react';
import { ApiError } from '../api/client';
import page from '../components/Page.module.css';
import { RetryNotice } from '../components/RetryNotice';
import { SourceDownload } from '../reading/SourceDownload';
import { useReporter } from '../reading/useReporter';
import { useSession } from '../session/useSession';
import { ResourceTools } from '../workspace/ResourceTools';
import styles from './Slides.module.css';
import { type NotesContext, SlideViewer } from './SlideViewer';
import {
  type DeckSummary,
  renewDeckUrl,
  slidePosition,
  useDeckContent,
  useDecks,
  useSaveSlide,
} from './slides';

interface Props {
  classId: string;
  courseId: string;
  topicId: string;
  instructor: boolean;
  /** The deck the address names, if any. */
  resource: string | undefined;
  /** Moves the address to another deck: a new history entry. */
  onResource: (revisionId: string, mode: 'push' | 'replace') => void;
  /** Fills the notes margin for the slide shown; P2-09 provides it. */
  notes?: (context: NotesContext) => ReactNode;
}

/** The Slides tab (§5, §7): the picked deck in its viewer, opened at the slide studied last. */
export function SlidesTab({
  classId,
  courseId,
  topicId,
  instructor,
  resource,
  onResource,
  notes,
}: Props) {
  const list = useDecks(classId, topicId);
  const session = useSession();
  const canAdd =
    instructor &&
    session.status === 'signed-in' &&
    session.me.courses.some((c) => c.courseId === courseId && (c.editor || c.owner));

  const decks = list.data?.decks ?? [];
  const chosen =
    decks.find((d) => d.revisionId === resource) ??
    decks.find((d) => d.revisionId === list.data?.lastRevisionId) ??
    decks[0];
  // An entry opened without a deck in its address is pinned to the one shown, so Back returns to it.
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
            message="The slides could not be loaded."
            onRetry={() => void list.refetch()}
          />
        ) : (
          <p role="status">Loading slides</p>
        )}
      </div>
    );
  }
  if (!chosen) {
    return (
      <div className={styles.empty}>
        <p>No slides have been added</p>
        {canAdd && (
          <p>
            <Link
              to="/courses/$courseId/edit/$topicId"
              params={{ courseId, topicId }}
              className={page.link}
            >
              Add slides
            </Link>
          </p>
        )}
      </div>
    );
  }

  const picker =
    decks.length > 1 ? (
      <label className={styles.picker}>
        <span className={styles.label}>Slides</span>
        <select value={chosen.revisionId} onChange={(e) => onResource(e.target.value, 'push')}>
          {decks.map((d) => (
            <option key={d.revisionId} value={d.revisionId}>
              {d.title}
            </option>
          ))}
        </select>
      </label>
    ) : undefined;

  return (
    <>
      {/* In the toolbar whatever the deck's state, so another deck stays reachable. */}
      <ResourceTools>
        {picker ?? <span className={styles.label}>{chosen.title}</span>}
        {canAdd && (
          <Link
            to="/courses/$courseId/edit/$topicId"
            params={{ courseId, topicId }}
            className={page.link}
          >
            Add slides
          </Link>
        )}
      </ResourceTools>
      <DeckView
        key={chosen.revisionId}
        classId={classId}
        topicId={topicId}
        deck={chosen}
        notes={notes}
      />
    </>
  );
}

interface ViewProps {
  classId: string;
  topicId: string;
  deck: DeckSummary;
  notes: Props['notes'];
}

function DeckView({ classId, topicId, deck, notes }: ViewProps) {
  const { revisionId } = deck;
  const content = useDeckContent(classId, revisionId);
  const save = useSaveSlide(classId, topicId);
  const lastSaved = useRef(deck.position && 'page' in deck.position ? deck.position.page : 0);
  const saving = useRef(false);
  const next = useRef<number | null>(null);

  const send = useCallback(
    function send(slide: number) {
      saving.current = true;
      save(revisionId, slide)
        .catch(() => {
          // Retried by the next move unless a newer slide is already waiting; nothing here
          // claims it was kept.
          if (next.current === null) lastSaved.current = 0;
        })
        .finally(() => {
          saving.current = false;
          const waiting = next.current;
          next.current = null;
          if (waiting !== null) send(waiting);
        });
    },
    [save, revisionId],
  );

  /** One save at a time, so an older PUT cannot land after a newer one. */
  const store = useCallback(
    (slide: number, now = false) => {
      if (slide === lastSaved.current) return;
      lastSaved.current = slide;
      if (saving.current && !now) {
        next.current = slide;
        return;
      }
      next.current = null;
      send(slide);
    },
    [send],
  );
  const report = useReporter(
    (position, reason) => {
      if ('page' in position) store(position.page, reason !== 'pause');
    },
    (position) => {
      if ('page' in position) store(position.page);
    },
    () => {
      const waiting = next.current;
      next.current = null;
      if (waiting !== null) send(waiting);
    },
  );
  const onPage = useCallback((n: number) => report(slidePosition(n)), [report]);
  const renew = useCallback(() => renewDeckUrl(classId, revisionId), [classId, revisionId]);

  if (content.error instanceof ApiError && content.error.status === 404) {
    return (
      <div className={`${page.feedback} ${styles.status}`} role="alert">
        <p>These slides are not available.</p>
      </div>
    );
  }
  const data = content.data;
  if (!data) {
    return content.isError ? (
      <div className={styles.status}>
        <RetryNotice
          message="These slides could not be loaded."
          onRetry={() => void content.refetch()}
        />
      </div>
    ) : (
      <p className={styles.status} role="status">
        Loading slides
      </p>
    );
  }
  if (data.status === 'pending') {
    return (
      <p className={styles.status} role="status">
        {data.title} is being prepared
      </p>
    );
  }
  if (data.status === 'failed' || !data.pdf) {
    return (
      <div className={`${page.feedback} ${styles.status}`} role="alert">
        <p>
          {data.title} could not be processed{data.error ? `: ${data.error}` : ''}
        </p>
        <button type="button" className={page.outline} onClick={() => void content.refetch()}>
          Try again
        </button>
        {data.sourceKey && (
          <SourceDownload
            classId={classId}
            revisionId={revisionId}
            sourceKey={data.sourceKey}
            className={page.outline}
          />
        )}
      </div>
    );
  }
  return (
    <SlideViewer
      url={data.pdf.url}
      pageCount={data.pdf.pageCount}
      renew={renew}
      initialPage={deck.position && 'page' in deck.position ? deck.position.page : 1}
      source={{ classId, revisionId, key: data.sourceKey }}
      onPage={onPage}
      notes={notes}
    />
  );
}
