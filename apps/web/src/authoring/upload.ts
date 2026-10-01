import {
  MAX_UPLOAD_BYTES,
  uploadedFile,
  uploadFormats,
} from '@parallax/contracts/routes/authoring';
import type { z } from 'zod';
import { ApiError } from '../api/client';

export type Uploaded = z.output<typeof uploadedFile>;

export const ACCEPT = Object.keys(uploadFormats)
  .map((e) => `.${e}`)
  .join(',');

/** Why the browser can already refuse a file, with the same wording the server uses. */
export function fileProblem(file: File): string | undefined {
  const extension = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() : undefined;
  if (!extension || !Object.hasOwn(uploadFormats, extension)) {
    return 'Upload a Markdown (.md), HTML (.html) or PDF (.pdf) file';
  }
  if (file.size === 0) return 'The file is empty';
  if (file.size > MAX_UPLOAD_BYTES) {
    return `The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`;
  }
  return undefined;
}

/** Sends one reading file to the course's storage; rejects with ApiError carrying the reason. */
export async function uploadReadingFile(courseId: string, file: File): Promise<Uploaded> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}/uploads`, {
    method: 'POST',
    credentials: 'same-origin',
    body: form,
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return uploadedFile.parse(body);
}

/** The editor-facing message for a failed upload or save. */
export function failureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (err.status === 413) return body?.message ?? 'The file is too large';
    // Upload refusals put the reason in `error`; request validation puts it in `message`.
    if (err.status === 400)
      return body?.error && body.error !== 'Bad Request'
        ? body.error
        : (body?.message ?? 'The server rejected the request');
    if (err.status === 404) return 'This course is no longer available to you';
  }
  return 'The request failed. Try again.';
}
