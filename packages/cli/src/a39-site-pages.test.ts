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
/**
 * The instructor fixture outside the repository, an earlier build in dist/, files written over it;
 * the folder `linked` moved out of the site, a link (a junction on Windows) in its place.
 */
function site(files: Record<string, string>, linked?: string): string {
  const root = join(temp, `site-${copies++}`);
  fs.cpSync(join(pkg, 'fixtures/site/instructor'), root, { recursive: true });
  if (linked) {
    fs.renameSync(join(root, linked), `${root}-outside`);
    fs.symlinkSync(`${root}-outside`, join(root, linked), 'junction');
  }
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

  // A front page at / and a page at /about build, and replace the earlier build; so does the
  // page's CSS module, whose every selector carries a class.
  const root = site({
    'src/pages/about.tsx': `import styles from './about.module.css';\nexport default () => <p className={styles.card}>About</p>;\n`,
    'src/pages/about.module.css': `.card :is(h1, h2) { margin: 0 }\n.card { --about-gap: 7px; span { color: red } }\n.x:not(.a, b) { color: blue }\n`,
  });
  expect(await build(root)).toMatchObject({ code: 0, kept: false });
  const assets = fs.readdirSync(join(root, 'dist/assets'));
  expect(assets.some((file) => /^about-/.test(file))).toBe(true);
  const sheets = assets.filter((file) => file.endsWith('.css'));
  const built = sheets.map((file) => fs.readFileSync(join(root, 'dist/assets', file), 'utf8'));
  expect(built.join('\n')).toContain('--about-gap');

  // Each of these stops the build as well, before dist/ changes, and names the file.
  const front = (line: string) => ({ 'src/pages/index.tsx': `${line}\n${page}` });
  const raw = (path: string) => front(`import '../../${path}?raw';`);
  const url = (path: string) => front(`new URL('../../${path}', import.meta.url);`);
  const notes = 'courses/statistics/means/reading/means.md';
  const yaml = 'private/courses/statistics/means/exercises/mean.yaml';
  const lies = 'which lies in a course folder or the private overlay';
  const glob = front("import.meta.glob('../../courses/**/*.md', { eager: true });");
  const twins = { 'src/pages/about.tsx': page, 'src/pages/about/index.tsx': page };
  const worker = front("new Worker(new URL('./_worker.ts', import.meta.url));");
  const entry = 'courses/statistics/means/w.js';
  const course = front(
    `new Worker(new URL('../../${entry}', import.meta.url), { type: 'module' });`,
  );
  const sheet = (css: string) => ({
    ...front("import './front.module.css';"),
    'src/pages/front.module.css': css,
  });
  const plain = { ...front("import './site.css';"), 'src/pages/site.css': '.site {}' };
  const look = {
    ...front("import 'look/look.css';"),
    'node_modules/look/package.json': '{ "name": "look", "version": "1.0.0" }',
    'node_modules/look/look.css': 'p { color: red; }',
  };
  const css = 'src/pages/front.module.css';
  const refused: [Record<string, string>, string, string?][] = [
    // A stylesheet that could reach a Parallax screen or token (docs/design/site.md §6.7).
    [plain, 'src/pages/site.css: a site stylesheet is a *.module.css file'],
    [look, 'node_modules/look/look.css: a site stylesheet is a *.module.css file'],
    [sheet('.front { --pc-accent: red; }'), `${css}: declares a --pc-* property of Parallax`],
    [sheet(`@import '../../${notes.replace('.md', '.module.css')}';`), `${css}: uses @import`],
    [sheet(':not(.front) { color: red; }'), `${css}: the selector :not(.front) has no class`],
    [twins, 'about.tsx and src/pages/about/index.tsx are both at /about'],
    [{ 'src/pages/About.tsx': page }, 'src/pages/About.tsx: "About" cannot be part of an address'],
    [{ 'src/pages/api/v2.tsx': page }, 'src/pages/api/v2.tsx would be at /api/v2, under /api'],
    [{ 'src/pages/assets.tsx': page }, 'src/pages/assets.tsx would be at /assets, under /assets'],
    [{ 'src/pages/content/x.tsx': page }, 'src/pages/content/x.tsx would be at /content/x'],
    [{ 'src/pages/notes.mdx': '# Notes\n' }, 'src/pages/notes.mdx: a page is a .tsx or .jsx'],
    [raw(notes), `src/pages/index.tsx imports ${notes}, ${lies}`],
    [glob, `src/pages/index.tsx imports ${notes}, ${lies}`],
    // A file that Vite reads itself, `?inline` or not, and a worker, which is a build of its own.
    [url(notes), `The build would read ${notes}, ${lies}`],
    [url(`${notes}?inline`), `The build would read ${notes}, ${lies}`],
    [url(yaml), `The build would read ${yaml}, ${lies}`],
    [front("import './_composes.module.css';"), `reading/means.module.css, ${lies}`],
    [worker, `src/pages/_worker.ts imports ${notes}, ${lies}`],
    [course, `The build would hold ${entry}, ${lies}`],
    // A course folder or an overlay that is a link counts where it leads.
    [raw(notes), 'src/pages/index.tsx imports ', 'courses/statistics'],
    [raw(yaml), 'src/pages/index.tsx imports ', 'private'],
    [url(notes), 'The build would read ', 'courses/statistics'],
    [url(yaml), 'The build would read ', 'private'],
  ];
  for (const [files, named, linked] of refused) {
    const stopped = await build(site(files, linked));
    expect(stopped).toMatchObject({ code: 1, kept: true });
    expect(stopped.said).toContain(named);
    if (linked) expect(stopped.said).toContain(lies);
    // One line for each problem: no error of the bundler, no stack and no colour around it.
    expect(stopped.said).not.toMatch(/Error:|\n\s+at /);
    expect(stopped.said).not.toContain('\u001b');
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
  // A tree whose form the reader does not know stops the build instead of passing every page.
  const unknown = join(temp, 'routeTree.gen.ts');
  fs.writeFileSync(unknown, 'export interface FileRoutesByTo {\n  "/courses": typeof X\n}\n');
  expect(() => screenAddresses(unknown)).toThrow('no address in FileRoutesByTo');
});
