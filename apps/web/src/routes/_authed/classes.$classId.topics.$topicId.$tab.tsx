import { createFileRoute, redirect } from '@tanstack/react-router';
import { ApiError } from '../../api/client';
import styles from '../../components/Page.module.css';
import { type TabDef, TabRow } from '../../components/TabRow';
import { Unavailable } from '../../components/Unavailable';
import { useClassContext } from '../../session/classContext';
import { TopicHeading } from '../../topics/TopicHeading';
import { isOpen, lockReason, useClassTopics } from '../../topics/topics';

export const TOPIC_TABS = [
  { id: 'slides', label: 'Slides' },
  { id: 'reading', label: 'Reading' },
  { id: 'exercises', label: 'Exercises' },
  { id: 'notebooks', label: 'Notebooks' },
  { id: 'tests', label: 'Tests' },
] as const satisfies readonly TabDef<string>[];

type TabId = (typeof TOPIC_TABS)[number]['id'];
const isTab = (value: string): value is TabId => TOPIC_TABS.some((t) => t.id === value);

export const Route = createFileRoute('/_authed/classes/$classId/topics/$topicId/$tab')({
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
  const navigate = Route.useNavigate();
  const context = useClassContext(classId);
  const query = useClassTopics(classId);
  if (!context || !isTab(tab)) return <Unavailable />;
  if (query.error instanceof ApiError && query.error.status === 404) return <Unavailable />;
  const data = query.data;
  if (!data) {
    return (
      <main className={styles.index}>
        {query.isError ? (
          <div className={styles.feedback} role="alert">
            <p>This topic could not be loaded.</p>
            <button type="button" className={styles.outline} onClick={() => void query.refetch()}>
              Try again
            </button>
          </div>
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
      <main>
        <TopicHeading data={data} topic={topic} />
        <div className={styles.panel}>
          <p className={styles.intro}>{lockReason(topic)}</p>
        </div>
      </main>
    );
  }
  const label = TOPIC_TABS.find((t) => t.id === tab)?.label ?? tab;
  return (
    <main>
      <TopicHeading data={data} topic={topic} />
      <TabRow
        label="Topic materials"
        tabs={TOPIC_TABS}
        selected={tab}
        panelId="pc-content"
        onSelect={(next) => navigate({ params: { classId, topicId, tab: next } })}
      />
      <div
        className={styles.panel}
        role="tabpanel"
        id="pc-content"
        aria-labelledby={`pc-tab-${tab}`}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: panel without focusable content must be reachable
        tabIndex={0}
      >
        <p className={styles.intro}>Nothing is available under {label} for this topic yet.</p>
      </div>
    </main>
  );
}
