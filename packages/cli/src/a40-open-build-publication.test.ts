import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { publicationReport } from './folder/publication';
import { readCourseForSite } from './folder/read';
import { buildUnderGuard } from './open/testing';

delete process.env.DATABASE_URL;
const temp = fs.mkdtempSync(join(tmpdir(), 'parallax-a40-open-'));
afterAll(() => fs.rmSync(temp, { recursive: true, force: true }));
const course = 'courses/reef-ecology';
const sampling = `${course}/sampling`;

test('A40 a level 0 build stops with the report of the existing validation and writes no site', async () => {
  const root = join(temp, 'site');
  fs.cpSync(resolve(import.meta.dirname, '../fixtures/open-site/instructor'), root, {
    recursive: true,
  });
  fs.mkdirSync(join(root, 'dist'));
  fs.writeFileSync(join(root, 'dist/index.html'), 'an earlier build');
  const files = ['topic.yaml', 'slides/zones.pdf', 'reading/paper.pdf'];
  const [topic = '', deck = '', paper = ''] = files.map((file) =>
    fs.readFileSync(join(root, sampling, file), 'latin1'),
  );
  // A deck whose pages hold no text, without its alternative, and a PDF reading that cannot be read.
  const blank = deck.replace(
    /\((Reef crest|Reef flat|Back reef)\)/g,
    (s) => `(${' '.repeat(s.length - 2)})`,
  );
  const changed = [
    topic.replace(/ {4}alternative: Three slides.*\n/, ''),
    blank,
    '%PDF-1.4 and no page',
  ];
  const write = (texts: string[]) => {
    for (const [i, file] of files.entries())
      fs.writeFileSync(join(root, sampling, file), texts[i] ?? '', 'latin1');
  };
  write(changed);
  const refused = buildUnderGuard(root);

  // Publication's report on the reader's manifest, for what conversion gives the two files.
  const { manifest, folders } = await readCourseForSite(join(root, course));
  if (!manifest) throw new Error('the reader gave no manifest');
  const entries = manifest.topics.flatMap((topic) => topic.resources);
  const at = (file: string) => entries.find((e) => 'path' in e && e.path === `sampling/${file}`);
  const id = (file: string) => at(file)?.id ?? '';
  const derived = {
    [id('slides/zones.pdf')]: { state: 'ready', derived: { rasterOnly: true } } as const,
    [id('reading/paper.pdf')]: { state: 'failed' } as const,
  };
  const options = { approvedShinyOrigins: ['https://shiny.example.org'], folders };
  const { errors, warnings } = publicationReport(manifest, derived, options);
  expect(errors.map((error) => [error.code, error.path])).toEqual([
    ['missing_alternative', 'sampling/slides/zones.pdf'],
    ['unprocessed_reading', 'sampling/reading/paper.pdf'],
  ]);
  const line = ({ path, message }: { path: string; message: string }) =>
    `${course}/${path}: ${message}`;
  const printed = (run: { stdout: string }) => run.stdout.split('\n').filter(Boolean);
  const errorLines = printed(refused).filter((text) => !/^(warning|note): /.test(text));
  const placed = [...refused.files].filter(([path]) => path.startsWith('dist/'));
  expect([refused.status, errorLines, placed]).toEqual([
    1,
    errors.map(line),
    [['dist/index.html', Buffer.from('an earlier build')]],
  ]);

  // Corrected, the folder builds, with a topic of only an exercise and a test, which gives no
  // line, and a Shiny app on an origin that is not listed, which gives the validator's warning.
  write([topic, deck, paper]);
  const done = buildUnderGuard(root);
  const shiny = warnings.find((warning) => warning.code === 'unapproved_shiny_origin');
  expect(shiny?.path).toBe('sampling/notebooks/currents.shiny.yaml');
  const lines = printed(done);
  expect([done.status, lines.filter((text) => text.includes('/practice/'))]).toEqual([0, []]);
  expect(lines).toContain(`warning: ${line(shiny ?? { path: '', message: '' })}`);
  expect(fs.readdirSync(join(root, 'dist')).sort()).toEqual(['content', 'site']);
}, 300_000);
