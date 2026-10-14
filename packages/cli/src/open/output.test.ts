import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { loadSource } from '../paths';
import { BuildStop, createOutput, placeOutput } from './output';

delete process.env.DATABASE_URL;
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-open-output-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
type Contracts = typeof import('@parallax/contracts');
const { openResource } = await loadSource<Contracts>('contracts', 'src/index.ts');

const [SITE, CONTENT] = ['https://site.example.org', 'https://content.example.org'];
const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const INDEX = '<!doctype html><script type="module" src="/assets/app.js"></script>';
const [PDF, PNG, IPYNB] = ['%PDF-1.7 the deck', 'the bytes of a figure', '{"nbformat":4}'];
const IPYNB_TYPE = 'application/x-ipynb+json';
/** The three objects of `build`, as the writer names them under `content/`. */
const at = { pdf: `o/${sha(PDF)}.pdf`, png: `o/${sha(PNG)}.png`, ipynb: `o/${sha(IPYNB)}.ipynb` };
const GOOD = `${CONTENT}/${at.png}`;
// Folders as a listing spells them (`FOLDER`): a last dot or space, and a colon but on Windows.
const T1 = `site/courses/Ana Lima./Reef${sep === '/' ? ':' : ''} ecology /t1`;
const [DECK, LAB, APP] = [`${T1}/deck.json`, `${T1}/lab.json`, `${T1}/app.json`];
const NOT_AUDITED = 'has not passed its audit';

function put(root: string, path: string, text: string): string[] {
  fs.mkdirSync(join(root, path, '..'), { recursive: true });
  fs.writeFileSync(join(root, path), text);
  return [path];
}
/** Every file below a folder: its path with forward slashes, and its text. */
const files = (root: string): Record<string, string> =>
  Object.fromEntries(
    fs
      .readdirSync(root, { recursive: true, encoding: 'utf8' })
      .filter((path) => fs.statSync(join(root, path)).isFile())
      .map((path) => [path.split(sep).join('/'), fs.readFileSync(join(root, path), 'utf8')]),
  );
const paths = (root: string) => Object.keys(files(root)).sort();
/** The message of the stop a call ends with. */
function stopOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof BuildStop) return error.message;
    throw error;
  }
  return 'it did not stop';
}

let sites = 0;
/** A site folder whose dist/ holds a level 1 build, and the writer of its level 0 build. */
async function site() {
  const root = join(temp, `site-${sites++}`);
  const [work, dist] = [join(root, '.parallax/open'), join(root, 'dist')];
  put(dist, 'index.html', 'the level 1 build');
  return { work, dist, out: await createOutput({ workDir: work, contentOrigin: CONTENT }) };
}
type Site = Awaited<ReturnType<typeof site>>;

const none = { executionCount: null };
const hidden = { ...none, sourceHidden: false, outputsHidden: false };
const slides = { type: 'slides', title: 'Deck', web: null };
const deck = (url: string) => ({ ...slides, pdf: { url, pageCount: 3 } });
const web = (html: string) => ({ ...deck(GOOD), web: { slides: [html] } });
const native = { type: 'reading', title: 'Tides', kind: 'native', pdf: null };
const reading = (html: string) => ({ ...native, html });
const image = (url: string) => ({ ...none, type: 'image', url, alt: 'Histogram' });
const markdown = (html: string) => ({ ...none, type: 'markdown', html });
/** A notebook with a Markdown cell and a code cell, whose source only looks like an image. */
const lab = (file: string, html: string, outputs: object[] = []) => {
  const intro = { id: 'intro', type: 'markdown', html };
  const draw = { id: 'draw', type: 'code', source: 'img(src = "plot.png")', ...hidden, outputs };
  const notebook = { kernel: null, language: 'r', cells: [intro, draw], outline: [] };
  return { type: 'notebook', title: 'Counts', file, notebook };
};
const H1 = '<h1>Counts</h1>';
/** Prose that only looks like an image, a formula as conversion writes it, and an odd image. */
const FIGURE = `<p data-block-id="b1"><code>&#x3C;img src="cat.png"></code> <span class="katex"><math display="block"><mi>x</mi></math></span></p><img alt="A > B" title="src=x" src="${GOOD}">`;

