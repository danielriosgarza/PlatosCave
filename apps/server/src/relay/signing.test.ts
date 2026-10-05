import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  decodeB64url,
  fingerprintOf,
  linkMessage,
  normaliseOrigin,
  pollMessage,
  unpairMessage,
  verifySignature,
  verifySignedRequest,
} from './signing';

const vectors = JSON.parse(
  readFileSync(
    new URL('../../../../connector/protocol/v1/vectors/signing.json', import.meta.url),
    'utf8',
  ),
) as {
  seed: string;
  publicKey: string;
  fingerprint: string;
  origin: string;
  connectorId: string;
  ts: number;
  nonce: string;
  link: { message: string; sig: string };
  poll: { message: string; sig: string };
  unpair: { message: string; sig: string };
};

/** DER prefix of an Ed25519 PKCS#8 private key; the 32-byte seed follows it. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const privateKey = createPrivateKey({
  key: Buffer.concat([PKCS8_PREFIX, Buffer.from(vectors.seed, 'hex')]),
  format: 'der',
  type: 'pkcs8',
});
const publicKey = decodeB64url(vectors.publicKey, 32) as Buffer;
const { connectorId, ts, origin } = vectors;
const nonce = decodeB64url(vectors.nonce, 32) as Buffer;

const cases = {
  link: (o = origin) => linkMessage(nonce, connectorId, ts, o),
  poll: (o = origin) => pollMessage(connectorId, ts, o),
  unpair: (o = origin) => unpairMessage(connectorId, ts, o),
};

describe('connector signing vectors', () => {
  test('the public key and fingerprint derive from the seed', () => {
    expect(publicKey).toHaveLength(32);
    expect(fingerprintOf(publicKey)).toBe(vectors.fingerprint);
  });

  test.each(Object.keys(cases) as (keyof typeof cases)[])(
    'reproduces the %s message bytes and signature',
    (kind) => {
      const msg = cases[kind]();
      expect(msg.toString('hex')).toBe(vectors[kind].message);
      expect(sign(null, msg, privateKey).toString('base64url')).toBe(vectors[kind].sig);
      expect(verifySignature(msg, publicKey, vectors[kind].sig)).toBe(true);
    },
  );

  test.each(Object.keys(cases) as (keyof typeof cases)[])(
    'rejects a %s signature with a flipped bit',
    (kind) => {
      const raw = decodeB64url(vectors[kind].sig, 64) as Buffer;
      for (const bit of [0, 255, 511]) {
        const flipped = Buffer.from(raw);
        flipped[bit >> 3] = (flipped[bit >> 3] as number) ^ (1 << (bit & 7));
        expect(verifySignature(cases[kind](), publicKey, flipped.toString('base64url'))).toBe(
          false,
        );
      }
      const message = Buffer.from(cases[kind]());
      message[message.length - 1] = (message[message.length - 1] as number) ^ 1;
      expect(verifySignature(message, publicKey, vectors[kind].sig)).toBe(false);
    },
  );

  test.each(Object.keys(cases) as (keyof typeof cases)[])(
    'rejects a %s signature made for another origin',
    (kind) => {
      expect(
        verifySignature(cases[kind]('https://other.example.org'), publicKey, vectors[kind].sig),
      ).toBe(false);
    },
  );

  test('rejects a signature made under another label', () => {
    expect(verifySignature(cases.unpair(), publicKey, vectors.poll.sig)).toBe(false);
    expect(verifySignature(cases.poll(), publicKey, vectors.unpair.sig)).toBe(false);
    expect(verifySignature(cases.poll(), publicKey, vectors.link.sig)).toBe(false);
  });

  test('rejects a signature from another key', () => {
    const other = Buffer.from(publicKey);
    other[0] = (other[0] as number) ^ 1;
    expect(verifySignature(cases.poll(), other, vectors.poll.sig)).toBe(false);
    expect(verifySignature(cases.poll(), publicKey, 'not-a-signature')).toBe(false);
  });
});

describe('signed poll and unpair requests', () => {
  const at = (seconds: number) => new Date(seconds * 1000);
  const body = { connectorId, ts, sig: vectors.poll.sig };

  test('hold within 120 seconds of the server clock, either way', () => {
    for (const offset of [-120, 0, 120]) {
      expect(verifySignedRequest('poll', body, publicKey, origin, at(ts + offset))).toBe(true);
    }
    for (const offset of [-121, 121]) {
      expect(verifySignedRequest('poll', body, publicKey, origin, at(ts + offset))).toBe(false);
    }
  });

  test('are bound to their purpose', () => {
    expect(verifySignedRequest('unpair', body, publicKey, origin, at(ts))).toBe(false);
    const unpair = { ...body, sig: vectors.unpair.sig };
    expect(verifySignedRequest('unpair', unpair, publicKey, origin, at(ts))).toBe(true);
  });
});

describe('origin normalisation', () => {
  test.each([
    ['https://Parallax.Example.org/', 'https://parallax.example.org'],
    ['https://parallax.example.org:443', 'https://parallax.example.org'],
    ['http://localhost:80/x', 'http://localhost'],
    ['http://127.0.0.1:5173', 'http://127.0.0.1:5173'],
  ])('%s signs as %s', (input, want) => {
    expect(normaliseOrigin(input)).toBe(want);
  });
});
