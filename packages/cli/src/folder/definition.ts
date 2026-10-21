import * as fs from 'node:fs';
import { join } from 'node:path';
import type { ExerciseV1, TestV1 } from '@parallax/contracts';
import { loadSource } from '../paths';
import { sameButCase } from './listing';
import { type Field, type Parsed, type Problem, parseYaml, refusal } from './yaml';

type Contracts = typeof import('@parallax/contracts');
const contracts = () => loadSource<Contracts>('contracts', 'src/index.ts');
/** A zod schema, as far as it is used here: the tool reaches the contracts when it runs. */
type Issue = {
  code?: string;
  path: PropertyKey[];
  message: string;
  keys?: string[];
  params?: unknown;
};
type Schema<T> = {
  safeParse(
    value: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: Issue[] } };
};

/** A problem at a field of a parsed file, as design §3 names it: `resources[1].title`, its line. */
export function problemAt(file: Parsed, at: Field, message: string, code = 'schema'): Problem {
  const key = (name: PropertyKey, i: number) =>
    typeof name === 'number' ? `[${name}]` : `${i ? '.' : ''}${String(name)}`;
  const field = at.length > 0 ? { field: at.map(key).join('') } : {};
  return { ...refusal(code, file.path, message), ...field, line: file.lineOf(at) };
}

/** A value as its schema gives it and no problem, or the problems that refuse it and no value. */
export type Checked<T> = { value: T; problems: [] } | { value?: undefined; problems: Problem[] };

/**
 * A parsed file's value as its schema gives it, or one problem for each field it refuses;
 * `words` rewrites the refusals' messages first.
 */
export function checked<T>(
  file: Parsed,
  schema: Schema<T>,
  words: (issues: Issue[]) => Issue[] = (issues) => issues,
): Checked<T> {
  if (file.problems.length > 0) return { problems: file.problems };
  const result = schema.safeParse(file.value);
  if (result.success) return { value: result.data, problems: [] };
  const problems = words(result.error.issues).flatMap(({ code, path, keys = [], message }) =>
    code === 'unrecognized_keys'
      ? keys.map((key) => problemAt(file, [...path, key], 'unknown key'))
      : [problemAt(file, path, message)],
  );
  return { problems };
}

/** A definition as its schema gives it, which is what is stored, or the problems that refuse it. */
export type Loaded<T> =
  | { definition: T; problems: [] }
  | { definition?: undefined; problems: Problem[] };
const loaded = <T>({ value, problems }: Checked<T>): Loaded<T> =>
  value === undefined ? { problems } : { definition: value, problems: [] };

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
/** `root` is the folder a definition is read from, `file` its path there, as a listing gave it. */
export function parse(root: string, file: string): Parsed {
  const bytes = fs.readFileSync(join(root, file));
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    // Read leniently, an invalid byte would become U+FFFD in what is stored, and nobody told.
    const problems = [refusal('yaml', file, 'this file is not valid UTF-8')];
    return { path: file, value: undefined, problems, lineOf: () => undefined };
  }
  return parseYaml(text, file);
}
const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const items = (value: unknown) => (Array.isArray(value) ? [...value.entries()] : []);
/** The value written out: in `parseYaml`'s value an alias is the object of its anchor. */
const writtenOut = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(writtenOut);
  if (!isMap(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, writtenOut(item)]));
};

/** An exercise (docs/design/course-folder.md §5): the file's value goes unchanged to `exerciseV1`. */
export async function loadExercise(root: string, file: string): Promise<Loaded<ExerciseV1>> {
  const { exerciseV1, iconHints } = await contracts();
  // An unknown icon is named with the nearest icons, as in the editor and on the server.
  return loaded(checked(parse(root, file), exerciseV1, iconHints));
}

/**
 * A test (design §5): first a `files` entry of a code question that has no `content` gets it from
 * its code file, `<test>/<question id>/<path>` beside the definition (design §2), then `testV1`.
 * `listed` holds the files that the listing of the folder gave, by their paths from `root`
 * (`definitionSource` returns them). The schema has not run by then, so this step holds a question
 * id and a path to the schema's own patterns, and it opens a file only where `listed` names it:
 * a path that leaves the test's folder, and a spelling the directory does not have, open nothing.
 */
export async function loadTest(
  root: string,
  file: string,
  listed: string[],
): Promise<Loaded<TestV1>> {
  const { testV1, codeQuestion, codeFile } = await contracts();
  const parsed = parse(root, file);
  // A file the parser refuses has no value: its problems are the result, and no schema runs.
  if (parsed.problems.length > 0) return { problems: parsed.problems };
  // Written out, so that each place an alias stands gets its own file.
  const value = writtenOut(parsed.value);
  const problems: Problem[] = [];
  const refuse = (at: PropertyKey[], message: string) =>
    problems.push(problemAt(parsed, at, message, 'code_file'));
  const folder = `${file.replace(/\.yaml$/i, '')}/`;
  const beside = new Set(listed.filter((path) => path.startsWith(folder)));
  // Every listed spelling, so that a case difference anywhere in the path is found.
  const spelled = new Map(listed.map((path) => [path.toLowerCase(), path]));
  const named = new Set<string>();
  for (const [q, question] of items(isMap(value) ? value.questions : undefined)) {
    if (!isMap(question) || question.kind !== 'code') continue;
    const id = codeQuestion.shape.id.safeParse(question.id);
    if (!id.success) {
      refuse(['questions', q, 'id'], 'expected a question id, so none of its files is read');
      continue;
    }
    if (!Array.isArray(question.files)) {
      // The schema names a `files` that is no list; the files of the question wait for that.
      for (const path of beside) if (path.startsWith(`${folder}${id.data}/`)) named.add(path);
      continue;
    }
    for (const [f, entry] of question.files.entries()) {
      // An entry that is no map is the schema's to refuse.
      if (!isMap(entry)) continue;
      const at = ['questions', q, 'files', f];
      const path = codeFile.shape.path.safeParse(entry.path);
      if (!path.success) {
        refuse([...at, 'path'], 'expected a path inside the question’s folder, so no file is read');
        continue;
      }
      const code = `${folder}${id.data}/${path.data}`;
      if ('content' in entry) {
        named.add(code);
        if (beside.has(code)) refuse([...at, 'content'], `${code} holds it as well`);
        continue;
      }
      // Decided from the listing: a file system that ignores case opens either spelling.
      const disk = spelled.get(code.toLowerCase());
      const twin = disk && sameButCase(disk, code) ? disk : undefined;
      named.add(twin ?? code);
      if (twin) {
        refuse([...at, 'path'], `${code} differs only in case from ${twin}, the name on disk`);
      } else if (!beside.has(code)) {
        refuse([...at, 'path'], `no file ${code}`);
      } else {
        const bytes = fs.readFileSync(join(root, code));
        try {
          entry.content =
            entry.encoding === 'base64' ? bytes.toString('base64') : utf8.decode(bytes);
        } catch {
          refuse([...at, 'path'], `${code} is not valid UTF-8`);
        }
      }
    }
  }
  for (const path of beside) {
    if (!named.has(path)) problems.push(refusal('code_file', path, 'no entry names it'));
  }
  if (problems.length > 0) return { problems };
  return loaded(checked({ ...parsed, value }, testV1));
}
