import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { loadSource } from '../paths';

/** What stops a level 0 build (docs/design/open-site.md §4). Its message names the file. */
export class BuildStop extends Error {}
function stop(message: string): never {
  throw new BuildStop(message);
}

/** A schema of `openSite.ts`: a data file is the serialised result of its `parse`. */
type Schema = { parse(value: unknown): unknown };
type Written = { path: string; sha256: string; schema?: Schema };
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const slashed = (path: string) => path.split(sep).join('/');

/** The work folders whose output passed an audit and was not touched since, with its files. */
const audited = new Map<string, Written[]>();

/** The text of a data file: the parse result serialised, never the value it was given. */
function serialise(path: string, schema: Schema, value: unknown): string {
  try {
    return JSON.stringify(schema.parse(value));
  } catch (error) {
    return stop(`${path} does not pass its schema: ${error}`);
  }
}

/** Every entry below a folder that is no folder, as a path with forward slashes. */
function list(root: string, below = ''): string[] {
  return fs.readdirSync(join(root, below), { withFileTypes: true }).flatMap((entry) => {
    const path = below ? `${below}/${entry.name}` : entry.name;
    return entry.isDirectory() ? list(root, path) : [path];
  });
}

/** A node of the tree the server's `parseHtmlFragment` gives; a `template` has `content`. */
type Node = { type: string; tagName?: string; properties?: Record<string, unknown> };
type Tree = Node & { children?: Tree[]; content?: Tree };
type Parser = { parseHtmlFragment(html: string): { tree: Tree; templateRemoved: boolean } };
/** Every node of a tree, the content of a `template` included. */
const under = (node: Tree) => [node.content ?? [], node.children ?? []].flat();
const nodes = (node: Tree): Node[] => [node, ...under(node).flatMap(nodes)];
/** An attribute's name in the allow-list or in hast, alike: `class`, `className`; `data-a`, `dataA`. */
const flat = (name: string) => name.replace(/^(class)Name$|^html(For)$|-/g, '$1$2').toLowerCase();

/**
 * The object addresses a data file names: `pdf.url`, `file`, an output's `url`, and each `src` in
 * an HTML string (`html`, and the slides of a web deck). A Shiny app's `url` is the app's own.
 */
function named(value: unknown, read: (html: string) => string[], key = '', app = false): string[] {
  if (typeof value === 'string') {
    if (key === 'file' || (key === 'url' && !app)) return [value];
    return key === 'html' || key === 'slides' ? read(value) : [];
  }
  if (typeof value !== 'object' || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => named(item, read, key));
  const shiny = 'type' in value && value.type === 'shiny';
  return Object.entries(value).flatMap(([name, inner]) => named(inner, read, name, shiny));
}

/**
 * The one write path of a level 0 build (docs/design/open-site.md §4). It empties `workDir`, the
 * site's `.parallax/open`, and writes `content/` (objects named by their digests) and `site/` (the
 * shell, copies of its `index.html`, and data that passed a schema, at `openPaths` decoded without
 * the first slash). `finish` holds the folder to the writer's record before `placeOutput` places it.
 */
