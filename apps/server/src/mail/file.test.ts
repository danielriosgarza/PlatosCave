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

test('stamps messages and names files from the injected clock', async () => {
  const at = new Date('2026-10-01T09:30:00Z');
  const mailer = new FileMailer(
    join(dir, 'clocked'),
    'Parallax <no-reply@parallax.invalid>',
    () => at,
  );
  await mailer.send({ to: 'p@example.test', subject: 's', text: 't' });
  const [file] = await readdir(join(dir, 'clocked'));
  expect(file?.startsWith(String(at.getTime()).padStart(15, '0'))).toBe(true);
  const stored = JSON.parse(await readFile(join(dir, 'clocked', file ?? ''), 'utf8'));
  expect(stored.sentAt).toBe(at.toISOString());
});
