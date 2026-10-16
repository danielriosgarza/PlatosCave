import type { ConnectionTarget } from '@parallax/contracts/routes/connections';

/**
 * Target kinds on the relay (docs/design/connector.md §4.6, §5.7). A `colab` target is a
 * compatible extension of protocol v1: a connector that does not list it in its live `hello`
 * (connector-v0.1.0 among them) would close the link over it, so it is never sent one.
 */

/** Whether the connector whose `hello` this is can be sent `target`. */
export const offersTarget = (hello: { targets: readonly string[] }, target: { kind: string }) =>
  target.kind !== 'colab' || hello.targets.includes('colab');

/**
 * Where a session's files are, for the Files panel: the SSH host, the Colab runtime, or null for
 * the connector's own computer, which the panel calls "this computer".
 */
export function hostLabel(target: ConnectionTarget): string | null {
  if (target.kind === 'ssh') return target.host;
  return target.kind === 'colab' ? 'the Colab runtime' : null;
}