export async function createOutput(options: { workDir: string; contentOrigin: string }) {
  const root = resolve(options.workDir);
  if (!slashed(root).endsWith('/.parallax/open')) stop(`${root} is not a site's .parallax/open`);
  const given = options.contentOrigin;
  const url = URL.canParse(given) ? new URL(given) : undefined;
  // An origin and nothing more: no path, query, fragment, user name or password.
  const origin = url && url.href === `${url.origin}/` ? url.origin : 'null';
  if (origin === 'null') stop(`${given} is not an origin, which the content host needs`);
  type Contracts = typeof import('@parallax/contracts');
  const contracts = await loadSource<Contracts>('contracts', 'src/index.ts');
  const { READING_HTML_TAGS: tags, READING_HTML_ATTRIBUTES: allowed } = contracts;
  const { parseHtmlFragment } = await loadSource<Parser>('server', 'src/content/html-fragment.ts');
  // HTML is read with conversion's parser (parse5) as a browser builds a page's body, without
  // scripting, and vouched for only inside the allow-list of both sanitisers (`readingHtml.ts`),
  // where a browser builds what parse5 builds and only `src` loads. Outside it: a comment (none from
  // conversion; parsers differ on CDATA in MathML), a template in svg or math (parse5 drops it).
  const outside = ({ type, tagName = '', properties = {} }: Node): string[] => {
    if (type !== 'element') return type === 'comment' ? ['a comment'] : [];
    if (!tags.includes(tagName)) return [`<${tagName}>`];
    const names = [...(allowed['*'] ?? []), ...(allowed[tagName] ?? [])].map(flat);
    const odd = Object.keys(properties).filter((name) => !names.includes(flat(name)));
    return odd.map((name) => `${name} on <${tagName}>`);
  };
  /** The `src` values of an HTML string; what of it the audit cannot vouch for goes to `unread`. */
  const read = (html: string, unread: string[]) => {
    const { tree, templateRemoved } = parseHtmlFragment(`<body>${html}`);
    const all = nodes(tree);
    unread.push(...(templateRemoved ? ['a template in svg or math'] : []), ...all.flatMap(outside));
    return all.flatMap(({ properties: p }) => (p && 'src' in p ? [String(p.src)] : []));
  };
  audited.delete(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  fs.mkdirSync(root, { recursive: true });
  /** Every file written, by its path in lower case; `schema` for a data file. */
  const written = new Map<string, Written>();
  /** Every folder that holds a written file, in lower case, with the first such file. */
  const folders = new Map<string, string>();
  /** The digest of every object and of every course file the build opened, with its path. */
  const courseBytes = new Map<string, string>();
  const addresses = new Set<string>();
  let index: Uint8Array | undefined;

  /** No output has the path of another or lies below it, compared without case (§2). */
  function write(path: string, bytes: Uint8Array, schema?: Schema, digest = sha256(bytes)): void {
    const file = resolve(root, path);
    // On every system a path inside its tree, and no `\` or control character, which no folder has.
    const odd = /[\\\p{Cc}]/u.test(path) || slashed(relative(root, file)) !== path;
    if (odd) stop(`${path} is no path inside the output, or it holds \\ or a control character`);
    const key = path.toLowerCase();
    const above = [...key.matchAll(/\//g)].map(({ index }) => key.slice(0, index));
    const taken = [key, ...above].map((at) => written.get(at)?.path).find(Boolean);
    // One spelling per folder, compared name by name, as a lower case may be longer (U+0130).
    const spelt = (at: string, depth: number) => at.split('/', depth + 1).join('/');
    const firsts = above.map((at) => folders.get(at));
    const respelt = firsts.find((f, depth) => f && spelt(f, depth) !== spelt(path, depth));
    const other = taken ?? folders.get(key) ?? respelt;
    if (other) stop(`${other} and ${path} cannot both be written: they need one path`);
    for (const folder of above) if (!folders.has(folder)) folders.set(folder, path);
    written.set(key, { path, sha256: digest, schema });
    audited.delete(root);
    fs.mkdirSync(dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }

  return {
    /** Writes `content/o/<sha256>.<ext>` and gives its address on the content origin. */
    object(bytes: Uint8Array, contentType: string): string {
      const ext = contracts.objectExtension(contentType);
      if (!ext) stop(`an object of type ${contentType} cannot be written: no such object type`);
      const digest = sha256(bytes);
      const name = `o/${digest}.${ext}`;
      if (!written.has(`content/${name}`)) write(`content/${name}`, bytes, undefined, digest);
      courseBytes.set(digest, `content/${name}`);
      addresses.add(`${origin}/${name}`);
      return `${origin}/${name}`;
    },
    /** Writes the parse result of `value` at a `.json` path. */
    data(path: string, schema: Schema, value: unknown): void {
      if (!path.endsWith('.json')) stop(`${path} is not a .json path: a data file has one`);
      write(`site/${path}`, Buffer.from(serialise(path, schema, value)), schema);
    },
    /** Writes a file of the compiled shell; every address copies `index.html`, kept as written. */
    shell(path: string, bytes: Uint8Array): void {
      write(`site/${path}`, bytes);
      if (path === 'index.html') index = Uint8Array.from(bytes);
    },
    /** Copies the shell's `index.html` to an address (`courses`); `/` is the shell's own file. */
    address(path: string): void {
      if (!index) stop(`${path} has no index.html to copy: the shell has not written its own`);
      write(`site/${path}/index.html`, index);
    },
    /** Records a course file that the build opened: no file under `site/` may have its bytes. */
    untrusted(digest: string, file: string): void {
      if (!/^[0-9a-f]{64}$/.test(digest)) stop(`${file}: ${digest} is no sha256 in lower-case hex`);
      audited.delete(root);
      courseBytes.set(digest, file);
    },
    /** The audit: every file of the work folder is read again and held to the record. */
    finish(): void {
      // An earlier audit counts no longer, whether this one passes or stops.
      audited.delete(root);
      if (!index) stop('site/index.html is missing: without the shell there is no site to audit');
      const found = new Set(list(root));
      const stray = [...found].find((path) => written.get(path.toLowerCase())?.path !== path);
      if (stray) stop(`${stray} is not a file this build wrote`);
      for (const { path, sha256: digest, schema } of written.values()) {
        if (!found.has(path)) stop(`${path} is missing: this build wrote it`);
        const bytes = fs.readFileSync(join(root, path));
        if (sha256(bytes) !== digest) stop(`${path} does not have the bytes this build wrote`);
        // Under content/ that is all: the writer names an object by its digest and its type.
        if (path.startsWith('content/')) continue;
        // A file of the site's own sources, a logo for one, must differ from course content.
        const twin = courseBytes.get(digest);
        if (twin) stop(`${path} has the bytes of ${twin}, course content: change the site's file`);
        if (!schema) continue;
        const text = bytes.toString();
        const value: unknown = JSON.parse(text);
        // Defence in depth: it stops only for a schema whose parse result does not parse to itself.
        const same = serialise(path, schema, value) === text;
        if (!same) stop(`${path} is not the serialised result of parsing it`);
        const unread: string[] = [];
        for (const address of named(value, (html) => read(html, unread))) {
          const url = URL.canParse(address) ? new URL(address) : undefined;
          const there = url?.origin === origin && !url.username && !url.password;
          const fault = there ? 'at a path this build did not write' : 'not on the content origin';
          if (!there || !addresses.has(address))
            stop(`${path} names "${address}", which is ${fault}`);
        }
        const why = 'the audit cannot vouch for what a browser builds from it, or loads';
        if (unread[0]) stop(`${path} holds ${unread[0]}, outside the reading allow-list: ${why}`);
      }
      audited.set(root, [...written.values()]);
    },
  };
}
export type Output = Awaited<ReturnType<typeof createOutput>>;

/**
 * Replaces the content of the site's `dist/` with the output that passed its audit, and only with
 * that: `dist/` is emptied first, so a placing that fails leaves no file of an earlier build, and
 * each file is read again and placed only with the bytes its audit read. The work folder is kept.
 */
export function placeOutput(workDir: string, distDir: string): void {
  const root = resolve(workDir);
  const files = audited.get(root);
  if (!files) stop(`nothing is placed: the output in ${root} has not passed its audit`);
  if (resolve(distDir) !== resolve(root, '../../dist')) stop(`${distDir} is not the site's dist`);
  fs.mkdirSync(distDir, { recursive: true });
  for (const name of fs.readdirSync(distDir))
    fs.rmSync(join(distDir, name), { recursive: true, force: true, maxRetries: 3 });
  for (const tree of ['site', 'content']) fs.mkdirSync(join(distDir, tree));
  for (const { path, sha256: digest } of files) {
    const bytes = fs.readFileSync(join(root, path));
    if (sha256(bytes) !== digest) stop(`${path} was changed after its audit: it is not placed`);
    fs.mkdirSync(dirname(join(distDir, path)), { recursive: true });
    fs.writeFileSync(join(distDir, path), bytes);
  }
}
