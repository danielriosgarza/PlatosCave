import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test, vi } from 'vitest';
import { main } from '../main';
import { readEnv } from './secrets';

const temp = mkdtempSync(join(tmpdir(), 'parallax-secrets-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
/** `parallax env` in a copy of the instructor fixture site; `.env` of the copy is `env`. */
async function env(name: string, text?: string) {
  const root = join(temp, name);
  cpSync(resolve(import.meta.dirname, '../../fixtures/config/instructor'), root, {
    recursive: true,
  });
  if (text !== undefined) writeFileSync(join(root, '.env'), text);
  expect(await main(['env'], { cwd: root })).toBe(0);
  return { root, text: () => readFileSync(join(root, '.env'), 'utf8') };
}

test('a second env leaves .env byte-identical and prints no secret', async () => {
  const { root, text } = await env('twice');
  const first = text();
  expect(await main(['env'], { cwd: root })).toBe(0);
  expect(text()).toBe(first);
  const secrets = [...readEnv(first).values()].map(({ value }) => value);
  expect(secrets).toHaveLength(4);
  for (const secret of secrets) {
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(printed.mock.calls.join('\n')).not.toContain(secret);
  }
  if (process.platform !== 'win32') expect(statSync(join(root, '.env')).mode & 0o777).toBe(0o600);
});

test('env completes .env and keeps every value there, a typed one included, byte for byte', async () => {
  const kept = "SMTP_URL='smtp://relay.example.org'\r\nSESSION_SECRET=kept\r\n";
  const { root, text } = await env('typed', `${kept}POSTGRES_PASSWORD=\r\n`);
  expect(text().startsWith(`${kept}POSTGRES_PASSWORD=`)).toBe(true);
  expect(statSync(join(root, '.parallax/.env.tmp'), { throwIfNoEntry: false })).toBeUndefined();
  const values = readEnv(text());
  expect(values.get('SMTP_URL')?.value).toBe('smtp://relay.example.org');
  expect(values.get('SESSION_SECRET')?.value).toBe('kept');
  expect(values.get('POSTGRES_PASSWORD')?.value).toMatch(/^[0-9a-f]{64}$/);
  expect(values.size).toBe(5);
});

test('readEnv reads a value as Compose does and marks one that Compose would change', () => {
  const text = `A='{"x":"$y #z"}'\nB=it\\'s # note\nC="a$b"\nD='O\\'Brien'\n# E=no\nF=$HOME`;
  expect(Object.fromEntries(readEnv(text))).toEqual({
    A: { value: '{"x":"$y #z"}', changed: false },
    B: { value: "it\\'s", changed: false },
    C: { value: 'a$b', changed: true },
    D: { value: "O'Brien", changed: false },
    F: { value: '$HOME', changed: true },
  });
});
