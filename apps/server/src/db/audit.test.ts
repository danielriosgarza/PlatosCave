import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { expect, test } from 'vitest';

const root = join(__dirname, '..');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

test('audit_events rows are appended only by db/audit.ts', () => {
  const writers = sources(root)
    .filter((file) => /insert\(\s*auditEvents\s*\)/.test(readFileSync(file, 'utf8')))
    .map((file) => relative(root, file).split(sep).join('/'));
  expect(writers).toEqual(['db/audit.ts']);
});
