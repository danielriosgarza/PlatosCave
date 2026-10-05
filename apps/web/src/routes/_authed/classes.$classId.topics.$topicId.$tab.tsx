import { createFileRoute, redirect } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { z } from 'zod';
import { ApiError } from '../../api/client';
import { TestsPanel } from '../../assessments/TestsPanel';
import { ClassUnavailable } from '../../components/AccessLost';
import styles from '../../components/Page.module.css';
import { usePageTitle } from '../../components/pageTitle';
import { RetryNotice } from '../../components/RetryNotice';
import { type TabDef, TabRow } from '../../components/TabRow';
import { Unavailable } from '../../components/Unavailable';
import { ExercisesPanel } from '../../exercises/ExercisesPanel';
import { NotebooksTab } from '../../notebooks/NotebooksTab';
import readingStyles from '../../reading/Reading.module.css';
import { ReadingTab } from '../../reading/ReadingTab';
import { useClassContext } from '../../session/classContext';
import type { SessionClass } from '../../session/useSession';
import { SlidesTab } from '../../slides/SlidesTab';
import { ReviewPanel } from '../../topics/ReviewPanel';
import { TopicHeading } from '../../topics/TopicHeading';
import {
  type ClassTopic,
  type ClassTopics,
  isOpen,
  lockReason,
  useClassTopics,
} from '../../topics/topics';
import { useFocusMode } from '../../workspace/focus';
import { ResourceToolbar } from '../../workspace/ResourceToolbar';
import { ToolsHost } from '../../workspace/ResourceTools';

export const TOPIC_TABS = [
  { id: 'slides', label: 'Slides' },
  { id: 'reading', label: 'Reading' },
  { id: 'exercises', label: 'Exercises' },
  { id: 'notebooks', label: 'Notebooks' },
  { id: 'tests', label: 'Tests' },
] as const satisfies readonly TabDef<string>[];

type TabId = (typeof TOPIC_TABS)[number]['id'];
const isTab = (value: string): value is TabId => TOPIC_TABS.some((t) => t.id === value);

/**
 * The reading and the place in it live in the address, so Back and Forward return to where each
 * history entry was left (§5). `block` carries a `b:` prefix: see `place.ts`.
 */
const topicSearch = z.object({
  resource: z.coerce.string().optional().catch(undefined),
  block: z.coerce.string().optional().catch(undefined),
  page: z.coerce.number().int().min(1).optional().catch(undefined),
  offset: z.coerce.number().int().min(0).optional().catch(undefined),
});

export const Route = createFileRoute('/_authed/classes/$classId/topics/$topicId/$tab')({
  validateSearch: topicSearch,
  // An unknown tab is a mistyped address, not a missing page: land on the first tab.
  beforeLoad: ({ params }) => {
    if (!isTab(params.tab)) {
      throw redirect({
        to: '/classes/$classId/topics/$topicId/$tab',
        params: { ...params, tab: 'slides' },
        search: (previous) => previous,
        replace: true,
      });
    }
  },
  component: TopicWorkspace,
});

function TopicWorkspace() {
  const { classId, topicId, tab } = Route.useParams();
  const context = useClassContext(classId);
  // No request is made for a class the person is not (or no longer) in (§14).
  if (!context || !isTab(tab)) return <ClassUnavailable classId={classId} />;
  return <LoadedWorkspace classId={classId} topicId={topicId} tab={tab} context={context} />;
}

function LoadedWorkspace({
  classId,
  topicId,
  tab,
  context,
}: {
  classId: string;
  topicId: string;
  tab: TabId;
  context: SessionClass;
}) {
  const query = useClassTopics(classId);
  const data = query.data;
  const notFound = query.error instanceof ApiError && query.error.status === 404;
  usePageTitle(notFound ? undefined : data?.topics.find((t) => t.topicId === topicId)?.title);
  if (notFound) return <Unavailable />;
  if (!data) {
    return (
      <main id="main" className={styles.index}>
        {query.isError ? (
          <RetryNotice
            message="This topic could not be loaded."
            onRetry={() => void query.refetch()}
          />
        ) : (
          <p className={styles.intro} role="status">
            Loading topic
          </p>
        )}
      </main>
    );
  }
  const topic = data.topics.find((t) => t.topicId === topicId);
  if (!topic) return <Unavailable />;
  if (!isOpen(topic)) {
    return (
      <main id="main">
        <TopicHeading data={data} topic={topic} />
        <div className={styles.panel}>
          <p className={styles.intro}>{lockReason(topic)}</p>
        </div>
      </main>
    );
  }
  return (
    <OpenTopic
      classId={classId}
      courseId={context.courseId}
      topicId={topicId}
      tab={tab}
      data={data}
      topic={topic}
      role={context.role}
    />
  );
}

