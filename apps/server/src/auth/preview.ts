import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { revokeSession } from '../db/auth/sessions';
import type { Executor } from '../db/client';
import { PREVIEW_SESSION_TTL_MS } from '../db/preview';
import { TOKEN_SHAPE } from './sessions';

/**
 * While a draft preview runs, the browser's session cookie holds the preview principal's
 * session and this signed, HttpOnly cookie keeps the instructor's own session token and the
 * editor to return to. It is scoped to `/api` so sign-out, sign-in and the exit can end it.
 */
export const PREVIEW_RETURN_COOKIE = 'pc_preview_return';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ReturnTo = z.object({
  token: z.string().regex(TOKEN_SHAPE),
  courseId: z.string().regex(UUID),
  topicId: z.string().regex(UUID).optional(),
});
export type PreviewReturn = z.infer<typeof ReturnTo>;

export function returnCookieOptions(appOrigin: string): CookieSerializeOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: '/api',
    secure: appOrigin.startsWith('https:'),
    signed: true,
    maxAge: PREVIEW_SESSION_TTL_MS / 1000,
  };
}

export function setPreviewReturn(reply: FastifyReply, value: PreviewReturn, appOrigin: string) {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  reply.setCookie(PREVIEW_RETURN_COOKIE, encoded, returnCookieOptions(appOrigin));
}

/** The kept instructor session and editor, or undefined when absent or tampered with. */
export function readPreviewReturn(req: FastifyRequest): PreviewReturn | undefined {
  const raw = req.cookies?.[PREVIEW_RETURN_COOKIE];
  if (!raw) return undefined;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return undefined;
  try {
    const parsed = ReturnTo.safeParse(
      JSON.parse(Buffer.from(unsigned.value, 'base64url').toString('utf8')),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The editor a preview returns to: built from ids only, so it is always a same-origin app path. */
export const editorPath = (value: Pick<PreviewReturn, 'courseId' | 'topicId'>): string =>
  value.topicId
    ? `/courses/${value.courseId}/edit/${value.topicId}`
    : `/courses/${value.courseId}/edit`;

/** Ends the kept instructor session, if the browser holds one; takes part in `db`'s transaction. */
export async function revokePreviewReturn(
  db: Executor | undefined,
  req: FastifyRequest,
  now: Date,
): Promise<void> {
  const kept = readPreviewReturn(req);
  if (kept && db) await revokeSession(db, kept.token, now);
}

export function clearPreviewReturn(req: FastifyRequest, reply: FastifyReply, appOrigin: string) {
  if (req.cookies?.[PREVIEW_RETURN_COOKIE]) {
    reply.clearCookie(PREVIEW_RETURN_COOKIE, returnCookieOptions(appOrigin));
  }
}

/**
 * Sign-out and sign-in end the kept instructor session too: a browser that signs out during a
 * preview must not keep a live session in a cookie it cannot see.
 */
export async function endPreviewReturn(
  db: Executor | undefined,
  req: FastifyRequest,
  reply: FastifyReply,
  appOrigin: string,
  now: Date,
): Promise<void> {
  await revokePreviewReturn(db, req, now);
  clearPreviewReturn(req, reply, appOrigin);
}
