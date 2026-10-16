import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { main } from './main';
import { buildOpenSite } from './open/build';
import { LEVEL_0, noViewerYet } from './open/shell';
import { buildUnderGuard, printing, STAND_IN } from './open/testing';
import { loadSite } from './site/load';

delete process.env.DATABASE_URL;
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-a45-open-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const reef = 'courses/reef-ecology/sampling';
const earlier = ['dist/index.html', Buffer.from('an earlier build')] as const;
let copies = 0;
/** A copy of the instructor fixture, with the `dist/` of an earlier build. */
function copy(): string {
  const root = join(temp, `site-${copies++}`);
  fs.cpSync(resolve(import.meta.dirname, '../fixtures/open-site/instructor'), root, {
    recursive: true,
  });
  fs.mkdirSync(join(root, 'dist'));
  fs.writeFileSync(join(root, earlier[0]), earlier[1]);
  return root;
}
/** The emitted files of one tree, `site` or `content`, in the work folder and in `dist/`. */
const tree = (files: Map<string, Buffer>, name: string) =>
  [...files].filter(([path]) =>
    path.replace(/^(\.parallax\/open|dist)\//, '').startsWith(`${name}/`),
  );

let good: ReturnType<typeof buildUnderGuard> & { root: string };
beforeAll(() => {
  const root = copy();
  good = { ...buildUnderGuard(root), root };
}, 300_000);

test('A45 a level 0 build without a distinct content origin stops', async () => {
  const root = copy();
  // A course whose read gives an error: that no line names it shows that no course was read.
  fs.writeFileSync(join(root, reef, 'topic.yaml'), 'resources: [');
  const [file, site] = [join(root, 'parallax.config.ts'), await loadSite(root)];
  const config = fs.readFileSync(file, 'utf8');
  // One host under another port, scheme and case, and with a trailing dot.
  for (const [app, content] of [
    ['https://reef.example.org', 'https://reef.example.org:8443'],
    ['https://localhost', 'http://localhost'],
    ['https://reef.example.org', 'https://REEF.Example.org'],
    ['https://reef.example.org', 'https://reef.example.org.'],
  ] as const) {
    fs.writeFileSync(
      file,
      config
        .replace(/app: '.*'/, `app: '${app}'`)
        .replace(/content: '.*'/, `content: '${content}'`),
    );
    const command = await printing(() => main(['build'], { cwd: root }));
    // Called past the loader, which refuses the configuration too, with the two origins.
    const origins = { ...site.config.origins, app, content };
    const call = () =>
      buildOpenSite({ ...site, config: { ...site.config, origins } }, { shell: noViewerYet });
    const direct = await printing(call);
    const lines = [...command.lines, ...direct.lines];
    const both = lines.filter((line) =>
      /origins\.(app|content)\b.*origins\.(app|content)\b/.test(line),
    );
    expect([command.result, direct.result, both.length], content).toEqual([1, 1, 2]);
    expect(lines.filter((line) => line.includes('topic.yaml'))).toEqual([]);
    // Nothing written: the stop came before the work folder, so not from noViewerYet, after it.
    expect([fs.existsSync(join(root, '.parallax')), fs.readdirSync(join(root, 'dist'))]).toEqual([
      false,
      ['index.html'],
    ]);
  }
  // With the origins as given and no course, the command passes the host rule and stops with
  // P5-07's level 0 message alone, as no viewer is compiled yet; dist/ is as it was.
  fs.writeFileSync(file, config);
  fs.rmSync(join(root, 'courses'), { recursive: true });
  fs.mkdirSync(join(root, 'courses'));
  const level0 = await printing(() => main(['build'], { cwd: root }));
  const placed = fs.readdirSync(join(root, 'dist'));
  expect([level0.result, level0.lines, placed]).toEqual([1, [LEVEL_0], ['index.html']]);
}, 120_000);

test('A45 untrusted objects are written only under content/, and a build stops when one would land under site/', () => {
  const { root, files, status } = good;
  const [content, site] = [tree(files, 'content'), tree(files, 'site')];
  // Both PDFs, the notebook files composed for download, the images, the SVG and the HTML outputs.
  const objects = new Set(content.map(([, bytes]) => sha(bytes)));
  const pdfs = ['slides/zones.pdf', 'reading/paper.pdf'].map((pdf) =>
    fs.readFileSync(join(root, reef, pdf)),
  );
  const types = [...new Set(content.map(([path]) => path.split('.').at(-1)))].sort();
  expect([status, types, pdfs.filter((pdf) => !objects.has(sha(pdf)))]).toEqual([
    0,
    ['html', 'ipynb', 'pdf', 'png', 'svg'],
    [],
  ]);
  // Under site/ none of them, and only the stand-in's two files, copies of its index.html (at /,
  // /courses, each course and each tab of its topics) and data files.
  const index = files.get('dist/site/index.html') ?? Buffer.of();
  const copied = site.filter(
    ([path, bytes]) => path.endsWith('/index.html') && bytes.equals(index),
  );
  const shell = new Set(copied.map(([path]) => path));
  const other = site.filter(([path]) => !shell.has(path) && !/(\/open\.js|\.json)$/.test(path));
  const twins = site.filter(([, bytes]) => objects.has(sha(bytes)));
  const catalogue = files.has('dist/site/courses/catalogue.json');
  const counts = [copied.length, other, twins, catalogue];
  expect(counts).toEqual([2 * (1 + 1 + 1 + 2 * 5 + 1 + 3 * 5), [], [], true]);

  // A stand-in with a copy of an emitted SVG, one with a copy of the course's PDF deck, and one
  // that puts a file into the staged site/ behind the writer: each stop names the file.
  const work = `join(root, '.parallax/open')`;
  const svg = `fs.readdirSync(join(${work}, 'content/o')).find((name) => name.endsWith('.svg'))`;
  for (const [named, plant] of [
    [
      'site/assets/figure.svg',
      `out.shell('assets/figure.svg', fs.readFileSync(join(${work}, 'content/o', ${svg})));`,
    ],
    [
      'site/assets/deck.pdf',
      `out.shell('assets/deck.pdf', fs.readFileSync(join(root, '${reef}/slides/zones.pdf')));`,
    ],
    ['site/figure.svg', `fs.writeFileSync(join(${work}, 'site/figure.svg'), '<svg/>');`],
  ]) {
    // One course is enough to reach the audit.
    const root = copy();
    fs.rmSync(join(root, 'courses/tide-pools'), { recursive: true });
    const run = buildUnderGuard(root, { shell: STAND_IN.replace(/\}$/, `${plant}\n}`) });
    const dist = [...run.files].filter(([path]) => path.startsWith('dist/'));
    expect([run.status, run.stderr.split(' ')[0], dist]).toEqual([1, named, [earlier]]);
  }
}, 300_000);

