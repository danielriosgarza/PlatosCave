import { describe, expect, test } from 'vitest';
import {
  type AvailabilityResource,
  type AvailabilityTopic,
  computeAvailability,
  firstTab,
} from './availability';

const now = new Date('2026-10-01T09:00:00Z');
const later = new Date('2026-10-05T09:00:00Z');
const visible = (tab: AvailabilityResource['tab'], releaseAt: Date | null = null) =>
  ({ tab, visibility: 'visible', releaseAt }) satisfies AvailabilityResource;

const topic = (
  topicId: string,
  prerequisites: string[] = [],
  resources: AvailabilityResource[] = [visible('reading')],
): AvailabilityTopic => ({ topicId, title: `Topic ${topicId}`, prerequisites, resources });

const states = (
  topics: AvailabilityTopic[],
  opts: { role?: 'student' | 'instructor'; completed?: string[] } = {},
) => {
  const result = computeAvailability(topics, {
    role: opts.role ?? 'student',
    now,
    completed: new Set(opts.completed ?? []),
  });
  return Object.fromEntries(topics.map((t) => [t.topicId, result.get(t.topicId)?.state]));
};

describe('topic availability', () => {
  test('A02 a topic behind an incomplete prerequisite is locked and names it', () => {
    const topics = [topic('a'), topic('b', ['a'])];
    expect(states(topics)).toEqual({ a: 'available', b: 'locked' });
    const result = computeAvailability(topics, {
      role: 'student',
      now,
      completed: new Set(),
    });
    expect(result.get('b')?.requires).toEqual([{ topicId: 'a', title: 'Topic a' }]);
  });

  test('A02 completing the prerequisite opens the topic', () => {
    const topics = [topic('a'), topic('b', ['a'])];
    expect(states(topics, { completed: ['a'] })).toEqual({ a: 'complete', b: 'available' });
  });

  test('A02 a topic whose only visible resources release later is scheduled until the earliest', () => {
    const topics = [
      topic('a', [], [visible('slides', later), visible('reading', new Date(later.getTime() + 1))]),
    ];
    const result = computeAvailability(topics, { role: 'student', now, completed: new Set() });
    expect(result.get('a')).toMatchObject({ state: 'scheduled', availableAt: later });
  });

  test('A02 a topic with one released resource is available', () => {
    expect(states([topic('a', [], [visible('slides'), visible('reading', later)])])).toEqual({
      a: 'available',
    });
  });

  test('A02 a topic with no resources, or only hidden ones, is available', () => {
    const hidden: AvailabilityResource = { tab: 'reading', visibility: 'hidden', releaseAt: later };
    expect(states([topic('a', [], []), topic('b', [], [hidden])])).toEqual({
      a: 'available',
      b: 'available',
    });
  });

  test('A02 instructors see no locks or schedules', () => {
    const topics = [topic('a', [], [visible('slides', later)]), topic('b', ['a'])];
    expect(states(topics, { role: 'instructor' })).toEqual({ a: 'available', b: 'available' });
  });

  test('A02 a prerequisite outside the release does not block', () => {
    expect(states([topic('a', ['gone'])])).toEqual({ a: 'available' });
  });
});

describe('first-visit tab', () => {
  const none = { slides: false, reading: false, exercises: false, notebooks: false, tests: false };
  test('A03 opens Slides when present, else the first populated tab, else nothing', () => {
    expect(firstTab({ ...none, slides: true, reading: true })).toBe('slides');
    expect(firstTab({ ...none, exercises: true, tests: true })).toBe('exercises');
    expect(firstTab(none)).toBeNull();
  });
});
