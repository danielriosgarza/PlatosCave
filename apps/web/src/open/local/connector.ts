import { z } from 'zod';

/**
 * The client of the connector's open mode (docs/design/open-site.md §14), the one module of the
 * open site besides `data.ts` that makes requests. It reaches only the connector on this
 * computer's loopback address, and only after the visitor chooses Run on this computer: `GET
 * /v1/hello`, then a pairing the visitor allows in the connector's terminal, then the session and
 * kernel requests of that page. The key it gets is kept in memory for this page load and never
 * in storage; the Jupyter token stays in the connector.
 */

export const CONNECTOR_PORT = 47821;
export const CONNECTOR_ORIGIN = `http://127.0.0.1:${CONNECTOR_PORT}`;

/** A refusal or failure the connector named, or `unreachable` when nothing answered. */
export class ConnectorError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

const failure = z.object({ code: z.string().max(64), detail: z.string().max(2000).optional() });

const kernelspec = z.object({
  name: z.string().max(64),
  displayName: z.string().max(256),
  language: z.string().max(64),
});

const opened = z.object({
  session: z.uuid(),
  folder: z.string().max(1024),
  jupyter: z.string().max(32).optional(),
  runtime: z.string().max(64).optional(),
  kernelspecs: z.array(kernelspec).max(64).nullable(),
  files: z
    .object({ written: z.array(z.string().max(1024)), kept: z.array(z.string().max(1024)) })
    .optional(),
});
export type OpenedSession = z.infer<typeof opened>;

const kernel = z.looseObject({
  id: z.uuid(),
  name: z.string().max(64),
  execution_state: z.string().max(32).optional(),
});
export type StartedKernel = z.infer<typeof kernel>;

async function send(
  path: string,
  init: { method: string; key?: string; body?: unknown; keepalive?: boolean },
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.key) headers.Authorization = `Bearer ${init.key}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`${CONNECTOR_ORIGIN}${path}`, {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'omit',
      cache: 'no-store',
      ...(init.keepalive ? { keepalive: true } : {}),
    });
  } catch {
    throw new ConnectorError('unreachable', 0);
  }
  if (!response.ok) {
    let parsed: z.infer<typeof failure> | undefined;
    try {
      parsed = failure.parse(await response.json());
    } catch {
      parsed = undefined;
    }
    throw new ConnectorError(parsed?.code ?? 'failed', response.status, parsed?.detail);
  }
  return response;
}

const json = async <T>(response: Response, schema: { parse(value: unknown): T }): Promise<T> => {
  try {
    return schema.parse(await response.json());
  } catch {
    throw new ConnectorError('invalid_answer', response.status);
  }
};

/** Whether a connector in open mode answers on this computer. */
export async function hello(): Promise<boolean> {
  try {
    const answer = await json(
      await send('/v1/hello', { method: 'GET' }),
      z.object({ api: z.literal(1) }),
    );
    return answer.api === 1;
  } catch {
    return false;
  }
}

/** A code the page shows and the connector's terminal repeats: `1234-5678`. */
export function pairingCode(): string {
  const digits = crypto.getRandomValues(new Uint32Array(2));
  const part = (n: number) => String(n % 10_000).padStart(4, '0');
  return `${part(digits[0] as number)}-${part(digits[1] as number)}`;
}

/** Asks the connector's terminal whether this site may run notebooks; resolves to the page's key. */
export async function pair(code: string): Promise<string> {
  const answer = await json(
    await send('/v1/pair', { method: 'POST', body: { code } }),
    z.object({ key: z.string().regex(/^[0-9a-f]{64}$/) }),
  );
  return answer.key;
}

/** The requests of one page with its key. */
export function client(key: string) {
  const at = (session: string) => `/v1/sessions/${encodeURIComponent(session)}`;
  const kernelAt = (session: string, id: string) =>
    `${at(session)}/kernels/${encodeURIComponent(id)}`;
  return {
    /** Starts Jupyter in the notebook's folder, after copying in the files of `files` (a zip). */
    open: async (folder: string[], files: string | null) =>
      json(await send('/v1/sessions', { method: 'POST', key, body: { folder, files } }), opened),
    stop: async (session: string, keepalive = false) => {
      await send(at(session), { method: 'DELETE', key, keepalive });
    },
    startKernel: async (session: string, name: string) =>
      json(await send(`${at(session)}/kernels`, { method: 'POST', key, body: { name } }), kernel),
    kernelState: async (session: string, id: string) =>
      json(await send(kernelAt(session, id), { method: 'GET', key }), kernel),
    interrupt: async (session: string, id: string) => {
      await send(`${kernelAt(session, id)}/interrupt`, { method: 'POST', key });
    },
    restart: async (session: string, id: string) => {
      await send(`${kernelAt(session, id)}/restart`, { method: 'POST', key });
    },
    /** The kernel's channel; a WebSocket cannot send a header, so the key is in the query. */
    channelUrl: (session: string, id: string, jupyterSession: string) =>
      `ws://127.0.0.1:${CONNECTOR_PORT}${kernelAt(session, id)}/channels?${new URLSearchParams({
        session_id: jupyterSession,
        key,
      })}`,
  };
}

export type ConnectorClient = ReturnType<typeof client>;
