import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUNNER_STOP_DRAIN_SECONDS } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../config';

/**
 * The installation files of the site templates (docs/design/site.md §9 and §11), which the create
 * command copies into every site: these tests hold the properties the design relies on, from the
 * files alone, so they need no Docker.
 */
const dir = resolve(
  import.meta.dirname,
  '../../../../packages/create-parallax-site/templates/shared',
);
const files = ['compose.yml', 'compose.level2.yml', 'compose.runner.yml', 'Caddyfile'] as const;
const text = Object.fromEntries(files.map((f) => [f, readFileSync(resolve(dir, f), 'utf8')]));
type Service = {
  image?: string;
  command?: string[];
  ports?: string[];
  environment?: Record<string, string>;
  env_file?: string[];
  networks?: string[] | Record<string, { ipv4_address?: string } | null>;
  volumes?: string[];
  depends_on?: Record<string, { condition: string; required?: boolean }> | string[];
  [key: string]: unknown;
};
type Compose = {
  services: Record<string, Service>;
  networks?: Record<
    string,
    {
      internal?: boolean;
      driver_opts?: Record<string, string>;
      ipam?: { config: { subnet: string; ip_range?: string }[] };
    }
  >;
};
const load = (file: string) => parse(text[file] ?? '', { merge: true }) as Compose;
const [site, level2, runner] = [
  load('compose.yml'),
  load('compose.level2.yml'),
  load('compose.runner.yml'),
];
const { services } = site;

const networksOf = (s: Service | undefined) =>
  Array.isArray(s?.networks) ? s.networks : Object.keys(s?.networks ?? {});
const onNetwork = (network: string) =>
  Object.entries(services)
    .filter(([, s]) => networksOf(s).includes(network))
    .map(([name]) => name)
    .sort();
/** Every `${NAME…}` of the three compose files, with its operator and what follows it. */
const refs = files
  .filter((f) => f !== 'Caddyfile')
  .flatMap((f) => [...(text[f] ?? '').matchAll(/\$\{([A-Z0-9_]+)(:[?-])?([^}]*)\}/g)])
  .map(([, name = '', op = '', rest = '']) => ({ name, op, rest }));
/** A `${NAME…}` reference as the files write it; most end in the hint to run `parallax env`. */
const ref = (name: string, tail = ':?run parallax env') => `\${${name}${tail}}`;
/** Whether an IPv4 address is in a CIDR range; false for anything that is not one of each. */
const inSubnet = (address: string, cidr: string) => {
  const number = (ip: string) => ip.split('.').reduce((n, part) => n * 256 + Number(part), 0);
  const [base = '', bits = ''] = cidr.split('/');
  const ip = /^\d{1,3}(\.\d{1,3}){3}$/;
  if (!ip.test(address) || !ip.test(base) || !/^\d{1,2}$/.test(bits) || Number(bits) > 32)
    return false;
  const size = 2 ** (32 - Number(bits));
  return Math.floor(number(address) / size) === Math.floor(number(base) / size);
};

