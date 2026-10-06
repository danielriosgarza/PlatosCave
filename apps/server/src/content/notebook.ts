import { createHash } from 'node:crypto';
import {
  joinLines,
  type NbCell,
  type NbNotebook,
  type NbOutput,
  parseNotebook,
  type StoredNotebook,
  type StoredNotebookOutput,
} from '@parallax/contracts';
import type { Element, ElementContent, Root, RootContent } from 'hast';
import { toString as hastToString } from 'hast-util-to-string';
import rehypeParse from 'rehype-parse';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { renderReading } from './reading';

/**
 * Notebook import (§10.1, §10.7): an `.ipynb` file in, the notebook as the reader shows it out.
 * Nothing is executed, and no stored output reaches the app origin as markup of its own:
 *
 * - Markdown cells, and Markdown or LaTeX outputs, go through the native reading pipeline and
 *   its allow-list (ADR-0002 §Readings on the app origin), and the browser sanitises them again.
 * - Text, errors and HTML tables become plain text the reader renders as text.
 * - Images and every other HTML output become separate objects on the content origin: images
 *   are shown with `<img>`, HTML in a frame with no script permission, served under the
 *   content origin's `sandbox` CSP. Scripts and event handlers are removed from that HTML too.
 * - SVG outputs and attachments are parsed and rebuilt from an SVG allow-list (no script, event
 *   handler, `foreignObject`, animation, or reference leaving the document), so a stored output
 *   holds no script even where it is opened on its own.
 */

/** An object the notebook's outputs need, under the key its bytes give it. */
export interface NotebookObject {
  key: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface RenderedNotebook {
  notebook: StoredNotebook;
  objects: NotebookObject[];
  /** Problems an editor can fix, such as equations that did not render. */
  warnings: string[];
}

/** A problem with the notebook itself, reported to the editor. */
export class NotebookError extends Error {}

/** Longest text kept from one output; the rest is cut and the output says so (§10.4). */
export const MAX_OUTPUT_CHARS = 50_000;
/** Largest table shown as text; a larger one is shown as its HTML in a frame. */
const MAX_TABLE_CELLS = 5000;
/** Frame heights for HTML outputs, estimated from their content (no script can measure them). */
const FRAME_MIN = 80;
const FRAME_MAX = 600;

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'];
/** Served with an explicit charset: the content origin sends the type it is given. */
const HTML_TYPE = 'text/html; charset=utf-8';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Escape sequences terminals use for colour and cursor movement, as tracebacks carry them. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences is the point
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g;

/** Terminal text as it would read: no escape codes, and a `\r` overwrites its line (progress bars). */
export function plainText(text: string): string {
  return text
    .replace(ANSI, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n');
}

function cut(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_OUTPUT_CHARS), truncated: true };
}

const textOf = (value: unknown): string | null =>
  typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? value.join('')
      : null;

const htmlParser = unified().use(rehypeParse, { fragment: true }).freeze();

/**
 * What an HTML output may keep inside its sandboxed frame: GitHub's schema plus styles (class,
 * `style` attributes and elements, which pandas and most libraries use) and data-URL images.
 * The frame already cannot run script; removing it here keeps that true if the frame or the
 * content origin's policy were ever loosened.
 */
export const outputSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    'style',
    'figure',
    'figcaption',
    'caption',
    'colgroup',
    'col',
  ],
  attributes: {
    ...defaultSchema.attributes,
    '*': [...(defaultSchema.attributes?.['*'] ?? []), 'className', 'style'],
    img: ['alt', 'src', 'title', 'width', 'height'],
  },
  protocols: { ...defaultSchema.protocols, src: ['http', 'https', 'data'] },
  ancestors: { ...defaultSchema.ancestors, caption: ['table'], col: ['table'] },
  // Inside its own document an id cannot clobber anything of the app.
  clobber: [],
  strip: [
    'script',
    'iframe',
    'object',
    'embed',
    'noscript',
    'template',
    'textarea',
    'title',
    'head',
  ],
};
const outputSanitizer = unified().use(rehypeSanitize, outputSchema).use(rehypeStringify).freeze();