/** Mounted only for an open topic, so F and Escape act only where the toolbar exists (§5). */
function OpenTopic({
  classId,
  courseId,
  topicId,
  tab,
  data,
  topic,
  role,
}: {
  classId: string;
  courseId: string;
  topicId: string;
  tab: TabId;
  data: ClassTopics;
  topic: ClassTopic;
  role: 'student' | 'instructor';
}) {
  const navigate = Route.useNavigate();
  const search = Route.useSearch();
  const workspace = useRef<HTMLElement | null>(null);
  const [toolsHost, setToolsHost] = useState<HTMLElement | null>(null);
  const mode = useFocusMode(workspace);
  const label = TOPIC_TABS.find((t) => t.id === tab)?.label ?? tab;
  return (
    <main id="main" ref={workspace} className={styles.workspace}>
      {mode.focus ? null : <TopicHeading data={data} topic={topic} />}
      {mode.focus ? null : (
        <TabRow
          label="Topic materials"
          tabs={TOPIC_TABS}
          selected={tab}
          panelId="pc-content"
          // Arriving at Reading keeps the scroll: the reader restores its own place, and a reset
          // to the top after it has done so would move the page under it. Other tabs open at
          // the top.
          onSelect={(next) =>
            navigate({ params: { classId, topicId, tab: next }, resetScroll: next !== 'reading' })
          }
        />
      )}
      <ResourceToolbar
        title={`${topic.title} / ${label}`}
        focus={mode.focus}
        fullscreen={mode.fullscreen}
        notice={mode.notice}
        onFocus={() => void mode.toggleFocus()}
        onFullscreen={() => void mode.toggleFullscreen()}
        focusButton={mode.focusButton}
        fullscreenButton={mode.fullscreenButton}
        toolsRef={setToolsHost}
      />
      <ToolsHost.Provider value={toolsHost}>
        <div
          className={tab === 'reading' || tab === 'slides' ? readingStyles.panel : styles.panel}
          role="tabpanel"
          id="pc-content"
          aria-labelledby={`pc-tab-${tab}`}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: panel without focusable content must be reachable
          tabIndex={0}
        >
          {tab === 'reading' ? (
            <ReadingTab
              classId={classId}
              courseId={courseId}
              topicId={topicId}
              instructor={role === 'instructor'}
              search={search}
              onSearch={(next, how) =>
                navigate({
                  params: { classId, topicId, tab },
                  search: next,
                  replace: how === 'replace',
                  // Moving the place is not a visit: the router must not scroll to the top.
                  resetScroll: how !== 'replace',
                })
              }
            />
          ) : tab === 'slides' ? (
            <SlidesTab
              classId={classId}
              courseId={courseId}
              topicId={topicId}
              instructor={role === 'instructor'}
              resource={search.resource}
              onResource={(resource, how) =>
                navigate({
                  params: { classId, topicId, tab },
                  search: { resource },
                  replace: how === 'replace',
                  resetScroll: how !== 'replace',
                })
              }
            />
          ) : tab === 'exercises' ? (
            <ExercisesPanel classId={classId} topicId={topicId} role={role} />
          ) : tab === 'notebooks' ? (
            <NotebooksTab
              classId={classId}
              courseId={courseId}
              topicId={topicId}
              instructor={role === 'instructor'}
              resource={search.resource}
              onResource={(resource, how) =>
                navigate({
                  params: { classId, topicId, tab },
                  search: { resource },
                  replace: how === 'replace',
                  resetScroll: how !== 'replace',
                })
              }
            />
          ) : (
            <TestsPanel classId={classId} topicId={topicId} role={role} />
          )}
        </div>
        {role === 'student' && !mode.focus ? (
          <ReviewPanel classId={classId} topicId={topicId} />
        ) : null}
      </ToolsHost.Provider>
    </main>
  );
}
