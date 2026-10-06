import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@playwright/test';

/*
 * The connector under test runs on the test runner, not in a container (docs/design/connector.md
 * §15): a binary built from connector/, a temporary PARALLAX_CONNECTOR_HOME per test, and
 * --allow-net 127.0.0.0/8 because the fixtures are published on loopback. The compute fixtures
 * (sshd-jupyter and jump) come from `docker compose --profile connector`.
 */

const root = resolve(import.meta.dirname, '../../..');
export const server = 'http://127.0.0.1:3100';
export const fixtureDir =
  process.env.CONNECTOR_FIXTURE_DIR ?? join(root, '.local', 'connector-fixtures');

/** The interpreter of the `local` target: the runner's Python with jupyter-server installed. */
export const localPython = process.env.CONNECTOR_E2E_PYTHON ?? 'python3';

let built: string | undefined;

/** Builds the connector once per run, or uses CONNECTOR_BIN. */
export function connectorBinary(): string {
  if (process.env.CONNECTOR_BIN) return process.env.CONNECTOR_BIN;
  if (built && existsSync(built)) return built;
  const dir = join(root, '.local', 'connector-e2e');
  mkdirSync(dir, { recursive: true });
  const out = join(
    dir,
    process.platform === 'win32' ? 'parallax-connector.exe' : 'parallax-connector',
  );
  execFileSync('go', ['build', '-o', out, './cmd/parallax-connector'], {
    cwd: join(root, 'connector'),
    stdio: 'inherit',
  });
  built = out;
  return out;
}

/** A running connector command: its output so far, and a way to wait for a line. */
export class Run {
  output = '';
  readonly exited: Promise<number | null>;

  constructor(readonly child: ChildProcess) {
    const collect = (chunk: Buffer) => {
      this.output += chunk.toString();
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    this.exited = new Promise((done) => child.once('exit', (code) => done(code)));
  }

  /** Resolves with the first match of `pattern` in the output, or fails with the output. */
  async waitFor(pattern: RegExp, timeoutMs = 30_000): Promise<RegExpMatchArray> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const match = this.output.match(pattern);
      if (match) return match;
      if (this.child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`connector output never matched ${pattern}:\n${this.output}`);
  }

  stop(): void {
    if (this.child.exitCode === null) this.child.kill('SIGTERM');
  }
}

/** One computer's connector: its own state directory, removed with it. */
export class Connector {
  readonly home = mkdtempSync(join(tmpdir(), 'parallax-connector-e2e-'));
  private runs: Run[] = [];
  private bin = connectorBinary();