/**
 * True when the markup held something that would run script were it not removed. `tags` names
 * more elements that count (SVG's `foreignObject`).
 */
function hasScript(tree: Root, tags: string[] = []): boolean {
  let found = false;
  visit(tree, 'element', (el) => {
    if (el.tagName === 'script' || tags.includes(el.tagName)) found = true;
    for (const [name, value] of Object.entries(el.properties)) {
      if (/^on[a-z]/i.test(name)) found = true;
      if (
        (name === 'href' ||
          name === 'xLinkHref' ||
          name === 'src' ||
          name === 'action' ||
          name === 'formAction') &&
        typeof value === 'string' &&
        // biome-ignore lint/suspicious/noControlCharactersInRegex: browsers ignore them in schemes
        /^javascript:/i.test(value.replace(/[\u0000- ]/g, ''))
      ) {
        found = true;
      }
    }
  });
  return found;
}

/** Drawing elements and presentation attributes an SVG output may keep; all else is dropped. */
const SVG_TAGS = (
  'svg g defs symbol use path rect circle ellipse line polyline polygon text tspan textPath ' +
  'title desc image linearGradient radialGradient stop pattern clipPath mask marker style ' +
  'filter feBlend feColorMatrix feComponentTransfer feComposite feConvolveMatrix ' +
  'feDiffuseLighting feDisplacementMap feDistantLight feDropShadow feFlood feFuncA feFuncB ' +
  'feFuncG feFuncR feGaussianBlur feMerge feMergeNode feMorphology feOffset fePointLight ' +
  'feSpecularLighting feSpotLight feTile feTurbulence'
).split(' ');
const SVG_ATTRIBUTES = (
  'xmlns id className style transform viewBox width height x y x1 x2 y1 y2 cx cy r rx ry d ' +
  'points dx dy rotate textLength lengthAdjust href preserveAspectRatio version baseProfile ' +
  'fill fillOpacity fillRule stroke strokeWidth strokeOpacity strokeLineCap strokeLineJoin ' +
  'strokeMiterLimit strokeDashArray strokeDashOffset opacity visibility display overflow ' +
  'clipPath clipRule clipPathUnits mask maskUnits maskContentUnits filter filterUnits ' +
  'primitiveUnits markerStart markerMid markerEnd markerWidth markerHeight markerUnits ' +
  'refX refY orient fontFamily fontSize fontStyle fontWeight fontVariant textAnchor ' +
  'dominantBaseline alignmentBaseline baselineShift letterSpacing wordSpacing textDecoration ' +
  'writingMode direction unicodeBidi stopColor stopOpacity offset gradientUnits ' +
  'gradientTransform spreadMethod fx fy fr patternUnits patternContentUnits patternTransform ' +
  'in in2 result mode type values stdDeviation operator k1 k2 k3 k4 order kernelMatrix ' +
  'divisor bias targetX targetY edgeMode scale xChannelSelector yChannelSelector tableValues ' +
  'slope intercept amplitude exponent floodColor floodOpacity colorInterpolationFilters ' +
  'baseFrequency numOctaves seed stitchTiles surfaceScale diffuseConstant specularConstant ' +
  'specularExponent lightingColor azimuth elevation z pointsAtX pointsAtY pointsAtZ ' +
  'limitingConeAngle radius vectorEffect shapeRendering textRendering colorInterpolation ' +
  'startOffset method spacing side xmlnsXLink xLinkHref xmlSpace color paintOrder pathLength ' +
  'pointerEvents font'
).split(' ');
const svgSchema: SanitizeSchema = {
  tagNames: SVG_TAGS,
  attributes: { '*': SVG_ATTRIBUTES },
  protocols: {},
  clobber: [],
  strip: [
    'script',
    'foreignObject',
    'metadata',
    'animate',
    'animateMotion',
    'animateTransform',
    'set',
  ],
};
const svgSanitizer = unified()
  .use(rehypeSanitize, svgSchema)
  .use(rehypeStringify, { space: 'svg' })
  .freeze();
const svgParser = unified().use(rehypeParse, { fragment: true, space: 'svg' }).freeze();

