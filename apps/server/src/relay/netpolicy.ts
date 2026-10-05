import {
  embeddedIpv4,
  ipv4Bytes,
  ipv6Bytes,
  type LinkTarget,
  validateTarget,
} from '@parallax/contracts';

/**
 * The server's early check of where a connection may point (docs/design/connector.md §8): rules
 * 1–2 of §4.4, then the class table of §8 for a *literal* address against the scope the connector
 * reported in `hello`. Public addresses pass; loopback, private and shared ones only when the
 * reported `cidrs` cover them; hard-denied ones never. A host name passes here: the connector
 * resolves it and checks every answer itself, and stays authoritative on every dial.
 */

export type AddressClass = 'hard_denied' | 'loopback' | 'private' | 'global';

export interface NetworkScope {
  cidrs: string[];
  hosts: string[];
}

export type PolicyResult =
  | { ok: true }
  | { ok: false; code: 'invalid_target' | 'network_scope_denied'; host?: string };

interface Address {
  family: 4 | 6;
  bytes: number[];
}

/** A literal address with an embedded IPv4 address unwrapped (§8), or null for a name. */
export function parseAddress(host: string): Address | null {
  const v4 = ipv4Bytes(host);
  if (v4) return { family: 4, bytes: v4 };
  if (!host.includes(':')) return null;
  const v6 = ipv6Bytes(host);
  if (!v6) return null;
  const inner = embeddedIpv4(v6);
  return inner ? { family: 4, bytes: inner } : { family: 6, bytes: v6 };
}

/** Whether the first `bits` bits of `a` and `b` agree. */
function samePrefix(a: number[], b: number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if (((a[byte] ?? 0) & mask) !== ((b[byte] ?? 0) & mask)) return false;
  }
  return true;
}

const v4 = (text: string, bits: number) => ({ net: ipv4Bytes(text) as number[], bits });
const v6 = (text: string, bits: number) => ({ net: ipv6Bytes(text) as number[], bits });

const HARD_DENIED_V4 = [v4('0.0.0.0', 8), v4('224.0.0.0', 4), v4('169.254.0.0', 16)];
const HARD_DENIED_V6 = [v6('::', 128), v6('ff00::', 8), v6('fe80::', 10)];
const LOOPBACK_V4 = [v4('127.0.0.0', 8)];
const LOOPBACK_V6 = [v6('::1', 128)];
const PRIVATE_V4 = [
  v4('10.0.0.0', 8),
  v4('172.16.0.0', 12),
  v4('192.168.0.0', 16),
  v4('100.64.0.0', 10),
];
const PRIVATE_V6 = [v6('fc00::', 7)];

const within = (a: Address, nets: { net: number[]; bits: number }[]) =>
  nets.some((n) => samePrefix(a.bytes, n.net, n.bits));

/** The class of §8 a literal address belongs to. */
export function classify(address: Address): AddressClass {
  if (address.family === 4) {
    if (address.bytes.every((b) => b === 255) || within(address, HARD_DENIED_V4)) {
      return 'hard_denied';
    }
    if (within(address, LOOPBACK_V4)) return 'loopback';
    if (within(address, PRIVATE_V4)) return 'private';
    return 'global';
  }
  if (within(address, HARD_DENIED_V6)) return 'hard_denied';
  if (within(address, LOOPBACK_V6)) return 'loopback';
  if (within(address, PRIVATE_V6)) return 'private';
  return 'global';
}

/** A CIDR of the reported scope, or null when it does not parse. */
function parseCidr(cidr: string): { address: Address; bits: number } | null {
  const [host = '', bitsText = ''] = cidr.split('/');
  const bits = Number(bitsText);
  const address = parseAddress(host);
  if (!address || !Number.isInteger(bits) || bits < 0) return null;
  // A v4-mapped CIDR (`::ffff:10.0.0.0/104`) is read as the IPv4 prefix it covers.
  const unwrapped = address.family === 4 && host.includes(':') ? bits - 96 : bits;
  const max = address.family === 4 ? 32 : 128;
  if (unwrapped < 0 || unwrapped > max) return null;
  return { address, bits: unwrapped };
}

/** Whether the connector's reported `cidrs` cover the address. */
export function covered(address: Address, scope: NetworkScope): boolean {
  return scope.cidrs.some((cidr) => {
    const parsed = parseCidr(cidr);
    return (
      parsed !== null &&
      parsed.address.family === address.family &&
      samePrefix(address.bytes, parsed.address.bytes, parsed.bits)
    );
  });
}

/** Whether one host may be dialled by a personal connector reporting `scope` (§8). */
export function hostAllowed(host: string, scope: NetworkScope): boolean {
  const address = parseAddress(host);
  if (!address) return true;
  const kind = classify(address);
  if (kind === 'hard_denied') return false;
  if (kind === 'global') return true;
  return covered(address, scope);
}

/**
 * Checks a saved or requested target against rules 1–2 of §4.4 and the connector's reported
 * scope. `invalid_target` for a host that breaks rule 1 or 2; `network_scope_denied` for a
 * loopback, private or shared literal the scope does not cover.
 */
export function checkTargetPolicy(target: LinkTarget, scope: NetworkScope): PolicyResult {
  const issues = validateTarget({ target }).filter((i) => i.rule === 1 || i.rule === 2);
  if (issues.length > 0) return { ok: false, code: 'invalid_target' };
  if (target.kind !== 'ssh') return { ok: true };
  for (const host of [target.host, ...(target.jump ? [target.jump.host] : [])]) {
    if (!hostAllowed(host, scope)) return { ok: false, code: 'network_scope_denied', host };
  }
  return { ok: true };
}
