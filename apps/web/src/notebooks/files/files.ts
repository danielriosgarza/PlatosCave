import {
  MAX_COPY_OUT_FILE_BYTES,
  MAX_COPY_OUT_SESSION_BYTES,
  type TransferView,
} from '@parallax/contracts/routes/transfers';
import { ApiError } from '../../api/client';
import { downloadText } from '../../format/format';

export type { TransferView };
export { MAX_COPY_OUT_FILE_BYTES, MAX_COPY_OUT_SESSION_BYTES };

/** The computer the workspace is on, as the destination sentences name it. */
export const where = (host: string | null) => (host ? host : 'this computer');

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `results.csv` → `results (parallax).csv`, the name "save mine as a copy" writes (design §11). */
export function copyName(path: string): string {
  const slash = path.lastIndexOf('/');
  const dir = path.slice(0, slash + 1);
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0
    ? `${dir}${name.slice(0, dot)} (parallax)${name.slice(dot)}`
    : `${dir}${name} (parallax)`;
}

const refusals: Record<string, string> = {
  not_ready: 'The session is not ready, so the computer’s files cannot be reached now.',
  connector_offline: 'The connector is offline. Nothing was changed on the computer.',
  workspace_unknown: 'This session’s workspace cannot be located, so files cannot be transferred.',
  transfer_failed: 'The computer refused the transfer. Nothing was written.',
  class_archived: 'This class is archived and no longer accepts changes.',
};

/** Why a request was refused, in words that name what did and did not happen. */
export function refusalText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: unknown; code?: unknown } | null;
    const known = typeof body?.error === 'string' ? refusals[body.error] : undefined;
    if (known) {
      return typeof body?.code === 'string' ? `${known} (${body.code})` : known;
    }
    if (err.status === 404) return 'This session is no longer available to you.';
  }
  return fallback;
}

const transferErrors: Record<string, string> = {
  too_large: `larger than ${size(MAX_COPY_OUT_FILE_BYTES)}`,
  session_limit: `would pass ${size(MAX_COPY_OUT_SESSION_BYTES)} for this session`,
  not_found: 'no longer in the workspace',
  not_a_file: 'not a file',
};

export const transferError = (code: string | null) =>
  code ? (transferErrors[code] ?? `refused (${code})`) : 'failed';

/** What a finished transfer actually did, in the words the acknowledgement allows. */
export function outcomeText(t: TransferView, host: string | null): string {
  switch (t.state) {
    case 'done':
      switch (t.outcome) {
        case 'unchanged':
          return `Already on ${where(host)}, unchanged`;
        case 'kept_theirs':
          return `Kept the file on ${where(host)}; nothing written`;
        case 'replaced':
          return `Replaced the file on ${where(host)}`;
        case 'saved_copy':
          return `Saved as ${t.path} on ${where(host)}`;
        default:
          return t.direction === 'out' ? 'Copied to Parallax' : `Copied to ${where(host)}`;
      }
    case 'conflict':
      return `A different file is already on ${where(host)}; nothing written`;
    case 'failed':
      return `${t.direction === 'out' ? 'Not copied' : 'Not written'}: ${transferError(t.error)}`;
    default:
      return 'In progress';
  }
}

/** Downloads the draft the page holds, for when a save to Parallax did not succeed. */
export function downloadNotebook(notebook: Record<string, unknown>, filename: string) {
  downloadText(filename, JSON.stringify(notebook, null, 1), 'application/x-ipynb+json');
}
