import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { main } from '../main';
import { applyIds, planIds } from './ids';

delete process.env.DATABASE_URL;
const fixture = resolve(import.meta.dirname, '../../fixtures/course');
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-ids-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const course = 'courses/reef-ecology';
const sampling = `${course}/sampling/topic.yaml`;
// The topic's id and the ids of its entries 0 and 4, which each copy of the fixture site lacks.
const removed = [
  '5f0c1d8e-3b7a-4c2e-9a41-7d2f6b0e1c33',
  'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
  '6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c2d',
];
let sites = 0;
function site(change = (text: string) => text) {
  const dir = join(temp, `site-${sites++}`);
  fs.cpSync(fixture, dir, { recursive: true });
  const text = fs.readFileSync(join(dir, sampling), 'utf8');
  const without = removed.reduce((t, id) => t.replace(new RegExp(`id: ${id}\\n *`), ''), text);
  fs.writeFileSync(join(dir, sampling), change(without));
  return dir;
}
/** Every file under a folder, by its path with `/`, with its bytes. */
function snapshot(dir: string) {
  const files = fs.readdirSync(dir, { recursive: true, encoding: 'utf8' });
  const file = (path: string) => fs.statSync(join(dir, path)).isFile();
  const bytes = (path: string) => [path.replaceAll('\\', '/'), fs.readFileSync(join(dir, path))];
  return Object.fromEntries(files.filter(file).map(bytes));
}
async function check(dir: string) {
  const lines: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((line: string) => lines.push(line));
  const code = await main(['check', '--write-ids'], { cwd: dir }).finally(() => log.mockRestore());
  return { code, lines };
}

test('--write-ids adds exactly the missing ids and prints each; the rest stays byte for byte, and a second run changes no file', async () => {
  const dir = site();
  const before = snapshot(dir);
  const { code, lines } = await check(dir);
  expect(code, lines.join(' | ')).toBe(0);
  const printed = lines.filter((line) => line.includes(': set to '));
  const ids = printed.map((line) => line.split(': set to ')[1] ?? '');
  const fields = ['id', 'resources[0].id', 'resources[4].id'];
  expect(printed).toEqual(fields.map((field, i) => `${sampling}: ${field}: set to ${ids[i]}`));
  expect(new Set(ids).size).toBe(3);
  // With the earlier ids where the new ones stand, the file is the fixture's again, byte for byte.
  const after = snapshot(dir);
  const text = fs.readFileSync(join(dir, sampling), 'utf8');
  const back = ids.reduce((t, id, i) => t.replace(id, removed[i] ?? ''), text);
  expect(back).toBe(fs.readFileSync(join(fixture, sampling), 'utf8'));
  expect({ ...after, [sampling]: before[sampling] }).toEqual(before);
  const again = await check(dir);
  expect(again.lines.filter((line) => line.includes(': set to '))).toEqual([]);
  expect(snapshot(dir)).toEqual(after);
});

const unread = `${sampling}: no id written: with them it would not read the same`;
const bom = String.fromCharCode(0xfeff);
test.each([
  ['a byte-order mark before its first key', (t: string) => bom + t.replace(/^#.*\n/gm, ''), []],
  ['an anchored, tagged first key', (t: string) => t.replace('- file', '- &d !!str file'), []],
  [
    'an explicit key, which no edit keeps',
    (t: string) => t.replace('- file:', '- ? file\n    :'),
    [unread],
  ],
])(
  '--write-ids on a topic.yaml with %s writes the ids and no other byte, or nothing',
  async (_, change, refused) => {
    const dir = site(change);
    const text = fs.readFileSync(join(dir, sampling), 'utf8');
    const { code, lines } = await check(dir);
    expect(code, lines.join(' | ')).toBe(refused.length);
    expect(lines).toEqual(expect.arrayContaining(refused));
    const ids = lines.flatMap((line) => line.split(': set to ')[1] ?? []);
    expect(ids).toHaveLength(refused.length ? 0 : 3);
    // With each new line taken out again, the file is as it was.
    const written = fs.readFileSync(join(dir, sampling), 'utf8');
    expect(ids.reduce((t, id) => t.replace(new RegExp(`id: ${id}\n *`), ''), written)).toBe(text);
  },
);

test('--write-ids writes nothing in the course while an entry’s file is gone and a file is unlisted, and names both', async () => {
  const dir = site();
  // methods.md renamed, in another Unicode form: the entry's file is gone, and this file unlisted.
  const reading = join(dir, course, 'sampling/reading');
  fs.renameSync(join(reading, 'methods.md'), join(reading, 'méthods.md'.normalize('NFD')));
  const before = snapshot(dir);
  const { code, lines } = await check(dir);
  expect(code).toBe(1);
  expect(snapshot(dir)).toEqual(before);
  expect(lines).toEqual(
    expect.arrayContaining([
      `${course}: no id written while the errors below stand`,
      `${sampling}: resources[1].file: no file sampling/reading/methods.md (line 15)`,
      // Not in NFC, so every character outside ASCII is printed as its code point.
      `${course}/sampling/reading/me\\u{301}thods.md: no entry of topic.yaml lists it`,
      'parallax check: 1 course folder read, 5 errors.',
    ]),
  );
});

test('a topic.yaml that changed between the read and the write is not replaced', async () => {
  const dir = join(site(), course);
  const plan = await planIds(dir);
  expect(plan?.edits.map((edit) => edit.path)).toEqual(['sampling/topic.yaml']);
  const file = join(dir, 'sampling/topic.yaml');
  fs.appendFileSync(file, '# Edited meanwhile.\n');
  const edited = fs.readFileSync(file);
  expect(applyIds(dir, plan?.edits ?? [])).toEqual({
    written: [],
    changed: ['sampling/topic.yaml'],
  });
  expect(fs.readFileSync(file)).toEqual(edited);
  expect(fs.readdirSync(join(dir, 'sampling'))).toEqual(
    fs.readdirSync(join(fixture, course, 'sampling')),
  );
});
