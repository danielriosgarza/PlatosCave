import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = import.meta.dirname;

function cssFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return cssFiles(path);
    return name.endsWith('.module.css') ? [path] : [];
  });
}

// A19: sizes come from the rem-based --pc-size-* tokens so browser text scaling applies.
describe('A19 module CSS uses the type tokens', () => {
  const files = cssFiles(src);

  it('A19 finds the module stylesheets', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('A19 no literal px, rem or pt in any font-size or font declaration', () => {
    const offenders = files.filter((f) =>
      /\bfont(-size)?\s*:[^;{}]*\d(px|rem|pt)\b/.test(readFileSync(f, 'utf8')),
    );
    expect(offenders.map((f) => relative(src, f))).toEqual([]);
  });
});
