import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { RunnerEnv } from '../../../../apps/runner/src/config';
import { loadSite } from '../site/load';
import { readEnv } from './secrets';
import { writeSiteEnv } from './siteEnv';

const pkg = resolve(import.meta.dirname, '../..');
const temp = mkdtempSync(join(tmpdir(), 'parallax-site-env-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const PROVIDERS = [
  { id: 'uni', name: "Uni's $login #1 \\", issuer: 'https://login.example.org', clientId: 'p' },
  { id: 'clinic', name: 'Clinic', issuer: 'https://id.example.org/a', clientId: 'q' },
];
const backend = (subnet: string) => ({
  'compose.yml': `networks: { backend: { ipam: { config: [{ subnet: ${subnet} }] } } }`,
});
let copies = 0;
/** `env`'s files in a copy of a fixture site, with an edit of its configuration and files over it. */
async function env(fixture: string, edit: [RegExp | string, string] = ['', ''], files = {}) {
  const root = join(temp, `site-${copies++}`);
  cpSync(join(pkg, 'fixtures/config', fixture), root, { recursive: true });
  const config = readFileSync(join(root, 'parallax.config.ts'), 'utf8');
  writeFileSync(join(root, 'parallax.config.ts'), config.replace(edit[0], edit[1]));
  for (const [file, text] of Object.entries({ ...backend('172.30.1.0/24'), ...files })) {
    writeFileSync(join(root, file), text);
  }
  const site = await loadSite(root);
  const read = (file: string) => readFileSync(join(root, file), 'utf8');
  const values = (file: string) =>
    Object.fromEntries([...readEnv(read(file))].map(([key, { value }]) => [key, value]));
  return { site, read, values, write: () => writeSiteEnv(site) };
}

test('A47 a provider-only level 1 or 2 site needs no SMTP settings and emits no secret', async () => {
  const providers = `signIn: { providers: ${JSON.stringify(PROVIDERS)} },`;
  const typed = `OIDC_CLIENT_SECRETS='{"uni":"sentinel-1","clinic":"sentinel-2"}'`;
  for (const fixture of ['instructor', 'school']) {
    const { values, read, write } = await env(fixture, [/signIn: .*/, providers], {
      '.env': typed,
    });
    write();
    const siteEnv = values('.parallax/site.env');
    expect(siteEnv.MAIL_TRANSPORT).toBe('none');
    expect(JSON.parse(siteEnv.OIDC_PROVIDERS ?? '')).toEqual(PROVIDERS);
    expect(siteEnv.MAIL_FROM).toBeUndefined();
    const secrets = ['sentinel', ...Object.values(values('.env'))];
    for (const secret of secrets) expect(read('.parallax/site.env')).not.toContain(secret);
  }
});

test('site.env holds the settings of the configuration and changes with it', async () => {
  const { version, parallax } = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  const one = await env('instructor');
  one.write();
  expect(one.values('.parallax/site.env')).toEqual({
    APP_ORIGIN: 'https://stats.example.org',
    APP_HOST: 'stats.example.org',
    CONTENT_ORIGIN: 'https://content.stats.example.org',
    CONTENT_HOST: 'content.stats.example.org',
    MAIL_TRANSPORT: 'smtp',
    MAIL_FROM: 'Statistics <login@example.org>',
    OIDC_PROVIDERS: '[]',
    INSTRUCTOR_EMAILS: 'ana@example.org',
    SHINY_ORIGINS: '',
    PARALLAX_SERVER_IMAGE: `${parallax.registry}/parallax-server:${version}`,
    PARALLAX_RUNNER_IMAGE: `${parallax.registry}/parallax-runner:${version}`,
    COMPOSE_PROFILES: 'bundled',
  });
  const two = await env(
    'instructor',
    ['origins: {', "origins: { shiny: ['https://a.example.org'],"],
    {
      'instructor.yaml': 'name: Ana\nemail: Ana@Example.org\n',
      '.env': "DATABASE_URL='postgres://parallax:pw@db.example.org/parallax'\n",
    },
  );
  two.write();
  expect(two.values('.parallax/site.env')).toMatchObject({
    SHINY_ORIGINS: 'https://a.example.org',
    INSTRUCTOR_EMAILS: 'ana@example.org',
    COMPOSE_PROFILES: '',
  });
  expect(two.read('.parallax/site.env')).not.toContain('pw@');
});

test("at level 2 runner.env has the runner's variables and image, and pg_hba.conf admits the socket and two roles", async () => {
  const { site, values, read, write } = await env('school');
  const { pulls } = write();
  const image = `registry.example.org/parallax-runner-python@sha256:${'1'.repeat(64)}`;
  const runner = values('.parallax/runner/runner.env');
  const password = values('.env').RUNNER_DB_PASSWORD;
  // Besides the runner's variables, the image reference that compose.runner.yml reads.
  const { PARALLAX_RUNNER_IMAGE, ...variables } = runner;
  expect(Object.keys(variables).every((key) => key in RunnerEnv.shape)).toBe(true);
  expect(variables).toEqual({
    RUNNER_DATABASE_URL: `postgres://parallax_runner:${password}@10.0.0.2:5432/parallax`,
    RUNNER_IMAGES: JSON.stringify({ 'python-3.12': [image] }),
  });
  const siteEnv = values('.parallax/site.env');
  expect(PARALLAX_RUNNER_IMAGE).toBe(siteEnv.PARALLAX_RUNNER_IMAGE);
  expect(siteEnv.RUNNER_DATABASE_HOST).toBe('10.0.0.2');
  expect(read('.parallax/pg_hba.conf')).toBe(
    'local all all trust\nhost parallax parallax 172.30.1.0/24 scram-sha-256\n' +
      'host parallax parallax_runner 10.0.0.7/32 scram-sha-256\n',
  );
  expect(JSON.parse(siteEnv.RUNNER_RUNTIMES ?? '')).toEqual(site.config.runner?.runtimes);
  expect(pulls).toContain(`docker pull ${image}`);
  if (process.platform === 'win32') return; // Windows keeps no mode bits.
  const mode = (file: string) => statSync(join(site.root, file)).mode & 0o777;
  for (const file of ['.env', '.parallax/site.env', '.parallax/runner/runner.env']) {
    expect(mode(file)).toBe(0o600);
  }
  expect(mode('.parallax/pg_hba.conf')).toBe(0o644);
});

test('with an existing PostgreSQL runner.env keeps a typed RUNNER_DATABASE_URL, not the bundled one', async () => {
  const { site, values, read, write } = await env('school');
  write();
  const url = (role: string) => `postgres://${role}:pw@db.example.org/parallax`;
  writeFileSync(join(site.root, '.env'), `${read('.env')}DATABASE_URL='${url('parallax')}'\n`);
  write();
  expect(values('.parallax/runner/runner.env').RUNNER_DATABASE_URL).toBeUndefined();
  const runnerEnv = join(site.root, '.parallax/runner/runner.env');
  writeFileSync(runnerEnv, `RUNNER_DATABASE_URL='${url('parallax_runner')}'\n`);
  write();
  expect(values('.parallax/runner/runner.env').RUNNER_DATABASE_URL).toBe(url('parallax_runner'));
});

test('env stops, before it writes anything, at a value the server or PostgreSQL cannot use', async () => {
  const cases: [[string, string], string, object?][] = [
    [["host: '10.0.0.7'", "host: '0.0.0.0'"], 'runner.host: 0.0.0.0 is'],
    [["databaseHost: '10.0.0.2'", "databaseHost: '127.0.0.1'"], 'runner.databaseHost: 127.0.0.1'],
    [["host: '10.0.0.7'", "host: '255.255.255.255'"], 'runner.host: 255.255.255.255'],
    [["language: 'python'", "language: 'r'"], 'runner.runtimes[0].language'],
    [['//school', '//my_school'], 'origins.app: the host my_school.example.org'],
    [['//shiny', '//a,b'], 'origins.shiny[0]: the host a,b.example.org'],
    [["login@example.org>'", "login@example.org>\\\\'"], 'signIn.email.from'],
    [['', ''], 'compose.yml: networks.backend', { 'compose.yml': 'services: {}' }],
    [['', ''], 'subnet: not an IPv4 subnet inside', backend('0.0.0.0/0')],
    [['', ''], 'subnet: not an IPv4 subnet inside', backend('192.168.0.0/15')],
    // Outside a range, wider than it, or more than one address and prefix, a rule line among them.
    ...['172.32.0.0/16', '10.0.0.0/7', '172.16.0.0/8', '10.0.0.0/8/x', '10.0.0.0/8/\\nhost x'].map(
      (subnet): [[string, string], string, object] => [['', ''], 'subnet:', backend(`"${subnet}"`)],
    ),
  ];
  for (const [edit, line, files] of cases) {
    const { site, write } = await env('school', edit, files);
    expect(write).toThrow(line);
    expect(
      ['.env', '.parallax'].some((name) =>
        statSync(join(site.root, name), { throwIfNoEntry: false }),
      ),
    ).toBe(false);
  }
});

test('a backend subnet inside each private range is written into pg_hba.conf as its address and prefix', async () => {
  for (const subnet of ['10.0.0.0/8', '172.31.0.0/16', '192.168.4.0/24']) {
    const { read, write } = await env('school', ['', ''], backend(subnet));
    write();
    expect(read('.parallax/pg_hba.conf')).toContain(`\nhost parallax parallax ${subnet} scram`);
  }
});
