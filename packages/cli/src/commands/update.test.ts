import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { main } from '../main';
import { loadSource } from '../paths';
import { type Prints, published, type Scaffold, writing } from '../site/template';
import { after, HANDOFF, updating } from './update';

type Create = Scaffold & {
  create(argv: string[], options: { version: string; print: (line: string) => void }): number;
};
const scaffold = await loadSource<Create>('scaffold', 'src/create.mjs');
const temp = mkdtempSync(join(tmpdir(), 'parallax-update-'));
const real = { updating: { ...updating }, versions: published.versions, writing: { ...writing } };
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.assign(updating, real.updating);
  Object.assign(writing, real.writing);
  published.versions = real.versions;
});
afterAll(() => rmSync(temp, { recursive: true, force: true }));

const print = (text: string) => scaffold.fingerprint(Buffer.from(text));
const read = (root: string, file: string) => readFileSync(join(root, file), 'utf8');
const write = (root: string, file: string, text: string) => {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), text);
};
const record = (root: string): Prints => JSON.parse(read(root, scaffold.RECORD)).files;
const setRecord = (root: string, files: Prints) => scaffold.writeRecord(root, files);
/** Each file of the site outside `node_modules/` and `.parallax/`, with its content. */
const files = (root: string) =>
  Object.fromEntries(
    readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => relative(root, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
      .filter((file) => !/^(node_modules|\.parallax)\//.test(file))
      .map((file) => [file, read(root, file)]),
  );
/**
 * Writes the manifest of an installed `parallax-site` at `version` into the site, and with
 * `command` the file of its update command, which versions up to 0.1.1 do not have.
 */
function install(root: string, version: string, command = true) {
  write(root, 'node_modules/parallax-site/package.json', JSON.stringify({ version }));
  const file = 'node_modules/parallax-site/src/commands/update.ts';
  if (command) write(root, file, '');
  else rmSync(join(root, file), { force: true });
}

let made = 0;
/** A new site of `mode` from this repository's scaffolder, naming and with installed `version`. */
function site(mode: 'instructor' | 'school' = 'instructor', version = '0.0.0') {
  const root = join(temp, `site-${++made}`);
  expect(scaffold.create([root, '--template', mode], { version, print: () => {} })).toBe(0);
  install(root, version);
  return root;
}

/**
 * `parallax update <args>` in `root`, with npm and the installed tool replaced: npm's latest is
 * `latest`, `npm install` ends with `npm` and on success installs what package.json names, and
 * the installed tool ends with 0. Resolves to the exit code, the lines printed and the calls.
 */
async function update(
  root: string,
  args: string[] = [],
  { latest = '0.0.0', npm = 0, command = true } = {},
) {
  const calls: string[] = [];
  updating.view = async (spec) => {
    calls.push(`view ${spec}`);
    return latest ? { version: latest } : { why: 'npm error code E404' };
  };
  updating.npm = async (args, cwd) => {
    calls.push(`npm ${args.join(' ')}`);
    if (npm === 0)
      install(cwd, JSON.parse(read(cwd, 'package.json')).dependencies['parallax-site'], command);
    return npm;
  };
  updating.installed = async (_, args) => {
    calls.push(`installed ${args.join(' ')}`);
    return 0;
  };
  const lines: string[] = [];
  const keep = (line: string) => void lines.push(line);
  vi.spyOn(console, 'log').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
  const code = await main(['update', ...args], { cwd: root, print: keep });
  vi.restoreAllMocks();
  return { code, lines: lines.map((line) => line.replace(/^parallax update: /, '')), calls };
}

const WELCOME = 'courses/welcome/start-here';
const TOUR = `private/${WELCOME}/exercises/interactive-tour.yaml`;
/** The starter topic's `topic.yaml` as 0.1.1 had it, before the interactive tour. */
const olderTopic = (text: string) =>
  text.replace(/ {2}- id: [\w-]+\n {4}file: exercises\/interactive-tour\.yaml\n.*\n/, '');

test('A37 an update to a version whose template is the same changes package.json and no other tracked file', async () => {
  const root = site('instructor', '0.0.0-a37.1');
  // The scaffolder records the fingerprint of each file it wrote but package.json.
  const before = files(root);
  const { [scaffold.RECORD]: _, 'package.json': __, ...written } = before;
  expect(Object.keys(record(root))).toEqual(Object.keys(written).sort());
  const done = await update(root);
  expect(done.code, done.lines.join('\n')).toBe(0);
  expect(done.calls).toEqual(['view latest', 'npm install --no-audit --no-fund']);
  expect(done.lines).toEqual([
    'package.json names parallax-site 0.0.0 (was 0.0.0-a37.1).',
    'npm install',
    'parallax-site 0.0.0: 0 files changed. Its template is in .parallax/template.',
    'Next: npx parallax check, then npx parallax upgrade where the site is served.',
  ]);
  const now = files(root);
  expect(Object.keys(now).filter((file) => now[file] !== before[file])).toEqual(['package.json']);
  expect(JSON.parse(now['package.json'] ?? '')).toEqual({
    private: true,
    type: 'module',
    dependencies: { 'parallax-site': '0.0.0' },
  });
  // A second run asks npm again and changes nothing.
  expect((await update(root)).calls).toEqual(['view latest']);
  expect(files(root)).toEqual(now);
});

test('update replaces the template files the author did not change, adds new ones and keeps the rest', async () => {
  const root = site();
  const fresh = record(root);
  const recorded: Prints = { ...fresh };
  /** The site's file as an earlier template wrote it, which the record names. */
  const earlier = (file: string, text: string) => {
    write(root, file, text);
    recorded[file] = print(text.replaceAll('\r\n', '\n'));
  };
  // A pristine .gitignore, checked out with Windows line ends.
  earlier('.gitignore', 'node_modules/\r\nprivate/\r\n');
  // The starter course as 0.1.1 had it, with a file the template has since dropped, and a
  // dot file that the course reader and the update skip.
  earlier(`${WELCOME}/topic.yaml`, olderTopic(read(root, `${WELCOME}/topic.yaml`)));
  rmSync(join(root, TOUR));
  delete recorded[TOUR];
  earlier(`${WELCOME}/notes/dropped.md`, '# Dropped\n');
  earlier(`${WELCOME}/notes/also-dropped.md`, '# Also dropped\n');
  write(root, 'courses/welcome/.DS_Store', '');
  // A file new in the template.
  rmSync(join(root, 'Caddyfile'));
  delete recorded.Caddyfile;
  // Changes of the author's, where the template changed the file too and where it did not.
  write(root, 'compose.yml', `${read(root, 'compose.yml')}# mine\n`);
  recorded['compose.yml'] = print('services: {}\n');
  write(root, 'src/pages/index.tsx', `${read(root, 'src/pages/index.tsx')}// mine\n`);
  earlier('src/pages/_visualization.tsx', 'export default () => null;\n');
  write(root, 'parallax.config.ts', `${read(root, 'parallax.config.ts')}// mine\n`);
  recorded['parallax.config.ts'] = print('export default {};\n');
  write(root, 'instructor.yaml', 'name: Ada\nemail: ada@example.org\n');
  // Files the author removed, one of which the template changed.
  rmSync(join(root, 'compose.runner.yml'));
  recorded['compose.runner.yml'] = print('services: {}\n');
  rmSync(join(root, 'compose.level2.yml'));
  // A file of an earlier template that this one does not have.
  earlier('notes.txt', 'An earlier sample\n');
  setRecord(root, recorded);
  const visualization = read(root, 'src/pages/_visualization.tsx');

  const done = await update(root, ['--to', '0.0.0']);
  expect(done.code, done.lines.join('\n')).toBe(0);
  expect(done.calls).toEqual([]);
  expect(done.lines).toEqual([
    'updated .gitignore',
    'added Caddyfile',
    `updated ${WELCOME}/topic.yaml`,
    `added ${TOUR}`,
    `removed ${WELCOME}/notes/also-dropped.md`,
    `removed ${WELCOME}/notes/dropped.md`,
    'updated .parallax-template.json',
    'compose.runner.yml is not in the site and is not added; the template changed it: .parallax/template/compose.runner.yml',
    'compose.yml has changes of yours and is kept; the template changed it: .parallax/template/compose.yml',
    "parallax.config.ts is yours and is kept; the template's sample changed: .parallax/template/parallax.config.ts",
    'src/pages has changes of yours and is kept; the template changed _visualization.tsx: .parallax/template/src/pages',
    'parallax-site 0.0.0: 7 files changed, 4 kept as you have them. Its template is in .parallax/template.',
    'Next: npx parallax check, then npx parallax upgrade where the site is served.',
  ]);
  const template = join(root, '.parallax/template');
  for (const file of ['.gitignore', 'Caddyfile', `${WELCOME}/topic.yaml`, TOUR]) {
    expect(read(root, file), file).toBe(read(template, file));
  }
  // The folder both removed files were in goes, and the course folder stays.
  expect(existsSync(join(root, `${WELCOME}/notes`))).toBe(false);
  expect(existsSync(join(root, WELCOME))).toBe(true);
  expect(existsSync(join(root, 'courses/welcome/.DS_Store'))).toBe(true);
  expect(read(root, 'compose.yml')).toMatch(/# mine\n$/);
  expect(read(root, 'src/pages/_visualization.tsx')).toBe(visualization);
  expect(read(root, 'instructor.yaml')).toBe('name: Ada\nemail: ada@example.org\n');
  expect(read(root, 'notes.txt')).toBe('An earlier sample\n');
  for (const file of ['compose.runner.yml', 'compose.level2.yml']) {
    expect(existsSync(join(root, file)), file).toBe(false);
  }
  // The record now holds the template of this version, so a second run changes nothing and has
  // nothing to say about the files the author keeps.
  expect(record(root)).toEqual(fresh);
  const after = files(root);
  const again = await update(root, ['--to', '0.0.0']);
  expect(again.lines[0]).toBe(
    'parallax-site 0.0.0: 0 files changed. Its template is in .parallax/template.',
  );
  expect(files(root)).toEqual(after);
  // The site checks with the new starter course.
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await main(['check'], { cwd: root, print: () => {} })).toBe(0);
});

test('a site with no record is compared with the templates of the published versions', async () => {
  const root = site();
  const fresh = record(root);
  rmSync(join(root, scaffold.RECORD));
  const older = {
    gitignore: 'node_modules/\nprivate/\n',
    topic: olderTopic(read(root, `${WELCOME}/topic.yaml`)),
  };
  const { [TOUR]: _, ...without } = fresh;
  published.versions = {
    '0.0.9': {
      instructor: {
        ...without,
        '.gitignore': print(older.gitignore),
        [`${WELCOME}/topic.yaml`]: print(older.topic),
      },
      school: {},
    },
  };
  write(root, '.gitignore', older.gitignore);
  write(root, `${WELCOME}/topic.yaml`, older.topic);
  rmSync(join(root, TOUR));
  write(root, 'compose.yml', 'services: {}\n');
  const done = await update(root, ['--to', '0.0.0']);
  expect(done.code, done.lines.join('\n')).toBe(0);
  expect(done.lines).toEqual([
    '.parallax-template.json is not there, so the files are compared with the templates of 0.0.9.',
    'updated .gitignore',
    `updated ${WELCOME}/topic.yaml`,
    `added ${TOUR}`,
    'added .parallax-template.json',
    'compose.yml has changes of yours and is kept; compare with .parallax/template/compose.yml',
    'parallax-site 0.0.0: 4 files changed, 1 kept as you have them. Its template is in .parallax/template.',
    'Next: npx parallax check, then npx parallax upgrade where the site is served.',
  ]);
  expect(record(root)).toEqual(fresh);
  // A record that cannot be read counts as none.
  writeFileSync(join(root, scaffold.RECORD), '{"files": 1}');
  expect((await update(root, ['--to', '0.0.0'])).lines[0]).toBe(
    '.parallax-template.json cannot be read, so the files are compared with the templates of 0.0.9.',
  );
});

test('the published versions are recorded as the scaffolder fingerprints a site', () => {
  const versions = Object.entries(real.versions);
  expect(versions.map(([version]) => version)).toEqual(['0.1.0-rc.1', '0.1.0', '0.1.1']);
  for (const [version, modes] of versions) {
    for (const [mode, prints] of Object.entries(modes)) {
      // The two files whose content A37 fixes, and no package.json or record.
      expect(prints['.npmrc'], `${version} ${mode}`).toBe(print('package-lock=false\n'));
      expect(prints['.gitattributes'], `${version} ${mode}`).toBe(print('* text=auto eol=lf\n'));
      expect(Object.keys(prints)).not.toContain('package.json');
      expect(Object.keys(prints)).toEqual(Object.keys(prints).sort());
    }
  }
  // A checkout with Windows line ends has the fingerprint of the template's file.
  expect(print('a\r\nb\n')).toBe(print('a\nb\n'));
});

test('in school mode the starter course of instructors/ana is the one compared', async () => {
  const root = site('school');
  const recorded = record(root);
  const topic = `instructors/ana/${WELCOME}/topic.yaml`;
  const older = olderTopic(read(root, topic));
  write(root, topic, older);
  recorded[topic] = print(older);
  rmSync(join(root, `private/instructors/ana/${TOUR.slice('private/'.length)}`));
  delete recorded[`private/instructors/ana/${TOUR.slice('private/'.length)}`];
  // The author removed Ben's folder, with his instructor.yaml and course; neither comes back.
  rmSync(join(root, 'instructors/ben'), { recursive: true });
  const config = read(root, 'parallax.config.ts')
    .replace("['ana', 'ben']", "['ana']")
    .replace("    { course: 'ben/field-statistics', name: 'Spring 2027' },\n", '');
  write(root, 'parallax.config.ts', config);
  setRecord(root, recorded);
  const done = await update(root, ['--to', '0.0.0']);
  expect(done.lines.slice(0, 2)).toEqual([
    `updated ${topic}`,
    `added private/instructors/ana/${TOUR.slice('private/'.length)}`,
  ]);
  expect(existsSync(join(root, 'instructors/ben'))).toBe(false);
});

test('a course folder that is a link is kept, and nothing is written through it', async () => {
  const root = site();
  const recorded = record(root);
  const elsewhere = join(temp, `linked-${made}`);
  cpSync(join(root, 'courses/welcome'), elsewhere, { recursive: true });
  rmSync(join(root, 'courses/welcome'), { recursive: true });
  symlinkSync(elsewhere, join(root, 'courses/welcome'), 'junction');
  const older = olderTopic(read(elsewhere, 'start-here/topic.yaml'));
  writeFileSync(join(elsewhere, 'start-here/topic.yaml'), older);
  recorded[`${WELCOME}/topic.yaml`] = print(older);
  setRecord(root, recorded);
  const done = await update(root, ['--to', '0.0.0']);
  expect(done.lines.slice(0, 2)).toEqual([
    'updated .parallax-template.json',
    'courses/welcome has changes of yours and is kept; the template changed 1 of its files: .parallax/template/courses/welcome and .parallax/template/private/courses/welcome',
  ]);
  expect(read(elsewhere, 'start-here/topic.yaml')).toBe(older);
});

/** Moves `path` of the site outside it and links it back; resolves to where it now is. */
function linkOut(root: string, path: string) {
  const outside = join(temp, `outside-${++made}`);
  cpSync(join(root, path), outside, { recursive: true });
  rmSync(join(root, path), { recursive: true });
  symlinkSync(outside, join(root, path), 'junction');
  return outside;
}

test('a part reached through a linked folder, or holding a linked file, is kept and nothing is written through the link', async () => {
  const kept =
    'courses/welcome has changes of yours and is kept; the template changed 2 of its files: .parallax/template/courses/welcome and .parallax/template/private/courses/welcome';
  for (const linked of ['private', 'courses', `${WELCOME}/reading/guide.md`]) {
    const root = site();
    const recorded = record(root);
    // The starter course as 0.1.1 had it, which the update replaces where nothing is linked.
    const older = olderTopic(read(root, `${WELCOME}/topic.yaml`));
    write(root, `${WELCOME}/topic.yaml`, older);
    recorded[`${WELCOME}/topic.yaml`] = print(older);
    rmSync(join(root, TOUR));
    delete recorded[TOUR];
    setRecord(root, recorded);
    const outside = linkOut(root, linked);
    const before = linked.endsWith('.md') ? read(outside, '') : files(outside);
    const done = await update(root, ['--to', '0.0.0']);
    expect(done.code, linked).toBe(0);
    expect(done.lines, linked).toContain(kept);
    expect(linked.endsWith('.md') ? read(outside, '') : files(outside), linked).toEqual(before);
    expect(read(root, `${WELCOME}/topic.yaml`), linked).toBe(older);
    expect(existsSync(join(root, TOUR)), linked).toBe(false);
  }
  // The front page, with src/ linked.
  const root = site();
  const older = 'export default () => null;\n';
  write(root, 'src/pages/index.tsx', older);
  setRecord(root, { ...record(root), 'src/pages/index.tsx': print(older) });
  const outside = linkOut(root, 'src');
  const done = await update(root, ['--to', '0.0.0']);
  expect(done.lines).toContain(
    'src/pages has changes of yours and is kept; the template changed index.tsx: .parallax/template/src/pages',
  );
  expect(read(outside, 'pages/index.tsx')).toBe(older);
});

test('a write that fails part way puts every file back, and the next run finishes', async () => {
  const root = site();
  const recorded = record(root);
  const exercises = `private/${WELCOME}/exercises`;
  // An earlier starter course: an older topic, no exercise folder, and a note since dropped.
  const older = olderTopic(read(root, `${WELCOME}/topic.yaml`));
  write(root, `${WELCOME}/topic.yaml`, older);
  recorded[`${WELCOME}/topic.yaml`] = print(older);
  rmSync(join(root, exercises), { recursive: true });
  for (const file of Object.keys(recorded)) if (file.startsWith(exercises)) delete recorded[file];
  write(root, `${WELCOME}/notes/dropped.md`, '# Dropped\n');
  recorded[`${WELCOME}/notes/dropped.md`] = print('# Dropped\n');
  write(root, '.gitignore', 'node_modules/\n');
  recorded['.gitignore'] = print('node_modules/\n');
  setRecord(root, recorded);
  const before = files(root);
  const busy = () => Object.assign(new Error('resource busy'), { code: 'EBUSY' });
  let copies = 0;
  // The fourth copy is the second file of the new exercise folder.
  writing.copy = (from, to) => {
    if (++copies === 4) throw busy();
    real.writing.copy(from, to);
  };
  const failed = await update(root, ['--to', '0.0.0']);
  expect(failed).toMatchObject({ code: 1, calls: [] });
  expect(failed.lines).toEqual([
    `the update stopped at ${TOUR} (EBUSY) and put back every file it had written. Run it again to finish.`,
  ]);
  expect(files(root)).toEqual(before);
  expect(existsSync(join(root, exercises))).toBe(false);
  // A removal that fails puts back the files already copied.
  Object.assign(writing, real.writing, {
    remove: () => {
      throw busy();
    },
  });
  expect((await update(root, ['--to', '0.0.0'])).lines).toEqual([
    `the update stopped at ${WELCOME}/notes/dropped.md (EBUSY) and put back every file it had written. Run it again to finish.`,
  ]);
  expect(files(root)).toEqual(before);
  // A file that cannot be put back is named; every other one is put back.
  copies = 0;
  Object.assign(writing, real.writing, {
    copy: (from: string, to: string) => {
      if (++copies === 2) throw busy();
      real.writing.copy(from, to);
    },
    restore: (path: string, bytes: Uint8Array) => {
      if (path.endsWith('.gitignore')) throw busy();
      real.writing.restore(path, bytes);
    },
  });
  expect((await update(root, ['--to', '0.0.0'])).lines).toEqual([
    `the update stopped at ${WELCOME}/topic.yaml (EBUSY) and could not put back .gitignore: git has the earlier text.`,
  ]);
  const { '.gitignore': gitignore, ...rest } = files(root);
  expect(gitignore).toBe(read(root, '.parallax/template/.gitignore'));
  expect({ ...rest, '.gitignore': before['.gitignore'] }).toEqual(before);
  Object.assign(writing, real.writing);
  const done = await update(root, ['--to', '0.0.0']);
  expect(done.code, done.lines.join('\n')).toBe(0);
  expect(done.lines.slice(0, 5)).toEqual([
    `updated ${WELCOME}/topic.yaml`,
    `added ${exercises}/first-exercise.yaml`,
    `added ${TOUR}`,
    `removed ${WELCOME}/notes/dropped.md`,
    'updated .parallax-template.json',
  ]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await main(['check'], { cwd: root, print: () => {} })).toBe(0);
});

test('a record of the other mode keeps every part it does not name', async () => {
  const root = site();
  const older = olderTopic(read(root, `${WELCOME}/topic.yaml`));
  write(root, `${WELCOME}/topic.yaml`, older);
  setRecord(root, record(site('school')));
  const done = await update(root, ['--to', '0.0.0']);
  expect(done.lines).toEqual([
    'updated .parallax-template.json',
    'courses/welcome has changes of yours and is kept; the template changed 1 of its files: .parallax/template/courses/welcome and .parallax/template/private/courses/welcome',
    'parallax-site 0.0.0: 1 file changed, 1 kept as you have them. Its template is in .parallax/template.',
    'Next: npx parallax check, then npx parallax upgrade where the site is served.',
  ]);
  expect(read(root, `${WELCOME}/topic.yaml`)).toBe(older);
});

test('--dry-run writes nothing but .parallax/template', async () => {
  const root = site();
  const recorded = record(root);
  write(root, '.gitignore', 'node_modules/\n');
  setRecord(root, { ...recorded, '.gitignore': print('node_modules/\n') });
  const before = files(root);
  const done = await update(root, ['--to', '0.0.0', '--dry-run']);
  expect(done.lines).toEqual([
    'would update .gitignore',
    'would update .parallax-template.json',
    'parallax-site 0.0.0: 2 files would change. Nothing was written but .parallax/template.',
  ]);
  expect(files(root)).toEqual(before);
  expect(existsSync(join(root, '.parallax/template/.gitignore'))).toBe(true);
  // With another version it says what it would install, and installs nothing.
  const other = await update(root, ['--dry-run'], { latest: '0.0.2' });
  expect(other.calls).toEqual(['view latest']);
  expect(other.lines).toEqual([
    'would make package.json name parallax-site 0.0.2 (now 0.0.0) and run npm install.',
    'The files are compared with the template once 0.0.2 is installed.',
  ]);
  expect(files(root)).toEqual(before);
});

test('the installed version compares the files, and a failed npm install puts package.json back', async () => {
  const root = site('instructor', '0.0.0-a.1');
  // Tabs, Windows line ends and an object on one line, which the update keeps.
  const manifest = (version: string) =>
    `{\r\n\t"private": true,\r\n\t"type": "module",\r\n\t"scripts": { "x": "echo" },\r\n\t"dependencies": {\r\n\t\t"parallax-site": "${version}"\r\n\t}\r\n}\r\n`;
  writeFileSync(join(root, 'package.json'), manifest('0.0.0-a.1'));
  const failed = await update(root, ['--to', '0.0.2'], { npm: 1 });
  expect(failed.code).toBe(1);
  expect(failed.calls).toEqual(['npm install --no-audit --no-fund']);
  expect(failed.lines.at(-1)).toBe(
    "npm install ended with 1; package.json names 0.0.0-a.1 again. The site's other files are as they were.",
  );
  expect(read(root, 'package.json')).toBe(manifest('0.0.0-a.1'));
  // This repository's tool is 0.0.0, so the installed 0.0.2 is started to compare the files.
  const done = await update(root, ['--to', '0.0.2']);
  expect(done.calls).toEqual(['npm install --no-audit --no-fund', 'installed update --to 0.0.2']);
  expect(read(root, 'package.json')).toBe(manifest('0.0.2'));
  // The tool an update started starts no other.
  vi.stubEnv(HANDOFF, '1');
  const loop = await update(root, ['--to', '0.0.2']);
  expect(loop).toMatchObject({ code: 1, calls: [] });
  expect(loop.lines).toEqual(['the installed parallax-site is 0.0.0, not 0.0.2.']);
  vi.unstubAllEnvs();
  // A version up to 0.1.1 is installed, but has no update command to start.
  const older = await update(root, ['--to', '0.1.1'], { command: false });
  expect(older).toMatchObject({ code: 1, calls: ['npm install --no-audit --no-fund'] });
  expect(older.lines.at(-1)).toBe(
    "parallax-site 0.1.1 is installed and has no update command, so the site's other files were not compared with its template.",
  );
  expect(read(root, 'package.json')).toBe(manifest('0.1.1'));
});

test("update takes npm's latest, keeps a newer prerelease, and stops before writing without a version", async () => {
  const root = site('instructor', '0.0.1-rc.1');
  const manifest = read(root, 'package.json');
  const kept = await update(root);
  expect(kept.lines[0]).toBe(
    "parallax-site 0.0.1-rc.1 is newer than 0.0.0, npm's latest, and stays.",
  );
  expect(kept.calls).toEqual(['view latest', 'installed update --to 0.0.1-rc.1']);
  const none = await update(root, ['--to', 'next'], { latest: '' });
  expect(none).toMatchObject({ code: 1, calls: ['view next'] });
  expect(none.lines).toEqual([
    'npm view gave no single version of parallax-site@next (npm error code E404). Name one with --to <version>.',
  ]);
  expect(read(root, 'package.json')).toBe(manifest);
  // A path, a link or a URL is replaced only by a version that --to names.
  const local = manifest.replace('"0.0.1-rc.1"', '"file:../parallax-site.tgz"');
  writeFileSync(join(root, 'package.json'), local);
  const path = await update(root);
  expect(path).toMatchObject({ code: 1, calls: [] });
  expect(path.lines).toEqual([
    'package.json names parallax-site file:../parallax-site.tgz, not a version from npm. Name one with --to <version>.',
  ]);
  expect(read(root, 'package.json')).toBe(local);
  for (const args of [['--bogus'], ['--to', '1.0'], ['--to', '1.0.0+build'], ['extra']]) {
    expect((await update(root, args)).code, args.join(' ')).toBe(2);
  }
  expect(
    ['0.1.1', '0.1.0', '0.1.0-rc.1', '0.1.0-rc.1', '0.0.9'].map((v) => after('0.1.0-rc.2', v)),
  ).toEqual([false, false, true, true, true]);
  expect(after('1.0.0-alpha.beta', '1.0.0-alpha.1')).toBe(true);
  expect(after('1.0.0-alpha', '1.0.0-alpha.1')).toBe(false);
  expect(after('1.10.0', '1.9.9')).toBe(true);
});
