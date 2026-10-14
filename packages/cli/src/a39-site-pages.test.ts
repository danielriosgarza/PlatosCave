import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { main } from './main';
import { screenAddresses } from './site/pages';

const pkg = resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-a39-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
delete process.env.DATABASE_URL;
const EARLIER = 'the earlier build';
const page = 'export default () => <p>A page</p>;\n';

let copies = 0;
/** The instructor fixture outside the repository, an earlier build in dist/, files written over it. */
function site(files: Record<string, string>): string {
  const root = join(temp, `site-${copies++}`);
  fs.cpSync(join(pkg, 'fixtures/site/instructor'), root, { recursive: true });
  for (const [path, text] of Object.entries({ 'dist/index.html': EARLIER, ...files })) {
    fs.mkdirSync(dirname(join(root, path)), { recursive: true });
    fs.writeFileSync(join(root, path), text);
  }
  return root;
}
/** What `parallax build` says for a site, its exit code, and whether dist/ is as it was. */
async function build(root: string) {
  const lines: string[] = [];
  const said = (line: unknown) => void lines.push(String(line));
  const spy = vi.spyOn(console, 'error').mockImplementation(said);
  const code = await main(['build'], { cwd: root, print: said });
  spy.mockRestore();
  const dist = fs.readdirSync(join(root, 'dist'));
  const earlier = fs.readFileSync(join(root, 'dist/index.html'), 'utf8') === EARLIER;
  return { code, said: lines.join('\n'), kept: dist.join() === 'index.html' && earlier };
}

test('A39 a site page at the address of a Parallax screen stops the build and names both', {
  timeout: 600_000,
}, async () => {
  const screens = [
    ['courses.tsx', '/courses'],
    ['courses/index.tsx', '/courses'],
    ['signin.tsx', '/signin'],
    ['classes/demo/review.tsx', '/classes/$classId/review'],
  ];
  for (const [file, screen] of screens) {
    const stopped = await build(site({ [`src/pages/${file}`]: page }));
    expect(stopped).toMatchObject({ code: 1, kept: true });
    expect(stopped.said).toContain(`src/pages/${file} would be at`);
    expect(stopped.said).toContain(`the address of the Parallax screen ${screen}.`);
  }

  // A front page at / and a page at /about build, and replace the earlier build.
  const root = site({ 'src/pages/about.tsx': page });
  expect(await build(root)).toMatchObject({ code: 0, kept: false });
  expect(fs.readdirSync(join(root, 'dist/assets')).some((file) => /^about-/.test(file))).toBe(true);

  // Each of these stops the build as well, before dist/ changes, and names the file.
  const notes = "import '../../courses/statistics/means/reading/means.md?raw';\n";
  const refused: [Record<string, string>, string][] = [
    [
      { 'src/pages/about.tsx': page, 'src/pages/about/index.tsx': page },
      'about.tsx and src/pages/about/index.tsx are both at /about',
    ],
    [{ 'src/pages/api/v2.tsx': page }, 'src/pages/api/v2.tsx would be at /api/v2, under /api'],
    [{ 'src/pages/assets.tsx': page }, 'src/pages/assets.tsx would be at /assets, under /assets'],
    [{ 'src/pages/content/x.tsx': page }, 'src/pages/content/x.tsx would be at /content/x'],
    [{ 'src/pages/notes.mdx': '# Notes\n' }, 'src/pages/notes.mdx: a page is a .tsx or .jsx'],
    [
      { 'src/pages/index.tsx': notes + page },
      'src/pages/index.tsx imports courses/statistics/means/reading/means.md, which lies in a course folder',
    ],
  ];
  for (const [files, named] of refused) {
    const stopped = await build(site(files));
    expect(stopped).toMatchObject({ code: 1, kept: true });
    expect(stopped.said).toContain(named);
  }
});

test('A39 the addresses read from routeTree.gen.ts cover every route file with a path', () => {
  const routes = resolve(pkg, '../../apps/web/src/routes');
  const files = fs.readdirSync(routes, { recursive: true, encoding: 'utf8' });
  const addresses = files.flatMap((file) => {
    // TanStack's file names: `.` and `/` separate segments, `_` marks the root and a pathless layout.
    const parts = file.replace(/\.tsx$/, '').split(/[\\/.]/);
    if (!file.endsWith('.tsx') || parts.at(-1)?.startsWith('_')) return [];
    return [`/${parts.filter((part) => !part.startsWith('_') && part !== 'index').join('/')}`];
  });
  expect(addresses.length).toBeGreaterThan(5);
  expect(screenAddresses().sort()).toEqual([...new Set(addresses)].sort());
});
