import type { ConnectionTarget } from '@parallax/contracts/routes/connections';
import { describe, expect, test } from 'vitest';
import { hostLabel, offersTarget } from './targets';

const auth = { method: 'agent' as const };
const local: ConnectionTarget = { kind: 'local', workspace: '/home/sam/notebooks' };
const ssh: ConnectionTarget = {
  kind: 'ssh',
  host: 'gpu01.example.org',
  port: 22,
  user: 'sam',
  auth,
  workspace: '/home/sam/parallax',
};
const colab: ConnectionTarget = { kind: 'colab', user: 'sam', auth, workspace: '/content' };

describe('offersTarget (design §4.6, §5.7)', () => {
  test('a colab target goes only to a connector whose hello lists colab', () => {
    expect(offersTarget({ targets: ['local', 'ssh'] }, colab)).toBe(false);
    expect(offersTarget({ targets: ['local', 'ssh', 'colab'] }, colab)).toBe(true);
  });

  test('local and ssh targets are sent whatever the list says', () => {
    for (const targets of [['local', 'ssh'], ['local', 'ssh', 'colab'], ['ssh'], ['local']]) {
      expect(offersTarget({ targets }, local)).toBe(true);
      expect(offersTarget({ targets }, ssh)).toBe(true);
    }
  });
});

describe('hostLabel: where the Files panel says the files are', () => {
  test("the host of an ssh target, and null for the connector's own computer", () => {
    expect(hostLabel(ssh)).toBe('gpu01.example.org');
    expect(hostLabel(local)).toBeNull();
  });

  test('a Colab session is on the Colab runtime, never on this computer', () => {
    const label = hostLabel(colab);
    expect(label).toBe('the Colab runtime');
    expect(label).not.toBeNull();
    expect(label).not.toMatch(/this computer|the account running the connector/i);
  });
});
