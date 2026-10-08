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
      const v = declared.get(`--pc-text-${k}`) ?? '';
      const rem = `${Number.parseFloat(t.fontSize) / 16}rem`;
      expect(v, k).toContain(`${t.fontWeight}${rem}/${t.lineHeight}`);
    }
  });
  it('size tokens are rem and equal the role sizes', () => {
    for (const k of ['title', 'section', 'subsection', 'body', 'field', 'ui', 'label']) {
      const role = declared.get(`--pc-text-${k}`) ?? '';
      expect(role, k).toContain(`${declared.get(`--pc-size-${k}`)}/`);
    }
    expect(declared.get('--pc-reading-size')).toBe(declared.get('--pc-size-body'));
  });
  it('tokenNames lists every declared property', () => {
    expect([...tokenNames].sort()).toEqual([...declared.keys()].sort());
  });
});
