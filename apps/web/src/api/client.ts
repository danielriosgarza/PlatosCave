import type { RouteContract } from '@parallax/contracts';
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API error ${status}`);
  }
}

interface CallArgs {
  params?: Record<string, string | number>;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** Lets the request outlive the page (a save sent as it is closed or reloaded). */
  keepalive?: boolean;
}

export async function call<C extends RouteContract>(
  contract: C,
  { params, query, body, keepalive }: CallArgs = {},
): Promise<z.output<C['response']>> {
  const path = contract.path.replace(/:([A-Za-z0-9_]+)/g, (_, k: string) => {
    const v = params?.[k];
    if (v === undefined) throw new Error(`missing route param ${k} for ${contract.path}`);
    return encodeURIComponent(String(v));
  });
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined) qs.set(k, String(v));
  }
  const url = qs.size ? `${path}?${qs}` : path;
  const res = await fetch(url, {
    method: contract.method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(keepalive && { keepalive }),
  });
  const isJson = res.headers.get('content-type')?.includes('json') ?? false;
  let json: unknown = null;
  let malformed = false;
  if (isJson) {
    try {
      json = await res.json();
    } catch {
      malformed = true;
    }
  }
  if (!res.ok) throw new ApiError(res.status, json);
  if (!isJson) throw new ApiError(res.status, 'response is not JSON');
  if (malformed) throw new ApiError(res.status, 'response body is not valid JSON');
  const parsed = import.meta.env.DEV ? contract.response.parse(json) : json;
  return parsed as z.output<C['response']>;
}

export function useApi<C extends RouteContract>(contract: C, args: CallArgs = {}) {
  return useQuery({
    queryKey: [contract.method, contract.path, args],
    queryFn: () => call(contract, args),
  });
}
