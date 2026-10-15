import type { Readable } from 'node:stream';
import type { CourseManifest, SiteManifest } from '@parallax/contracts';
import { loadSource } from '../paths';
import { type Problem, refusal } from './yaml';

type Contracts = typeof import('@parallax/contracts');
type Manifest = CourseManifest | SiteManifest;
type Issue = { code: string; message: string; topicId?: string; resourceId?: string };
/** An issue of publication's report, with the path from the course folder of the file it names. */
export type Located = Issue & { path: string; overlay?: true };
type Validation = {
  validate(drafts: unknown, options: object): { errors: Issue[]; warnings: Issue[] };
};
// The tool reaches both when it runs (paths.ts); of the server's sources, the validator only (§7).
const contracts = await loadSource<Contracts>('contracts', 'src/index.ts');
const { validate } = await loadSource<Validation>('server', 'src/content/validation.ts');

/** What a conversion gave one resource, by its folder id: its derived output, or a failure. */
export type Conversion = { state: 'ready'; derived: Record<string, unknown> } | { state: 'failed' };
/** A test's publication rules, which need the server's runtimes, and the codes of a conversion. */
const TESTS = ['invalid_test', 'script_only_hidden_checks'];
const CONVERSIONS = ['unconverted_deck', 'unprocessed_reading'];

/**
 * Publication's report (docs/design/course-folder.md §9): the unchanged `validate` on the manifest
 * as loaded drafts, each issue with its path; without a test's rules, nor a conversion's unless
 * `derived` holds conversions. `folders` gives a topic's folder by its id (`topicFolders`).
 */
export function publicationReport(
  manifest: Manifest,
  derived: Readonly<Record<string, Conversion>> | undefined,
  options: { approvedShinyOrigins?: readonly string[]; folders: ReadonlyMap<string, string> },
): { errors: Located[]; warnings: Located[] } {
  const entries = new Map<string, { path: string; overlay?: boolean }>();
  const drafts = manifest.topics.map(({ id, title, prerequisites = [], resources }) => ({
    topic: { id, title, prerequisites },
    resources: resources.flatMap((entry) => {
      if (!('source' in entry)) return [];
      entries.set(entry.id, entry);
      const { type, title: name, source, alternative } = entry;
      const done = derived?.[entry.id];
      // As the job records it: what it derived, beside its status (`reading-ingest.job.ts`).
      const at = new Date(0).toISOString();
      const status = done && { state: done.state, job: 'conversion', jobId: null, updatedAt: at };
      const outputs = { ...(done?.state === 'ready' && done.derived), ...(status && { status }) };
      const content = 'definition' in source ? source.definition : source;
      const revision = { resourceId: entry.id, courseId: '', type, content, derived: outputs };
      const accessibleAlternative = alternative === undefined ? null : { text: alternative };
      return {
        resource: { id: entry.id, courseId: '', type, title: name },
        revision: { ...revision, accessibleAlternative },
        status: status ?? null,
      };
    }),
  }));
  const { approvedShinyOrigins = [], folders } = options;
  const report = validate(drafts, { approvedShinyOrigins, runtimes: [] });
  const left = new Set([...TESTS, ...(derived ? [] : CONVERSIONS)]);
  const located = (issue: Issue): Located => {
    const entry = entries.get(issue.resourceId ?? '');
    const topic = issue.topicId && `${folders.get(issue.topicId)}/topic.yaml`;
    const path = entry?.path ?? (topic || 'course.yaml');
    return { ...issue, path, ...(entry?.overlay && { overlay: true }) };
  };
  const kept = (issues: Issue[]) => issues.filter((i) => !left.has(i.code)).map(located);
  return { errors: kept(report.errors), warnings: kept(report.warnings) };
}

const UNPAIRED = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Text PostgreSQL does not store, as `sync` refuses it (`planSync`): a NUL, an unpaired surrogate. */
const unstorable = (value: unknown): boolean =>
  typeof value === 'string'
    ? value.includes('\0') || UNPAIRED.test(value)
    : typeof value === 'object' &&
      value !== null &&
      Object.entries(value).some(([key, item]) => unstorable(key) || unstorable(item));

/**
 * The upload rules (design §8) on every file of the manifest, streamed, and on each notebook's data
 * files; then the text `sync` stores, definitions included: an error with the route's sentence.
 */
export async function uploadProblems(
  manifest: Manifest,
  open: (file: string) => Readable,
  folders: ReadonlyMap<string, string>,
): Promise<Problem[]> {
  const problems: Problem[] = [];
  const refuse = (path: string, error: unknown) => {
    const refused = error instanceof contracts.CourseFileRefused;
    const why = `cannot be read (${(error as NodeJS.ErrnoException).code ?? error})`;
    problems.push(refusal('upload', path, refused ? error.message : why));
  };
  for (const { path, format } of manifest.files) {
    const check = contracts.courseFileCheck(format);
    try {
      for await (const chunk of open(path)) check.push(chunk);
      check.end();
    } catch (error) {
      refuse(path, error);
    }
  }
  const text = 'The text holds a NUL or an unpaired surrogate';
  for (const { resources, ...topic } of manifest.topics) {
    const fields = resources.map((r) => [r.title, 'alternative' in r && r.alternative]);
    const yaml = `${folders.get(topic.id)}/topic.yaml`;
    if (unstorable([topic, fields])) problems.push(refusal('text', yaml, text));
    for (const entry of resources) {
      if (!('source' in entry)) continue;
      const mark = 'overlay' in entry && entry.overlay ? { overlay: true as const } : {};
      if (unstorable(entry.source))
        problems.push({ ...refusal('text', entry.path, text), ...mark });
      if (entry.type !== 'notebook') continue;
      try {
        contracts.checkDataPaths(entry.source.data.map((data) => data.path));
      } catch (error) {
        refuse(entry.path, error);
      }
    }
  }
  return problems;
}