/** A small whole output. A run that is not `whole` writes one shell file, data file and object fewer. */
function build({ out }: Site, whole = true): void {
  const index = bytes(INDEX);
  out.shell('index.html', index);
  index.fill(0); // A caller may reuse its buffer: no copy of the shell's index.html changes with it.
  if (whole) out.shell('assets/app.js', bytes('mount();'));
  out.address('courses');
  if (whole) out.data(DECK.slice(5), openResource, deck(out.object(bytes(PDF), 'application/pdf')));
  const [file, png] = [out.object(bytes(IPYNB), IPYNB_TYPE), out.object(bytes(PNG), 'image/png')];
  out.data(LAB.slice(5), openResource, lab(file, FIGURE, [image(png)]));
  // A Shiny app's `url` is the app's own address and no object: the audit lets it be.
  const app = { type: 'shiny', title: 'Tide', url: 'https://shiny.example.org/', origin: null };
  out.data(APP.slice(5), openResource, app);
}
const ONLY_WHOLE = [`content/${at.pdf}`, 'site/assets/app.js', DECK];
const shared = ['site/index.html', 'site/courses/index.html', LAB, APP];
const LESS = [`content/${at.ipynb}`, `content/${at.png}`, ...shared].sort();
const WHOLE = [...LESS, ...ONLY_WHOLE].sort();

test('an object is written only under content/o, named by its digest, with an address on the content origin', async () => {
  const { work, out } = await site();
  expect(out.object(bytes(PNG), 'image/png')).toBe(GOOD);
  expect(out.object(bytes(PNG), 'image/png')).toBe(GOOD);
  const refused = ['application/javascript', 'text/javascript', 'text/html', 'application/zip'];
  for (const type of refused)
    expect(stopOf(() => out.object(bytes('alert(1)'), type))).toContain(type);
  expect(files(work)).toEqual({ [`content/${at.png}`]: PNG });
});

test('a data file is the parse result of its schema, at a .json path under site/', async () => {
  const { work, out } = await site();
  const good = lab(out.object(bytes(IPYNB), IPYNB_TYPE), H1);
  const cells = good.notebook.cells.map((cell) => ({ ...cell, solution: 'planted' }));
  const planted = { ...good, notebook: { ...good.notebook, cells, sourceKey: 'planted' } };
  out.data(LAB.slice(5), openResource, planted);
  // A key that the notebook's schema does not name is not in the file; one at a strict level stops.
  expect(files(work)[LAB]).toBe(JSON.stringify(openResource.parse(good)));
  expect(files(work)[LAB]).not.toContain('planted');
  const strict = { ...good, email: 'ana.lima@example.org' };
  const refused = stopOf(() => out.data('courses/x.json', openResource, strict));
  expect(refused).toMatch(/courses\/x\.json.*email/s);
  const outside = [join(work, 'site/a.json'), '/a.json', '../a.json', 'b/../../content/a.json'];
  // On every system a name with `\` or a control character, which no listing gives (`FOLDER`).
  const odd = ['a\\b.json', 'a\u0007.json'];
  for (const path of [...outside, ...odd, './a.json', 'a//a.json', 'courses/a.txt', 'courses/a'])
    expect(stopOf(() => out.data(path, openResource, good))).toContain(path);
  expect(stopOf(() => out.shell('../content/o/a.js', bytes('a()')))).toContain('../content/o/a.js');
  expect(paths(work)).toEqual([`content/${at.ipynb}`, LAB]);
});

