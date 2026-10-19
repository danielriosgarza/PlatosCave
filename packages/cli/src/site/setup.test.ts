import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { text } from 'node:stream/consumers';
import { siteSetup } from '@parallax/contracts';
import { expect, test, vi } from 'vitest';
import { run as apply } from '../commands/apply';
import { composeArgs, processes } from '../host/compose';
import { loadSite } from './load';
import { setupDocument } from './setup';

const fixtures = resolve(import.meta.dirname, '../../fixtures/config');

test('the document derived from the fixture site equals the server fixture document and holds each instructor.yaml path', async () => {
  const a51 = resolve(fixtures, '../../../../apps/server/test/fixtures/site-setup.json');
  const document = setupDocument(await loadSite(join(fixtures, 'school')));
  expect(document).toEqual(JSON.parse(readFileSync(a51, 'utf8')));
  const paths = document.instructors.map(({ path }) => path);
  expect(paths).toEqual(['instructors/ana/instructor.yaml', 'instructors/ben/instructor.yaml']);
  const one = setupDocument(await loadSite(join(fixtures, 'instructor')));
  expect(one.instructors).toEqual([
    { ref: '.', path: 'instructor.yaml', email: 'ana@example.org' },
  ]);
});

test('apply pipes a document that siteSetup accepts and puts no address or code on a command line', async () => {
  const site = await loadSite(join(fixtures, 'school'));
  const calls: [string, string][] = [];
  processes.run = async (args, cwd, input) => {
    calls.push([`${cwd}: ${args.join(' ')}`, input ? await text(input) : '']);
    return 2;
  };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await apply({ site, args: [] })).toBe(2);
  const script = 'run --rm -T server node_modules/.bin/tsx src/scripts/apply-site.ts';
  expect(calls.map(([call]) => call)).toEqual([
    `${site.root}: ${composeArgs(2).join(' ')} ${script}`,
  ]);
  expect(siteSetup.parse(JSON.parse(calls[0]?.[1] ?? ''))).toEqual(setupDocument(site));
  const level0 = { ...site, config: { ...site.config, level: 0 as const } };
  expect(await apply({ site: level0, args: [] })).toBe(1);
  expect(calls).toHaveLength(1);
});
