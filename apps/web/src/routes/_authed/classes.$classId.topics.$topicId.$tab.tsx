import { createFileRoute, redirect } from '@tanstack/react-router';
import styles from '../../components/Page.module.css';
import { type TabDef, TabRow } from '../../components/TabRow';
import { Unavailable } from '../../components/Unavailable';
import { useClassContext } from '../../session/classContext';

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
  if (!context || !isTab(tab)) return <Unavailable />;
  const label = TOPIC_TABS.find((t) => t.id === tab)?.label ?? tab;
  return (
    <main>
      <div className={styles.heading}>
        <h1>{context.courseTitle}</h1>
        <p className={`${styles.small} ${styles.muted}`} style={{ marginTop: 5 }}>
          {context.className}
        </p>
      </div>
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
        <p className={styles.intro}>{label} for this topic are not available yet.</p>
      </div>
    </main>
  );
}
