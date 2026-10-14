import { expect, test } from 'vitest';
import * as rules from './courseFiles';

type Declare = typeof rules.declareWorkspaceFiles;
// The editor's module is loaded when the test runs, from a path built here and not through a
// static import: it imports the web client, which `tsc` of this package must not follow (§8).
const editorModule = new URL('../../../apps/web/src/authoring/workspaceFiles.ts', import.meta.url);
const editor = (await import(/* @vite-ignore */ editorModule.href)) as { declareFiles: Declare };

const MiB = 1024 * 1024;
const notebook = (extra: object = {}) =>
  JSON.stringify({ nbformat: 4, nbformat_minor: 4, metadata: {}, cells: [], ...extra });
const pdf = (size: number) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(size - 9)]);
const bytes = (content: string | number[]) =>
  Uint8Array.from(typeof content === 'string' ? Buffer.from(content) : content);
const upload = (name: string, content: string | number[]) =>
  rules.checkCourseFile(rules.uploadFormatOf(name), bytes(content));
const inChunks = (format: rules.CourseFileFormat, ...chunks: (string | number[])[]) => {
  const check = rules.courseFileCheck(format);
  for (const chunk of chunks) check.push(bytes(chunk));
  return check.end();
};
const paths = (count: number) => Array.from({ length: count }, (_, i) => `data/q${i}.csv`);

const files = [{ path: 'data/quadrats.csv', resourceId: '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d' }];
const kernel = { kernelspec: { name: 'python3', display_name: 'Python 3' } };
/** What a declaration gives: the notebook's new text, or the sentence it throws with. */
function outcome(declare: Declare, text: string, declared = files): string {
  try {
    return declare(text, declared);
  } catch (err) {
    return `thrown: ${(err as Error).message}`;
  }
}

test('declareWorkspaceFiles returns the string the editor’s declareFiles returns, and throws where it throws', () => {
  const notebooks = [
    notebook({ metadata: kernel }),
    notebook({ metadata: undefined }),
    notebook({ metadata: { ...kernel, parallax: { files: [{ path: 'old.csv' }], note: 'kept' } } }),
    notebook({ metadata: { parallax: 'none' } }),
    notebook({ metadata: [] }),
  ];
  const broken = ['', '{', '[]', 'null', '"counts"', '3'];
  for (const text of [...notebooks, ...broken]) {
    const theirs = [outcome(editor.declareFiles, text), outcome(editor.declareFiles, text, [])];
    const ours = [
      outcome(rules.declareWorkspaceFiles, text),
      outcome(rules.declareWorkspaceFiles, text, []),
    ];
    expect(ours, text).toEqual(theirs);
    expect(theirs[0]?.startsWith('thrown: The notebook is not '), text).toBe(broken.includes(text));
  }
  const declared = JSON.parse(rules.declareWorkspaceFiles(notebooks[0] ?? '', files));
  expect(declared.metadata).toEqual({ ...kernel, parallax: { files } });
  expect(() => rules.declareWorkspaceFiles('{', files)).toThrow(rules.CourseFileRefused);
});

const EMPTY = 'The file is empty';
const TOO_LARGE = 'The file is larger than 25 MB';
const NOT_PDF = 'The file is not a PDF';
const NO_FORMAT = 'Upload a Markdown (.md), HTML (.html), PDF (.pdf) or notebook (.ipynb) file';
const NOT_UTF8 = 'The text is not valid UTF-8';
const NOT_TEXT = 'The file is not text';
const NO_PATH = '“data/.cache/q.csv” is no relative path without empty, dot or hidden segments';
const NOT_V4 = 'Only nbformat 4 notebooks can be imported; save it with Jupyter 4 or later';
const NOT_JSON = 'The file is not a Jupyter notebook: it is not valid JSON';

test.each<[what: string, sentence: string, run: () => unknown]>([
  ['an empty file', EMPTY, () => upload('methods.md', '')],
  ['an empty data file', EMPTY, () => rules.checkCourseFile('data', Buffer.alloc(0))],
  ['a 26 MiB file', TOO_LARGE, () => rules.checkCourseFile('pdf', pdf(26 * MiB))],
  ['a 26 MiB data file', TOO_LARGE, () => rules.checkCourseFile('data', Buffer.alloc(26 * MiB))],
  [
    '101 data files',
    'A notebook declares at most 100 files',
    () => rules.checkDataPaths(paths(101)),
  ],
  [
    'a data path that is no WorkspacePath',
    NO_PATH,
    () => rules.checkDataPaths(['q.csv', 'data/.cache/q.csv']),
  ],
  ['a .pdf that does not start with %PDF-', NOT_PDF, () => upload('paper.pdf', '<p>Fish</p>')],
  ['a .pdf of four bytes', NOT_PDF, () => upload('paper.pdf', '%PDF')],
  ['a .pdf whose second chunk breaks the signature', NOT_PDF, () => inChunks('pdf', '%P', 'NG-1')],
  ['an extension outside uploadFormats', NO_FORMAT, () => rules.uploadFormatOf('notes.htm')],
  ['a name without an extension', NO_FORMAT, () => rules.uploadFormatOf('constructor')],
  ['invalid UTF-8', NOT_UTF8, () => upload('methods.md', [0x23, 0xff, 0x41])],
  ['UTF-8 that ends inside a character', NOT_UTF8, () => upload('page.html', [0x3c, 0xc3])],
  ['a NUL byte in a text format', NOT_TEXT, () => upload('page.html', [0x3c, 0x00, 0x3e])],
  ['a NUL byte in a notebook', NOT_TEXT, () => upload('counts.ipynb', [0x7b, 0x7d, 0x00])],
  [
    'a notebook parseNotebook rejects',
    NOT_V4,
    () => upload('counts.ipynb', notebook({ nbformat: 3 })),
  ],
  ['a notebook that is no JSON', NOT_JSON, () => upload('counts.ipynb', '# Counts')],
])('the upload rules refuse %s', (_, sentence, run) => {
  // The first compares the sentence, and the second the class.
  expect(run).toThrow(new rules.CourseFileRefused(sentence));
  expect(run).toThrow(rules.CourseFileRefused);
});

test('a file of each accepted kind passes with its stored content type', () => {
  expect(upload('methods.md', '# Methods\n')).toBe('text/markdown');
  expect(upload('Methods.MARKDOWN', '# Methods\r\n')).toBe('text/markdown');
  expect(upload('page.html', '<p>Tide tables</p>')).toBe('text/html');
  expect(rules.checkCourseFile(rules.uploadFormatOf('paper.PDF'), pdf(25 * MiB))).toBe(
    'application/pdf',
  );
  expect(upload('counts.ipynb', notebook())).toBe('application/x-ipynb+json');
  expect(rules.checkCourseFile('data', Buffer.from([0, 0xff]))).toBe('application/octet-stream');
  expect(() => rules.checkDataPaths(paths(100))).not.toThrow();
  // The first bytes of a PDF, and the bytes of one character, may come in separate chunks.
  expect(inChunks('pdf', '%P', 'DF-1.7')).toBe('application/pdf');
  expect(inChunks('markdown', [0x63, 0x61, 0x66, 0xc3], [0xa9])).toBe('text/markdown');
  expect(inChunks('notebook', notebook().slice(0, 9), notebook().slice(9))).toBe(
    'application/x-ipynb+json',
  );
});
