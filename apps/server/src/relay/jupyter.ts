import type { LinkServerMessage } from '@parallax/contracts';
import type { z } from 'zod';

/**
 * The typed Jupyter operations of docs/design/connector.md §7. The browser never names a path,
 * host or port: the relay builds every request here from validated arguments, and the connector
 * checks it again against the same allowlist. A builder throws `JupyterArgumentError` for an
 * argument it cannot place inside the allowlist, so no operation produces a path outside it.
 */

type ServerMessage = z.input<typeof LinkServerMessage>;
export type HttpMessage = Extract<ServerMessage, { t: 'http' }>;
export type WsOpenMessage = Extract<ServerMessage, { t: 'ws_open' }>;

export class JupyterArgumentError extends Error {}

/** One Jupyter REST call, before a stream id is allocated for it. */
export interface JupyterRequest {
  purpose: 'session' | 'contents';
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** The encoded path and query, as sent. */
  path: string;
  /** A JSON or file body, sent as frames after the `http` message. */
  body?: Buffer;
  contentType?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KERNEL_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
/** §4.3: a `start` body for `purpose: session` is at most 1 KiB. */
const MAX_KERNEL_BODY = 1024;
/** §4.5: a `contents` body is at most 64 MiB. */
export const MAX_CONTENTS_BODY = 64 * 1024 * 1024;
/** §7 path rules: at most 1024 characters after decoding. */
const MAX_PATH = 1024;

function kernelId(id: string): string {
  if (!UUID.test(id)) throw new JupyterArgumentError('a kernel id is a lower-case uuid');
  return id;
}

const json = (value: object) => Buffer.from(JSON.stringify(value), 'utf8');

const session = (
  method: JupyterRequest['method'],
  path: string,
  body?: object,
): JupyterRequest => ({
  purpose: 'session',
  method,
  path,
  ...(body && { body: json(body), contentType: 'application/json' }),
});

/** `GET /api/status`: the service answers with the token (§5.1 `notebook_auth`). */
export const status = () => session('GET', '/api/status');
/** `GET /api/kernelspecs`. */
export const kernelspecs = () => session('GET', '/api/kernelspecs');
/** `GET /api/kernels`: the connector answers only with the session's own kernels (§7). */
export const listKernels = () => session('GET', '/api/kernels');

/** `POST /api/kernels { name }`: starts a kernel of the chosen kernelspec. */
export function startKernel(name: string): JupyterRequest {
  if (!KERNEL_NAME.test(name)) throw new JupyterArgumentError('not a kernelspec name');
  const request = session('POST', '/api/kernels', { name });
  if ((request.body?.length ?? 0) > MAX_KERNEL_BODY) throw new JupyterArgumentError('too long');
  return request;
}

export const kernelState = (id: string) => session('GET', `/api/kernels/${kernelId(id)}`);
export const deleteKernel = (id: string) => session('DELETE', `/api/kernels/${kernelId(id)}`);
export const interruptKernel = (id: string) =>
  session('POST', `/api/kernels/${kernelId(id)}/interrupt`);
export const restartKernel = (id: string) =>
  session('POST', `/api/kernels/${kernelId(id)}/restart`);

/**
 * The kernel channel: the only WebSocket (§7). The notebook session id is Jupyter's
 * `session_id`, so Jupyter's offline buffer replays what the kernel emitted meanwhile.
 */
export function openChannel(id: string, sessionId: string): { path: string } {
  if (!UUID.test(sessionId)) throw new JupyterArgumentError('a session id is a uuid');
  return { path: `/api/kernels/${kernelId(id)}/channels?session_id=${sessionId}` };
}

/**
 * Splits a workspace-relative path into segments and checks the rules of §7: no NUL, backslash,
 * empty, `.` or `..` segment, no segment starting with `.` or holding a percent escape, at most
 * 1024 characters, and the path equals the session's content root or lies below it, segment by segment.
 */
export function contentPath(contentRoot: string, relpath: string): string {
  const root = contentRoot === '' ? [] : segments(contentRoot);
  const parts = relpath === '' ? [] : segments(relpath);
  if (relpath.length > MAX_PATH) throw new JupyterArgumentError('the path is too long');
  if (!root.every((seg, i) => parts[i] === seg)) {
    throw new JupyterArgumentError('the path is outside the session workspace');
  }
  return parts.map((seg) => encodeURIComponent(seg)).join('/');
}

const hasControlOrBackslash = (path: string) =>
  [...path].some((c) => c === '\\' || c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);

function segments(path: string): string[] {
  if (hasControlOrBackslash(path)) {
    throw new JupyterArgumentError('control characters and backslashes are not allowed');
  }
  const parts = path.split('/');
  for (const seg of parts) {
    if (seg === '' || seg.startsWith('.')) {
      throw new JupyterArgumentError('empty, dot and hidden segments are not allowed');
    }
    // The connector decodes once and refuses a path whose decoding would change again.
    if (/%[0-9A-Fa-f]{2}/.test(seg)) {
      throw new JupyterArgumentError('a name holding a percent escape is not allowed');
    }
  }
  return parts;
}

/** The query keys §7 allows on `contents` calls, each with simple values. */
export interface ContentsQuery {
  content?: 0 | 1;
  type?: 'file' | 'directory' | 'notebook';
  format?: 'text' | 'base64';
  hash?: 0 | 1;
}

function query(q: ContentsQuery): string {
  const entries = Object.entries(q).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return '';
  return `?${entries.map(([key, value]) => `${key}=${String(value)}`).join('&')}`;
}

const contentsUrl = (root: string, relpath: string, q: ContentsQuery = {}) => {
  const path = contentPath(root, relpath);
  return `/api/contents${path === '' ? '' : `/${path}`}${query(q)}`;
};

/** File transfer within the session's workspace (P3-09, §11): `purpose: 'contents'`. */
export const contents = {
  /** Lists a directory (never above the content root). */
  list: (root: string, reldir: string): JupyterRequest => ({
    purpose: 'contents',
    method: 'GET',
    path: contentsUrl(root, reldir, { content: 1, type: 'directory' }),
  }),
  get: (root: string, relpath: string, q: ContentsQuery = {}): JupyterRequest => ({
    purpose: 'contents',
    method: 'GET',
    path: contentsUrl(root, relpath, q),
  }),
  /** Writes a file; `model` is Jupyter's contents model (`{ type, format, content }`). */
  put: (root: string, relpath: string, model: object): JupyterRequest => {
    const body = json(model);
    if (body.length > MAX_CONTENTS_BODY) throw new JupyterArgumentError('the body is too large');
    return {
      purpose: 'contents',
      method: 'PUT',
      path: contentsUrl(root, relpath),
      body,
      contentType: 'application/json',
    };
  },
  /** Creates an untitled file or directory; the body holds only `type` and `ext` (§7). */
  create: (
    root: string,
    reldir: string,
    model: { type: 'file' | 'directory' | 'notebook'; ext?: string },
  ): JupyterRequest => {
    if (model.ext !== undefined && !/^\.[A-Za-z0-9]{1,16}$/.test(model.ext)) {
      throw new JupyterArgumentError('not a file extension');
    }
    return {
      purpose: 'contents',
      method: 'POST',
      path: contentsUrl(root, reldir),
      body: json({ type: model.type, ...(model.ext && { ext: model.ext }) }),
      contentType: 'application/json',
    };
  },
  delete: (root: string, relpath: string): JupyterRequest => {
    if (contentPath(root, relpath) === contentPath(root, root)) {
      throw new JupyterArgumentError('the workspace itself is not deleted');
    }
    return { purpose: 'contents', method: 'DELETE', path: contentsUrl(root, relpath) };
  },
};

/** The `http` message opening `request` on stream `streamId` of session `sessionId`. */
export function httpMessage(
  request: JupyterRequest,
  streamId: number,
  sessionId: string,
): HttpMessage {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (request.contentType) headers['content-type'] = request.contentType;
  return {
    v: 1,
    t: 'http',
    streamId,
    sessionId,
    purpose: request.purpose,
    method: request.method,
    path: request.path,
    headers,
    ...(request.body
      ? { body: 'stream' as const, contentLength: request.body.length }
      : { body: 'none' as const }),
  };
}

/** The `ws_open` message opening the kernel channel of `kernel` on stream `streamId`. */
export function channelMessage(kernel: string, streamId: number, sessionId: string): WsOpenMessage {
  return { v: 1, t: 'ws_open', streamId, sessionId, path: openChannel(kernel, sessionId).path };
}
