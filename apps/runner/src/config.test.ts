import { describe, expect, test } from 'vitest';
import { loadConfig, RunnerEnv } from './config';

const minimal = {
  RUNNER_DATABASE_URL: 'postgres://parallax_runner@db/parallax',
  RUNNER_IMAGES: '{"python-3.12":["parallax-runner-python:dev"]}',
};

describe('runner configuration', () => {
  test('the schema has exactly the keys of design §7.1', () => {
    expect(Object.keys(RunnerEnv.shape).sort()).toEqual(
      [
        'DOCKER_HOST',
        'LOG_LEVEL',
        'RUNNER_DATABASE_URL',
        'RUNNER_DOCKER_RUNTIME',
        'RUNNER_IMAGES',
        'RUNNER_PULL',
        'RUNNER_SLOTS',
      ].sort(),
    );
  });

  test('defaults and parsed images', () => {
    expect(loadConfig(minimal)).toEqual({
      RUNNER_DATABASE_URL: minimal.RUNNER_DATABASE_URL,
      RUNNER_SLOTS: 4,
      RUNNER_IMAGES: { 'python-3.12': ['parallax-runner-python:dev'] },
      RUNNER_PULL: 'never',
      LOG_LEVEL: 'info',
    });
  });

  test('application secrets in the environment are not read', () => {
    const config = loadConfig({
      ...minimal,
      DATABASE_URL: 'postgres://app@db/parallax',
      SESSION_SECRET: 'x'.repeat(40),
      S3_SECRET_ACCESS_KEY: 'secret',
    });
    expect(Object.keys(config)).not.toContain('DATABASE_URL');
    expect(JSON.stringify(config)).not.toContain('secret');
  });

  test('RUNNER_DATABASE_URL and RUNNER_IMAGES are required', () => {
    expect(() => loadConfig({ RUNNER_IMAGES: minimal.RUNNER_IMAGES })).toThrow(
      /RUNNER_DATABASE_URL/,
    );
    expect(() => loadConfig({ RUNNER_DATABASE_URL: minimal.RUNNER_DATABASE_URL })).toThrow(
      /RUNNER_IMAGES/,
    );
  });

  test('slots are 1 to 32', () => {
    expect(() => loadConfig({ ...minimal, RUNNER_SLOTS: '0' })).toThrow(/RUNNER_SLOTS/);
    expect(() => loadConfig({ ...minimal, RUNNER_SLOTS: '33' })).toThrow(/RUNNER_SLOTS/);
    expect(loadConfig({ ...minimal, RUNNER_SLOTS: '32' }).RUNNER_SLOTS).toBe(32);
  });

  test('images must be JSON naming runtimes with at least one reference', () => {
    expect(() => loadConfig({ ...minimal, RUNNER_IMAGES: 'nope' })).toThrow(/not JSON/);
    expect(() => loadConfig({ ...minimal, RUNNER_IMAGES: '{"python-3.12":[]}' })).toThrow();
    expect(() => loadConfig({ ...minimal, RUNNER_IMAGES: '{"java-21":["x"]}' })).toThrow();
  });

  test('pull policy is never or missing', () => {
    expect(loadConfig({ ...minimal, RUNNER_PULL: 'missing' }).RUNNER_PULL).toBe('missing');
    expect(() => loadConfig({ ...minimal, RUNNER_PULL: 'always' })).toThrow(/RUNNER_PULL/);
  });
});
