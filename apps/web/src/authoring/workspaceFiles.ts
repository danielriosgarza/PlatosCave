import { uploadedWorkspaceFile, uploadWorkspaceFile } from '@parallax/contracts/routes/authoring';
import { WorkspacePath } from '@parallax/contracts/routes/transfers';
import type { z } from 'zod';
import { ApiError } from '../api/client';

export type UploadedWorkspaceFile = z.output<typeof uploadedWorkspaceFile>;

/** A notebook declares at most this many files (the server reads no more). */
export const MAX_WORKSPACE_FILES = 100;

/** A file chosen for the workspace and the path it will have there. */
export interface WorkspaceEntry {
  id: string;
  file: File;
  path: string;
}

/** The sentence shown when a path cannot be used in a workspace; undefined when it can. */
export function pathProblem(path: string, others: readonly string[]): string | undefined {
  if (path.trim() === '') return 'Enter a path';
  if (path !== path.trim()) return 'The path starts or ends with a space';
  if (!WorkspacePath.safeParse(path).success) {
    return 'Use a relative path without empty, dot or hidden segments, such as data/sample.csv';
  }
  if (others.includes(path)) return 'Another file already has this path';
  if (others.some((o) => o.startsWith(`${path}/`) || path.startsWith(`${o}/`))) {
    return 'A file cannot also be a folder of another file';
  }
  return undefined;
}

/** Problem of each entry's path, by entry id. */
export function pathProblems(entries: readonly WorkspaceEntry[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const e of entries) {
    const problem = pathProblem(
      e.path,
      entries.filter((o) => o.id !== e.id).map((o) => o.path),
    );
    if (problem) found.set(e.id, problem);
  }
  return found;
}

/** Sends one data file to the course's storage; rejects with ApiError carrying the reason. */
export async function uploadWorkspaceData(
  courseId: string,
  file: File,
): Promise<UploadedWorkspaceFile> {
  const form = new FormData();
  form.append('file', file, file.name);
  const res = await fetch(
    uploadWorkspaceFile.path.replace(':courseId', encodeURIComponent(courseId)),
    {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
    },
  );
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, body);
  return uploadedWorkspaceFile.parse(body);
}

/**
 * The notebook with `metadata.parallax.files` set to the declared files, every other part kept.
 * Throws an Error with the sentence to show when the file is not a JSON object.
 */
export function declareFiles(
  notebookText: string,
  files: readonly { path: string; resourceId: string }[],
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(notebookText);
  } catch {
    throw new Error('The notebook is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('The notebook is not a Jupyter notebook');
  }
  const notebook = parsed as { metadata?: unknown };
  const metadata =
    typeof notebook.metadata === 'object' && notebook.metadata && !Array.isArray(notebook.metadata)
      ? (notebook.metadata as Record<string, unknown>)
      : {};
  const parallax =
    typeof metadata.parallax === 'object' && metadata.parallax && !Array.isArray(metadata.parallax)
      ? (metadata.parallax as Record<string, unknown>)
      : {};
  return JSON.stringify({
    ...notebook,
    metadata: { ...metadata, parallax: { ...parallax, files: [...files] } },
  });
}

/** The declared files recorded in a notebook revision's content, for display. */
export function declaredFromContent(
  content: unknown,
): { path: string; resourceId: string; size: number }[] {
  const list = (content as { workspaceFiles?: unknown } | null)?.workspaceFiles;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const e = raw as { path?: unknown; resourceId?: unknown; size?: unknown };
    return typeof e?.path === 'string' && typeof e.resourceId === 'string'
      ? [{ path: e.path, resourceId: e.resourceId, size: typeof e.size === 'number' ? e.size : 0 }]
      : [];
  });
}
