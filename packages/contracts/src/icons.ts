import { z } from 'zod';
import { ICON_NAMES } from './iconNames.gen';

/**
 * The icons of interactive exercises (§9): the Lucide set (https://lucide.dev/icons), drawn by
 * Parallax from its own copy of their path data (`scripts/icons.ts`), so an exercise names an
 * icon and never carries markup. An icon is drawn on a 24-unit square in the scene's stroke tone.
 */
export const iconNames: ReadonlySet<string> = new Set(ICON_NAMES.split(' '));

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        (row[j] ?? 0) + 1,
        (next[j - 1] ?? 0) + 1,
        (row[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    row = next;
  }
  return row[b.length] ?? 0;
}

const prefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
};

/** Up to three icon names close to `name`: those it is a word of, then the nearest spellings. */
export function iconSuggestions(name: string): string[] {
  const word = name.trim().toLowerCase();
  if (!word) return [];
  const all = [...iconNames];
  // Names with the word, those that start with it first: tree gives tree-palm, tree-pine…
  const at = (n: string) => n.split('-').indexOf(word);
  const words = all.filter((n) => at(n) >= 0).sort((a, b) => at(a) - at(b) || a.length - b.length);
  const near = all
    .map((n) => [n, distance(word, n)] as const)
    .filter(([, d]) => d <= Math.max(2, Math.floor(word.length / 3)))
    .sort(
      (a, b) => a[1] - b[1] || prefix(word, b[0]) - prefix(word, a[0]) || a[0].localeCompare(b[0]),
    )
    .map(([n]) => n);
  return [...new Set([...words, ...near])].slice(0, 3);
}

/** An icon's name, as https://lucide.dev/icons lists it; capitals are read as small letters. */
export const iconName = z
  .string()
  .trim()
  .toLowerCase()
  .superRefine((name, ctx) => {
    if (iconNames.has(name)) return;
    const like = iconSuggestions(name);
    ctx.addIssue({
      code: 'custom',
      message: `is not an icon${like.length ? `: try ${like.join(', ')}` : ''} (the icons are listed at lucide.dev/icons)`,
    });
  });
