import type { Question } from './api';

export interface CodeFile {
  path: string;
  content: string;
}

/** A code answer is the editable files as the editor holds them. */
export interface CodeAnswer {
  files: CodeFile[];
}

export const editableFiles = (question: Extract<Question, { kind: 'code' }>): CodeFile[] =>
  question.files.filter((f) => f.editable).map((f) => ({ path: f.path, content: f.content }));

/** Whether a stored value answers its question; a cleared or empty answer does not (§11). */
export const isAnswered = (value: unknown): boolean =>
  value !== null &&
  value !== undefined &&
  value !== '' &&
  !(Array.isArray(value) && value.length === 0);

export const codeFilesOf = (
  question: Extract<Question, { kind: 'code' }>,
  value: unknown,
): CodeFile[] => {
  const saved = (value as CodeAnswer | null | undefined)?.files;
  const starter = editableFiles(question);
  if (!Array.isArray(saved)) return starter;
  return starter.map((f) => saved.find((s) => s.path === f.path) ?? f);
};

/** JSON with object keys sorted: the server's `canonical`, so the same files give the same hash. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * The hash the server gives a run for these files (`codeHash` in the execution job builder).
 * Comparing it with a run's `codeHash` tells whether the output belongs to the code on screen.
 */
export async function hashFiles(files: CodeFile[]): Promise<string> {
  const sorted = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((f) => ({ path: f.path, content: f.content, encoding: 'utf8' }));
  const bytes = new TextEncoder().encode(canonical(sorted));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The question's state in the navigation: Answered, Unanswered, with Flagged beside either. */
export function navLabel(answered: boolean, flagged: boolean): string {
  const base = answered ? 'Answered' : 'Unanswered';
  return flagged ? `${base} · Flagged` : base;
}

/** The file offered when saving a draft: the code, or the written answer as text. */
export const draftFilename = (question: Question, path?: string) =>
  question.kind === 'code' ? (path ?? 'solution.txt') : `${question.id}.txt`;