  private start(args: string[]): Run {
    const run = new Run(
      spawn(this.bin, args, {
        env: { ...process.env, PARALLAX_CONNECTOR_HOME: this.home, SSH_AUTH_SOCK: '' },
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    this.runs.push(run);
    return run;
  }

  /** `pair`, which prints its fingerprint and then waits for the person to approve it. */
  pair(code: string, name: string): Run {
    return this.start(['pair', '--server', server, '--code', code, '--name', name]);
  }

  /** `run` with the loopback scope the fixtures need. */
  run(...extra: string[]): Run {
    return this.start(['run', '--allow-net', '127.0.0.0/8', ...extra]);
  }

  /** Stops every process (the connector stops the sessions it owns on SIGTERM) and removes the state directory. */
  async dispose(): Promise<void> {
    for (const r of this.runs) r.stop();
    await Promise.race([
      Promise.all(this.runs.map((r) => r.exited)),
      new Promise((done) => setTimeout(done, 20_000)),
    ]);
    for (const r of this.runs) if (r.child.exitCode === null) r.child.kill('SIGKILL');
    rmSync(this.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

/** Reads the pairing code out of the line Parallax shows after "Pair a computer". */
export function codeFrom(text: string): string {
  const match = text.match(/--code ([0-9A-Z]{4}-[0-9A-Z]{4})/);
  if (!match?.[1]) throw new Error(`no pairing code in: ${text}`);
  return match[1];
}

/** Every pid at or below `pid`. */
function family(pid: number): number[] {
  const parents = new Map<number, number>();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      // pid (comm) state ppid …; comm may contain spaces and parentheses.
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parents.set(Number(entry), Number(fields[1]));
    } catch {
      // The process ended while listing.
    }
  }
  const found = [pid];
  for (let i = 0; i < found.length; i++) {
    for (const [child, parent] of parents)
      if (parent === found[i] && !found.includes(child)) found.push(child);
  }
  return found;
}

/**
 * The local addresses the connector and the processes it started listen on (Linux). A27 asserts
 * every one is loopback: the connector opens no door to this computer.
 */
export function listeningAddresses(pid: number): string[] {
  const inodes = new Set<string>();
  for (const p of family(pid)) {
    try {
      for (const fd of readdirSync(`/proc/${p}/fd`)) {
        const link = readlinkSync(`/proc/${p}/fd/${fd}`);
        const m = link.match(/^socket:\[(\d+)\]$/);
        if (m?.[1]) inodes.add(m[1]);
      }
    } catch {
      // Not ours to read, or gone.
    }
  }
  const addresses: string[] = [];
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!existsSync(table)) continue;
    for (const line of readFileSync(table, 'utf8').split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      const local = cols[1];
      const state = cols[3];
      const inode = cols[9];
      if (state === '0A' && inode && inodes.has(inode) && local) addresses.push(hex(local));
    }
  }
  return addresses;
}

/** `0100007F:1F90` → `127.0.0.1:8080`; IPv6 addresses stay hexadecimal. */
function hex(local: string): string {
  const [addr = '', port = ''] = local.split(':');
  const portNumber = Number.parseInt(port, 16);
  if (addr.length === 8) {
    const bytes = addr.match(/../g)?.map((b) => Number.parseInt(b, 16)) ?? [];
    return `${bytes.reverse().join('.')}:${portNumber}`;
  }
  return `${addr}:${portNumber}`;
}

export function isLoopback(address: string): boolean {
  return address.startsWith('127.') || address.startsWith('00000000000000000000000001000000:');
}

export function expectLoopbackOnly(pid: number): void {
  if (process.platform !== 'linux') return;
  const addresses = listeningAddresses(pid);
  expect(addresses.length, 'the connector and its Jupyter listen somewhere').toBeGreaterThan(0);
  expect(addresses.filter((a) => !isLoopback(a))).toEqual([]);
}

/** The fixtures' endpoints (infra/compose.yml, profile connector), all on loopback. */
export const fixtures = { direct: 2222, noForwarding: 2223, rotating: 2224, jump: 2225 } as const;
export const fixtureKey = join(fixtureDir, 'id_ed25519');
export const onwardName = 'sshd-jupyter';
export const studentWorkspace = '/home/student/work';

const compose = ['compose', '-f', join(root, 'infra', 'compose.yml'), '--profile', 'connector'];

/** The host ports the fixtures publish; A28 asserts no Jupyter port is among them. */
export function publishedPorts(): number[] {
  // A local sshd without containers (CONNECTOR_FIXTURE_NO_DOCKER=1) shares this computer's network.
  if (process.env.CONNECTOR_FIXTURE_NO_DOCKER) return [];
  const out = execFileSync('docker', [...compose, 'ps', '--format', 'json'], { encoding: 'utf8' });
  const ports = new Set<number>();
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const rows = JSON.parse(line) as
      | { Publishers?: { PublishedPort: number }[] }
      | { Publishers?: { PublishedPort: number }[] }[];
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      for (const p of row.Publishers ?? []) if (p.PublishedPort) ports.add(p.PublishedPort);
    }
  }
  return [...ports].sort((a, b) => a - b);
}

/** Replaces the host key of the rotating sshd (port 2224), as a rebuilt host would. */
export function rotateHostKey(): void {
  const custom = process.env.CONNECTOR_FIXTURE_ROTATE_CMD;
  if (custom) {
    execFileSync('sh', ['-c', custom], { stdio: 'inherit' });
    return;
  }
  execFileSync('docker', [...compose, 'exec', '-T', 'sshd-jupyter', 'rotate-host-key'], {
    stdio: 'inherit',
  });
}

/** The connector's own known_hosts text, empty before the first trust. */
export function knownHosts(connector: Connector): string {
  const path = join(connector.home, 'known_hosts');
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
