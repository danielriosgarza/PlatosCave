import { createHash } from 'node:crypto';
import type { Element, ElementContent, Nodes, Root } from 'hast';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeParse from 'rehype-parse';
import rehypeSanitize, { defaultSchema, type Options as SanitizeSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';

/**
 * Native reading ingestion (§8, ADR-0003): Markdown or HTML in, sanitised HTML out, with every
 * block element carrying a stable `data-block-id` and every figure a `data-figure-id`. Images
 * keep only the storage key of an uploaded file (`data-object-key`); the reader turns that into a
 * short-lived content URL at read time (`resolveReadingImages`), so stored HTML holds no tokens.
 */

export type ReadingFormat = 'markdown' | 'html';

export interface BlockEntry {
  id: string;
  tag: string;
  /** The block's text content, as a browser's `textContent` reports it (anchor offsets). */
  text: string;
}

export interface FigureEntry {
  id: string;
  /** Storage key of the figure's image, when it is an uploaded file of the reading. */
  objectKey: string | null;
  alt: string;
  caption: string;
}

export interface RenderedReading {
  html: string;
  blockMap: BlockEntry[];
  figures: FigureEntry[];
  /** Problems the author can fix, such as images that are not uploaded files. */
  warnings: string[];
}

/** Elements that get a block id; anchors (ADR-0003) reference the nearest one. */
const BLOCK_TAGS = new Set(
  'p h1 h2 h3 h4 h5 h6 li pre blockquote td th dt dd figcaption'.split(' '),
);
const MATH_DISPLAY_CLASS = 'math-display';

/** Prefix the sanitiser gives ids, so uploaded markup cannot clobber names the app uses. */
const CLOBBER_PREFIX = 'user-content-';

/** MathML elements KaTeX emits; MathML only, so no `style` or class soup reaches the page. */
const MATHML_TAGS = (
  'math annotation semantics menclose merror mfrac mi mn mo mover mpadded mphantom mroot mrow ' +
  'ms mspace msqrt mstyle msub msubsup msup mtable mtd mtext mtr munder munderover'
).split(' ');
const MATHML_ATTRIBUTES = (
  'accent accentunder columnalign columnlines columnspacing depth display displaystyle encoding ' +
  'fence height linethickness lspace mathvariant maxsize minsize movablelimits notation ' +
  'rowlines rowspacing rspace scriptlevel separator stretchy symmetric width'
).split(' ');

/**
 * GitHub's schema plus figures, KaTeX MathML and highlight classes. `picture`/`source` and
 * `longDesc` go: they would load images from anywhere, past the image rewrite below.
 */
export const readingSchema: SanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []).filter((t) => t !== 'picture' && t !== 'source'),
    'figure',
    'figcaption',
    'caption',
    'colgroup',
    'col',
    ...MATHML_TAGS,
  ],
  attributes: {
    ...defaultSchema.attributes,
    code: [['className', /^language-./, 'hljs']],
    img: ['alt', 'src', 'title'],
    span: [['className', /^hljs-[a-z_-]+$/, 'katex']],
    ...Object.fromEntries(MATHML_TAGS.map((t) => [t, MATHML_ATTRIBUTES])),
  },
  ancestors: { ...defaultSchema.ancestors, caption: ['table'], col: ['table'] },
};

const sha12 = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 12);

/** Whitespace-collapsed NFC text: what block ids hash, so reflowed source keeps its ids. */
export const normaliseText = (text: string): string =>
  text.normalize('NFC').replace(/\s+/g, ' ').trim();

/** ADR-0003: first 12 hex of sha256(normalisedText + ':' + occurrenceIndex). */
export const blockId = (normalisedText: string, occurrence: number): string =>
  sha12(`${normalisedText}:${occurrence}`);

/** `textContent` of a hast node: all descendant text, no layout. */
export function textContent(node: Nodes): string {
  if (node.type === 'text') return node.value;
  if ('children' in node) return node.children.map((c) => textContent(c as Nodes)).join('');
  return '';
}

const classes = (el: Element): string[] => {
  const c = el.properties.className;
  return Array.isArray(c) ? c.map(String) : [];
};

const isElement = (node: ElementContent): node is Element => node.type === 'element';

/** Display math (a KaTeX span holding `<math display="block">`) becomes its own block. */
function liftDisplayMath(tree: Root): void {
  visit(tree, 'element', (el) => {
    if (el.tagName !== 'span' || !classes(el).includes('katex')) return;
    const math = el.children.find(isElement);
    if (math?.tagName === 'math' && math.properties.display === 'block') {
      el.tagName = 'div';
      el.properties.className = [MATH_DISPLAY_CLASS];
    }
  });
}

/** A paragraph holding only one image is a figure; the image title becomes its caption. */
function paragraphImagesToFigures(tree: Root): void {
  visit(tree, 'element', (el) => {
    if (el.tagName !== 'p') return;
    const content = el.children.filter((c) => !(c.type === 'text' && c.value.trim() === ''));
    const [img] = content;
    if (content.length !== 1 || !img || !isElement(img) || img.tagName !== 'img') return;
    const title = typeof img.properties.title === 'string' ? img.properties.title : '';
    el.tagName = 'figure';
    el.children = [img];
    if (title) {
      el.children.push({
        type: 'element',
        tagName: 'figcaption',
        properties: {},
        children: [{ type: 'text', value: title }],
      });
    }
  });
}