describe('the site template installation', () => {
  test('runs caddy, migrate, postgres, server and worker, and nothing but compose.runner.yml holds a runner or the Docker socket', () => {
    expect(Object.keys(services).sort()).toEqual([
      'caddy',
      'migrate',
      'postgres',
      'server',
      'worker',
    ]);
    expect(services.postgres?.profiles).toEqual(['bundled']);
    for (const s of Object.values(services)) expect(s.image).not.toMatch(/runner/);
    for (const f of ['compose.yml', 'compose.level2.yml', 'Caddyfile']) {
      expect(text[f], f).not.toMatch(/docker\.sock|runner\.Dockerfile|RUNNER_IMAGE/);
    }
    expect(text['compose.runner.yml']).toContain('/var/run/docker.sock:/var/run/docker.sock');
  });

  test('exactly one process, in relay mode, serves every path and the compiled site', () => {
    const relays = Object.entries(services).filter(([, s]) => s.command?.at(-1) === 'relay');
    expect(relays.map(([name]) => name)).toEqual(['server']);
    expect(Object.values(services).filter((s) => s.command?.at(-1) === 'api')).toEqual([]);
    expect(services.worker?.command?.at(-1)).toBe('worker');
    expect(services.server?.environment?.STATIC_DIR).toBe('/site');
    expect(services.server?.volumes).toContain('./dist:/site:ro');
    // It listens beyond its own loopback, where Caddy reaches it, and is ready only when it says so.
    const { HOST, PORT } = services.server?.environment ?? {};
    expect([HOST, PORT]).toEqual(['0.0.0.0', '3000']);
    const probe = JSON.stringify(services.server?.healthcheck);
    for (const part of ['/api/ready', 'APP_HOST', 'x-ready-token']) expect(probe).toContain(part);
  });

  test('the server image runs with no capability and no new privilege, and every image is pinned', () => {
    for (const name of ['migrate', 'server', 'worker']) {
      const s = services[name];
      expect([s?.image, s?.cap_drop], name).toEqual([ref('PARALLAX_SERVER_IMAGE'), ['ALL']]);
      expect(s?.security_opt, name).toEqual(['no-new-privileges:true']);
    }
    expect(services.postgres?.image).toMatch(/^postgres:16\.\d+$/);
    expect(services.caddy?.image).toMatch(/^caddy:\d+\.\d+\.\d+$/);
    // Caddy runs as root with only the capability to bind 80 and 443 (owner's decision on #570),
    // so the Caddyfile must be readable by Caddy; P5-23 makes `parallax start` keep it readable.
    const { cap_drop, cap_add, security_opt } = services.caddy ?? {};
    expect([cap_drop, cap_add]).toEqual([['ALL'], ['NET_BIND_SERVICE']]);
    expect(security_opt).toEqual(['no-new-privileges:true']);
  });

  test('only caddy publishes ports', () => {
    const published = Object.entries(services).filter(([, s]) => s.ports?.length);
    expect(published.map(([name]) => name)).toEqual(['caddy']);
    expect(services.caddy?.ports).toEqual(['80:80', '443:443', '443:443/udp']);
  });

  test('migrate, server and worker, which read DATABASE_URL, are on backend and on egress, which is not internal', () => {
    const readers = Object.entries(services).filter(([, s]) => s.environment?.DATABASE_URL);
    expect(readers.map(([name]) => name).sort()).toEqual(['migrate', 'server', 'worker']);
    expect(onNetwork('backend')).toEqual(['migrate', 'postgres', 'server', 'worker']);
    expect(onNetwork('egress')).toEqual(['migrate', 'server', 'worker']);
    expect(networksOf(services.postgres)).toEqual(['backend']);
    expect(site.networks?.backend?.internal).toBe(true);
    expect(site.networks?.egress?.internal).toBeUndefined();
    // parallax env reads this subnet into pg_hba.conf at level 2.
    expect(site.networks?.backend?.ipam?.config[0]?.subnet).toMatch(/^\d+\.\d+\.\d+\.\d+\/\d+$/);
    // An existing PostgreSQL is named in .env; the bundled one is role and database parallax.
    for (const [, s] of readers) {
      const bundled = ':-postgres://parallax@postgres:5432/parallax';
      expect(s.environment?.DATABASE_URL).toBe(ref('DATABASE_URL', bundled));
      expect(s.environment?.PGPASSWORD).toBe(ref('POSTGRES_PASSWORD'));
    }
    expect(services.migrate?.depends_on).toEqual({
      postgres: { condition: 'service_healthy', required: false },
    });
    for (const name of ['server', 'worker']) {
      expect(services[name]?.depends_on).toEqual({
        migrate: { condition: 'service_completed_successfully' },
      });
    }
  });

  test('storage is fs, on one volume that server and worker share', () => {
    const { STORAGE_DRIVER, STORAGE_DIR } = services.server?.environment ?? {};
    expect([STORAGE_DRIVER, STORAGE_DIR]).toEqual(['fs', '/var/lib/parallax/storage']);
    for (const name of ['server', 'worker']) {
      expect(services[name]?.volumes).toContain(`storage:${STORAGE_DIR}`);
    }
    expect(text['compose.yml']).not.toMatch(/S3_|garage/i);
  });

  test('every secret is a required reference and no file holds a literal one', () => {
    const required = ['POSTGRES_PASSWORD', 'SESSION_SECRET', 'CONTENT_TOKEN_SECRET'];
    required.push('READY_PROBE_TOKEN', 'APP_HOST', 'CONTENT_HOST', 'PARALLAX_SERVER_IMAGE');
    required.push('RUNNER_DATABASE_HOST', 'PARALLAX_RUNNER_IMAGE', 'RUNNER_DATABASE_URL');
    for (const name of [...required, 'RUNNER_IMAGES', 'DOCKER_GID']) {
      const uses = refs.filter((r) => r.name === name);
      expect(uses.length, name).toBeGreaterThan(0);
      for (const use of uses) expect(use.op, name).toBe(':?');
    }
    // The defaults: settings, the optional sign-in secrets, and the bundled database's address.
    const defaulted = new Set(refs.filter((r) => r.op !== ':?').map((r) => r.name));
    expect([...defaulted].sort()).toEqual([
      'DATABASE_URL',
      'LOG_LEVEL',
      'OIDC_CLIENT_SECRETS',
      'RUNNER_DOCKER_RUNTIME',
      'RUNNER_SLOTS',
      'SMTP_URL',
    ]);
    // A value that is a secret, or may carry one, is one reference and nothing else.
    for (const compose of [site, level2, runner]) {
      for (const [name, s] of Object.entries(compose.services)) {
        for (const [key, value] of Object.entries(s.environment ?? {})) {
          if (!/PASSWORD|SECRET|TOKEN|_URL$/.test(key)) continue;
          expect(value, `${name}.${key}`).toMatch(/^\$\{[A-Z0-9_]+:[?-][^}$]*\}$/);
        }
      }
    }
    for (const f of files) expect(text[f], f).not.toMatch(/:\/\/[^\s/@]*:[^\s/@]*@/);
  });

  test('server and worker take SMTP_URL and OIDC_CLIENT_SECRETS from .env as optional references, and no file holds a value of either', () => {
    for (const name of ['SMTP_URL', 'OIDC_CLIENT_SECRETS']) {
      const given = Object.entries(services).filter(([, s]) => s.environment?.[name] !== undefined);
      expect(given.map(([service]) => service).sort(), name).toEqual(['server', 'worker']);
      for (const [, s] of given) expect(s.environment?.[name]).toBe(ref(name, ':-'));
      for (const use of refs.filter((r) => r.name === name))
        expect([use.op, use.rest]).toEqual([':-', '']);
      for (const f of files) {
        const lines = (text[f] ?? '')
          .split('\n')
          .filter((l) => l.includes(name) && !/^\s*#/.test(l));
        for (const line of lines) expect(line.trim(), f).toBe(`${name}: ${ref(name, ':-')}`);
      }
    }
    for (const f of files) expect(text[f], f).not.toMatch(/smtps?:\/\/|clientSecret/i);
    // Everything that is not a secret comes from .parallax/site.env, which holds none.
    expect(services.server?.env_file).toEqual(['.parallax/site.env']);
    expect(services.worker?.env_file).toEqual(['.parallax/site.env']);
    for (const name of ['caddy', 'migrate', 'postgres'])
      expect(services[name]?.env_file).toBeUndefined();
  });

  test('Caddyfile has the two host blocks, each to server:3000, and leaves Host as it is', () => {
    const caddyfile = (text.Caddyfile ?? '').replace(/#.*$/gm, '');
    const blocks = [...caddyfile.matchAll(/^(\S[^{\n]*)\{([^}]*)\}/gm)].map(
      ([, site = '', body = '']) => [site.trim(), body.trim().split(/\s+/).join(' ')],
    );
    expect(blocks).toEqual([
      ['{$APP_HOST}', 'reverse_proxy server:3000'],
      ['{$CONTENT_HOST}', 'reverse_proxy server:3000'],
    ]);
    expect(caddyfile).not.toMatch(/header_up/);
    expect(services.caddy?.volumes).toContain('./Caddyfile:/etc/caddy/Caddyfile:ro');
    expect(services.caddy?.environment).toEqual({
      APP_HOST: ref('APP_HOST'),
      CONTENT_HOST: ref('CONTENT_HOST'),
    });
  });

  test("TRUST_PROXY is Caddy's fixed address on edge, where only caddy and server are", () => {
    const { subnet = '', ip_range: range = '' } = site.networks?.edge?.ipam?.config[0] ?? {};
    const caddy = services.caddy?.networks as Record<string, { ipv4_address?: string }> | undefined;
    const address = caddy?.edge?.ipv4_address ?? '';
    expect(networksOf(services.caddy)).toEqual(['edge']);
    expect(onNetwork('edge')).toEqual(['caddy', 'server']);
    expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
    // No other container on edge, a one-off run of the server included, can be given it.
    expect([inSubnet(address, subnet), inSubnet(address, range)]).toEqual([true, false]);
    expect(inSubnet(range.split('/')[0] ?? '', subnet)).toBe(true);
    expect(services.server?.environment?.TRUST_PROXY).toBe(address);
    expect(services.worker?.environment?.TRUST_PROXY).toBe(address);
  });

  test('compose.level2.yml changes only postgres, which it puts on a network that is not internal, so that its port is published on runner.databaseHost', () => {
    expect(Object.keys(level2.services)).toEqual(['postgres']);
    const postgres = level2.services.postgres ?? {};
    expect(Object.keys(postgres).sort()).toEqual(['command', 'networks', 'ports', 'volumes']);
    // The command replaces the image's, whose entrypoint initialises only for `postgres …`.
    expect(postgres.command).toEqual(['postgres', '-c', 'hba_file=/etc/parallax/pg_hba.conf']);
    expect(postgres.volumes).toEqual(['./.parallax/pg_hba.conf:/etc/parallax/pg_hba.conf:ro']);
    expect(postgres.ports).toEqual([`${ref('RUNNER_DATABASE_HOST')}:5432:5432`]);
    // It stays on backend, where the application reaches it, and gains one network of its own.
    const added = networksOf(postgres).filter((n) => n !== 'backend');
    expect(networksOf(postgres)).toContain('backend');
    expect(added).toEqual(Object.keys(level2.networks ?? {}));
    expect(added).toHaveLength(1);
    const [own = ''] = added;
    expect(level2.networks?.[own]?.internal).toBeUndefined();
    expect(site.networks?.[own]).toBeUndefined();
    expect(onNetwork(own)).toEqual([]);
    // On a Linux host Docker masquerades nothing from it, so postgres cannot connect out there.
    const masquerade = 'com.docker.network.bridge.enable_ip_masquerade';
    expect(level2.networks?.[own]?.driver_opts).toEqual({ [masquerade]: 'false' });
  });

  test('compose.runner.yml has the one service runner, only the variables the runner reads, no application secret, and the URL of parallax_runner', () => {
    expect(Object.keys(runner.services)).toEqual(['runner']);
    const service = runner.services.runner ?? {};
    // The keys of RunnerEnv (apps/runner/src/config.ts), which a runner's config test pins exactly.
    const read = ['RUNNER_DATABASE_URL', 'RUNNER_SLOTS', 'RUNNER_IMAGES', 'RUNNER_PULL'];
    read.push('RUNNER_DOCKER_RUNTIME', 'DOCKER_HOST', 'LOG_LEVEL');
    const given = Object.keys(service.environment ?? {});
    expect(given.filter((k) => !read.includes(k))).toEqual([]);
    expect(service.env_file).toBeUndefined();
    const application =
      /SESSION|CONTENT_TOKEN|READY_PROBE|POSTGRES|PGPASS|SMTP|OIDC|\bDATABASE_URL/;
    expect(text['compose.runner.yml']).not.toMatch(application);
    expect(service.environment?.RUNNER_DATABASE_URL).toMatch(
      /^\$\{RUNNER_DATABASE_URL:\?[^}]*parallax_runner[^}]*\}$/,
    );
    expect(service.environment?.RUNNER_PULL).toBe('never');
    expect(service.environment?.RUNNER_DOCKER_RUNTIME).toBe(
      ref('RUNNER_DOCKER_RUNTIME', ':-runsc'),
    );
    expect([service.cap_drop, service.security_opt]).toEqual([['ALL'], ['no-new-privileges:true']]);
    expect(service.group_add).toEqual([expect.stringMatching(/^\$\{DOCKER_GID:\?[^}]*\}$/)]);
    const grace = String(service.stop_grace_period);
    expect(Number.parseInt(grace, 10)).toBeGreaterThan(RUNNER_STOP_DRAIN_SECONDS);
  });

  test('with the values parallax env writes, the server environment is a production configuration the server accepts', () => {
    const env: Record<string, string> = {
      POSTGRES_PASSWORD: 'p'.repeat(64),
      SESSION_SECRET: 's'.repeat(64),
      CONTENT_TOKEN_SECRET: 'c'.repeat(64),
      READY_PROBE_TOKEN: 'r'.repeat(64),
      OIDC_CLIENT_SECRETS: '{"university":"x"}',
    };
    const siteEnv: Record<string, string> = {
      APP_ORIGIN: 'https://stats.example.org',
      APP_HOST: 'stats.example.org',
      CONTENT_ORIGIN: 'https://content.stats.example.org',
      CONTENT_HOST: 'content.stats.example.org',
      MAIL_TRANSPORT: 'none',
      OIDC_PROVIDERS: JSON.stringify([
        {
          id: 'university',
          name: 'Example University',
          issuer: 'https://id.example.org',
          clientId: 'p',
        },
      ]),
      INSTRUCTOR_EMAILS: 'alex@example.org',
    };
    // As Compose does: a default only for `:-`, and a reference that resolves to nothing stops.
    const fill = (raw: string) =>
      raw.replace(/\$\{([A-Z0-9_]+)(:[?-])?([^}]*)\}/g, (_, name: string, op = '', tail = '') => {
        const value = env[name] ?? (op === ':-' ? tail : undefined);
        if (value === undefined) throw new Error(`\${${name}} is not set in the test's .env`);
        return value;
      });
    for (const name of ['server', 'worker']) {
      const given = Object.entries(services[name]?.environment ?? {}).map(([k, v]) => [
        k,
        fill(String(v)),
      ]);
      const config = loadConfig({ HOST: '0.0.0.0', ...siteEnv, ...Object.fromEntries(given) });
      expect(config).toMatchObject({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://parallax@postgres:5432/parallax',
        STORAGE_DRIVER: 'fs',
        MAIL_TRANSPORT: 'none',
        TRUST_PROXY: [services.server?.environment?.TRUST_PROXY],
      });
      expect(config.OIDC_PROVIDERS.map((p) => p.clientSecret)).toEqual(['x']);
    }
  });
});