test('A45 no JavaScript output is in a level 0 build', () => {
  const { root, files } = good;
  const marker = 'only-in-a-javascript-output';
  // The fixture's notebook has a JavaScript output, which alone holds the marker, an HTML output
  // with a script and an SVG with a handler.
  const notebook = fs.readFileSync(join(root, reef, 'notebooks/counts.ipynb'), 'utf8');
  const sources = ['"application/javascript"', marker, "<script>alert('html')", 'onload='];
  const content = tree(files, 'content');
  // Every object is named by its digest, with an extension of the table, which has no script.
  const named = /\/o\/[0-9a-f]{64}\.(pdf|ipynb|png|jpg|gif|webp|svg|html)$/;
  const markup = content.filter(([path]) => /\.(html|svg)$/.test(path));
  const downloads = content.filter(([path]) => path.endsWith('.ipynb'));
  // The notebook files offered for download have code cells without outputs.
  const outputs = downloads.flatMap(([, bytes]) =>
    JSON.parse(String(bytes)).cells.flatMap((cell: { outputs?: unknown[] }) => cell.outputs ?? []),
  );
  expect({
    absent: sources.filter((text) => !notebook.includes(text)),
    unnamed: content.filter(([path]) => !named.test(path)).map(([path]) => path),
    marked: [...files].filter(([, bytes]) => bytes.includes(marker)).map(([path]) => path),
    active: markup
      .filter(([, bytes]) => /<script|\son[a-z]+\s*=/i.test(String(bytes)))
      .map(([path]) => path),
    counts: [markup.length, downloads.length, outputs.length],
  }).toEqual({ absent: [], unnamed: [], marked: [], active: [], counts: [4, 4, 0] });
});
