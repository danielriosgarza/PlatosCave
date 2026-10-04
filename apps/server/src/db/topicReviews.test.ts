import { describe, expect, test } from 'vitest';
import {
  checksOf,
  completedFrom,
  type Evidence,
  type RuleResource,
  type RuleTopic,
} from './topicReviews';

const now = new Date('2026-10-01T09:00:00Z');
const topic = (completionRule: RuleTopic['completionRule'] = null): RuleTopic => ({
  id: 'rt1',
  topicId: 't1',
  completionRule,
});
const resource = (id: string, type: string, extra: Partial<RuleResource> = {}): RuleResource => ({
  releaseTopicId: 'rt1',
  resourceId: id,
  type,
  tab: 'reading',
  title: id,
  visibility: 'visible',
  releaseAt: null,
  ...extra,
});
const evidence = (reviewed: string[] = [], submitted: string[] = []): Evidence => ({
  reviewed: new Set(reviewed),
  submitted: new Set(submitted),
});
const done = (t: RuleTopic, rs: RuleResource[], e: Evidence) =>
  completedFrom([t], rs, e, now).has('t1');

describe('completion rule', () => {
  test('the default asks for every ungraded resource and ignores graded ones', () => {
    const rs = [resource('a', 'reading_native'), resource('b', 'notebook'), resource('q', 'test')];
    expect(done(topic(), rs, evidence(['a']))).toBe(false);
    expect(done(topic(), rs, evidence(['a', 'b']))).toBe(true);
  });

  test('resources a student cannot open yet are not asked for', () => {
    const later = new Date('2026-11-01T00:00:00Z');
    const rs = [
      resource('a', 'reading_native'),
      resource('late', 'reading_pdf', { releaseAt: later }),
      resource('gone', 'reading_pdf', { visibility: 'hidden' }),
    ];
    expect(done(topic(), rs, evidence(['a']))).toBe(true);
  });

  test('a topic with nothing to ask is never complete', () => {
    expect(done(topic(), [resource('q', 'test')], evidence())).toBe(false);
    expect(done(topic({ requires: [] }), [resource('a', 'notebook')], evidence())).toBe(false);
  });

  test('a custom rule asks for a submission of a named resource', () => {
    const t = topic({ requires: ['submitted:nb'] });
    const rs = [resource('nb', 'notebook'), resource('a', 'reading_native')];
    // Reviewing the notebook is not submitting it.
    expect(done(t, rs, evidence(['nb', 'a']))).toBe(false);
    expect(done(t, rs, evidence([], ['nb']))).toBe(true);
    // A submission for a resource that is not on the topic does not count.
    expect(done(topic({ requires: ['submitted:other'] }), rs, evidence([], ['other']))).toBe(false);
  });

  test('a custom rule can combine reviewed marks and submissions', () => {
    const t = topic({ requires: ['reviewed:*', 'submitted:nb'] });
    const rs = [resource('nb', 'notebook'), resource('a', 'reading_native')];
    expect(done(t, rs, evidence(['a', 'nb']))).toBe(false);
    expect(done(t, rs, evidence(['a', 'nb'], ['nb']))).toBe(true);
  });

  test('an unknown requirement is never met', () => {
    const t = topic({ requires: ['reviewed:*', 'attended:lecture'] });
    const rs = [resource('a', 'reading_native')];
    expect(done(t, rs, evidence(['a']))).toBe(false);
    expect(checksOf(t, rs, evidence(['a'])).filter((c) => !c.met)).toHaveLength(1);
  });
});