test('two outputs at one path stop and name both, also across case and where a folder would stand on a file', async () => {
  const { out } = await site();
  expect(stopOf(() => out.address('courses'))).toContain('courses has no index.html to copy');
  out.shell('index.html', bytes(INDEX));
  const data = (path: string) => () => out.data(path, openResource, reading('<p>Tides</p>'));
  const both = (path: string) => `site/courses/catalogue.json and site/${path}`;
  data('courses/catalogue.json')();
  for (const path of ['courses/catalogue.json', 'Courses/Catalogue.json'])
    expect(stopOf(data(path))).toContain(both(path));
  // A course folder called catalogue.json: its files would lie below the catalogue's file.
  const below = 'courses/CATALOGUE.json/course.json';
  expect(stopOf(data(below))).toContain(both(below));
  const address = stopOf(() => out.address('courses/catalogue.json'));
  expect(address).toContain(both('courses/catalogue.json/index.html'));
  data('courses/reef/course.json')();
  const folder = stopOf(() => out.shell('courses/Reef', bytes('a file')));
  expect(folder).toContain('site/courses/reef/course.json and site/courses/Reef');
  // One folder spelled in two ways: two folders where case counts, one where it does not.
  expect(stopOf(data('courses/Reef/topic.json'))).toContain('site/courses/reef/course.json and');
  expect(stopOf(() => out.shell('Courses/app.js', bytes('a()')))).toContain(both('Courses/app.js'));
  // U+0130 is two code units in lower case: still one folder, which another spelling cannot share.
  for (const name of ['course', 'topic']) data(`courses/\u0130\u0130/${name}.json`)();
  expect(stopOf(data('courses/i\u0307i\u0307/x.json'))).toContain('\u0130/course.json and site');
  expect(stopOf(() => out.address('index.html/..'))).toContain('index.html/..');
});

