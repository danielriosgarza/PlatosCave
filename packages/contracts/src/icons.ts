import { z } from 'zod';
import { ICON_ALIASES, ICON_NAMES } from './iconNames.gen';

/**
 * The icons of interactive exercises (§9): the Lucide set (https://lucide.dev/icons), drawn by
 * Parallax from its own copy of their path data (`scripts/icons.ts`), so an exercise names an
 * icon and never carries markup. An icon is drawn on a 24-unit square in the scene's stroke tone.
 */
export const iconNames: ReadonlySet<string> = new Set(ICON_NAMES.split(' '));

/** Lucide's older names, each read as the icon it names now: `home` is `house`. */
export const iconAliases: ReadonlyMap<string, string> = new Map(
  ICON_ALIASES.split(' ').map((pair) => pair.split(':') as [string, string]),
);

/** The longest name accepted: a longer one is no icon. */
const LONGEST = Math.max(...[...iconNames, ...iconAliases.keys()].map((n) => n.length));
/** The most edits between a name and a suggestion: no suggestion is longer than LONGEST + MOST. */
const MOST = 3;

/** Every accepted name with its words, made once, when a name is first not found. */
let spellings: { name: string; words: string[] }[] | null = null;
let rows: [Int32Array, Int32Array] = [new Int32Array(LONGEST + 1), new Int32Array(LONGEST + 1)];

/** The edit distance from `a` to `b` when it is at most `most`; otherwise more than `most`. */
function distance(a: string, b: string, most: number): number {
  let [row, next] = rows;
  for (let j = 0; j <= b.length; j++) row[j] = j;
  for (let i = 1; i <= a.length; i++) {
    next[0] = i;
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = (row[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const v = Math.min((row[j] as number) + 1, (next[j - 1] as number) + 1, cost);
      next[j] = v;
      if (v < least) least = v;
    }
    // No later row is smaller than this one's least.
    if (least > most) return most + 1;
    [row, next] = [next, row];
  }
  rows = [row, next];
  return row[b.length] as number;
}

const prefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return i;
};

/** Up to three icon names close to `name`: those it is a word of, then the nearest spellings. */
export function iconSuggestions(name: string): string[] {
  const word = name.trim().toLowerCase();
  if (!word || word.length > LONGEST + MOST) return [];
  spellings ??= [...iconNames, ...iconAliases.keys()].map((n) => ({
    name: n,
    words: n.split('-'),
  }));
  // Names with the word, those that start with it first: tree gives tree-palm, tree-pine…
  const words = spellings
    .flatMap(({ name: n, words }) =>
      iconNames.has(n) && words.includes(word) ? [[n, words.indexOf(word)] as const] : [],
    )
    .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length)
    .map(([n]) => n);
  // Older names count as spellings of the icons they name. An edit distance is at least the
  // difference in length, so most names are never compared.
  const most = word.length < 6 ? 2 : MOST;
  const near = spellings
    .flatMap(({ name: n }) =>
      Math.abs(n.length - word.length) <= most ? [[n, distance(word, n, most)] as const] : [],
    )
    .filter(([, d]) => d <= most)
    .sort(
      (a, b) => a[1] - b[1] || prefix(word, b[0]) - prefix(word, a[0]) || a[0].localeCompare(b[0]),
    )
    .map(([n]) => iconAliases.get(n) ?? n);
  return [...new Set([...words, ...near])].slice(0, 3);
}

const unknown = (like: string[]) =>
  `is not an icon${like.length ? `: try ${like.join(', ')}` : ''} (the icons are listed at lucide.dev/icons)`;

/**
 * An icon's name, as https://lucide.dev/icons lists it. Capitals are read as small letters, and
 * an older Lucide name as the icon it names now. An unknown name is refused with the name in the
 * issue's `params.icon`, and without the nearest names: `iconHints` adds them to a few issues,
 * since one exercise can hold thousands of names and each search costs about a millisecond.
 */
export const iconName = z
  .string()
  .trim()
  .toLowerCase()
  .superRefine((name, ctx) => {
    if (iconNames.has(name) || iconAliases.has(name)) return;
    ctx.addIssue({ code: 'custom', message: unknown([]), params: { icon: name } });
  })
  .overwrite((name) => iconAliases.get(name) ?? name);

/** The unknown names given the nearest names in their messages; later ones keep the plain one. */
export const HINTED = 10;

/** `issues` with the nearest icon names added to the first `HINTED` unknown icon names. */
export function iconHints<T extends { code?: string; message: string; params?: unknown }>(
  issues: readonly T[],
): T[] {
  let left = HINTED;
  return issues.map((issue) => {
    const icon = (issue.params as { icon?: unknown } | undefined)?.icon;
    if (issue.code !== 'custom' || typeof icon !== 'string' || left === 0) return issue;
    left -= 1;
    return { ...issue, message: unknown(iconSuggestions(icon)) };
  });
}
