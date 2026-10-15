import { createHash } from 'node:crypto';
import { CourseFileRefused, type CourseManifest, declareWorkspaceFiles } from '@parallax/contracts';
import { describe, expect, test } from 'vitest';
import { BundleMismatch, checkedFile, notebookWithData } from './folder-input';

// The upload rules on the server's side (docs/design/course-folder.md §8): each file of a sync
// bundle is checked while it streams into storage, and a notebook names its stored data files.

type File = CourseManifest['files'][number];
const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (content: Uint8Array) => createHash('sha256').update(content).digest('hex');
const file = (format: File['format'], content: Uint8Array): File => ({
  ...{ path: 'sampling/reading/a', format },
  ...{ size: content.length, sha256: sha256(content) },
});
async function* chunks(...parts: Uint8Array[]) {
  yield* parts;
}
/** The bytes storage receives, and the error the stream ends with. */
async function drain(stream: AsyncIterable<Uint8Array>) {
  const got: number[] = [];
  try {
    for await (const chunk of stream) got.push(...chunk);
  } catch (error) {
    return { got, error };
  }
  return { got, error: undefined };
}
function thrown(call: () => unknown): unknown {
  try {
    call();
  } catch (error) {
    return error;
  }
  return undefined;
}

// The editor's module is loaded when the test runs, from a path built here, as courseFiles.test.ts
// loads it: it imports the web client, which `tsc` of the server must not follow.
const editorModule = new URL('../../../web/src/authoring/workspaceFiles.ts', import.meta.url);
const editor = (await import(/* @vite-ignore */ editorModule.href)) as {
  pathProblem: (path: string, others: readonly string[]) => string | undefined;
};

const notebook = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] });
const [a, b] = ['3f6a1c2e-5b4d-4e8f-9a0b-1c2d3e4f5a6b', '7d8e9f0a-1b2c-4d3e-8f4a-5b6c7d8e9f0a'];

describe('folder input', () => {
  test.each([
    ['a PDF without its signature', 'pdf', '%PDX-1.7 rest', 'The file is not a PDF'],
    ['a Markdown file with a NUL byte', 'markdown', '# A\0', 'The file is not text'],
    ['an empty data file', 'data', '', 'The file is empty'],
  ] as const)("%s ends the stream with the rule's message", async (_, format, text, message) => {
    const content = bytes(text);
    const { error } = await drain(checkedFile(file(format, content), chunks(content)));
    expect(error).toBeInstanceOf(CourseFileRefused);
    expect(error).toHaveProperty('message', message);
  });

  test('the first refusal ends the file: the refused chunk and the ones after it are not passed on', async () => {
    const parts = [bytes('# A'), bytes('\0'), bytes(' and the rest')];
    const content = bytes('# A\0 and the rest');
    const { got, error } = await drain(checkedFile(file('markdown', content), chunks(...parts)));
    expect(got).toEqual([...bytes('# A')]);
    expect(error).toBeInstanceOf(CourseFileRefused);
    expect(error).toHaveProperty('message', 'The file is not text');
  });

  // A notebook: had the rules' end() judged these bytes first, each would be refused as no notebook.
  const stated = bytes(notebook);
  const altered = stated.map((byte, i) => (i === stated.length - 1 ? 0x5d : byte)); // } becomes ]
  test.each([
    ['a short', [stated.subarray(0, 10)], `the bundle holds 10 of the ${stated.length} bytes`],
    ['a long', [stated, bytes('x')], `the bundle holds more than the ${stated.length} bytes`],
    ['an altered', [altered], 'the bytes differ from the sha256'],
  ])('%s file ends the stream with a BundleMismatch that names it', async (_, sent, what) => {
    const { got, error } = await drain(checkedFile(file('notebook', stated), chunks(...sent)));
    expect(error).toBeInstanceOf(BundleMismatch);
    expect(error).toHaveProperty('message', `sampling/reading/a: ${what} the manifest states`);
    // The chunk that passes the stated size is not passed on.
    expect(got).toEqual([...(sent[0] ?? [])]);
  });

  test('a file the manifest states is passed on whole', async () => {
    const content = bytes(notebook);
    const parts = [content.subarray(0, 5), content.subarray(5)];
    expect(await drain(checkedFile(file('notebook', content), chunks(...parts)))).toEqual({
      ...{ got: [...content] },
      error: undefined,
    });
  });

  test('a notebook with two data files comes out as declareWorkspaceFiles gives it', () => {
    // The rows revisionPayload declares carry a size, which the stored notebook does not hold.
    const declared = [
      { path: 'data/a.csv', resourceId: a, size: 3 },
      { path: 'data/b.csv', resourceId: b, size: 5 },
    ];
    const pairs = [
      { path: 'data/a.csv', resourceId: a },
      { path: 'data/b.csv', resourceId: b },
    ];
    const stored = notebookWithData(notebook, declared);
    expect(stored).toBe(declareWorkspaceFiles(notebook, pairs));
    expect(JSON.parse(stored).metadata.parallax.files).toStrictEqual(pairs);
  });

  test.each([
    ['data/a.csv', 'data/a.csv', 'data/a.csv', 'Another file already has this path'],
    ['data', 'data/a.csv', 'data', 'A file cannot also be a folder of another file'],
    ['data/a.csv', 'data', 'data/a.csv', 'A file cannot also be a folder of another file'],
    ['data/a.csv', 'data/b.csv ', 'data/b.csv ', 'The path starts or ends with a space'],
    ['data/a.csv', ' ', ' ', 'Enter a path'],
  ])("data paths “%s” and “%s” are refused with the editor's sentence", (...row) => {
    const [first, second, named, sentence] = row;
    const paths = [first, second];
    const files = paths.map((path, i) => ({ path, resourceId: [a, b][i] ?? a }));
    const error = thrown(() => notebookWithData(notebook, files));
    expect(error).toBeInstanceOf(CourseFileRefused);
    expect(error).toHaveProperty('message', `${named}: ${sentence}`);
    const others = paths.filter((_, i) => i !== paths.indexOf(named));
    expect(editor.pathProblem(named, others)).toBe(sentence);
  });

  test('a data path that is no WorkspacePath is refused', () => {
    const files = [
      { path: 'data/a.csv', resourceId: a },
      { path: '../a.csv', resourceId: b },
    ];
    const error = thrown(() => notebookWithData(notebook, files));
    expect(error).toBeInstanceOf(CourseFileRefused);
    expect(error).toHaveProperty(
      'message',
      '“../a.csv” is no relative path without empty, dot or hidden segments',
    );
  });
});
