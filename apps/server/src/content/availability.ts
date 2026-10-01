export type Tab = 'slides' | 'reading' | 'exercises' | 'notebooks' | 'tests';
export const TABS: readonly Tab[] = ['slides', 'reading', 'exercises', 'notebooks', 'tests'];

export interface AvailabilityResource {
  tab: Tab;
  visibility: 'visible' | 'hidden';
  releaseAt: Date | null;
}

export interface AvailabilityTopic {
  topicId: string;
  title: string;
  prerequisites: string[];
  resources: AvailabilityResource[];
}

export type TopicState = 'available' | 'scheduled' | 'locked' | 'complete';

export interface TopicAvailability {
  state: TopicState;
  /** When a `scheduled` topic opens: its earliest resource release. */
  availableAt: Date | null;
  /** Unmet prerequisites of a `locked` topic, in syllabus order. */
  requires: { topicId: string; title: string }[];
}

/** A topic in this state can be studied; one predicate for the topic list, readings and media. */
export const topicOpens = (a: TopicAvailability): boolean =>
  a.state === 'available' || a.state === 'complete';

/** A student can open a resource that is visible and whose release time has passed. */
export const openToStudent = (r: AvailabilityResource, now: Date): boolean =>
  r.visibility === 'visible' && (r.releaseAt === null || r.releaseAt <= now);

/**
 * Availability of every topic of a release for one caller (§4), in one place so the topic list
 * and the media download gate agree. Instructors see no locks. For a student, in order:
 * a completed topic is `complete`; a topic with an incomplete prerequisite is `locked`; a topic
 * whose visible resources are all still unreleased is `scheduled` until the earliest of them;
 * anything else is `available`. A prerequisite that is not in the release cannot block (publishing
 * rejects such references).
 */
export function computeAvailability(
  topics: AvailabilityTopic[],
  opts: { role: 'student' | 'instructor'; now: Date; completed: ReadonlySet<string> },
): Map<string, TopicAvailability> {
  const { role, now, completed } = opts;
  const byId = new Map(topics.map((t) => [t.topicId, t]));
  const out = new Map<string, TopicAvailability>();
  for (const topic of topics) {
    if (completed.has(topic.topicId)) {
      out.set(topic.topicId, { state: 'complete', availableAt: null, requires: [] });
      continue;
    }
    if (role === 'instructor') {
      out.set(topic.topicId, { state: 'available', availableAt: null, requires: [] });
      continue;
    }
    const requires = topic.prerequisites.flatMap((id) => {
      const needed = byId.get(id);
      return needed && !completed.has(id) ? [{ topicId: id, title: needed.title }] : [];
    });
    if (requires.length > 0) {
      out.set(topic.topicId, { state: 'locked', availableAt: null, requires });
      continue;
    }
    const visible = topic.resources.filter((r) => r.visibility === 'visible');
    const released = visible.some((r) => openToStudent(r, now));
    if (visible.length > 0 && !released) {
      const times = visible.flatMap((r) => (r.releaseAt ? [r.releaseAt.getTime()] : []));
      out.set(topic.topicId, {
        state: 'scheduled',
        availableAt: new Date(Math.min(...times)),
        requires: [],
      });
      continue;
    }
    out.set(topic.topicId, { state: 'available', availableAt: null, requires: [] });
  }
  return out;
}

/** The tab a first visit opens: Slides when present, else the first populated tab (§4). */
export function firstTab(presence: Record<Tab, boolean>): Tab | null {
  return TABS.find((tab) => presence[tab]) ?? null;
}