/** Changes the output behind the writer or writes through it, and gives what the stop must name. */
type Change = (site: Site) => string[];
function behind(path: string, text: string): Change {
  return ({ work }) => put(work, path, text);
}
const elsewhere = {
  'on the site origin': `${SITE}/${at.png}`,
  'on another host': `https://elsewhere.example.org/${at.png}`,
  'at a path the build did not write': `${CONTENT}/o/${'0'.repeat(64)}.png`,
  'on the content host with a password': `https://ana:secret@content.example.org/${at.png}`,
  'on another port of the content host': `${CONTENT}:8443/${at.png}`,
  'on the content host over http': `http://content.example.org/${at.png}`,
};
const scripts = {
  'that is a javascript: address': 'javascript:alert(1)',
  'that is a data: address': 'data:text/html,x',
};
/** A resource that holds an address in one of the places where a data file names an object. */
const places: Record<string, (address: string) => object> = {
  'pdf.url': deck,
  file: (address) => lab(address, H1),
  'an output url': (address) => lab(GOOD, H1, [image(GOOD), image(address)]),
  'an image src': (address) => reading(`<p><img alt="Reef" src="${address}"></p>`),
  'an unquoted SRC in a notebook cell': (address) => lab(GOOD, `<IMG ALT="Reef"SRC=${address}>`),
  'an image src in a slide of a web deck': (address) => web(`<img src='${address}'>`),
  'an image src in a Markdown output': (address) =>
    lab(GOOD, H1, [markdown(`<img src="${address}">`)]),
  // As a browser reads these two, `a` is `b"c="` (or `b'c='`) and the tag has the `src`.
  'a src after a value that holds "': (address) => reading(`<img a=b"c=" src=${address} x=" ">`),
  "a src after a value that holds '": (address) => reading(`<img a=b'c=' src=${address} x=' '>`),
  'a src after a stray < and a stray quote': (address) => reading(`a < b <img " src=${address}>`),
  // A sanitiser in a browser parses without scripting, so it reads what `noscript` holds.
  'a src inside noscript': (address) => reading(`<noscript><img src="${address}"></noscript>`),
  'a src inside a template': (address) => reading(`<template><img src="${address}"></template>`),
  // A page's body ignores a stray `col`; as a template's content the image after it would go.
  'a src after a stray col': (address) => reading(`<col><img src="${address}">`),
};
const NAMED = `${T1}/named.json`;
const named = Object.entries(places).flatMap(([place, resource]) =>
  Object.entries({ ...elsewhere, ...(place === 'an output url' ? scripts : {}) }).map(
    ([where, address]): [string, Change] => [
      `a data file with ${place} ${where}`,
      ({ out }) => {
        out.data(NAMED.slice(5), openResource, resource(address));
        const fault = where.startsWith('at a path') ? 'did not write' : 'not on the content origin';
        return [NAMED, address, fault];
      },
    ],
  ),
);
// HTML a browser may build otherwise than the audit reads it, or that loads by more than `src`.
const unread = [
  '<svg><template><foreignObject><img src="@"></foreignObject></template></svg>',
  '<math><template><mi><img src="@"></mi></template></math>',
  '<svg><g><template><foreignObject><img src="@"></foreignObject></template></g></svg>',
  '<select><img src="@"></select>',
  '<noscript><p title="</noscript><img src=@>"></noscript>',
  // parse5 reads two comments; a parser that reads CDATA inside `mi` builds the image.
  '<math><mi><![CDATA[x><!--]]><img src="@">--></mi></math>',
  '<img alt="Reef" srcset="@ 2x">',
];
const odd = unread.map((html): [string, Change] => [
  `a reading whose HTML is ${html}`,
  ({ out }) => {
    out.data(NAMED.slice(5), openResource, reading(html.replace('@', 'https://evil.example.org')));
    return [NAMED, 'outside the reading allow-list'];
  },
]);
const COURSE_FILE = 'courses/reef/topic-1/notebooks/counts.ipynb';
/** The text of the deck's data file, as `build` writes it. */
const written = JSON.stringify(openResource.parse(deck(`${CONTENT}/${at.pdf}`)));
const stops: Record<string, Change> = {
  'a shell file with the bytes of a written object': ({ out }) => {
    out.shell('assets/logo.png', bytes(PNG));
    return ['site/assets/logo.png', `content/${at.png}`, "change the site's file"];
  },
  'a shell file with the bytes of a course file given to untrusted': ({ out }) => {
    out.untrusted(sha('the notebook itself'), COURSE_FILE);
    out.shell('assets/counts.ipynb', bytes('the notebook itself'));
    return ['site/assets/counts.ipynb', COURSE_FILE, "change the site's file"];
  },
  'figure.svg put into site/ behind the writer': behind('site/courses/figure.svg', '<svg/>'),
  'page.html put into site/ behind the writer': behind('site/courses/reef/page.html', '<p>x</p>'),
  'deck.pdf put into site/ behind the writer': behind('site/deck.pdf', PDF),
  'an unrecorded data file that passes its schema': behind(DECK.replace('deck', 'old'), written),
  'an unrecorded object named by its digest': behind(`content/o/${sha('older')}.png`, 'older'),
  "an unrecorded copy of the shell's index.html": behind('site/about/index.html', INDEX),
  'a file of the work folder outside the two trees': behind('notes.txt', 'left here'),
  'a recorded file that is missing': ({ work }) => {
    fs.rmSync(join(work, 'site/assets/app.js'));
    return ['site/assets/app.js'];
  },
  "an index.html copy that differs from the shell's": behind('site/courses/index.html', 'other'),
  'a data file changed after it was written': behind(DECK, written.replace('}', ',"x":1}')),
  'a changed data file that passes its schema': behind(DECK, written.replace('Deck', 'Decks')),
  'a data file that is not the serialised result of parsing it': ({ out }) => {
    let parses = 0;
    out.data('courses/count.json', { parse: () => ({ parses: ++parses }) }, null);
    return ['site/courses/count.json'];
  },
  ...Object.fromEntries(named),
  ...Object.fromEntries(odd),
  'a file under content/ whose name is not its digest': behind(`content/${at.pdf}`, 'other'),
  'a file under content/ named by another digest': behind(`content/o/${'a'.repeat(64)}.png`, PNG),
  'a .js file under content/, a type outside the table': behind(`content/o/${sha('x')}.js`, 'x'),
};

test.each(Object.entries(stops))(
  'the audit stops for %s, names the file and places nothing',
  async (_name, change) => {
    const made = await site();
    build(made);
    // The output first passes an audit, so that only the audit after the change can stop it.
    made.out.finish();
    const names = change(made);
    const message = stopOf(() => made.out.finish());
    for (const name of names) expect(message).toContain(name);
    expect(stopOf(() => placeOutput(made.work, made.dist))).toContain(NOT_AUDITED);
    expect(files(made.dist)).toEqual({ 'index.html': 'the level 1 build' });
  },
);

