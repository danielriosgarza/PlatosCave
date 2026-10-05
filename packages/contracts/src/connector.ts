import { z } from 'zod';

/**
 * Connector protocol v1, pairing half: the zod mirror of the definitions in
 * `connector/protocol/v1/pairing.schema.json`, the bodies of the public endpoints under
 * `/api/connector/v1` (docs/design/connector.md §3, §4.2). `connector.test.ts` holds it to the
 * fixtures under `connector/protocol/v1/examples/`. The link half (`LinkServerMessage`,
 * `LinkConnectorMessage`, `validateTarget`, `ERROR_CODES`) follows in P3-02a.
 */

/** Lower-case UUID. */
export const ConnectorUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
/** 32 bytes, base64url without padding (an Ed25519 public key). */
export const B64url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** 64 bytes, base64url without padding (an Ed25519 signature). */
export const B64url64 = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
/** `SHA256:` and the unpadded base64 of the SHA-256 of the raw public key (§3). */
export const ConnectorFingerprint = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/);
export const Semver = z
  .string()
  .max(32)
  .regex(/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/);
export const UnixSeconds = z.number().int().min(0).max(4102444800);
/** RFC 3339, UTC, with the Z suffix. */
export const UtcTimestamp = z
  .string()
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?Z$/);
export const ConnectorOs = z.enum(['linux', 'darwin', 'windows']);
export const ConnectorArch = z.enum(['amd64', 'arm64']);

/** No C0 control character and no DEL, as the schema's `^[^\x00-\x1f\x7f]+$`. */
const hasNoControl = (s: string) =>
  [...s].every((c) => {
    const code = c.codePointAt(0) ?? 0;
    return code > 0x1f && code !== 0x7f;
  });

/** A device name: 1 to 60 characters without control characters. */
export const ConnectorName = z
  .string()
  .min(1)
  .max(60)
  .refine(hasNoControl, { message: 'control characters are not allowed' });

/** Crockford base 32 without `I L O U`: what a normalised pairing code may hold. */
export const PAIRING_CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

/** Body of `POST /api/connector/v1/pair`. */
export const PairRequest = z.strictObject({
  code: z.string().regex(PAIRING_CODE_PATTERN),
  publicKey: B64url32,
  name: ConnectorName,
  os: ConnectorOs,
  arch: ConnectorArch,
  version: Semver,
});
export type PairRequest = z.infer<typeof PairRequest>;

/** Answer 201 of `POST /api/connector/v1/pair`. */
export const PairResponse = z.strictObject({
  connectorId: ConnectorUuid,
  fingerprint: ConnectorFingerprint,
  status: z.literal('pending'),
  pollAfterSeconds: z.number().int().min(1).max(60),
  approveBy: UtcTimestamp,
});
export type PairResponse = z.infer<typeof PairResponse>;

/** Body of `POST /api/connector/v1/pair/poll` and `POST /api/connector/v1/unpair`. */
export const SignedRequest = z.strictObject({
  connectorId: ConnectorUuid,
  ts: UnixSeconds,
  sig: B64url64,
});
export type SignedRequest = z.infer<typeof SignedRequest>;

export const PollResponse = z.strictObject({
  status: z.enum(['pending', 'active', 'rejected', 'expired']),
  pollAfterSeconds: z.number().int().min(1).max(60).optional(),
});
export type PollResponse = z.infer<typeof PollResponse>;

/** Every refusal of the pairing endpoints. */
export const ErrorBody = z.strictObject({ error: z.string().max(200) });
export type ErrorBody = z.infer<typeof ErrorBody>;

/** The pairing definitions by name, as the `pairing-<Def>` fixture prefix selects them. */
export const PAIRING_DEFS = {
  PairRequest,
  PairResponse,
  SignedRequest,
  PollResponse,
  ErrorBody,
} as const;
