/**
 * The live-link registry (docs/design/connector.md §10.4). P3-02 ships the interface and an
 * empty registry, so every connector reads as offline; P3-02a replaces it with the real one,
 * which holds one authenticated WebSocket per connector.
 */

/** One connector's live link. */
export interface Link {
  readonly connectorId: string;
  /** Closes the link with a close code of §4.6 (4403 `revoked` after a revocation). */
  close(code: number, reason: string): void;
}

export interface LinkRegistry {
  /** The connector's live link, or nothing when it is offline. */
  get(connectorId: string): Link | undefined;
}

/** No connector holds a link until P3-02a: `online` is false for every one. */
export const emptyLinkRegistry: LinkRegistry = {
  get: () => undefined,
};
