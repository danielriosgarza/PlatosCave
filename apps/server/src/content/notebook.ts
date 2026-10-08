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
import { fromParse5 } from 'hast-util-from-parse5';
import { toString as hastToString } from 'hast-util-to-string';
import { type DefaultTreeAdapterMap, parseFragment } from 'parse5';
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
 *   holds no script even where it is opened on its own. This holds for notebooks imported since
 *   that rule landed (P2-AUD4); SVG objects of earlier imports are not re-derived and stay as
 *   they were stored until the notebook is imported again.
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

/** What URL parsing drops from the start of a value, and browsers ignore inside a scheme. */
const BLANK = '[\\u0000-\\u0020]';
const BLANKS = new RegExp(BLANK, 'g');
const attrText = (value: unknown) => (Array.isArray(value) ? value.join(' ') : String(value));

/** Animation elements, which the SVG schema strips. */
const ANIMATION_TAGS = ['animate', 'animateMotion', 'animateTransform', 'set'];
/** Where an animation can put a script URL. SMIL cannot set event-handler attributes. */
const ANIMATED_VALUES = new Set(['to', 'from', 'by', 'values']);
/** The attributes an animation must target to turn a value into a link. */
const ANIMATED_LINKS = new Set(['href', 'xlink:href']);
/** Elements that may load or run a document of their own, in or out of `foreignObject`. */
const SCRIPT_CAPABLE = ['iframe', 'object', 'embed', 'meta', 'template', 'frame', 'applet'];
const URL_ATTRIBUTES = new Set(['href', 'xLinkHref', 'src', 'action', 'formAction']);

const isScriptUrl = (value: string) => /^javascript:/i.test(value.replace(BLANKS, ''));

/**
 * Whether a `capable` element brings a document of its own. `meta` only with `http-equiv=refresh`
 * and `iframe` only with `srcdoc` (a script `src` counts as any script URL does); an HTML
 * `template` is searched for what it holds instead. The rest always count.
 */
function bringsDocument(el: Element): boolean {
  if (!SCRIPT_CAPABLE.includes(el.tagName) || el.tagName === 'template') return false;
  if (el.tagName === 'meta')
    return (
      attrText(el.properties.httpEquiv ?? '')
        .trim()
        .toLowerCase() === 'refresh'
    );
  if (el.tagName === 'iframe') return el.properties.srcDoc !== undefined;
  return true;
}

/** An animation that sets a link to a script URL: `values` is a list, the rest one value. */
function animatesScriptUrl(el: Element): boolean {
  if (!ANIMATION_TAGS.includes(el.tagName)) return false;
  const target = attrText(el.properties.attributeName ?? '')
    .replace(BLANKS, '')
    .toLowerCase();
  if (!ANIMATED_LINKS.has(target)) return false;
  return [...ANIMATED_VALUES].some((name) => {
    const value = el.properties[name];
    return value !== undefined && attrText(value).split(';').some(isScriptUrl);
  });
}

/**
 * True when the markup held something that would run script were it not removed: a script
 * element, an event handler, a script URL, an animation that sets a link to one, the content of a
 * `template` (searched, though `visit` does not enter it) or, with `capable`, an element that
 * brings a document of its own (see `bringsDocument`). Elements are removed whole, so what they
 * held counts without looking inside.
 */
function hasScript(tree: Root, capable = false): boolean {
  let found = false;
  const scan = (node: Root): void =>
    visit(node, 'element', (el) => {
      if (el.tagName === 'script' || (capable && bringsDocument(el)) || animatesScriptUrl(el)) {
        found = true;
      }
      if (el.tagName === 'template' && el.content) scan(el.content);
      for (const [name, value] of Object.entries(el.properties)) {
        if (/^on[a-z]/i.test(name)) found = true;
        if (URL_ATTRIBUTES.has(name) && typeof value === 'string' && isScriptUrl(value)) {
          found = true;
        }
      }
      return undefined;
    });
  scan(tree);
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
  attributes: { '*': SVG_ATTRIBUTES, style: ['media'] },
  protocols: {},
  clobber: [],
  strip: ['script', 'foreignObject', 'metadata', ...ANIMATION_TAGS],
};
/** The link attributes (`href`, `xlink:href`) the SVG allow-list lets through to the checks. */
const SVG_REFERENCES = new Set(SVG_ATTRIBUTES.filter((name) => URL_ATTRIBUTES.has(name)));
const svgSanitizer = unified()
  .use(rehypeSanitize, svgSchema)
  .use(rehypeStringify, { space: 'svg' })
  .freeze();

