import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = join(__dirname, '..');

const cssFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });

/** The declaration blocks of every `@media (pointer: coarse)` block in a stylesheet. */
const coarseBlocks = (css: string) => {
  const blocks: string[] = [];
  for (let at = css.indexOf('@media (pointer: coarse)'); at !== -1; ) {
    const end = css.indexOf('\n}\n', at);
    blocks.push(css.slice(at, end === -1 ? undefined : end));
    at = css.indexOf('@media (pointer: coarse)', at + 1);
  }
  return blocks;
};

describe('coarse-pointer touch targets', () => {
  it('A20 global.css gives buttons, selects, text areas and text inputs a 44 px minimum that wins over module rules', () => {
    const rule = coarseBlocks(readFileSync(join(src, 'styles/global.css'), 'utf8')).join('\n');
    for (const element of ['button', 'select', 'textarea', 'input'])
      expect(rule).toContain(element);
    expect(rule).toMatch(/min-height:\s*var\(--pc-touch-target, 44px\)\s*!important/);
    expect(rule).toMatch(/min-width:\s*var\(--pc-touch-target, 44px\)\s*!important/);
  });

  it('A20 no module stylesheet caps the height of a control with !important', () => {
    // A module rule with !important and higher specificity would beat the global rule.
    const offenders = cssFiles(src)
      .filter((file) => !file.endsWith('global.css'))
      .flatMap((file) => {
        // Visually hidden text is not a control and is meant to be 1 px.
        const css = readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\.visuallyHidden\s*\{[^}]*\}/g, '');
        return [...css.matchAll(/(?:^|[;{\s])((?:min-|max-)?height)\s*:[^;}]*!important/g)].map(
          (m) => `${file.slice(src.length + 1)}: ${m[1]}`,
        );
      });
    expect(offenders).toEqual([]);
  });
});
