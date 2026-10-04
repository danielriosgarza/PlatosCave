import {
  MAX_UPLOAD_BYTES,
  uploadedFile,
  uploadFormats,
} from '@parallax/contracts/routes/authoring';
import type { z } from 'zod';
import { ApiError } from '../api/client';

export type Uploaded = z.output<typeof uploadedFile>;

type Kind = 'reading' | 'notebook';

const extensionsOf = (kind: Kind) =>
  Object.entries(uploadFormats)
    .filter(([, format]) => (format === 'notebook') === (kind === 'notebook'))
    .map(([extension]) => extension);

/** File types a reading accepts; a notebook is added on the Notebooks tab. */
export const ACCEPT = extensionsOf('reading')
  .map((e) => `.${e}`)
  .join(',');
export const NOTEBOOK_ACCEPT = extensionsOf('notebook')
  .map((e) => `.${e}`)
  .join(',');

/** Why the browser can already refuse a file, with the same wording the server uses. */
export function fileProblem(file: File, kind: Kind = 'reading'): string | undefined {
  const extension = file.name.includes('.') ? file.name.split('.').pop()?.toLowerCase() : undefined;
  if (!extension || !extensionsOf(kind).includes(extension)) {
    return kind === 'notebook'
      ? 'Upload a Jupyter notebook (.ipynb) file'
      : 'Upload a Markdown (.md), HTML (.html) or PDF (.pdf) file';
  }
  if (file.size === 0) return 'The file is empty';
  if (file.size > MAX_UPLOAD_BYTES) {
    return `The file is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB`;
  }
  return undefined;
}

/** Sends one reading or notebook file to the course's storage; rejects with ApiError carrying the reason. */
export async function uploadFile(courseId: string, file: File): Promise<Uploaded> {
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
    // Every 400 carries the sentence to show in `message` (ADR-0002 §Error replies).
    if (err.status === 400) return body?.message ?? 'The server rejected the request';
    if (err.status === 404) return 'This course is no longer available to you';
  }
  return 'The request failed. Try again.';
}
