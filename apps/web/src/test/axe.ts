import axe from 'axe-core';
import { expect } from 'vitest';

/** Fails on any axe violation in `root`; colour contrast needs real layout, which jsdom lacks. */
export async function expectNoAxeViolations(root: HTMLElement): Promise<void> {
  const results = await axe.run(root, { rules: { 'color-contrast': { enabled: false } } });
  expect(results.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
}
