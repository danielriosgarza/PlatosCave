import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { text } from 'node:stream/consumers';
import { afterAll, expect, test, vi } from 'vitest';
import { composeArgs, processes } from '../host/compose';
import { readEnv } from '../host/secrets';
import { main } from '../main';

// The compile is `build`'s and tested with it; here it succeeds at once.
vi.mock('./build', () => ({ run: async () => 0 }));
const temp = mkdtempSync(join(tmpdir(), 'parallax-start-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const PROVIDER = `signIn: { providers: [{ id: 'uni', name: 'U', issuer: 'https://u.example.org', clientId: 'p' }] },`;
const SMTP = "SMTP_URL='smtp://relay.example.org:587'\n";
const UP = ['pull', 'up -d --wait'];
let copies = 0;
/** `parallax start` in a copy of a fixture site, with an edit of its configuration and `.env`. */
async function start(fixture: string, edit: [RegExp | string, string] = ['', ''], env = SMTP) {
  const root = join(temp, `site-${copies++}`);
  cpSync(resolve(import.meta.dirname, '../../fixtures/config', fixture), root, { recursive: true });
  const config = readFileSync(join(root, 'parallax.config.ts'), 'utf8');
  writeFileSync(join(root, 'parallax.config.ts'), config.replace(edit[0], edit[1]));
  const subnet = 'networks: { backend: { ipam: { config: [{ subnet: 172.30.1.0/24 }] } } }';
  writeFileSync(join(root, 'compose.yml'), subnet);
  writeFileSync(join(root, '.env'), env);
  return again(root);
}
/** `parallax start` with the process runner injected: each call after the compose arguments. */
async function again(root: string) {
  const calls: string[] = [];
  const inputs: string[] = [];
  processes.run = async (args, _cwd, input) => {
    const files = composeArgs(args.includes('compose.level2.yml') ? 2 : 1);
    expect(args.slice(0, files.length)).toEqual(files);
    calls.push(args.slice(files.length).join(' '));
    if (input) inputs.push(await text(input));
    return 0;
  };
  const lines: string[] = [];
  const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error')];
  for (const spy of spies) spy.mockImplementation((line) => lines.push(line));
  const code = await main(['start'], { cwd: root }).finally(() => vi.restoreAllMocks());
  const env = readFileSync(join(root, '.env'), 'utf8');
  for (const { value } of readEnv(env).values())
    if (value) expect(lines.join()).not.toContain(value);
  return { code, calls, inputs, said: lines.join('\n'), root, env };
}

test('A47 start of a provider-only site asks for no SMTP_URL and stops when a listed provider has no secret', async () => {
  const stopped = await start('instructor', [/signIn: .*/, PROVIDER], '');
  expect(stopped).toMatchObject({ code: 1, calls: [] });
  expect(stopped.said).toContain('no secret for the provider uni,');
  expect(stopped.said).not.toContain('SMTP_URL');
  writeFileSync(join(stopped.root, '.env'), `${stopped.env}OIDC_CLIENT_SECRETS='{"uni":"s3"}'\n`);
  expect(await again(stopped.root)).toMatchObject({ code: 0, calls: UP });
});

test('start stops before any compose call at level 0, with an invalid configuration, with signIn.email set and SMTP_URL empty, or with OIDC_CLIENT_SECRETS the server refuses', async () => {
  const providers: [RegExp, string] = [/signIn: .*/, PROVIDER];
  const cases: [[RegExp | string, string], string, string][] = [
    [['level: 1', 'level: 0'], SMTP, 'level 0 has no server'],
    [['level: 1', 'level: 3'], SMTP, 'parallax.config.ts: level:'],
    [['', ''], "SMTP_URL=''", 'signIn.email is set and SMTP_URL is empty'],
    [providers, `OIDC_CLIENT_SECRETS='{"uni":""}'`, 'not a JSON object of non-empty secrets'],
    [providers, `OIDC_CLIENT_SECRETS='["uni"]'`, 'not a JSON object of non-empty secrets'],
    [providers, `OIDC_CLIENT_SECRETS='{"uni":"s3","old":"t4"}'`, 'a secret for "old", which'],
    [providers, 'OIDC_CLIENT_SECRETS={"uni":"s$3"}', 'that Compose would change'],
  ];
  for (const [edit, env, said] of cases) {
    const run = await start('instructor', edit, env);
    expect(run).toMatchObject({ code: 1, calls: [] });
    expect(run.said).toContain(said);
  }
});

test('a second start changes no generated secret and stops no service', async () => {
  const first = await start('instructor');
  expect(first).toMatchObject({ code: 0, calls: UP });
  expect(await again(first.root)).toMatchObject({ code: 0, calls: UP, env: first.env });
});

test('at level 2 start sends its ALTER ROLE on standard input to psql in the postgres container', async () => {
  const { calls, inputs, env } = await start('school');
  const password = readEnv(env).get('RUNNER_DB_PASSWORD')?.value;
  const psql = 'exec -T postgres psql -U parallax -d parallax -v ON_ERROR_STOP=1';
  expect(calls).toEqual([...UP, psql]);
  const login = `LOGIN PASSWORD '${password}' CONNECTION LIMIT 8`;
  expect(inputs).toEqual([`ALTER ROLE parallax_runner ${login};\nSELECT pg_reload_conf();\n`]);
});

test('start leaves the Caddyfile and dist/ readable to Caddy and the server, which have no capability to read them otherwise', async () => {
  const { root } = await start('instructor');
  // As an umask of 077 leaves them.
  for (const file of ['Caddyfile', 'dist/index.html', 'dist/assets/a.js']) {
    mkdirSync(dirname(join(root, file)), { recursive: true, mode: 0o700 });
    writeFileSync(join(root, file), '', { mode: 0o600 });
  }
  expect(await again(root)).toMatchObject({ code: 0, calls: UP });
  if (process.platform === 'win32') return; // Windows keeps no mode bits.
  const files = ['Caddyfile', 'dist', 'dist/assets', 'dist/index.html', 'dist/assets/a.js'];
  const modes = files.map((file) => statSync(join(root, file)).mode & 0o777);
  expect(modes).toEqual([0o644, 0o755, 0o755, 0o644, 0o644]);
});
