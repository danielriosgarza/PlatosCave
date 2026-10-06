import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { z } from 'zod';
import {
  CAUSES,
  ERROR_CODES,
  ipv6Bytes,
  LINK_CLOSE,
  LinkConnectorMessage,
  LinkServerMessage,
  LOSS_CAUSES,
  PAIRING_DEFS,
  PairRequest,
  PairResponse,
  SignedRequest,
  validateTarget,
} from './connector';

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

/** `s2c-` server messages, `c2s-` connector messages, `both-` either (§4 "How the files are used"). */
function linkSchemas(name: string): z.ZodType[] {
  if (name.startsWith('s2c-')) return [LinkServerMessage];
  if (name.startsWith('c2s-')) return [LinkConnectorMessage];
  if (name.startsWith('both-')) return [LinkServerMessage, LinkConnectorMessage];
  throw new Error(`${name} has no link prefix`);
}
const linkFiles = (dir: string) =>
  readdirSync(new URL(dir, V1)).filter((f) => /^(s2c|c2s|both)-.*\.json$/.test(f));
/** The key a zod issue points at: the last path segment, or the unknown key it names. */
const issueKey = (issue: z.core.$ZodIssue) =>
  issue.code === 'unrecognized_keys' ? issue.keys[0] : issue.path.at(-1);

describe('connector protocol v1 link examples', () => {
  test('every example file is checked by the pairing, link or state suite', () => {
    for (const dir of ['examples/', 'examples/invalid/', 'examples/rejected/']) {
      const files = readdirSync(new URL(dir, V1)).filter((f) => f.endsWith('.json'));
      expect(files.filter((f) => !/^(s2c|c2s|both|pairing|state)-/.test(f))).toEqual([]);
    }
  });

  test.each(linkFiles('examples/'))('parses %s', (name) => {
    for (const schema of linkSchemas(name)) {
      expect(schema.safeParse(read(`examples/${name}`)).error).toBeUndefined();
    }
  });

  test.each(linkFiles('examples/'))('%s breaks no semantic target rule', (name) => {
    const message = read(`examples/${name}`) as { target?: unknown };
    if (message.target === undefined) return;
    const parsed = LinkServerMessage.parse(message);
    if (parsed.t !== 'test_connection' && parsed.t !== 'open_session') throw new Error(name);
    expect(validateTarget(parsed)).toEqual([]);
  });

  /** The rule each invalid link fixture breaks (§4.4), named by the key the zod issue points at. */
  const invalidKey: Record<string, string> = {
    'both-error-code-shape.json': 'code',
    'c2s-auth-short-signature.json': 'sig',
    'c2s-hello-unknown-os.json': 'os',
    'c2s-session_state-content-root-dotdot.json': 'contentRoot',
    'c2s-session_state-unknown-state.json': 'state',
    'c2s-test_result-detail-too-long.json': 'detail',
    'c2s-test_result-host_identity-ok-without-hops.json': 'data',
    'c2s-test_result-running-stage.json': 'status',
    's2c-challenge-version-2.json': 'v',
    's2c-http-method-trace.json': 'method',
    's2c-http-path-not-api.json': 'path',
    's2c-http-stream-without-length.json': 'contentLength',
    's2c-open_session-lease-below-bounds.json': 'idleTimeoutMin',
    's2c-open_session-unknown-property.json': 'token',
    's2c-test_connection-password-in-auth.json': 'password',
    's2c-test_connection-user-backslash.json': 'user',
    's2c-test_connection-user-option.json': 'user',
    's2c-window-zero-credit.json': 'credit',
  };

  test('every invalid link fixture has a named rule', () => {
    expect(linkFiles('examples/invalid/').sort()).toEqual(Object.keys(invalidKey).sort());
  });

  test.each(Object.entries(invalidKey))('rejects %s on %s', (name, key) => {
    for (const schema of linkSchemas(name)) {
      const parsed = schema.safeParse(read(`examples/invalid/${name}`));
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.map(issueKey)).toEqual([key]);
    }
  });

  /** The rule of §4.4 each rejected fixture breaks; it passes the schema. */
  const rejectedRule: Record<string, number> = {
    's2c-open_session-login-on-local.json': 5,
    's2c-open_session-python-dotdot.json': 5,
    's2c-test_connection-confirmation-replacing-itself.json': 7,
    's2c-test_connection-host-decimal-ip.json': 1,
    's2c-test_connection-host-hex-ip-upper.json': 1,
    's2c-test_connection-host-hex-ip.json': 1,
    's2c-test_connection-host-link-local-v6.json': 2,
    's2c-test_connection-host-mapped-metadata.json': 2,
    's2c-test_connection-host-metadata-ip.json': 2,
    's2c-test_connection-host-short-ipv4.json': 1,
    's2c-test_connection-hostkeys-duplicate.json': 6,
    's2c-test_connection-jump-is-target.json': 8,
    's2c-test_connection-keypath-relative.json': 4,
    's2c-test_connection-workspace-dotdot.json': 3,
    's2c-test_connection-workspace-relative.json': 3,
  };

  test('every rejected fixture has a named rule', () => {
    expect(linkFiles('examples/rejected/').sort()).toEqual(Object.keys(rejectedRule).sort());
  });

  test.each(Object.entries(rejectedRule))(
    '%s passes the schema and breaks rule %i',
    (name, rule) => {
      const parsed = LinkServerMessage.parse(read(`examples/rejected/${name}`));
      if (parsed.t !== 'test_connection' && parsed.t !== 'open_session') throw new Error(name);
      expect(validateTarget(parsed).map((i) => i.rule)).toEqual([rule]);
    },
  );
});

