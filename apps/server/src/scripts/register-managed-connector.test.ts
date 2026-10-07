import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { parseCommandLine, parsePublicKey, UsageError } from './register-managed-connector';

const ed25519 = () => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return { raw, pem: publicKey.export({ format: 'pem', type: 'spki' }) as string };
};

// A fixed key, so no test depends on chance. This one starts with "-" (raw bytes 0xfb 0xff …).
const DASH_KEY = '-_8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const KEY = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA';

describe('connectors:register-managed command line', () => {
  test('accepts a key that starts with "-" in both the space and the = form', () => {
    expect(DASH_KEY).toHaveLength(43);
    const raw = parsePublicKey(DASH_KEY);
    expect(raw[0]).toBe(0xfb);
    expect(parseCommandLine(['--name', 'HPC', '--public-key', DASH_KEY]).publicKey).toEqual(raw);
    expect(parseCommandLine(['--public-key', DASH_KEY, '--name', 'HPC']).publicKey).toEqual(raw);
    expect(parseCommandLine(['--name', 'HPC', `--public-key=${DASH_KEY}`]).publicKey).toEqual(raw);
    expect(() => parseCommandLine(['--name', 'HPC', '--public-key'])).toThrow(UsageError);
  });

  test('accepts the key as unpadded base64url or as the PEM openssl prints', () => {
    const key = ed25519();
    expect(parsePublicKey(key.raw.toString('base64url'))).toEqual(key.raw);
    expect(parsePublicKey(key.pem)).toEqual(key.raw);
    expect(parsePublicKey(`\n${key.pem}\n`)).toEqual(key.raw);
  });

  test('refuses anything that is not one Ed25519 public key', () => {
    const { publicKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    for (const bad of [
      '',
      'not-a-key',
      Buffer.alloc(31).toString('base64url'),
      `${Buffer.alloc(32).toString('base64url')}=`,
      Buffer.alloc(32).toString('base64'),
      rsa.export({ format: 'pem', type: 'spki' }) as string,
      '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----',
    ]) {
      expect(() => parsePublicKey(bad), bad).toThrow(UsageError);
    }
  });

  test('needs a name of 1–60 characters and a key, and nothing else', () => {
    const key = KEY;
    expect(parseCommandLine(['--name', ' HPC login ', '--public-key', key]).name).toBe('HPC login');
    for (const argv of [
      ['--public-key', key],
      ['--name', 'HPC'],
      ['--name', '', '--public-key', key],
      ['--name', 'x'.repeat(61), '--public-key', key],
      ['--name', 'bad\u0007name', '--public-key', key],
      ['--name', 'HPC', '--public-key', key, '--owner', 'someone'],
      ['--name', 'HPC', '--public-key', key, 'extra'],
    ]) {
      expect(() => parseCommandLine(argv), argv.join(' ')).toThrow(UsageError);
    }
  });
});