/** In-document links follow the sanitiser's id prefix; other links open without a referrer. */
function fixLinks(tree: Root): void {
  visit(tree, 'element', (el) => {
    if (el.tagName !== 'a' || typeof el.properties.href !== 'string') return;
    const href = el.properties.href;
    if (href.startsWith('#')) {
      if (!href.startsWith(`#${CLOBBER_PREFIX}`))
        el.properties.href = `#${CLOBBER_PREFIX}${href.slice(1)}`;
    } else {
      el.properties.rel = ['noopener', 'noreferrer', 'nofollow'];
    }
  });
}

/**
 * Images may only show uploaded files of this reading: the source name is looked up in `assets`
 * and replaced by its storage key; anything else (remote URLs, unknown names) loses its `src`.
 */
function rewriteImages(tree: Root, assets: Record<string, string>, warnings: string[]): void {
  visit(tree, 'element', (el) => {
    if (el.tagName !== 'img') return;
    const src = typeof el.properties.src === 'string' ? el.properties.src : '';
    delete el.properties.src;
    if (!src) return;
    const name = src.replace(/^\.\//, '');
    let decoded = name;
    try {
      decoded = decodeURIComponent(name);
    } catch {}
    const key = assets[name] ?? assets[decoded];
    if (key) el.properties.dataObjectKey = key;
    else warnings.push(`Image "${src}" is not an uploaded file of this reading`);
  });
}

function assignIds(tree: Root): { blockMap: BlockEntry[]; figures: FigureEntry[] } {
  const blockMap: BlockEntry[] = [];
  const figures: FigureEntry[] = [];
  const seenText = new Map<string, number>();
  const seenFigure = new Map<string, number>();
  visit(tree, 'element', (el) => {
    const isBlock =
      BLOCK_TAGS.has(el.tagName) ||
      (el.tagName === 'div' && classes(el).includes(MATH_DISPLAY_CLASS));
    if (isBlock) {
      const text = textContent(el);
      const normalised = normaliseText(text);
      const occurrence = seenText.get(normalised) ?? 0;
      seenText.set(normalised, occurrence + 1);
      const id = blockId(normalised, occurrence);
      el.properties.dataBlockId = id;
      blockMap.push({ id, tag: el.tagName, text });
    }
    if (el.tagName === 'figure') {
      let img: Element | undefined;
      let caption = '';
      visit(el, 'element', (child) => {
        if (child.tagName === 'img' && !img) img = child;
        if (child.tagName === 'figcaption' && !caption) caption = normaliseText(textContent(child));
      });
      const objectKey =
        typeof img?.properties.dataObjectKey === 'string' ? img.properties.dataObjectKey : null;
      // The image identifies the figure; a figure without an uploaded image is known by its text.
      const ref = objectKey ?? `text:${normaliseText(textContent(el))}`;
      const occurrence = seenFigure.get(ref) ?? 0;
      seenFigure.set(ref, occurrence + 1);
      const id = sha12(`figure:${ref}:${occurrence}`);
      el.properties.dataFigureId = id;
      const alt = typeof img?.properties.alt === 'string' ? img.properties.alt : '';
      figures.push({ id, objectKey, alt, caption });
    }
  });
  return { blockMap, figures };
}

/**
 * Renders one native reading. `assets` maps image names used in the source to storage keys of
 * the revision's own objects. Raw HTML inside Markdown is dropped; HTML uploads are sanitised.
 */
export function renderReading(
  source: string,
  format: ReadingFormat,
  assets: Record<string, string> = {},
): RenderedReading {
  let tree: Root;
  if (format === 'markdown') {
    const markdown = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkMath)
      // Footnote ids without a prefix: the sanitiser adds one, and fixLinks follows it.
      .use(remarkRehype, { clobberPrefix: '' });
    tree = markdown.runSync(markdown.parse(source));
  } else {
    tree = unified().use(rehypeParse, { fragment: true }).parse(source);
  }

  const transform = unified()
    .use(rehypeKatex, { output: 'mathml' })
    .use(rehypeHighlight, { detect: false })
    .use(rehypeSanitize, readingSchema);
  const clean = transform.runSync(tree);

  const warnings: string[] = [];
  liftDisplayMath(clean);
  paragraphImagesToFigures(clean);
  fixLinks(clean);
  rewriteImages(clean, assets, warnings);
  const { blockMap, figures } = assignIds(clean);
  const html = unified().use(rehypeStringify).stringify(clean);
  return { html, blockMap, figures, warnings };
}

/**
 * Read time: gives each uploaded image a URL from `urlFor` (a content-token minting function);
 * an image whose key it refuses keeps no `src` and shows its alt text.
 */
export function resolveReadingImages(html: string, urlFor: (key: string) => string | null): string {
  const processor = unified().use(rehypeParse, { fragment: true });
  const tree = processor.parse(html);
  visit(tree, 'element', (el) => {
    if (el.tagName !== 'img' || typeof el.properties.dataObjectKey !== 'string') return;
    const url = urlFor(el.properties.dataObjectKey);
    if (url) el.properties.src = url;
  });
  return unified().use(rehypeStringify).stringify(tree);
}
