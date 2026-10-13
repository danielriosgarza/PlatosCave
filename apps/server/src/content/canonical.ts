import { createHash } from 'node:crypto';

type Json = Record<string, unknown>;

/** JSON with object keys sorted, so equal content always hashes equally. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Json)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export interface RevisionPayload {
  content: Json;
  objectKeys: string[];
  accessibleAlternative: Json | null;
  provenance: Json | null;
}

/** sha256 over everything a revision stores; equal hash means "unchanged content". */
export const revisionHash = (type: string, p: RevisionPayload): string =>
  createHash('sha256')
    .update(canonical({ type, ...p }))
    .digest('hex');
