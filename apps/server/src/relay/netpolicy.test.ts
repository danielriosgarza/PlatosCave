import type { LinkTarget } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import { checkTargetPolicy, classify, hostAllowed, parseAddress } from './netpolicy';

const none = { cidrs: [], hosts: [] };
const lab = { cidrs: ['10.20.0.0/16', '127.0.0.0/8', 'fd00:1::/32'], hosts: [] };

const ssh = (host: string, jump?: string): LinkTarget => ({
  kind: 'ssh',
  host,
  port: 22,
  user: 'sam',
  auth: { method: 'agent' },
  workspace: '/home/sam/parallax',
  ...(jump && { jump: { host: jump, port: 22, user: 'sam' } }),
});

describe('address classes of docs/design/connector.md §8', () => {
  test.each([
    ['0.0.0.0', 'hard_denied'],
    ['0.1.2.3', 'hard_denied'],
    ['224.0.0.1', 'hard_denied'],
    ['239.255.255.250', 'hard_denied'],
    ['255.255.255.255', 'hard_denied'],
    ['169.254.169.254', 'hard_denied'],
    ['::', 'hard_denied'],
    ['ff02::1', 'hard_denied'],
    ['fe80::1', 'hard_denied'],
    ['::ffff:169.254.169.254', 'hard_denied'],
    ['64:ff9b::a9fe:a9fe', 'hard_denied'],
    ['2002:a9fe:a9fe::1', 'hard_denied'],
    ['127.0.0.1', 'loopback'],
    ['127.1.2.3', 'loopback'],
    ['::1', 'loopback'],
    ['::ffff:127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['172.31.255.255', 'private'],
    ['192.168.1.1', 'private'],
    ['100.64.0.1', 'private'],
    ['fd12:3456::1', 'private'],
    ['::ffff:10.0.0.1', 'private'],
    ['172.32.0.1', 'global'],
    ['8.8.8.8', 'global'],
    ['2001:db8::1', 'global'],
  ])('%s is %s', (host, kind) => {
    const address = parseAddress(host);
    expect(address).not.toBeNull();
    expect(classify(address as NonNullable<typeof address>)).toBe(kind);
  });

  test('a host name is not classified here: the connector resolves it', () => {
    expect(parseAddress('login.cluster.example.org')).toBeNull();
    expect(hostAllowed('login.cluster.example.org', none)).toBe(true);
  });
});

describe('the reported scope', () => {
  test('public addresses pass without any scope', () => {
    expect(hostAllowed('8.8.8.8', none)).toBe(true);
    expect(hostAllowed('2001:db8::1', none)).toBe(true);
  });

  test('loopback, private and shared addresses need a covering cidr', () => {
    for (const host of ['127.0.0.1', '10.20.3.4', '192.168.1.1', '100.64.0.1', '::1']) {
      expect(hostAllowed(host, none), host).toBe(false);
    }
    expect(hostAllowed('10.20.3.4', lab)).toBe(true);
    expect(hostAllowed('10.21.3.4', lab)).toBe(false);
    expect(hostAllowed('127.0.0.1', lab)).toBe(true);
    expect(hostAllowed('fd00:1:2::5', lab)).toBe(true);
    expect(hostAllowed('fd00:2::5', lab)).toBe(false);
    expect(hostAllowed('::ffff:10.20.0.9', lab)).toBe(true);
  });

  test('hard-denied addresses are refused whatever the scope covers', () => {
    const everything = { cidrs: ['0.0.0.0/0', '::/0'], hosts: [] };
    for (const host of ['169.254.169.254', '0.0.0.0', 'fe80::1', '224.0.0.1', '::']) {
      expect(hostAllowed(host, everything), host).toBe(false);
    }
    expect(hostAllowed('10.0.0.1', everything)).toBe(true);
  });

  test('a malformed reported cidr covers nothing', () => {
    expect(hostAllowed('10.0.0.1', { cidrs: ['10.0.0.0/40', 'nonsense'], hosts: [] })).toBe(false);
  });
});

describe('A33 a forbidden destination is refused before anything is sent', () => {
  test('rules 1 and 2 of §4.4 are invalid_target', () => {
    for (const host of ['2852039166', '0x7f000001', '127.1', '169.254.169.254', 'fe80::1']) {
      expect(checkTargetPolicy(ssh(host), lab), host).toEqual({
        ok: false,
        code: 'invalid_target',
      });
    }
  });

  test('the target and the jump host are both checked against the scope', () => {
    expect(checkTargetPolicy(ssh('10.20.0.5'), none)).toEqual({
      ok: false,
      code: 'network_scope_denied',
      host: '10.20.0.5',
    });
    expect(checkTargetPolicy(ssh('login.example.org', '192.168.0.2'), lab)).toEqual({
      ok: false,
      code: 'network_scope_denied',
      host: '192.168.0.2',
    });
    expect(checkTargetPolicy(ssh('10.20.0.5', 'bastion.example.org'), lab)).toEqual({ ok: true });
  });

  test('a local target dials nothing', () => {
    expect(checkTargetPolicy({ kind: 'local', workspace: '/home/sam' }, none)).toEqual({
      ok: true,
    });
  });
});