test('after a good audit dist/ holds exactly site/ and content/, and a level 1 index.html is gone', async () => {
  const made = await site();
  build(made);
  expect(stopOf(() => placeOutput(made.work, made.dist))).toContain(NOT_AUDITED);
  made.out.finish();
  expect(stopOf(() => placeOutput(made.work, join(temp, 'elsewhere')))).toContain('elsewhere');
  placeOutput(made.work, made.dist);
  expect(fs.readdirSync(made.dist).sort()).toEqual(['content', 'site']);
  expect(paths(made.dist)).toEqual(WHOLE);
  const placed = files(made.dist);
  expect(placed).toEqual(files(made.work));
  expect([placed['site/courses/index.html'], placed[`content/${at.pdf}`]]).toEqual([INDEX, PDF]);
  // An audit is spent by what follows it: a write, and a course file that is named late.
  made.out.shell('assets/late.js', bytes('late();'));
  expect(stopOf(() => placeOutput(made.work, made.dist))).toContain(NOT_AUDITED);
  made.out.finish();
  made.out.untrusted(sha('late();'), COURSE_FILE);
  expect(stopOf(() => made.out.untrusted('A'.repeat(64), COURSE_FILE))).toContain(COURSE_FILE);
  expect(stopOf(() => placeOutput(made.work, made.dist))).toContain(NOT_AUDITED);
  const twin = stopOf(() => made.out.finish());
  expect(twin).toContain(`site/assets/late.js has the bytes of ${COURSE_FILE}`);
});

test('a second run over a used work folder and a used dist/ leaves nothing of what only the first wrote', async () => {
  const first = await site();
  build(first);
  first.out.finish();
  placeOutput(first.work, first.dist);
  // Both still hold the first output, a half-written file in each tree and a folder on no recorded path.
  for (const root of [first.work, first.dist]) {
    expect(paths(root)).toEqual(WHOLE);
    put(root, 'site/courses/reef/t1/half.json', '{"type":"sli');
    put(root, 'content/o/half.pdf', '%PDF-');
    fs.mkdirSync(join(root, 'site/courses/gone/t9'), { recursive: true });
  }
  const out = await createOutput({ workDir: first.work, contentOrigin: CONTENT });
  expect(fs.readdirSync(first.work)).toEqual([]);
  build({ ...first, out }, false);
  out.finish();
  placeOutput(first.work, first.dist);
  for (const root of [first.work, first.dist]) {
    for (const path of ONLY_WHOLE) expect(paths(root)).not.toContain(path);
    expect(paths(root)).toEqual(LESS);
    expect(fs.existsSync(join(root, 'site/courses/gone'))).toBe(false);
  }
});

test('only a .parallax/open folder is emptied, and a file changed after its audit is not placed', async () => {
  put(temp, 'kept/notes.txt', 'not a work folder');
  const refused = createOutput({ workDir: join(temp, 'kept'), contentOrigin: CONTENT });
  await expect(refused).rejects.toThrow(BuildStop);
  expect(files(join(temp, 'kept'))).toEqual({ 'notes.txt': 'not a work folder' });
  const made = await site();
  const origins = ['content.example.org', `${CONTENT}/o/`, 'https://a:b@content.example.org'];
  for (const contentOrigin of origins)
    await expect(createOutput({ workDir: made.work, contentOrigin })).rejects.toThrow(BuildStop);
  // Without the shell's index.html there is no site: an empty output must not empty dist/.
  expect(stopOf(() => made.out.finish())).toContain('site/index.html is missing');
  expect(stopOf(() => placeOutput(made.work, made.dist))).toContain(NOT_AUDITED);
  build(made);
  made.out.finish();
  put(made.work, 'site/assets/app.js', 'changed after the audit');
  const changed = stopOf(() => placeOutput(made.work, made.dist));
  expect(changed).toContain('site/assets/app.js was changed');
  // The placing stopped part-way: dist/ holds no file of the earlier build, and not the changed one.
  expect(paths(made.dist).filter((path) => !WHOLE.includes(path))).toEqual([]);
  expect(paths(made.dist)).not.toContain('site/assets/app.js');
});
