import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** A value of an env file as Compose reads it; `changed` when Compose would replace part of it. */
export type EnvValue = { value: string; changed: boolean };
const ASSIGN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
const QUOTED = /^(['"])((?:\\.|(?!\1)[^\\])*)\1/;

/**
 * Reads an env file as Compose does: in single quotes only `\'` is an escape and nothing is
 * replaced; elsewhere Compose replaces `$…` (and in double quotes `\…`), and an unquoted value
 * ends before ` #`. The last line of a key wins.
 */
export function readEnv(text: string): Map<string, EnvValue> {
  const env = new Map<string, EnvValue>();
  for (const line of text.split(/\r?\n/)) {
    const [, key, raw = ''] = ASSIGN.exec(line) ?? [];
    if (!key) continue;
    const [, quote, inner = ''] = QUOTED.exec(raw) ?? [];
    const value = quote ? inner : (raw.split(' #')[0] ?? '').trimEnd();
    if (quote === "'") env.set(key, { value: inner.replaceAll("\\'", "'"), changed: false });
    else env.set(key, { value, changed: (quote ? /[$\\]/ : /\$/).test(value) });
  }
  return env;
}

/** An env file's text, or none. */
export const readText = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8') : '');

/**
 * Creates or completes the site's `.env` (docs/design/site.md §9), mode 0600: each generated
 * secret without a value gets 32 random bytes in hex, which a connection URL takes as it is. A
 * value that is there never changes, so a second run leaves the file byte-identical. Returns the
 * file's values and the names it added, never a value.
 */
export function completeEnv(root: string, level: number) {
  const file = join(root, '.env');
  const text = readText(file);
  const keys = ['POSTGRES_PASSWORD', 'SESSION_SECRET', 'CONTENT_TOKEN_SECRET', 'READY_PROBE_TOKEN'];
  if (level === 2) keys.push('RUNNER_DB_PASSWORD');
  const missing = keys.filter((key) => !readEnv(text).get(key)?.value);
  if (missing.length > 0) {
    // A line of a missing secret holds no value, so leaving it out loses nothing.
    const named = (line: string) => missing.includes(ASSIGN.exec(line)?.[1] ?? '');
    const kept = text
      .split(/\r?\n/)
      .filter((line) => !named(line))
      .join('\n')
      .trimEnd();
    const added = missing.map((key) => `${key}=${randomBytes(32).toString('hex')}\n`);
    writeFileSync(file, `${kept && `${kept}\n`}${added.join('')}`, { mode: 0o600 });
  }
  chmodSync(file, 0o600);
  return { env: readEnv(readText(file)), added: missing };
}
