import { getClassTopics } from '@parallax/contracts/routes/topics';
import type { z } from 'zod';
import { useApi } from '../api/client';
import { formatInstant } from '../format/format';

export type ClassTopics = z.output<typeof getClassTopics.response>;
export type ClassTopic = ClassTopics['topics'][number];
export type TopicTab = ClassTopic['presence'] extends Record<infer K, boolean> ? K : never;

/** Tab order and the letters of the syllabus legend (§4). */
export const TAB_LEGEND: readonly { id: TopicTab; label: string; letter: string }[] = [
  { id: 'slides', label: 'Slides', letter: 'S' },
  { id: 'reading', label: 'Reading', letter: 'R' },
  { id: 'exercises', label: 'Exercises', letter: 'E' },
  { id: 'notebooks', label: 'Notebooks', letter: 'N' },
  { id: 'tests', label: 'Tests', letter: 'T' },
];

export const useClassTopics = (classId: string) => useApi(getClassTopics, { params: { classId } });

/** Two-digit syllabus number, as in the wireframe: 01, 02, … */
export const topicNumber = (topic: ClassTopic) => String(topic.number).padStart(2, '0');

export const isOpen = (topic: ClassTopic) =>
  topic.state === 'available' || topic.state === 'complete';

/** Tab a link to this topic opens: its saved tab, else the first-visit rule (§4). */
export const tabFor = (topic: ClassTopic): TopicTab => topic.savedTab ?? topic.firstTab ?? 'slides';

/** Why a topic is closed: its release time or the topics it waits for; null when it is open. */
export function lockReason(topic: ClassTopic): string | null {
  if (topic.state === 'scheduled' && topic.availableAt) {
    return `Opens ${formatInstant(topic.availableAt)}`;
  }
  if (topic.state === 'locked') {
    return `Requires ${topic.requires.map((r) => r.title).join(', ')}`;
  }
  return null;
}

export const minutes = (topic: ClassTopic) =>
  topic.estimatedMinutes === null ? '—' : `${topic.estimatedMinutes} min`;
