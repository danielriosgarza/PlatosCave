import type { Connection, ConnectionTest, Connector, NotebookSession, Stage } from './api';

/** Builders for the connect tests: the shapes of the contracts, with the fields a test varies. */
export const CONNECTOR = '00000000-0000-4000-8000-0000000a0001';
export const CONNECTION = '00000000-0000-4000-8000-0000000b0001';
export const TEST_ID = '00000000-0000-4000-8000-0000000c0001';
export const SESSION = '00000000-0000-4000-8000-0000000d0001';
export const REVISION = '00000000-0000-4000-8000-000000000701';
export const FP_A = 'SHA256:nThbg6kXUpJWGl7E1IGOCspRomTxdCARLviKw6E5SY8';
export const FP_B = 'SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s';

export const connector = (over: Partial<Connector> = {}): Connector => ({
  id: CONNECTOR,
  name: 'Laptop',
  os: 'linux',
  arch: 'amd64',
  version: '0.1.0',
  fingerprint: 'SHA256:AbCdEf0123456789AbCdEf0123456789AbCdEf01234',
  status: 'active',
  mode: 'personal',
  online: true,
  lastSeenAt: '2026-10-05T09:00:00Z',
  createdAt: '2026-10-04T09:00:00Z',
  approveBy: null,
  networkScope: { cidrs: [], hosts: [] },
  ...over,
});

export const sshConnection = (over: Partial<Connection> = {}): Connection => ({
  id: CONNECTION,
  name: 'Cluster',
  connectorId: CONNECTOR,
  target: {
    kind: 'ssh',
    host: 'node1.lab.example.org',
    port: 22,
    user: 'sam',
    auth: { method: 'key', keyPath: '~/.ssh/id_ed25519' },
    workspace: '/home/sam/parallax',
  },
  runtime: { mode: 'start', kernelName: 'python3' },
  templateId: null,
  trustedHostKeys: [],
  createdAt: '2026-10-04T09:00:00Z',
  updatedAt: '2026-10-04T09:00:00Z',
  archivedAt: null,
  ...over,
});

export const localConnection = (over: Partial<Connection> = {}): Connection => ({
  ...sshConnection(),
  name: 'My laptop',
  target: { kind: 'local', workspace: '/home/sam/notebooks' },
  ...over,
});

export const ok = (name: Stage['name'], data?: Stage['data']): Stage => ({
  name,
  status: 'ok',
  ...(data ? { data } : {}),
});

export const stage = (s: Stage): Stage => s;

export const testView = (over: Partial<ConnectionTest> = {}): ConnectionTest => ({
  testId: TEST_ID,
  state: 'done',
  stages: [],
  ...over,
});

export const session = (over: Partial<NotebookSession> = {}): NotebookSession => ({
  id: SESSION,
  connectionId: CONNECTION,
  connectorId: CONNECTOR,
  resourceRevisionId: REVISION,
  state: 'ready',
  cause: null,
  owned: true,
  runtime: { mode: 'start', kernelName: 'python3' },
  environment: null,
  jupyterVersion: '2.14.0',
  lease: { idleTimeoutMin: 30, gracePeriodMin: 5 },
  leaseExpiresAt: null,
  kernelName: 'python3',
  lastHeartbeatAt: '2026-10-05T09:00:00Z',
  createdAt: '2026-10-05T09:00:00Z',
  stoppedAt: null,
  ...over,
});
