import { type OpenCourse, type OpenTopic, openPaths } from '@parallax/contracts';
import { useNavigate } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { Loading } from '../components/Loading';
import page from '../components/Page.module.css';
import { usePageTitle } from '../components/pageTitle';
import { RetryNotice } from '../components/RetryNotice';
import { TabRow } from '../components/TabRow';
import readingStyles from '../reading/Reading.module.css';
import { TopicHeading } from '../topics/TopicHeading';
import { type ClassTopic, type ClassTopics, TAB_LEGEND, type TopicTab } from '../topics/topics';
import { useFocusMode } from '../workspace/focus';
import { ResourceToolbar } from '../workspace/ResourceToolbar';
import { ToolsHost } from '../workspace/ResourceTools';
import { Missing, useCourse, useTopic } from './data';
import { OpenUnavailable } from './OpenUnavailable';
import { Panel, type PanelProps } from './panels';

/** A topic's address: course reference, topic folder id, tab, and the tab's `?resource` and `?page`. */
export type TopicAddress = Pick<PanelProps, 'course' | 'topicId' | 'resource' | 'page'> & {
  tab: string;
};

/** What the heading reads: the course and its topics, each open, with nothing saved; no class. */
const OPEN = { savedTab: null, state: 'available' as const, availableAt: null, requires: [] };
const asClassTopics = ({ title, instructors, topics }: OpenCourse): ClassTopics => ({
  release: null,
  course: { id: '', title },
  cohort: 'Open to everyone',
  instructors,
  topics: topics.map((topic) => ({ ...topic, ...OPEN })),
  resume: null,
  reviewed: { count: 0, total: 0 },
});

/** A topic of the open site, from `course.json` and `topic.json` (docs/design/open-site.md §6). */
export function Topic(at: TopicAddress) {
  const course = useCourse(at.course);
  const lists = useTopic(at.course, at.topicId);
  usePageTitle(course.data?.topics.find((t) => t.topicId === at.topicId)?.title);
  if (course.data && lists.data) {
    const data = asClassTopics(course.data);
    const topic = data.topics.find((t) => t.topicId === at.topicId);
    const tab = TAB_LEGEND.find((t) => t.id === at.tab)?.id;
    if (!topic || !tab) return <OpenUnavailable />;
    return <Workspace {...{ at, data, topic, tab }} lists={lists.data} />;
  }
  const failed = course.error ?? lists.error;
  if (failed instanceof Missing) return <OpenUnavailable />;
  const retry = () => void Promise.all([course.refetch(), lists.refetch()]);
  return (
    <main id="main" className={page.index}>
      {failed ? (
        <RetryNotice message="This topic could not be loaded." onRetry={retry} />
      ) : (
        <Loading label="Loading topic" />
      )}
    </main>
  );
}

interface WorkspaceProps {
  at: TopicAddress;
  data: ClassTopics;
  topic: ClassTopic;
  tab: TopicTab;
  lists: OpenTopic;
}

/** Heading, the five tabs, the resource toolbar with Focus and full screen, and the tab's panel. */
function Workspace({ at, data, topic, tab, lists }: WorkspaceProps) {
  const navigate = useNavigate();
  const workspace = useRef<HTMLElement | null>(null);
  const [toolsHost, setToolsHost] = useState<HTMLElement | null>(null);
  const mode = useFocusMode(workspace);
  const label = TAB_LEGEND.find((t) => t.id === tab)?.label ?? tab;
  // The address is the open site's own (§2): `openPaths` gives it, and the router decodes it.
  const go = (next: TopicTab, resource?: string) =>
    void navigate({
      to: openPaths.topic(at.course, at.topicId, next) as never,
      search: (resource ? { resource } : {}) as never,
    });
  return (
    <main id="main" ref={workspace} className={page.workspace}>
      {mode.focus ? null : <TopicHeading data={data} topic={topic} />}
      {mode.focus ? null : (
        <TabRow
          label="Topic materials"
          tabs={TAB_LEGEND}
          selected={tab}
          panelId="pc-content"
          onSelect={(next) => go(next)}
        />
      )}
      <ResourceToolbar
        title={`${topic.title} / ${label}`}
        {...mode}
        onFocus={() => void mode.toggleFocus()}
        onFullscreen={() => void mode.toggleFullscreen()}
        toolsRef={setToolsHost}
      />
      <ToolsHost.Provider value={toolsHost}>
        <div
          className={tab === 'reading' || tab === 'slides' ? readingStyles.panel : page.panel}
          role="tabpanel"
          id="pc-content"
          // The tab row is not rendered during Focus, so the panel is then named by its label.
          {...(mode.focus ? { 'aria-label': label } : { 'aria-labelledby': `pc-tab-${tab}` })}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: panel without focusable content must be reachable
          tabIndex={0}
        >
          <Panel {...at} tab={tab} lists={lists} onResource={(id) => go(tab, id)} />
        </div>
      </ToolsHost.Provider>
    </main>
  );
}
