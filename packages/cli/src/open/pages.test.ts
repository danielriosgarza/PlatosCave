import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { LEVEL_0 } from '../commands/dev';
import { main } from '../main';
import { printing } from './testing';

delete process.env.DATABASE_URL;
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-open-pages-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
/** A copy of the instructor fixture of the open site, at `level`, with the `dist/` of a build. */
function copy(name: string, level: 0 | 1): string {
  const root = join(temp, name);
  fs.cpSync(resolve(import.meta.dirname, '../../fixtures/open-site/instructor'), root, {
    recursive: true,
  });
  const config = join(root, 'parallax.config.ts');
  fs.writeFileSync(config, fs.readFileSync(config, 'utf8').replace('level: 0', `level: ${level}`));
  fs.mkdirSync(join(root, 'dist'));
  fs.writeFileSync(join(root, 'dist/index.html'), 'an earlier build');
  return root;
}

test('a page at /courses/intro stops the build at level 0 and at level 1 and names both', async () => {
  for (const level of [0, 1] as const) {
    const root = copy(`intro-${level}`, level);
    fs.mkdirSync(join(root, 'src/pages/courses'), { recursive: true });
    fs.writeFileSync(join(root, 'src/pages/courses/intro.tsx'), 'export default () => null;\n');
    const run = await printing(() => main(['build'], { cwd: root }));
    expect(run, `level ${level}`).toEqual({
      result: 1,
      lines: [
        'src/pages/courses/intro.tsx would be at /courses/intro, which matches /courses/$a: Parallax keeps /courses and the addresses below it. Move or rename the page.',
      ],
    });
    // Nothing was compiled, converted or placed.
    expect(fs.readdirSync(root).filter((name) => /^(\.parallax|dist)$/.test(name))).toEqual([
      'dist',
    ]);
    expect(fs.readdirSync(join(root, 'dist'))).toEqual(['index.html']);
  }
}, 120_000);

test('parallax dev at level 0 stops and names parallax build and the two folders', async () => {
  const run = await printing(() => main(['dev'], { cwd: copy('dev', 0) }));
  expect(run).toEqual({ result: 1, lines: [LEVEL_0] });
  expect(LEVEL_0).toMatch(/parallax build.*dist\/site and dist\/content/);
});
