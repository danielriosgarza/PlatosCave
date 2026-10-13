import { readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import type { ResourceType } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import { type Drafts, validate } from './validation';

// `parallax check` loads the validator where there is no database (docs/design/course-folder.md
// §8), so nothing it imports, type-only imports included, may lie under db/ or auth/.

const src = resolve(import.meta.dirname, '..');
const isFile = (path: string) => statSync(path, { throwIfNoEntry: false })?.isFile() === true;

/** Every file the relative imports of `entry` lead to, as sorted paths from `apps/server/src`. */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const follow = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const code = readFileSync(file, 'utf8');
    for (const [, spec = ''] of code.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g)) {
      const base = resolve(dirname(file), spec);
      const target = [`${base}.ts`, resolve(base, 'index.ts'), base].find(isFile);
      if (!target) throw new Error(`${file} imports ${spec}, which is no file`);
      follow(target);
    }
  };
  follow(resolve(src, entry));
  return [...seen].map((file) => relative(src, file).replaceAll('\\', '/')).sort();
}

type Item = Drafts[number]['resources'][number];
const ready = {
  status: { state: 'ready', job: 'slides', jobId: null, updatedAt: '2026-10-01T09:00:00.000Z' },
};
const item = (
  id: string,
  type: ResourceType,
  revision: Partial<NonNullable<Item['revision']>> = {},
): Item => ({
  resource: { id, courseId: 'reef-ecology', type, title: `Resource ${id}` },
  revision: {
    resourceId: id,
    courseId: 'reef-ecology',
    type,
    content: {},
    derived: {},
    accessibleAlternative: null,
    ...revision,
  },
  status: null,
});
const topic = (id: string, resources: Item[], prerequisites: string[] = []): Drafts[number] => ({
  topic: { id, title: `Topic ${id}`, prerequisites },
  resources,
});

describe('publication checks without a database (P5-09a)', () => {
  test('the imports of validation.ts, followed to the end, reach no file under db/ or auth/', () => {
    const closure = importClosure('content/validation.ts');
    // The walk went through the modules that led into db/ before the move, and config.ts is
    // reached through type-only imports alone.
    expect(closure).toEqual(
      expect.arrayContaining([
        'config.ts',
        'content/canonical.ts',
        'content/derived-status.ts',
        'execution/job-builder.ts',
        'execution/publication.ts',
      ]),
    );
    expect(closure.filter((file) => /^(db|auth)\//.test(file))).toEqual([]);
  });

  test('a course without topics is an empty release', () => {
    expect(validate([], { runtimes: [] })).toEqual({
      errors: [{ code: 'empty_release', message: 'The course has no topics to publish' }],
      warnings: [],
    });
  });

  test('a missing prerequisite, a foreign revision and another type are broken references', () => {
    const drafts = [
      topic(
        't1',
        [
          item('r1', 'reading_native', { resourceId: 'r9' }),
          item('r2', 'reading_native', { type: 'notebook' }),
        ],
        ['gone'],
      ),
    ];
    const broken = (message: string, resourceId?: string) => ({
      code: 'broken_reference',
      message,
      topicId: 't1',
      ...(resourceId && { resourceId }),
    });
    expect(validate(drafts, { runtimes: [] })).toEqual({
      errors: [
        broken('“Topic t1” requires a topic that is not in this release'),
        broken('“Resource r1” points at another resource’s revision', 'r1'),
        broken('“Resource r2” has content of another resource type', 'r2'),
      ],
      warnings: [],
    });
  });

  test('a missing alternative is a warning, and an error for a raster-only deck', () => {
    const drafts = [
      topic('t1', [
        item('r1', 'reading_pdf'),
        item('r2', 'slides_pdf', { derived: { ...ready, rasterOnly: true } }),
        item('r3', 'slides_pdf', { derived: ready, accessibleAlternative: { text: 'Ten slides' } }),
        item('r4', 'shiny', { content: { url: 'https://shiny.example.org/reef' } }),
      ]),
    ];
    const missing = (resourceId: string) => ({
      code: 'missing_alternative',
      message: `“Resource ${resourceId}” has no accessible alternative`,
      topicId: 't1',
      resourceId,
    });
    expect(
      validate(drafts, { runtimes: [], approvedShinyOrigins: ['https://shiny.example.org'] }),
    ).toEqual({ errors: [missing('r2')], warnings: [missing('r1'), missing('r4')] });
  });
});
