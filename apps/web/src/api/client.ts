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
}

export async function call<C extends RouteContract>(
  contract: C,
  { params, query, body }: CallArgs = {},
): Promise<z.output<C['response']>> {
  let path: string = contract.path;
  for (const [k, v] of Object.entries(params ?? {})) {
    path = path.replace(`:${k}`, encodeURIComponent(String(v)));
  }
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
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, json);
  const parsed = import.meta.env.DEV ? contract.response.parse(json) : json;
  return parsed as z.output<C['response']>;
}

export function useApi<C extends RouteContract>(contract: C, args: CallArgs = {}) {
  return useQuery({ queryKey: [contract.path, args], queryFn: () => call(contract, args) });
}
