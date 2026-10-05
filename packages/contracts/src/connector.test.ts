import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { PAIRING_DEFS, PairRequest, PairResponse, SignedRequest } from './connector';

const V1 = new URL('../../../connector/protocol/v1/', import.meta.url);
const read = (path: string): unknown => JSON.parse(readFileSync(new URL(path, V1), 'utf8'));
const pairingFiles = (dir: string) =>
  readdirSync(new URL(dir, V1)).filter((f) => f.startsWith('pairing-') && f.endsWith('.json'));

/** `pairing-<Def>[-…].json` names the definition it is checked against. */
function defFor(name: string) {
  const def = name.replace(/^pairing-/, '').replace(/(-[^.]*)?\.json$/, '');
  const schema = PAIRING_DEFS[def as keyof typeof PAIRING_DEFS];
  if (!schema) throw new Error(`${name} names no pairing definition`);
  return schema;
}

describe('connector protocol v1 pairing examples', () => {
  test('every pairing definition has an example', () => {
    const named = pairingFiles('examples/').map((f) => f.replace(/^pairing-|\.json$/g, ''));
    expect(named.sort()).toEqual(Object.keys(PAIRING_DEFS).sort());
  });

  test.each(pairingFiles('examples/'))('parses %s', (name) => {
    expect(defFor(name).safeParse(read(`examples/${name}`)).error).toBeUndefined();
  });

  /** The rule each invalid pairing fixture breaks, named by the key the zod issue points at. */
  const invalidKey: Record<string, string> = {
    'pairing-PairRequest-lowercase-code.json': 'code',
  };

  test('every invalid pairing fixture has a named rule', () => {
    expect(pairingFiles('examples/invalid/').sort()).toEqual(Object.keys(invalidKey).sort());
  });

  test.each(Object.entries(invalidKey))('rejects %s on %s', (name, key) => {
    const parsed = defFor(name).safeParse(read(`examples/invalid/${name}`));
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues.map((i) => i.path.at(-1))).toEqual([key]);
  });

  test('strict objects refuse unknown properties', () => {
    const body = read('examples/pairing-SignedRequest.json') as object;
    expect(SignedRequest.safeParse({ ...body, extra: 1 }).success).toBe(false);
  });

  test('a device name holds no control character and at most 60 characters', () => {
    const body = read('examples/pairing-PairRequest.json') as object;
    expect(PairRequest.safeParse({ ...body, name: 'laptop\u0007' }).success).toBe(false);
    expect(PairRequest.safeParse({ ...body, name: 'x'.repeat(61) }).success).toBe(false);
    expect(PairRequest.safeParse({ ...body, name: 'Ünïcode laptop' }).success).toBe(true);
  });
});

describe('connector protocol v1 signing vectors', () => {
  const v = read('vectors/signing.json') as {
    publicKey: string;
    fingerprint: string;
    connectorId: string;
    ts: number;
    poll: { sig: string };
    unpair: { sig: string };
  };

  test('the vector key, fingerprint and signed requests fit the pairing definitions', () => {
    const request = read('examples/pairing-PairRequest.json') as object;
    expect(PairRequest.safeParse({ ...request, publicKey: v.publicKey }).success).toBe(true);
    const response = read('examples/pairing-PairResponse.json') as object;
    expect(PairResponse.safeParse({ ...response, fingerprint: v.fingerprint }).success).toBe(true);
    for (const sig of [v.poll.sig, v.unpair.sig]) {
      expect(SignedRequest.parse({ connectorId: v.connectorId, ts: v.ts, sig })).toBeTruthy();
    }
  });
});