describe('validateTarget host rules', () => {
  const ssh = (host: string, jump?: string) => ({
    target: {
      kind: 'ssh' as const,
      host,
      port: 22,
      user: 'student',
      auth: { method: 'agent' as const },
      workspace: '/home/student',
      ...(jump && { jump: { host: jump, port: 22, user: 'student' } }),
    },
  });
  const rules = (host: string) => validateTarget(ssh(host)).map((i) => i.rule);

  test.each([
    'gpu01.lab.example.org',
    'localhost',
    '203.0.113.7',
    '127.0.0.1',
    '10.20.0.5',
    '2001:db8::1',
    '::1',
    '::ffff:203.0.113.7',
    'a-b.example',
    'host1',
  ])('accepts %s', (host) => {
    expect(rules(host)).toEqual([]);
  });

  test.each([
    '2852039166',
    '0x7f000001',
    '127.1',
    '127.0.0.01',
    '1.2.3.256',
    '-lead.example',
    'trail-.example',
    'example.org.',
    'a..b',
    'foo.0xab',
    'fe80::1::2',
    '1:2:3:4:5:6:7:8:9',
    '::ffff:1.2.3',
  ])('rule 1 refuses %s', (host) => {
    expect(rules(host)).toEqual([1]);
  });

  test.each([
    '0.0.0.0',
    '0.1.2.3',
    '169.254.169.254',
    '224.0.0.1',
    '239.255.255.250',
    '255.255.255.255',
    '::',
    'ff02::1',
    'fe80::1',
    'febf::1',
    '::ffff:169.254.169.254',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b::169.254.169.254',
    '2002:a9fe:a9fe::1',
    '::ffff:0.0.0.0',
  ])('rule 2 refuses %s', (host) => {
    expect(rules(host)).toEqual([2]);
  });

  test('rule 2 applies to the jump host', () => {
    expect(validateTarget(ssh('gpu01.example.org', '169.254.169.254')).map((i) => i.rule)).toEqual([
      2,
    ]);
  });

  test('IPv6 literals parse to sixteen bytes', () => {
    expect(ipv6Bytes('::1')).toEqual([...Array(15).fill(0), 1]);
    expect(ipv6Bytes('::ffff:1.2.3.4')?.slice(10)).toEqual([0xff, 0xff, 1, 2, 3, 4]);
    expect(ipv6Bytes('1::')).toEqual([0, 1, ...Array(14).fill(0)]);
    expect(ipv6Bytes('fe80::1%eth0')).toBeNull();
  });

  test('a local workspace may be a Windows path; an ssh one may not', () => {
    const local = (workspace: string) =>
      validateTarget({ target: { kind: 'local', workspace } }).map((i) => i.rule);
    expect(local('C:\\Users\\sam\\work')).toEqual([]);
    expect(local('C:/Users/sam/work')).toEqual([]);
    expect(local('C:\\Users\\..\\x')).toEqual([3]);
    const remote = ssh('gpu01.example.org');
    remote.target.workspace = 'C:\\Users\\sam';
    expect(validateTarget(remote).map((i) => i.rule)).toEqual([3]);
  });
});

describe('connector protocol v1 error catalogue', () => {
  const catalogue = read('errors.json') as {
    codes: Record<string, unknown>;
    causes: Record<string, unknown>;
    loss: Record<string, unknown>;
  };

  test('ERROR_CODES equals the keys of errors.json', () => {
    expect([...ERROR_CODES].sort()).toEqual(Object.keys(catalogue.codes).sort());
  });

  test('CAUSES and LOSS_CAUSES equal the cause and loss keys of errors.json', () => {
    expect([...CAUSES].sort()).toEqual(Object.keys(catalogue.causes).sort());
    expect([...LOSS_CAUSES].sort()).toEqual(Object.keys(catalogue.loss).sort());
  });

  test('every session_state cause of the schema is a loss cause of the catalogue', () => {
    const schema = read('link.schema.json') as { $defs: { cause: { enum: string[] } } };
    for (const cause of schema.$defs.cause.enum) expect(LOSS_CAUSES).toContain(cause);
  });

  test('close codes follow §4.6', () => {
    expect(LINK_CLOSE).toMatchObject({
      protocol_error: 4400,
      bad_signature: 4401,
      clock_skew: 4401,
      pending: 4403,
      revoked: 4403,
      mode_mismatch: 4403,
      heartbeat_timeout: 4408,
      replaced: 4409,
      upgrade_required: 4426,
      rate_limited: 4429,
      server_error: 4500,
    });
  });
});
