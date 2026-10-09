import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = import.meta.dirname;
const read = (path: string) => readFileSync(join(src, path), 'utf8');
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const sheets = [
  'review/ClassReview.module.css',
  'review/Grading.module.css',
  'assessments/Test.module.css',
];
const components = [
  'assessments/AccommodationsPanel.tsx',
  'assessments/Results.tsx',
  'assessments/TestsPanel.tsx',
  'assessments/AttemptWorkspace.tsx',
];

// Spacing comes from the --pc-space-* scale so every surface shares one rhythm.
describe('spacing tokens in review, grading and test surfaces', () => {
  it.each(sheets)('A19 %s has no literal px in margin, padding or gap', (sheet) => {
    const spacing = stripComments(read(sheet))
      .split('\n')
      .filter((line) => /^\s*(margin|padding|gap)[a-z-]*:/.test(line) && /\d+px/.test(line))
      // a negative 1px margin belongs to the visually-hidden utility, not to layout
      .filter((line) => !line.includes('-1px'));
    expect(spacing).toEqual([]);
  });

  it.each(components)('A19 %s has no inline spacing styles', (file) => {
    expect(read(file)).not.toMatch(/style=\{\{[^}]*(margin|padding|gap|maxWidth)/i);
  });
});
