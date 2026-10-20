import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { parse } from 'yaml';
import { backupService } from '../../../../packages/cli/src/host/backup';
import { readEnv, readText } from '../../../../packages/cli/src/host/secrets';
import { writeSiteEnv } from '../../../../packages/cli/src/host/siteEnv';
import { loadSite } from '../../../../packages/cli/src/site/load';
import { loadConfig as runnerConfig } from '../../../runner/src/config';
import { loadConfig } from '../config';

/**
 * What `parallax env` writes against what the template's compose files read (docs/design/site.md
 * §9 to §11): fixture sites get the template's own installation files, `env` writes for them,
 * and its files must fill every `${VAR}` and give configurations the server and runner accept.
 */
const repo = resolve(import.meta.dirname, '../../../..');
const temp = mkdtempSync(join(tmpdir(), 'parallax-compose-env-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
type Env = Record<string, string>;
type Compose = { services: Record<string, { image?: string; environment?: Env }> };
const PROVIDERS = [
  { id: 'uni', name: "Uni's", issuer: 'https://login.example.org', clientId: 'p' },
];
const SIGN_IN = `signIn: { email: { from: 'Site <login@example.org>' }, providers: ${JSON.stringify(PROVIDERS)} },`;
/** What the operator types into .env for those two ways to sign in. */
const TYPED = `SMTP_URL='smtp://relay.example.org:587'\nOIDC_CLIENT_SECRETS='{"uni":"s3"}'\n`;
const EXISTING = `${TYPED}DATABASE_URL='postgres://parallax:pw@db.example.org/parallax'\n`;
const FILES = ['compose.yml', 'compose.level2.yml', 'compose.runner.yml', 'Caddyfile'];

let copies = 0;
/** `env` in a copy of a fixture site with the template's installation files and the backup's. */
async function written(fixture: 'instructor' | 'school', dotenv = TYPED) {
  const root = join(temp, `${fixture}-${copies++}`);
  cpSync(join(repo, 'packages/cli/fixtures/config', fixture), root, { recursive: true });
  const shared = join(repo, 'packages/create-parallax-site/templates/shared');
  for (const file of FILES) cpSync(join(shared, file), join(root, file));
  const config = join(root, 'parallax.config.ts');
  writeFileSync(config, readFileSync(config, 'utf8').replace(/signIn: .*/, SIGN_IN));
  writeFileSync(join(root, '.env'), dotenv);
  writeSiteEnv(await loadSite(root));
  writeFileSync(join(root, '.parallax/compose.backup.yml'), JSON.stringify(backupService()));
  const values = (file: string): Env =>
    Object.fromEntries([...readEnv(readText(join(root, file)))].map(([k, v]) => [k, v.value]));
  const text = (file: string) => readFileSync(join(root, file), 'utf8');
  const compose = (file: string) => parse(text(file), { merge: true }) as Compose;
  const site = values('.parallax/site.env');
  return { text, compose, site, env: { ...values('.env'), ...site }, runner: values(RUNNER) };
}
const RUNNER = '.parallax/runner/runner.env';

/** `${…}` filled as Compose fills them; each that is unset or empty and has no default is named. */
const fill = (raw: string, env: Env, missing: string[] = []) =>
  raw.replace(/\$\{([A-Z0-9_]+)(:[?-])?([^}]*)\}/g, (_, name: string, op = '', tail = '') => {
    if (env[name]) return env[name];
    if (op !== ':-') missing.push(name);
    return op === ':-' ? tail : '';
  });
const filled = (environment: Env = {}, env: Env) =>
  Object.fromEntries(Object.entries(environment).map(([key, raw]) => [key, fill(raw, env)]));

test('the files env writes fill every reference of the compose files, at level 1 and 2, with the bundled or an existing PostgreSQL', async () => {
  const cases = [
    ['instructor', TYPED],
    ['school', TYPED],
    ['school', EXISTING],
  ] as const;
  for (const [fixture, dotenv] of cases) {
    const { text, env, runner } = await written(fixture, dotenv);
    const files = ['compose.yml', '.parallax/compose.backup.yml'];
    if (fixture === 'school') files.push('compose.level2.yml');
    const missing: string[] = [];
    for (const file of files) fill(text(file), env, missing);
    expect(missing, `${fixture} ${dotenv}`).toEqual([]);
    if (fixture !== 'school') continue;
    // On the runner host: runner.env and the socket's group; with an existing PostgreSQL the
    // operator types the role's URL into runner.env, so env writes none.
    const left: string[] = [];
    fill(text('compose.runner.yml'), { ...runner, DOCKER_GID: '998' }, left);
    expect(left).toEqual(dotenv === EXISTING ? ['RUNNER_DATABASE_URL'] : []);
  }
});

test('server and worker, filled from what env writes, are a production configuration the server accepts, the runner one the runner accepts, and the backup reads the database as server does', async () => {
  for (const fixture of ['instructor', 'school'] as const) {
    const { compose, site, env, runner } = await written(fixture);
    const { services } = compose('compose.yml');
    for (const name of ['server', 'worker']) {
      // As Compose does: `environment` over the env_file, .parallax/site.env.
      const config = loadConfig({ ...site, ...filled(services[name]?.environment, env) });
      expect(config).toMatchObject({
        NODE_ENV: 'production',
        APP_HOST: site.APP_HOST,
        CONTENT_HOST: site.CONTENT_HOST,
        MAIL_TRANSPORT: 'smtp',
        SMTP_URL: 'smtp://relay.example.org:587',
        SHINY_ORIGINS: fixture === 'school' ? ['https://shiny.example.org'] : [],
        RUNNER_RUNTIMES: fixture === 'school' ? JSON.parse(site.RUNNER_RUNTIMES ?? '') : [],
      });
      expect(config.OIDC_PROVIDERS).toEqual([{ ...PROVIDERS[0], clientSecret: 's3' }]);
    }
    const { DATABASE_URL, PGPASSWORD } = services.server?.environment ?? {};
    const backup = { image: services.postgres?.image, environment: { DATABASE_URL, PGPASSWORD } };
    expect(compose('.parallax/compose.backup.yml').services.backup).toMatchObject(backup);
    if (fixture !== 'school') continue;
    const { runner: service } = compose('compose.runner.yml').services;
    const given = filled(service?.environment, { ...runner, DOCKER_GID: '998' });
    expect(runnerConfig(given).RUNNER_DATABASE_URL).toMatch(/^postgres:\/\/parallax_runner:/);
  }
});
