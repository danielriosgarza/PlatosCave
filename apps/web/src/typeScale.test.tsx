import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = import.meta.dirname;

function files(dir: string, test: (name: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, test);
    return test(name) ? [path] : [];
  });
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

// Sizes come from the rem-based --pc-size-* and --pc-text-* tokens so browser text scaling applies.
describe('type tokens in stylesheets', () => {
  const sheets = files(src, (n) => n.endsWith('.css'));

  it('A19 finds the stylesheets', () => {
    expect(sheets.length).toBeGreaterThan(10);
  });

  it('A19 no literal px, rem or pt in any font-size or font declaration', () => {
    const offenders = sheets.filter((f) =>
      /\bfont(-size)?\s*:[^;{}]*\d(px|rem|pt)\b/.test(stripComments(readFileSync(f, 'utf8'))),
    );
    expect(offenders.map((f) => relative(src, f))).toEqual([]);
  });

  it('A19 font-size never takes a --pc-text-* font shorthand', () => {
    const offenders = sheets.filter((f) =>
      /\bfont-size\s*:\s*var\(--pc-text-/.test(stripComments(readFileSync(f, 'utf8'))),
    );
    expect(offenders.map((f) => relative(src, f))).toEqual([]);
  });

  it('A19 no literal font size in inline styles', () => {
    const sources = files(src, (n) => /\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n));
    const offenders = sources.filter((f) =>
      /\bfontSize\s*:\s*['"]?\d|\bfont\s*:\s*['"][^'"]*\d(px|rem|pt)\b/.test(
        readFileSync(f, 'utf8'),
      ),
    );
    expect(offenders.map((f) => relative(src, f))).toEqual([]);
  });
});
