import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { Link, useRouter } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import buttons from '../components/Buttons.module.css';
import { Loading } from '../components/Loading';
import { OfflineBanner } from '../components/OfflineBanner';
import page from '../components/Page.module.css';
import { RetryNotice } from '../components/RetryNotice';
import { isRevoked } from '../session/revocation';
import { useSession } from '../session/useSession';
import { ReadingMargin } from './margin/ReadingMargin';
import { NativeReading } from './NativeReading';
import { PdfReading } from './PdfReading';
import { positionFromSearch, type ReadingSearch, searchFor } from './place';
import { isArchivedRefusal, markPositionsRefused, positionsRefused } from './positionRefusal';
import styles from './Reading.module.css';
import {
  type ReadingPosition,
  type ReadingSummary,
  renewPdfUrl,
  useReadingContent,
  useReadings,
  useSavePosition,
} from './readings';
import { SourceDownload } from './SourceDownload';
import { type PlaceReason, useReporter } from './useReporter';

interface Props {
  classId: string;
  courseId: string;
  topicId: string;
  instructor: boolean;
  search: ReadingSearch;
  /** Moves the address: a new entry when the reading changes, in place for a new position. */
  onSearch: (search: ReadingSearch, mode: 'push' | 'replace') => void;
}

/** The Reading tab (§5, §8): resource toolbar, then the picked reading in its reader. */
export function ReadingTab({ classId, courseId, topicId, instructor, search, onSearch }: Props) {
  const list = useReadings(classId, topicId);
  const queryClient = useQueryClient();
  const entryKey = historyKey(useRouter());
  // The margin (My notes, Discussion) is open unless the reader hides it.
  const [marginOpen, setMarginOpen] = useState(true);
  const openMargin = useCallback(() => setMarginOpen(true), []);
  // Adding a reading is course authoring (§12): an instructor without an editor grant has no page for it.
  const session = useSession();
  const canAdd =
    instructor &&
    session.status === 'signed-in' &&
    session.me.courses.some((c) => c.courseId === courseId && (c.editor || c.owner));

  // The reading the address names, else the one studied last, else the first.
  const readings = list.data?.readings ?? [];
  const chosen =
    readings.find((r) => r.revisionId === search.resource) ??
    readings.find((r) => r.revisionId === list.data?.lastRevisionId) ??
    readings[0];
  // An entry opened without a reading in its address is pinned to the one shown, so Back returns
  // to it even after a later save has moved "the reading studied last".
  const shownId = chosen?.revisionId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: `onSearch` is a new function every render
  useEffect(() => {
    // Keeps any place the address already names: it is what this entry restores.
    if (shownId && search.resource === undefined) {
      onSearch({ ...search, resource: shownId }, 'replace');
    }
  }, [shownId, search.resource]);

  if (!list.data) {
    return (
      <div className={styles.stage}>
        {list.isError ? (
          <RetryNotice
            message="The readings could not be loaded."
            onRetry={() => void list.refetch()}
          />
        ) : (
          <Loading label="Loading reading" className={styles.loading} />
        )}
      </div>
    );
  }

  if (!chosen) {
    return (
      <div className={styles.stage}>
        <p className={styles.empty}>No reading has been added</p>
        {canAdd && (
          <p>
            <Link
              to="/courses/$courseId/edit/$topicId"
              params={{ courseId, topicId }}
              className={page.link}
            >
              Add reading
            </Link>
          </p>
        )}
      </div>
    );
  }

  // The address place wins over the saved one: it is where this history entry was left, unless
  // the reader moved on from it before leaving (see `leftAt`).
  const addressed =
    search.resource === undefined || search.resource === chosen.revisionId
      ? positionFromSearch(search)
      : null;
  const left = leftPlaces(queryClient).get(leftAtKey(classId, chosen.revisionId, entryKey));
  const initial = left ?? addressed ?? chosen.position;

  return (
    <>
      <div className={styles.toolbar}>
        {readings.length > 1 ? (
          <label className={styles.picker}>
            <span className={styles.small}>Reading</span>
            <select
              value={chosen.revisionId}
              onChange={(e) => onSearch({ resource: e.target.value }, 'push')}
            >
              {readings.map((r) => (
                <option key={r.revisionId} value={r.revisionId}>
                  {r.title}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className={styles.small}>{chosen.title}</span>
        )}
        <span className={styles.toolbarActions}>
          <button
            type="button"
            className={buttons.tool}
            data-on={marginOpen}
            onClick={() => setMarginOpen((open) => !open)}
          >
            {marginOpen ? 'Hide notes' : 'Notes'}
          </button>
          {canAdd && (
            <Link
              to="/courses/$courseId/edit/$topicId"
              params={{ courseId, topicId }}
              className={page.link}
            >
              Add reading
            </Link>
          )}
        </span>
      </div>
      <div className={styles.stage}>
        <ReadingView
          key={chosen.revisionId}
          classId={classId}
          topicId={topicId}
          reading={chosen}
          initial={initial}
          addressed={addressed}
          flushed={left ?? null}
          onSearch={onSearch}
          marginOpen={marginOpen}
          onOpenMargin={openMargin}
        />
      </div>
    </>
  );
}

/**
 * Places flushed as a reader left a reading (a tab click within the pause before a save) that the
 * address of the entry left behind does not hold. Keyed by the history entry (the router's location
 * key), so Back to that entry restores the flushed place instead and no other entry inherits it. One map per QueryClient: it belongs to this
 * app and session and goes with them, and it never expires while they last.
 */
const leftAt = new WeakMap<QueryClient, Map<string, ReadingPosition>>();
/** The router's key for the history entry now shown; a replaced address gets a new one. */
const historyKey = (router: ReturnType<typeof useRouter>) =>
  router.history.location.state.__TSR_key ?? '';
const leftAtKey = (classId: string, revisionId: string, entryKey: string) =>
  `${classId}\n${revisionId}\n${entryKey}`;
function leftPlaces(client: QueryClient) {
  let places = leftAt.get(client);
  if (!places) {
    places = new Map();
    leftAt.set(client, places);
  }
  return places;
}

interface ViewProps {
  classId: string;
  topicId: string;
  reading: ReadingSummary;
  initial: ReadingPosition | null;
  /** The place the address names for this reading, if any. */
  addressed: ReadingPosition | null;
  /** The place flushed as the reader left this entry, which the address does not hold. */
  flushed: ReadingPosition | null;
  onSearch: Props['onSearch'];
  marginOpen: boolean;
  onOpenMargin: () => void;
}

function ReadingView({
  classId,
  topicId,
  reading,
  initial,
  addressed,
  flushed,
  onSearch,
  marginOpen,
  onOpenMargin,
}: ViewProps) {
  const content = useReadingContent(classId, reading.revisionId);
  const save = useSavePosition(classId, topicId);
  const { revisionId } = reading;
  const queryClient = useQueryClient();
  const places = leftPlaces(queryClient);
  const inAddress = useRef(JSON.stringify(addressed));
  const router = useRouter();
  /** This entry's history key as of the last place reported: the router replaces it with each new address. */
  const entry = useRef(historyKey(router));
  const lastSaved = useRef<string>('');
  /** Saves sent and not yet settled: a hide or close flush can run beside one already in flight. */
  const inFlight = useRef(0);
  const next = useRef<ReadingPosition | null>(null);
  /** The place a failed save left unsent, sent again when the connection returns. */
  const unsaved = useRef<ReadingPosition | null>(null);
  /** Counts sends, so a failure only counts as the last word while no later send has started. */
  const sends = useRef(0);

  const send = useCallback(
    function send(place: ReadingPosition) {
      // Once access ended nothing more is written for the class (§14), whatever was pending.
      // An archived class refused a save and takes no more for the life of the page.
      if (isRevoked(queryClient, classId) || positionsRefused(queryClient, classId)) {
        next.current = null;
        unsaved.current = null;
        return;
      }
      inFlight.current += 1;
      unsaved.current = null;
      const sequence = ++sends.current;
      save(revisionId, place)
        .catch((error: unknown) => {
          if (isArchivedRefusal(error)) {
            markPositionsRefused(queryClient, classId);
            next.current = null;
            unsaved.current = null;
            return;
          }
          // Retried by the next move or when the connection returns, unless a newer place is
          // already waiting or was sent meanwhile (it would be overwritten by this older one).
          if (!next.current && sequence === sends.current) {
            lastSaved.current = '';
            unsaved.current = place;
          }
        })
        .finally(() => {
          inFlight.current -= 1;
          // A waiting place goes only once every outstanding save has settled.
          if (inFlight.current > 0) return;
          const waiting = next.current;
          next.current = null;
          if (waiting) send(waiting);
        });
    },
    [save, revisionId, queryClient, classId],
  );

  /**
   * One save at a time per reading, so an older PUT cannot land after a newer one; a place that
   * arrives meanwhile waits and replaces any place already waiting. When the page is hidden or
   * closed (`now`), it is sent at once: the save in flight may never finish, and nothing would be
   * left to send the waiting place.
   */
  const store = useCallback(
    (position: ReadingPosition, now = false) => {
      const key = JSON.stringify(position);
      if (key === lastSaved.current) return;
      lastSaved.current = key;
      if (inFlight.current > 0 && !now) {
        next.current = position;
        return;
      }
      // A place sent at once supersedes any still waiting, which would otherwise land after it.
      next.current = null;
      send(position);
    },
    [send],
  );
  // A place restored from the record is written to the address, so a reload or a copied link
  // names what the reader sees, and the record has done its work.
  // biome-ignore lint/correctness/useExhaustiveDependencies: only on mount; `onSearch` is new every render
  useEffect(() => {
    if (!flushed) return;
    places.delete(leftAtKey(classId, revisionId, entry.current));
    inAddress.current = JSON.stringify(flushed);
    onSearch(searchFor(revisionId, flushed), 'replace');
  }, []);
  useEffect(() => {
    const retry = () => {
      const place = unsaved.current;
      if (place) store(place);
    };
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [store]);
  const reportAtPlace = useReporter(
    (position: ReadingPosition, reason: PlaceReason) => {
      store(position, reason !== 'pause');
      // This entry's address moves on, so a place flushed from its old address no longer applies.
      places.delete(leftAtKey(classId, revisionId, entry.current));
      inAddress.current = JSON.stringify(position);
      onSearch(searchFor(revisionId, position), 'replace');
    },
    (position) => {
      store(position);
      // An address without a place falls back to the saved place, which this save updates.
      const from = inAddress.current;
      if (from !== 'null' && from !== JSON.stringify(position)) {
        places.set(leftAtKey(classId, revisionId, entry.current), position);
      }
    },
    () => {
      // Hidden or closing with no new place: a place still waiting behind a save goes now.
      const waiting = next.current;
      next.current = null;
      if (waiting) send(waiting);
    },
  );

  // Sampled as the reader moves, while this entry is the one shown: once they leave, the router
  // has already moved on to the next entry's key.
  const report = useCallback(
    (position: ReadingPosition) => {
      entry.current = historyKey(router);
      reportAtPlace(position);
    },
    [router, reportAtPlace],
  );

  const renew = useCallback(() => renewPdfUrl(classId, revisionId), [classId, revisionId]);

  if (content.error instanceof ApiError && content.error.status === 404) {
    return (
      <div className={page.feedback} role="alert">
        <p>This reading is not available.</p>
      </div>
    );
  }
  const data = content.data;
  if (!data) {
    return content.isError ? (
      <RetryNotice
        message="This reading could not be loaded."
        onRetry={() => void content.refetch()}
      />
    ) : (
      <Loading label="Loading reading" className={styles.loading} />
    );
  }
  if (data.status === 'pending') {
    return <Loading label={`${data.title} is being prepared`} className={styles.loading} />;
  }
  if (data.status === 'failed') {
    return (
      <RetryNotice
        message={`${data.title} could not be processed${data.error ? `: ${data.error}` : ''}`}
        onRetry={() => void content.refetch()}
      >
        {data.sourceKey && (
          <SourceDownload
            classId={classId}
            revisionId={revisionId}
            sourceKey={data.sourceKey}
            className={buttons.outline}
          />
        )}
      </RetryNotice>
    );
  }
  const offline = (
    <OfflineBanner>
      You are offline. This reading stays open; your place is not saved until you are back online.
    </OfflineBanner>
  );
  if (data.html !== null) {
    return (
      <>
        {offline}
        <ReadingMargin
          classId={classId}
          resourceId={reading.resourceId}
          html={data.html}
          open={marginOpen}
          onOpen={onOpenMargin}
        >
          {(setRoot) => (
            <NativeReading
              html={data.html as string}
              initial={initial}
              onPosition={report}
              onRoot={setRoot}
            />
          )}
        </ReadingMargin>
      </>
    );
  }
  if (data.pdf) {
    return (
      <>
        {offline}
        <ReadingMargin
          classId={classId}
          resourceId={reading.resourceId}
          html={null}
          open={marginOpen}
          onOpen={onOpenMargin}
        >
          {(_root, sketch) => (
            <PdfReading
              url={(data.pdf as { url: string }).url}
              pageCount={(data.pdf as { pageCount: number }).pageCount}
              renew={renew}
              source={{ classId, revisionId, key: data.sourceKey }}
              initial={initial}
              onPosition={report}
              sketch={sketch}
            />
          )}
        </ReadingMargin>
      </>
    );
  }
  return null;
}