/** In-document references: `url(#id)`, quoted or spaced. */
const LOCAL_URL = /url\(\s*(['"]?)\s*#[^)'"\s]*\s*\1\s*\)/gi;

/**
 * Whether CSS (a `<style>` body or a presentation attribute) may be stored. It is kept only when
 * it is plain: no escapes or at-rules (they hide `url(` and `@import`) and every `url(` points
 * into the document. A `<style>` body is also written raw, so it may hold none of `<`, `&` or
 * `]]>`, which would be markup or malformed XML there. Anything else is dropped, never repaired.
 */
function cssIsPlain(css: string, raw = false): boolean {
  if (/[\\@]/.test(css) || (raw && (/[<&]/.test(css) || css.includes(']]>')))) return false;
  return !/url\(|image-set|image\(|expression\s*\(|javascript:/i.test(css.replace(LOCAL_URL, ''));
}

const CSS_ATTRIBUTES = /^(style|fill|stroke|filter|mask|clipPath|marker(Start|Mid|End)|cursor)$/;
/** Rasters an SVG may carry in itself; `data:image/svg+xml` is not one of them. */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i;
const SVG_NS = 'http://www.w3.org/2000/svg';
const SCRIPT_TAGS = ['foreignObject', 'animate', 'animateMotion', 'animateTransform', 'set'];

/**
 * Runs on the sanitised tree, so a stripped element cannot sit inside a token the check reads.
 * Drops CSS that fetches or holds markup, references that leave the document, and values the
 * serialiser would write as invalid XML; pins the namespaces of the root. True when a `<style>`
 * held markup.
 */
function finishSvg(root: Element): boolean {
  let markup = false;
  let xlink = false;
  visit(root, (node, index, parent) => {
    if (node.type === 'text') {
      node.value = node.value.replaceAll(']]>', ']] >');
      return undefined;
    }
    if (node.type !== 'element') return undefined;
    const el = node;
    if (el.tagName === 'style' && parent && index !== undefined) {
      const css = hastToString(el);
      if (el.children.every((c) => c.type === 'text') && cssIsPlain(css, true)) return undefined;
      markup ||= css.includes('<') || el.children.some((c) => c.type === 'element');
      parent.children.splice(index, 1);
      return ['skip', index];
    }
    for (const [name, value] of Object.entries(el.properties)) {
      const text = Array.isArray(value) ? value.join(' ') : String(value);
      const reference = name === 'href' || name === 'xLinkHref';
      if (
        text.includes('<') ||
        (name === 'xmlns' && el !== root) ||
        name === 'xmlnsXLink' ||
        (reference &&
          !text.trim().startsWith('#') &&
          !(el.tagName === 'image' && DATA_IMAGE.test(text.trim()))) ||
        (CSS_ATTRIBUTES.test(name) && !cssIsPlain(text))
      ) {
        delete el.properties[name];
      } else if (name === 'xLinkHref') xlink = true;
    }
    return undefined;
  });
  root.properties.xmlns = SVG_NS;
  if (xlink) root.properties.xmlnsXLink = 'http://www.w3.org/1999/xlink';
  return markup;
}

/**
 * SVG text as it may be stored: only the root `svg` element, rebuilt from the allow-list, with
 * the SVG namespace set so it displays on its own; null when the text holds no `svg` element.
 * `scriptsRemoved` when that element held script, a handler, a script URL, foreign markup,
 * animation or CSS that carried markup. Parsing as HTML lets HTML-only tags close the `svg`
 * early; what follows the root is dropped so the stored text stays one well-formed element.
 */
export function sanitizeSvg(svg: string): { text: string; scriptsRemoved: boolean } | null {
  const root = svgParser
    .parse(svg)
    .children.find((n): n is Element => isElement(n) && n.tagName === 'svg');
  if (!root) return null;
  const tree: Root = { type: 'root', children: [root] };
  const scriptsRemoved = hasScript(tree, SCRIPT_TAGS);
  const clean = svgSanitizer.runSync(tree);
  const [cleanRoot] = clean.children;
  if (!cleanRoot || !isElement(cleanRoot)) return null;
  const markup = finishSvg(cleanRoot);
  return { text: svgSanitizer.stringify(clean), scriptsRemoved: scriptsRemoved || markup };
}

const FRAME_STYLE =
  'body{margin:8px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2328;background:#fff}' +
  'table{border-collapse:collapse}th,td{padding:4px 10px;border-bottom:1px solid #d9d9d9;text-align:right}' +
  'img{max-width:100%}';

/** The frame document of one HTML output: sanitised content in a page of its own. */
function frameDocument(tree: Root): string {
  const body = outputSanitizer.stringify(outputSanitizer.runSync(structuredClone(tree)));
  return `<!doctype html><html><head><meta charset="utf-8"><style>${FRAME_STYLE}</style></head><body>${body}</body></html>`;
}

const LINE_TAGS = new Set('p tr li br div h1 h2 h3 h4 h5 h6 dt dd caption'.split(' '));

/** A height that shows a typical output whole; the reader can resize the frame. */
function frameHeight(tree: Root): number {
  let lines = 0;
  visit(tree, 'element', (el) => {
    if (LINE_TAGS.has(el.tagName)) lines += 1;
    if (el.tagName === 'pre') lines += hastToString(el).split('\n').length;
    if (el.tagName === 'img') lines += 8;
  });
  return Math.min(FRAME_MAX, Math.max(FRAME_MIN, 32 + lines * 26));
}

const isElement = (node: RootContent | ElementContent): node is Element => node.type === 'element';
const isBlank = (node: RootContent | ElementContent) =>
  node.type === 'comment' || (node.type === 'text' && node.value.trim() === '');

const span = (value: unknown): number | undefined => {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isInteger(n) && n > 1 ? Math.min(n, 1000) : undefined;
};

const cellText = (el: Element) => hastToString(el).replace(/\s+/g, ' ').trim();

/**
 * An HTML output that is one plain table (a pandas DataFrame and the like) as text rows, so it
 * reads inline; null for anything else (nested tables, images or forms in cells, other markup).
 */
export function tableOf(tree: Root): Extract<StoredNotebookOutput, { type: 'table' }> | null {
  // Unwrap containers holding a single table, plus style sheets and trailing paragraphs.
  let nodes: (RootContent | ElementContent)[] = tree.children;
  const notes: string[] = [];
  let table: Element | undefined;
  for (let depth = 0; depth < 4 && !table; depth += 1) {
    const kept = nodes.filter((n) => !isBlank(n) && !(isElement(n) && n.tagName === 'style'));
    const [first, ...rest] = kept;
    if (!first || !isElement(first)) return null;
    if (!rest.every((n) => isElement(n) && n.tagName === 'p')) return null;
    for (const p of rest as Element[]) notes.push(cellText(p));
    if (first.tagName === 'table') table = first;
    else if (first.tagName === 'div' && rest.length === 0) nodes = first.children;
    else return null;
  }
  if (!table) return null;
  let caption: string | null = null;
  const head: Extract<StoredNotebookOutput, { type: 'table' }>['head'] = [];
  const body: typeof head = [];
  let count = 0;
  const readRow = (tr: Element): (typeof head)[number] | null => {
    const row: (typeof head)[number] = [];
    for (const cell of tr.children) {
      if (isBlank(cell)) continue;
      if (!isElement(cell) || (cell.tagName !== 'th' && cell.tagName !== 'td')) return null;
      let plain = true;
      visit(cell, 'element', (el) => {
        if (
          el !== cell &&
          !['span', 'b', 'strong', 'em', 'i', 'code', 'br', 'abbr', 'sub', 'sup'].includes(
            el.tagName,
          )
        ) {
          plain = false;
        }
      });
      if (!plain) return null;
      count += 1;
      const colSpan = span(cell.properties.colSpan);
      const rowSpan = span(cell.properties.rowSpan);
      row.push({
        text: cellText(cell),
        header: cell.tagName === 'th',
        ...(colSpan && { colSpan }),
        ...(rowSpan && { rowSpan }),
      });
    }
    return row;
  };
  const readRows = (parent: Element, into: typeof head): boolean => {
    for (const tr of parent.children) {
      if (isBlank(tr)) continue;
      if (!isElement(tr) || tr.tagName !== 'tr') return false;
      const row = readRow(tr);
      if (!row) return false;
      into.push(row);
    }
    return true;
  };
  for (const part of table.children) {
    if (isBlank(part)) continue;
    if (!isElement(part)) return null;
    if (part.tagName === 'caption' && caption === null) caption = cellText(part);
    else if (part.tagName === 'thead') {
      if (!readRows(part, head)) return null;
    } else if (part.tagName === 'tbody' || part.tagName === 'tfoot') {
      if (!readRows(part, body)) return null;
    } else if (part.tagName === 'tr') {
      const row = readRow(part);
      if (!row) return null;
      body.push(row);
    } else if (part.tagName !== 'colgroup') return null;
    if (count > MAX_TABLE_CELLS) return null;
  }
  if (head.length + body.length === 0) return null;
  return { type: 'table', executionCount: null, caption, head, body, notes };
}

function decodeBase64(value: string): Uint8Array | null {
  const compact = value.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length === 0) return null;
  return new Uint8Array(Buffer.from(compact, 'base64'));
}

class Builder {
  readonly objects = new Map<string, NotebookObject>();
  readonly warnings: string[] = [];

  constructor(private readonly prefix: string) {}

  /** Records an object and returns its content-addressed key, as storage will name it. */
  object(bytes: Uint8Array, contentType: string): string {
    const key = `${this.prefix}/objects/${sha256(bytes)}`;
    if (!this.objects.has(key)) this.objects.set(key, { key, contentType, bytes });
    return key;
  }

  markdown(source: string, assets: Record<string, string> = {}) {
    const rendered = renderReading(source, 'markdown', assets);
    this.warnings.push(...rendered.warnings);
    return rendered;
  }

  /** One representation of a display or result bundle, the safest static one first (§10.7). */
  bundle(data: Record<string, unknown>, executionCount: number | null): StoredNotebookOutput {
    const html = textOf(data['text/html']);
    const tree = html === null ? null : htmlParser.parse(html);
    const table = tree && tableOf(tree);
    if (table) return { ...table, executionCount };

    for (const type of IMAGE_TYPES) {
      const value = textOf(data[type]);
      if (value === null) continue;
      const svg = type === 'image/svg+xml' ? sanitizeSvg(value) : null;
      if (type === 'image/svg+xml' && !svg) continue;
      const bytes = svg ? new TextEncoder().encode(svg.text) : decodeBase64(value);
      if (!bytes) continue;
      const alt = textOf(data['text/plain']);
      return {
        type: 'image',
        executionCount,
        key: this.object(bytes, type),
        contentType: type,
        alt: alt && alt.length <= 300 ? plainText(alt).trim() : 'Image output',
        ...(svg?.scriptsRemoved && { scriptsRemoved: true }),
      };
    }
    for (const type of ['text/markdown', 'text/latex']) {
      const value = textOf(data[type]);
      if (value !== null)
        return { type: 'markdown', executionCount, html: this.markdown(value).html };
    }
    if (tree) {
      return {
        type: 'html',
        executionCount,
        key: this.object(new TextEncoder().encode(frameDocument(tree)), HTML_TYPE),
        height: frameHeight(tree),
        scriptsRemoved: hasScript(tree),
      };
    }
    const plain = textOf(data['text/plain']);
    if (plain !== null)
      return { type: 'text', executionCount, stream: null, ...cut(plainText(plain)) };
    if (data['application/json'] !== undefined) {
      const json = JSON.stringify(data['application/json'], null, 2) ?? '';
      return { type: 'text', executionCount, stream: null, ...cut(json) };
    }
    return { type: 'unsupported', executionCount, mimeTypes: Object.keys(data).sort() };
  }

  outputs(outputs: NbOutput[]): StoredNotebookOutput[] {
    const result: StoredNotebookOutput[] = [];
    for (const output of outputs) {
      if (output.output_type === 'stream') {
        const stream = output.name === 'stderr' ? 'stderr' : 'stdout';
        const text = joinLines(output.text);
        // Jupyter shows consecutive writes to one stream as one block.
        const last = result.at(-1);
        if (last?.type === 'text' && last.stream === stream && !last.truncated) {
          Object.assign(last, cut(last.text + plainText(text)));
        } else result.push({ type: 'text', executionCount: null, stream, ...cut(plainText(text)) });
      } else if (output.output_type === 'error') {
        const traceback = cut(plainText(output.traceback.join('\n')));
        result.push({
          type: 'error',
          executionCount: null,
          name: output.ename,
          value: plainText(output.evalue),
          traceback: traceback.text,
          truncated: traceback.truncated,
        });
      } else {
        const count = output.output_type === 'execute_result' ? output.execution_count : null;
        result.push(this.bundle(output.data, count));
      }
    }
    return result;
  }

  /** Images a Markdown cell attaches, as names its source can use without the `attachment:` scheme. */
  attachments(cell: Extract<NbCell, { cell_type: 'markdown' }>): Record<string, string> {
    const assets: Record<string, string> = {};
    for (const [name, data] of Object.entries(cell.attachments ?? {})) {
      const type = IMAGE_TYPES.find((t) => textOf(data[t]) !== null);
      const value = type && textOf(data[type]);
      if (!type || !value) continue;
      const svg = type === 'image/svg+xml' ? sanitizeSvg(value) : null;
      const bytes =
        type === 'image/svg+xml' ? svg && new TextEncoder().encode(svg.text) : decodeBase64(value);
      if (bytes) assets[name] = this.object(bytes, type);
    }
    return assets;
  }
}

const jupyterFlag = (metadata: Record<string, unknown>, name: string): boolean => {
  const jupyter = metadata.jupyter;
  return (
    typeof jupyter === 'object' &&
    jupyter !== null &&
    (jupyter as Record<string, unknown>)[name] === true
  );
};

/**
 * Builds the reader's notebook from a checked nbformat document. `prefix` is the course's
 * object prefix (`courses/{courseId}`): output objects get the keys storage will give them.
 */
export function buildNotebook(nb: NbNotebook, prefix: string): RenderedNotebook {
  const builder = new Builder(prefix);
  const used = new Set<string>();
  const outline: StoredNotebook['outline'] = [];
  const cells = nb.cells.map((cell, index): StoredNotebook['cells'][number] => {
    let id = cell.id && !used.has(cell.id) ? cell.id : `cell-${index}`;
    while (used.has(id)) id = `${id}-${index}`;
    used.add(id);
    const source = joinLines(cell.source);
    if (cell.cell_type === 'markdown') {
      const assets = builder.attachments(cell);
      // `attachment:name` is a scheme the reading pipeline drops; the name alone resolves.
      const rendered = builder.markdown(source.replace(/\]\(\s*(<?)attachment:/g, ']($1'), assets);
      for (const block of rendered.blockMap) {
        const level = /^h([1-6])$/.exec(block.tag)?.[1];
        const text = block.text.replace(/\s+/g, ' ').trim();
        if (level && text) outline.push({ cellId: id, level: Number(level), text });
      }
      return { id, type: 'markdown', html: rendered.html };
    }
    if (cell.cell_type === 'raw') return { id, type: 'raw', text: source };
    return {
      id,
      type: 'code',
      source,
      executionCount: cell.execution_count,
      sourceHidden: jupyterFlag(cell.metadata, 'source_hidden'),
      outputsHidden:
        jupyterFlag(cell.metadata, 'outputs_hidden') || cell.metadata.collapsed === true,
      outputs: builder.outputs(cell.outputs),
    };
  });
  const { kernelspec, language_info } = nb.metadata;
  return {
    notebook: {
      kernel: kernelspec?.display_name.trim() || language_info?.name || null,
      language: language_info?.name ?? kernelspec?.name ?? null,
      cells,
      outline,
    },
    objects: [...builder.objects.values()],
    warnings: builder.warnings,
  };
}

/** Checks and renders the text of an `.ipynb` file; throws `NotebookError` with the reason. */
export function renderNotebook(text: string, prefix: string): RenderedNotebook {
  const parsed = parseNotebook(text);
  if (!parsed.ok) throw new NotebookError(parsed.error);
  return buildNotebook(parsed.notebook, prefix);
}
