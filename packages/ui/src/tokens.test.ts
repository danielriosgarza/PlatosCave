import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { tokenNames } from './index';

const root = resolve(import.meta.dirname, '../../..');
const css = readFileSync(resolve(import.meta.dirname, 'tokens.css'), 'utf8');
const design = readFileSync(resolve(root, 'DESIGN.md'), 'utf8');
const front = parse(design.split('---')[1] ?? '') as {
  colors: Record<string, string>;
  typography: Record<
    string,
    { fontSize: string; fontWeight: number; lineHeight: number; letterSpacing?: string }
  >;
  rounded: Record<string, string>;
  spacing: Record<string, string>;
};

const squash = (s: string) => s.replace(/\s+/g, '');
const declared = new Map<string, string>();
for (const m of css.matchAll(/(--pc-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
  declared.set(m[1] as string, squash(m[2] as string));
}
const resolveSizes = (v: string): string =>
  v.replace(/var\((--pc-size-[a-z]+)\)/g, (_, name: string) => declared.get(name) ?? '');

describe('design tokens match DESIGN.md', () => {
  it('colors', () => {
    for (const [k, v] of Object.entries(front.colors)) {
      expect(declared.get(`--pc-${k}`), k).toBe(squash(v));
    }
  });
  it('rounded', () => {
    for (const [k, v] of Object.entries(front.rounded)) {
      expect(declared.get(`--pc-radius-${k}`), k).toBe(squash(v));
    }
  });
  it('spacing', () => {
    for (const [k, v] of Object.entries(front.spacing)) {
      expect(declared.get(`--pc-space-${k}`), k).toBe(squash(v));
    }
  });
  it('typography weight, size and line height', () => {
    for (const [k, t] of Object.entries(front.typography)) {
      const v = resolveSizes(declared.get(`--pc-text-${k}`) ?? '');
      const rem = `${Number.parseFloat(t.fontSize) / 16}rem`;
      expect(v, k).toContain(`${t.fontWeight}${rem}/${t.lineHeight}`);
    }
  });
  it('roles take their size from the rem size tokens', () => {
    for (const [k, t] of Object.entries(front.typography)) {
      if (!declared.has(`--pc-size-${k}`)) continue;
      expect(declared.get(`--pc-size-${k}`), k).toBe(`${Number.parseFloat(t.fontSize) / 16}rem`);
      expect(declared.get(`--pc-text-${k}`), k).toContain(`var(--pc-size-${k})`);
    }
    expect(declared.get('--pc-reading-size')).toBe('var(--pc-size-body)');
  });
  it('tokenNames lists every declared property', () => {
    expect([...tokenNames].sort()).toEqual([...declared.keys()].sort());
  });
});