type Parse5Node = DefaultTreeAdapterMap['node'];

/**
 * Removes every `template` element that parse5 made in a foreign namespace (inside `svg` or
 * `math`: directly, or in `g`, `defs`, ...). Only an HTML `template` has a `content` fragment, and
 * `hast-util-from-parse5` throws when it reads the missing one. An HTML `template` keeps its
 * content, which is searched too, and is dropped later by the allow-lists. True when one was
 * removed. Splices in place, so a tree without a foreign `template` is not copied.
 */
function dropForeignTemplates(node: Parse5Node): boolean {
  let dropped = false;
  if ('content' in node && dropForeignTemplates(node.content)) dropped = true;
  if ('childNodes' in node) {
    for (let i = node.childNodes.length - 1; i >= 0; i -= 1) {
      const child = node.childNodes[i];
      if (!child) continue;
      if (child.nodeName === 'template' && !('content' in child)) {
        node.childNodes.splice(i, 1);
        dropped = true;
      } else if (dropForeignTemplates(child)) dropped = true;
    }
  }
  return dropped;
}

/**
 * Markup as a hast fragment, parsed the way `rehype-parse` does it (`fragment` mode, no
 * scripting) but with foreign `template`s removed first, so it does not throw on them. Uses the
 * same `parse5` that `rehype-parse` resolves; keep their versions together. `templateRemoved` is
 * true when one was removed from the first top-level node that `keep` accepts (every node when
 * `keep` is not given).
 */
function parseHtmlFragment(
  html: string,
  space: 'html' | 'svg' = 'html',
  keep?: (node: Parse5Node) => boolean,
): { tree: Root; templateRemoved: boolean } {
  const fragment = parseFragment(html, { scriptingEnabled: false });
  const dropped = new Set<Parse5Node>();
  if (/template/i.test(html)) {
    for (const child of fragment.childNodes) if (dropForeignTemplates(child)) dropped.add(child);
  }
  const kept = keep && fragment.childNodes.find(keep);
  const templateRemoved = kept ? dropped.has(kept) : !keep && dropped.size > 0;
  return { tree: fromParse5(fragment, { space }) as Root, templateRemoved };
}

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

const CSS_ATTRIBUTES = /^(style|fill|stroke|filter|mask|clipPath|marker(Start|Mid|End))$/;
/** Rasters an SVG may carry in itself; `data:image/svg+xml` is not one of them. */
const DATA_IMAGE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]*$/i;
const SVG_NS = 'http://www.w3.org/2000/svg';
const LEADING_BLANK = new RegExp(`^${BLANK}+`);
/** A reference into the document, as URL parsing reads it: `#` after any leading blanks. */
const LOCAL_REFERENCE = new RegExp(`^${BLANK}*#`);
/** Script written as markup in the text of a dropped `<style>` (an escaped or CDATA payload). */
const STYLE_SCRIPT = new RegExp(
  `<\\s*(script|foreignObject|${SCRIPT_CAPABLE.join('|')})\\b|<[^>]*\\son[a-z]+\\s*=`,
  'i',
);
/** C0 controls other than tab, LF and CR: not legal in XML 1.0, so never stored. */
const stripIllegal = (text: string) =>
  text.replace(/\p{Cc}/gu, (c) => (c > '\u001f' || '\t\n\r'.includes(c) ? c : ''));

/**
 * Runs on the sanitised tree, so a stripped element cannot sit inside a token the check reads.
 * Drops CSS that fetches or holds markup, references that leave the document, and values the
 * serialiser would write as invalid XML; pins the namespaces of the root. True when a dropped
 * `<style>` held script as text.
 */
