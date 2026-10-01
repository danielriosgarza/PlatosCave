import type { ClassScope, CourseScope } from '../auth/scope';
import { type Disposition, keyInScope, mintContentToken } from './tokens';

const EXTENSIONS: Record<string, string> = {
  'application/pdf': '.pdf',
  'application/x-ipynb+json': '.ipynb',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/svg+xml': '.svg',
  'text/csv': '.csv',
};

/**
 * Longest download base name in UTF-8 bytes: the name travels in the signed token, which must
 * stay under MAX_TOKEN_LENGTH even with long content types (minting refuses longer tokens).
 */
const MAX_NAME_BYTES = 120;

/** File name for a download: the resource title with filesystem-hostile characters removed. */
export function downloadName(title: string, contentType: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\p{Cc}]+/gu, ' ').trim();
  let base = '';
  for (const char of cleaned) {
    if (Buffer.byteLength(base + char) > MAX_NAME_BYTES) break;
    base += char;
  }
  base = base.trim() || 'download';
  const ext = EXTENSIONS[contentType.split(';')[0]?.trim() ?? ''] ?? '';
  return base.toLowerCase().endsWith(ext) ? base : `${base}${ext}`;
}

export interface ContentUrlDeps {
  contentOrigin: string;
  secret: string;
  now: Date;
}

/** Key prefixes a scope may mint for: its own class area and its course's content. */
function scopeIdFor(scope: ClassScope | CourseScope, key: string): string {
  const owners = 'classId' in scope ? [scope.classId, scope.courseId] : [scope.courseId];
  const owner = owners.find((id) => keyInScope(key, id));
  if (!owner) throw new Error(`storage key ${key} is outside the request scope`);
  return owner;
}

/**
 * Signed, short-lived URL on the content origin for one object (ADR-0002). Takes a resolved
 * scope only; refuses keys outside that scope's prefixes.
 */
export function mintContentUrl(
  deps: ContentUrlDeps,
  scope: ClassScope | CourseScope,
  object: { key: string; contentType: string },
  options: { disposition: Disposition; filename?: string },
): { url: string; expiresAt: string } {
  const { token, exp } = mintContentToken(
    deps.secret,
    {
      key: object.key,
      userId: scope.user.id,
      scopeId: scopeIdFor(scope, object.key),
      contentType: object.contentType,
      disposition: options.disposition,
      ...(options.filename !== undefined && { filename: options.filename }),
    },
    deps.now,
  );
  return {
    url: `${deps.contentOrigin}/content/${token}`,
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}
