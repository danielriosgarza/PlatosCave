import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

/** The body of the `@media (pointer: coarse)` block of global.css. */
const coarse = () => {
  const css = read('styles/global.css');
  const start = css.indexOf('@media (pointer: coarse)');
  return css.slice(start, css.indexOf('\n}\n', start));
};

describe('coarse-pointer touch targets', () => {
  it('A20 one global rule gives buttons, selects and text inputs 44 px that a module rule cannot shrink', () => {
    const rule = coarse();
    expect(rule).toMatch(/button,\s*select,\s*input:not\(\[type="checkbox"\], \[type="radio"\]\)/);
    expect(rule).toMatch(/min-height: var\(--pc-touch-target, 44px\) !important/);
    expect(rule).toMatch(/min-width: var\(--pc-touch-target, 44px\) !important/);
  });
});
