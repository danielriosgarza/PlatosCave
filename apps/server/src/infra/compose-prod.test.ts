import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { parse } from 'yaml';
import { loadConfig } from '../config';

/**
 * infra/compose.prod.yml is the production-like layout the runbook describes (spec §17,
 * docs/design/runner.md §10.1): these tests hold the properties the runbook relies on, and that
 * its environment is a configuration the server accepts.
 */
const file = resolve(import.meta.dirname, '../../../../infra/compose.prod.yml');
const text = readFileSync(file, 'utf8');
const compose = parse(text, { merge: true }) as {
  services: Record<
    string,
    {
      networks?: string[];
      ports?: string[];
      environment?: Record<string, string>;
      command?: string[];
      stop_grace_period?: string;
      volumes?: string[];
      profiles?: string[];
    }
  >;
  networks: Record<string, { internal?: boolean }>;
  'x-server-env': Record<string, string>;
};
const services = compose.services;

const onNetwork = (network: string) =>
  Object.entries(services)
    .filter(([, s]) => s.networks?.includes(network))
    .map(([name]) => name)
    .sort();

describe('compose.prod.yml', () => {
  test('runs api, relay, worker, runner, Postgres and Garage, and a managed connector on request', () => {
    expect(Object.keys(services).sort()).toEqual([
      'api',
      'connector-managed',
      'garage',
      'migrate',
      'postgres',
      'relay',
      'runner',
      'worker',
    ]);
    expect(services['connector-managed']?.profiles).toEqual(['managed']);
  });

  test('the runner shares a network with Postgres only, and that network has no route out', () => {
    expect(onNetwork('runner-db')).toEqual(['postgres', 'runner']);
    expect(services.runner?.networks).toEqual(['runner-db']);
    expect(compose.networks['runner-db']?.internal).toBe(true);
    expect(compose.networks.backend?.internal).toBe(true);
  });

  test('the managed connector reaches neither Postgres nor Garage', () => {
    expect(services['connector-managed']?.networks).toEqual(['managed']);
    expect(onNetwork('managed')).toEqual(['connector-managed']);
  });

  test('only api and relay publish a port, on the loopback address for the reverse proxy', () => {
    const published = Object.entries(services)
      .filter(([, s]) => s.ports?.length)
      .map(([name]) => name)
      .sort();
    expect(published).toEqual(['api', 'relay']);
    for (const name of published) {
      for (const port of services[name]?.ports ?? []) expect(port).toMatch(/^127\.0\.0\.1:/);
    }
  });

  test('exactly one relay, because connector links live in its memory', () => {
    const relays = Object.values(services).filter((s) => s.command?.at(-1) === 'relay');
    expect(relays).toHaveLength(1);
    expect(services.api?.command?.at(-1)).toBe('api');
    expect(services.worker?.command?.at(-1)).toBe('worker');
  });

  test('the worker may drain for the 8 s main.ts waits, so its stop grace is at least 10 s', () => {
    expect(services.worker?.stop_grace_period).toBe('10s');
  });

  test('the runner is given exactly the variables it reads and no application secret', () => {
    const given = Object.keys(services.runner?.environment ?? {});
    // The keys of RunnerEnv (apps/runner/src/config.ts), which a runner's config test pins exactly.
    const read = [
      'RUNNER_DATABASE_URL',
      'RUNNER_SLOTS',
      'RUNNER_IMAGES',
      'RUNNER_PULL',
      'RUNNER_DOCKER_RUNTIME',
      'DOCKER_HOST',
      'LOG_LEVEL',
    ];
    expect(given.filter((k) => !read.includes(k))).toEqual([]);
    for (const secret of [
      'SESSION_SECRET',
      'CONTENT_TOKEN_SECRET',
      'S3_SECRET_ACCESS_KEY',
      'SMTP_URL',
    ]) {
      expect(given).not.toContain(secret);
    }
    expect(services.runner?.environment?.RUNNER_PULL).toBe('never');
  });

  test('no secret or address has a default: each is required by `:?`', () => {
    for (const name of [
      'POSTGRES_PASSWORD',
      'RUNNER_DB_PASSWORD',
      'SESSION_SECRET',
      'CONTENT_TOKEN_SECRET',
      'S3_ACCESS_KEY_ID',
      'S3_SECRET_ACCESS_KEY',
      'SMTP_URL',
      'APP_ORIGIN',
      'CONTENT_ORIGIN',
      'TRUST_PROXY',
      'RUNNER_RUNTIMES',
      'RUNNER_IMAGES',
    ]) {
      const uses = [...text.matchAll(new RegExp(`\\$\\{${name}([:?-][^}]*)?\\}`, 'g'))];
      expect(uses.length, name).toBeGreaterThan(0);
      for (const use of uses) expect(use[1], name).toMatch(/^:\?/);
    }
  });

  test('its server environment is a production configuration the server accepts', () => {
    const values: Record<string, string> = {
      POSTGRES_PASSWORD: 'p',
      APP_ORIGIN: 'https://parallax.example.org',
      APP_HOST: 'parallax.example.org',
      CONTENT_ORIGIN: 'https://content.parallax.example.org',
      CONTENT_HOST: 'content.parallax.example.org',
      SESSION_SECRET: 's'.repeat(40),
      CONTENT_TOKEN_SECRET: 'c'.repeat(40),
      TRUST_PROXY: '172.16.0.0/12',
      S3_ACCESS_KEY_ID: 'GK0123456789abcdef01234567',
      S3_SECRET_ACCESS_KEY: 'k'.repeat(64),
      SMTP_URL: 'smtp://mail:pw@mail.example.org:587',
      MAIL_FROM: 'Parallax <login@example.org>',
      RUNNER_RUNTIMES: JSON.stringify([
        {
          id: 'python-3.12',
          language: 'python',
          image: 'registry.example.org/parallax-runner-python',
          digest: `sha256:${'a'.repeat(64)}`,
          harnessVersion: '1',
          packages: ['numpy'],
        },
      ]),
    };
    const env: Record<string, string> = {};
    for (const [key, raw] of Object.entries(compose['x-server-env'])) {
      env[key] = String(raw).replace(
        /\$\{([A-Z0-9_]+)(?::[?-]([^}]*))?\}/g,
        (_, name: string, fallback?: string) =>
          values[name] ?? (text.includes(`\${${name}:-`) ? (fallback ?? '') : ''),
      );
    }
    env.HOST = '0.0.0.0';
    const config = loadConfig(env);
    expect(config).toMatchObject({
      NODE_ENV: 'production',
      STORAGE_DRIVER: 's3',
      MAIL_TRANSPORT: 'smtp',
      SESSION_TTL_DAYS: 14,
      RUN_RATE_LIMIT: 30,
      LEASE_IDLE_MINUTES: 30,
      LEASE_GRACE_MINUTES: 5,
    });
  });
});
