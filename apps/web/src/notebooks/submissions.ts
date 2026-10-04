import {
  COLAB_URL,
  getSubmissionDownload,
  launchColab,
  listOwnSubmissions,
  MAX_SUBMISSION_BYTES,
  reviewSubmissions,
  submissionReceipt,
} from '@parallax/contracts/routes/notebookSubmissions';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import { ApiError, call, useApi } from '../api/client';

export { COLAB_URL };
export type Receipt = z.output<typeof submissionReceipt>;
export type ReviewedSubmission = z.output<typeof reviewSubmissions.response>['submissions'][number];

export const useOwnSubmissions = (classId: string, resourceId: string) =>
  useApi(listOwnSubmissions, { params: { classId, resourceId } });

/** Every student's submissions; only asked for by an instructor, so a student never sends it. */
export const useReviewedSubmissions = (classId: string, resourceId: string, enabled: boolean) => {
  const args = { params: { classId, resourceId } };
  return useQuery({
    queryKey: [reviewSubmissions.method, reviewSubmissions.path, args],
    queryFn: () => call(reviewSubmissions, args),
    enabled,
  });
};

/** Tells the server the learner opened Colab; failure changes nothing for the learner. */
export const recordLaunch = (classId: string, resourceId: string) =>
  call(launchColab, { params: { classId, resourceId } }).catch(() => null);

/** Why the browser can already refuse a file, with the same wording the server uses. */
export function submissionProblem(file: File): string | undefined {
  if (!file.name.toLowerCase().endsWith('.ipynb')) return 'Upload a Jupyter notebook (.ipynb) file';
  if (file.size === 0) return 'The file is empty';
  if (file.size > MAX_SUBMISSION_BYTES) {
    return `The file is larger than ${MAX_SUBMISSION_BYTES / (1024 * 1024)} MB`;
  }
  return undefined;
}

/**
 * Sends the file as the next version of the learner's submission. `key` identifies this attempt:
 * sending the same key again after a lost answer returns the same receipt, not another version.
 */
export async function sendSubmission(
  classId: string,
  resourceId: string,
  file: File,
  key: string,
): Promise<Receipt> {
  const form = new FormData();
  form.append('file', file, file.name);
  const url = `/api/classes/${encodeURIComponent(classId)}/resources/${encodeURIComponent(resourceId)}/notebook-submissions?submissionKey=${encodeURIComponent(key)}`;
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', body: form });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return submissionReceipt.parse(body);
}

/** The learner-facing message for a refused or failed submission. */
export function submissionFailure(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as { error?: string; message?: string } | null;
    if (err.status === 413) return body?.message ?? 'The file is too large';
    if (err.status === 400) return body?.message ?? 'The server rejected the file';
    if (err.status === 409 && body?.error === 'class_archived') {
      return 'This class is archived and no longer accepts submissions';
    }
    if (err.status === 404) return 'This notebook is no longer available to you';
  }
  return 'The notebook was not received. Try again.';
}

export const downloadSubmission = (classId: string, submissionId: string) =>
  call(getSubmissionDownload, { params: { classId, submissionId } });

export const useRefreshSubmissions = () => {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      predicate: (q) => String(q.queryKey[1]).includes('/notebook-submissions'),
    });
};
