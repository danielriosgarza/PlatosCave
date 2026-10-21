import { iconAliases } from '@parallax/contracts';
import { useEffect, useId, useState } from 'react';
import buttons from '../components/Buttons.module.css';
import { Glyph } from '../exercises/interactive/icon';
import local from './Authoring.module.css';

/** Results shown at once; a longer list is narrowed by typing more. */
const SHOWN = 60;

type Tags = Readonly<Record<string, string>>;

/** Each icon's older names (`home` for `house`), made once. */
let older: Map<string, string[]> | null = null;

/** How `word` matches `name`: 0 its first part, 1 another part, 2 the start of a part, 3 inside. */
function nameRank(word: string, name: string): number {
  const parts = name.split('-');
  if (parts[0] === word) return 0;
  if (parts.includes(word)) return 1;
  if (parts.some((p) => p.startsWith(word))) return 2;
  return name.includes(word) ? 4 : -1;
}

/**
 * Icon names matching every word of `query`, by name, by older name or by search word: names
 * that start with the word first, then names with it as a part, then names with a part that
 * starts with it, then names with it as a search word, then names that contain it, then names
 * with a search word that starts with it. An older name counts as the icon's name.
 */
export function findIcons(query: string, tags: Tags): string[] {
  const words = query
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  if (!words.length) return [];
  if (!older) {
    older = new Map();
    for (const [alias, name] of iconAliases) older.set(name, [...(older.get(name) ?? []), alias]);
  }
  const found: [string, number][] = [];
  for (const [name, list] of Object.entries(tags)) {
    const spellings = [name, ...(older.get(name) ?? [])];
    const search = list.split(/[,\s]+/);
    // How each word matches, as above; -1 not at all.
    const ranks = words.map((w) => {
      const named = spellings.map((n) => nameRank(w, n)).filter((r) => r >= 0);
      if (named.some((r) => r < 3)) return Math.min(...named);
      if (search.includes(w)) return 3;
      if (named.length) return 4;
      return search.some((t) => t.startsWith(w)) ? 5 : -1;
    });
    if (!ranks.includes(-1)) found.push([name, ranks.reduce((a: number, b) => a + b, 0)]);
  }
  return found
    .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
    .map(([name]) => name);
}

/**
 * Finds an icon (`packages/contracts/src/icons.ts`) by its name or by what it shows, and puts
 * the chosen name in the step's fields. The search words are fetched when the finder opens.
 */
export function IconFinder({ onPick }: { onPick: (name: string) => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [tags, setTags] = useState<Tags | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!open || tags) return;
    let live = true;
    setFailed(false);
    import('./iconTags.gen').then(
      (m) => live && setTags(m.ICON_TAGS),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [open, tags]);
  const found = tags ? findIcons(query, tags) : [];
  return (
    <div className={local.iconFinder}>
      <button
        type="button"
        className={buttons.textButton}
        aria-expanded={open}
        aria-controls={`${id}-panel`}
        onClick={() => setOpen(!open)}
      >
        {open ? 'Close the icon finder' : 'Find an icon'}
      </button>
      {open ? (
        <div id={`${id}-panel`} className={local.iconPanel}>
          <label htmlFor={`${id}-query`}>Icon</label>
          <input
            id={`${id}-query`}
            type="search"
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder="tree, triangle, apple…"
            onChange={(e) => setQuery(e.target.value)}
          />
          <p className={local.hint} aria-live="polite">
            {failed
              ? 'The icon list did not load. Close the finder and open it again to retry.'
              : !tags
                ? 'Loading the icon list…'
                : !query.trim()
                  ? 'Type what the icon shows. Choosing an icon puts its name at the cursor in the fields.'
                  : found.length === 0
                    ? 'No icon matches. Try another word.'
                    : found.length > SHOWN
                      ? `${found.length} icons match; the first ${SHOWN} are shown.`
                      : `${found.length} ${found.length === 1 ? 'icon matches' : 'icons match'}.`}
          </p>
          {found.length ? (
            <ul className={local.iconGrid} aria-label="Matching icons">
              {found.slice(0, SHOWN).map((name) => (
                <li key={name}>
                  <button
                    type="button"
                    className={local.iconChoice}
                    title={name}
                    onClick={() => onPick(name)}
                  >
                    <Glyph name={name} size={28} />
                    <span>{name}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
