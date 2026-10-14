import { isMap, isNode, isScalar, LineCounter, parseDocument, visit } from 'yaml';

/**
 * A problem of a course folder (docs/design/course-folder.md §7). `path` is from the course
 * folder, with `/`; with `overlay` it is from the course's own folder in the overlay.
 */
export type Problem = {
  severity: 'error' | 'warning' | 'note';
  code: string;
  path: string;
  overlay?: true;
  field?: string;
  line?: number;
  message: string;
};

/** An error at a path. */
export function refusal(code: string, path: string, message: string): Problem {
  return { severity: 'error', code, path, message };
}

/** The keys and positions that lead to a field: `['resources', 1, 'title']`. */
export type Field = readonly PropertyKey[];
/** A file read as YAML: its JSON value, or problems and no value; `lineOf` finds a field's line. */
export type Parsed = {
  path: string;
  value: unknown;
  problems: Problem[];
  lineOf(field: Field): number | undefined;
};

/** The parser's two refusals of design §5, in the words of a course's author. */
const words: Record<string, string> = {
  DUPLICATE_KEY: 'this key stands twice in one map',
  MULTIPLE_DOCS: 'a second document starts here, and a file holds one',
};

/**
 * Reads a file as one YAML 1.2 document with the core schema (design §5) and gives the value
 * `JSON.parse` gives for the same content written as JSON: maps with string keys, lists, strings,
 * finite numbers, booleans and null. No date is made, no tag outside the core schema is
 * interpreted, and aliases are written out within the parser's alias limit.
 */
export function parseYaml(text: string, path: string): Parsed {
  const counter = new LineCounter();
  // The schema is named, so that neither a `%YAML 1.1` directive nor a tag brings in another type.
  const options = { schema: 'core', resolveKnownTags: false } as const;
  const doc = parseDocument(text, { ...options, lineCounter: counter, prettyErrors: false });
  const line = (offset?: number) =>
    offset === undefined ? undefined : counter.linePos(offset).line;
  const problems: Problem[] = [];
  const refuse = (message: string, offset?: number) =>
    problems.push({ ...refusal('yaml', path, message), line: line(offset) });
  for (const error of doc.errors) refuse(words[error.code] ?? error.message, error.pos[0]);
  // The parser accepts these three, and afterwards a number key is a string like any other.
  visit(doc, {
    Alias(_, alias, above) {
      const target = alias.resolve(doc);
      if (!target) refuse(`no anchor ${alias.source} stands before this alias`, alias.range?.[0]);
      else if (above.includes(target)) {
        refuse('this alias points into its own node, so the value has no end', alias.range?.[0]);
      }
    },
    Pair(_, { key }) {
      // An alias in a key's place is refused too: the parser's check for a second key skips it.
      if (isScalar(key) && typeof key.value === 'string') return;
      refuse('a key must be a string', isNode(key) ? key.range?.[0] : undefined);
    },
    Scalar(_, { value, range }) {
      if (typeof value === 'number' && !Number.isFinite(value)) {
        refuse('this number is not finite', range?.[0]);
      }
    },
  });
  let value: unknown;
  try {
    if (problems.length === 0) value = doc.toJS();
  } catch (error) {
    // Aliases past the parser's limit: written out, the value would be larger than it allows.
    refuse(error instanceof Error ? error.message : String(error));
  }
  const lineOf = (field: Field) => {
    // A field that is absent has the line of its nearest parent; a key stands before its value.
    for (let end = field.length; end >= 0; end--) {
      const parent = end > 0 ? doc.getIn(field.slice(0, end - 1), true) : undefined;
      const name = (key: unknown) => isScalar(key) && key.value === field[end - 1];
      const key = isMap(parent) ? parent.items.find((pair) => name(pair.key))?.key : undefined;
      const node = key ?? doc.getIn(field.slice(0, end), true);
      if (isNode(node) && node.range) return line(node.range[0]);
    }
  };
  return { path, value, problems, lineOf };
}
