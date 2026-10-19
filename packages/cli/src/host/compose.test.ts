import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { expect, test } from 'vitest';
import type { Site } from '../site/load';
import { processes, runInServer } from './compose';

test('runInServer gives a script of the server image its input on standard input, bytes or text', async () => {
  const calls: [string, Buffer?][] = [];
  processes.run = async (args, cwd, input) => {
    calls.push([`${cwd}: ${args.join(' ')}`, input && (await buffer(input))]);
    return 3;
  };
  const site = { root: 'site', config: { level: 1 } } as Site;
  const bytes = Uint8Array.from([0, 10, 255]);
  expect(await runInServer(site, 'src/scripts/sync.ts', Readable.from([bytes]))).toBe(3);
  await runInServer({ ...site, config: { ...site.config, level: 2 } }, 'src/scripts/x.ts', 'text');
  const env = 'compose --env-file .env --env-file .parallax/site.env -f compose.yml';
  const tsx = 'run --rm -T server node_modules/.bin/tsx src/scripts';
  expect(calls).toEqual([
    [`site: ${env} ${tsx}/sync.ts`, Buffer.from(bytes)],
    [`site: ${env} -f compose.level2.yml ${tsx}/x.ts`, Buffer.from('text')],
  ]);
});