function finishSvg(root: Element): boolean {
  let markup = false;
  let xlink = false;
  // First, so the checks below see the values as they will be stored, not as they were written.
  visit(root, (node) => {
    if (node.type === 'text') node.value = stripIllegal(node.value);
    if (node.type !== 'element') return;
    for (const [name, value] of Object.entries(node.properties)) {
      if (typeof value === 'string') node.properties[name] = stripIllegal(value);
      else if (Array.isArray(value)) {
        node.properties[name] = value.map((v) => (typeof v === 'string' ? stripIllegal(v) : v));
      }
    }
  });
  visit(root, (node, index, parent) => {
    if (node.type === 'text') {
      node.value = node.value.replaceAll(']]>', ']] >');
      return undefined;
    }
    if (node.type !== 'element') return undefined;
    const el = node;
    if (el.tagName === 'style' && parent && index !== undefined) {
      const css = hastToString(el);
      if (!(el.children.every((c) => c.type === 'text') && cssIsPlain(css, true))) {
        // Elements inside were seen before sanitising; only text can still carry escaped markup.
        markup ||= STYLE_SCRIPT.test(
          el.children.map((c) => (c.type === 'text' ? c.value : '')).join(''),
        );
        parent.children.splice(index, 1);
        return ['skip', index];
      }
    }
    for (const [name, value] of Object.entries(el.properties)) {
      const text = attrText(value);
      const reference = SVG_REFERENCES.has(name);
      if (
        text.includes('<') ||
        (name === 'xmlns' && el !== root) ||
        name === 'xmlnsXLink' ||
        (reference &&
          !LOCAL_REFERENCE.test(text) &&
          !(el.tagName === 'image' && DATA_IMAGE.test(text.replace(LEADING_BLANK, '')))) ||
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
 * `scriptsRemoved` when that element held a script element, a handler, a script URL (also set by
 * an animation that sets a link to one), an element that brings a document of its own (an
 * `iframe` with `srcdoc`, `object`, a `meta` refresh, ...), a `template` that held any of these, or
 * script written as markup text in a `<style>`; `foreignObject`, animation, and `meta` or `iframe`
 * without these are removed without the flag. C0 controls other than tab, LF and CR are removed
 * from text and values, as XML 1.0 forbids them. Parsing as HTML lets HTML-only tags close the
 * `svg` early; what follows the root is dropped so the stored text stays one well-formed element.
 */
export function sanitizeSvg(svg: string): { text: string; scriptsRemoved: boolean } | null {
  const parsed = parseHtmlFragment(svg, 'svg', (n) => n.nodeName === 'svg');
  const root = parsed.tree.children.find((n): n is Element => isElement(n) && n.tagName === 'svg');
  if (!root) return null;
  const tree: Root = { type: 'root', children: [root] };
  const scriptsRemoved = hasScript(tree, true) || parsed.templateRemoved;
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
    const tree = html === null ? null : parseHtmlFragment(html).tree;
    const table = tree && tableOf(tree);
    if (table) return { ...table, executionCount };

    for (const type of IMAGE_TYPES) {
      const value = textOf(data[type]);
      if (value === null) continue;
      const image = imageBytes(type, value);
      if (!image) continue;
      const alt = textOf(data['text/plain']);
      return {
        type: 'image',
        executionCount,
        key: this.object(image.bytes, type),
        contentType: type,
        alt: alt && alt.length <= 300 ? plainText(alt).trim() : 'Image output',
        ...(image.scriptsRemoved && { scriptsRemoved: true }),
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
      const image = imageBytes(type, value);
      if (image) assets[name] = this.object(image.bytes, type);
    }
    return assets;
  }
}

/** The bytes an image output is stored as: SVG rebuilt from the allow-list, rasters decoded. */
function imageBytes(
  type: string,
  value: string,
): { bytes: Uint8Array; scriptsRemoved: boolean } | null {
  if (type !== 'image/svg+xml') {
    const bytes = decodeBase64(value);
    return bytes && { bytes, scriptsRemoved: false };
  }
  const svg = sanitizeSvg(value);
  return svg && { bytes: new TextEncoder().encode(svg.text), scriptsRemoved: svg.scriptsRemoved };
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

/**
 * One live output (a `display_data` or `execute_result` bundle a kernel sent during a session,
 * docs/design/connector.md §14) as stored output would be: the same `bundle` choice, the same
 * `outputSchema`, `sanitizeSvg` and `hasScript` passes, objects keyed under `prefix` as storage
 * will name them. Nothing else is shared with a notebook import; Markdown and LaTeX go through
 * the reading pipeline as stored outputs do.
 */
export function renderLiveOutput(
  data: Record<string, unknown>,
  executionCount: number | null,
  prefix: string,
): { output: StoredNotebookOutput; objects: NotebookObject[] } {
  const builder = new Builder(prefix);
  const output = builder.bundle(data, executionCount);
  return { output, objects: [...builder.objects.values()] };
}

/** Checks and renders the text of an `.ipynb` file; throws `NotebookError` with the reason. */
export function renderNotebook(text: string, prefix: string): RenderedNotebook {
  const parsed = parseNotebook(text);
  if (!parsed.ok) throw new NotebookError(parsed.error);
  return buildNotebook(parsed.notebook, prefix);
}
