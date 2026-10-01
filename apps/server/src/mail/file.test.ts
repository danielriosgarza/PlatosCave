import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { FileMailer } from './file';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'parallax-mail-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test('writes one JSON file per message, named in send order, with no partial files left', async () => {
  const mailer = new FileMailer(join(dir, 'mail'), 'Parallax <no-reply@parallax.invalid>');
  for (const n of [1, 2, 3]) {
    await mailer.send({ to: `p${n}@example.test`, subject: `s${n}`, text: `t${n}` });
  }
  const files = (await readdir(join(dir, 'mail'))).sort();
  expect(files).toHaveLength(3);
  expect(files.every((f) => f.endsWith('.json'))).toBe(true);
  const messages = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(dir, 'mail', f), 'utf8'))),
  );
  expect(messages.map((m) => m.to)).toEqual([
    'p1@example.test',
    'p2@example.test',
    'p3@example.test',
  ]);
  expect(messages[0]).toMatchObject({
    from: 'Parallax <no-reply@parallax.invalid>',
    subject: 's1',
    text: 't1',
  });
  expect(Number.isNaN(Date.parse(messages[0].sentAt))).toBe(false);
});
