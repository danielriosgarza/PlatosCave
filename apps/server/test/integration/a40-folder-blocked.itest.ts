import { afterAll, beforeAll, expect, test } from 'vitest';
import { folderCourseId } from '../../src/content/folder-ids';
import { validateDrafts } from '../../src/db/content/releases';
import { makePdf } from '../fixtures/pdf';
import { asCourseScope } from '../fixtures/world';
import { entry, folder, ids, type SyncWorld, syncWorld } from './course-folder';

// A40 at level 1 (§13, N4): a problem that blocks publication stops `syncCourse` with
// publication's own report, after the counts of what it wrote.

let w: SyncWorld;
beforeAll(async () => {
  w = await syncWorld();
});
afterAll(() => w?.close());

test('A40 a problem that blocks publication stops sync with the report of the existing validation and leaves no release', {
  timeout: 120_000,
}, async () => {
  const f = folder('course');
  // A deck whose pages carry no text, without an alternative.
  f.bytes.set('sampling/slides/deck.pdf', makePdf(['', ''], [960, 540]));
  delete entry(f, ids.deck).alternative;
  // A notebook the upload rules accept and the renderer cannot write out: an output nested deeper
  // than its thread's stack. It has no data files, so sync stores it as it is.
  const counts = entry(f, ids.notebook);
  if (counts.type !== 'notebook') throw new Error('no notebook');
  counts.source.data = [];
  f.manifest.files = f.manifest.files.filter((file) => file.format !== 'data');
  const deep = `${'['.repeat(50_000)}${']'.repeat(50_000)}`;
  const output = `{"output_type":"display_data","metadata":{},"data":{"application/json":${deep}}}`;
  const cell = `{"cell_type":"code","execution_count":null,"metadata":{},"source":"counts","outputs":[${output}]}`;
  const nb = `{"cells":[${cell}],"metadata":{},"nbformat":4,"nbformat_minor":4}`;
  f.bytes.set(counts.source.file, new TextEncoder().encode(nb));

  const scope = asCourseScope(folderCourseId(w.ana, 'reef-blocked'), w.ana);
  const blocked = await w.sync(f, { course: 'reef-blocked' });
  const report = await validateDrafts(w.db, scope, w.deps.validate);
  expect(blocked).toMatchObject({ code: 1, validation: report });
  expect(report.errors.map((issue) => issue.code).sort()).toEqual([
    'missing_alternative',
    'unprocessed_reading',
  ]);
  expect(blocked.report.slice(0, 3)).toEqual([
    'created course reef-blocked',
    'created 11, new revisions 0, moved 0, fields changed 0, archived 0, unchanged 0, editor only 0',
    'not published',
  ]);
  const deck = '“Reef zones” has no accessible alternative (sampling/slides/deck.pdf)';
  expect(blocked.report).toContain(`error missing_alternative: ${deck}`);
  expect((await w.rows(scope.courseId)).releases).toEqual([]);

  // The folder corrected: the deck has its alternative and the notebook the fixture's file.
  const fixed = folder('course');
  fixed.bytes.set('sampling/slides/deck.pdf', makePdf(['', ''], [960, 540]));
  const published = await w.sync(fixed, { course: 'reef-blocked' });
  expect(published).toMatchObject({
    code: 0,
    report: expect.arrayContaining(['release 1 published']),
  });
  expect((await w.rows(scope.courseId)).releases.map((r) => r.version)).toEqual([1]);
  expect(w.errors).toEqual([]);
});
