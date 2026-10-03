import type { Element, ElementContent, Nodes, Root } from 'hast';
import { toString as hastToString } from 'hast-util-to-string';
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
import { SKIP, visit } from 'unist-util-visit';
import { VFile } from 'vfile';
import { blockId, normaliseText, sha12 } from './text';

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
  /** The 1-based slide the block is on; only blocks of a slide deck have one. */
  slide?: number;
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
  'fence height largeop linebreak linethickness lspace mathbackground mathcolor mathsize ' +
  'mathvariant maxsize minsize movablelimits notation rowlines rowspacing rspace scriptlevel ' +
  'separator stretchy symmetric voffset width'
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
  // Removed with their content rather than unwrapped: a document head or style sheet would
  // otherwise turn into stray visible text.
  strip: [
    'script',
    'style',
    'title',
    'head',
    'iframe',
    'textarea',
    'noscript',
    'object',
    'embed',
    'template',
    'svg',
  ],
};

export { blockId, normaliseText };

/** `textContent` of a hast node: all descendant text, no layout. */
export const textContent = (node: Nodes): string => hastToString(node);

const classes = (el: Element): string[] => {
  const c = el.properties.className;
  return Array.isArray(c) ? c.map(String) : [];
};

const isElement = (node: ElementContent): node is Element => node.type === 'element';

/** Elements whose content model allows a `div`, so display math may stand as a block in them. */
const FLOW_PARENTS = new Set(
  'article aside blockquote dd details div figure footer header li main nav section td th'.split(
    ' ',
  ),
);

const isBlank = (node: ElementContent) => node.type === 'text' && node.value.trim() === '';

/**
 * Display math (a KaTeX span holding `<math display="block">`) becomes its own block where a
 * block may stand. A paragraph holding nothing else is replaced by it; display math inside a
 * paragraph with other content (possible only in uploaded HTML) stays inline, since a `div` in a
 * `p` would close the paragraph in the browser and break the block map.
 */
function liftDisplayMath(tree: Root): void {
  visit(tree, 'element', (el, index, parent) => {
    if (el.tagName !== 'span' || !classes(el).includes('katex')) return;
    const math = el.children.find(isElement);
    if (math?.tagName !== 'math' || math.properties.display !== 'block') return;
    if (!parent || index === undefined) return;
    const lift = () => {
      el.tagName = 'div';
      el.properties.className = [MATH_DISPLAY_CLASS];
    };
    if (parent.type === 'root' || FLOW_PARENTS.has(parent.tagName)) {
      lift();
      return SKIP;
    }
    if (parent.tagName === 'p' && parent.children.every((c) => c === el || isBlank(c))) {
      lift();
      // The paragraph becomes the display block itself, keeping its place in the tree.
      // It keeps its own sanitised attributes (an `id` a link targets, `dir`, `lang`).
      parent.tagName = 'div';
      parent.properties = { ...parent.properties, ...el.properties };
      parent.children = el.children;
      return SKIP;
    }
  });
}

/** A paragraph holding only one image is a figure; the image title becomes its caption. */
function paragraphImagesToFigures(tree: Root): void {
  visit(tree, 'element', (el) => {
    if (el.tagName !== 'p') return;
    const content = el.children.filter((c) => !isBlank(c));
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
    // The sanitiser prefixes every id, even one that already starts with the prefix, so every
    // in-document link gets the prefix too.
    if (href.startsWith('#')) el.properties.href = `#${CLOBBER_PREFIX}${href.slice(1)}`;
    else {
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
    if (!src) {
      // The sanitiser removes `data:`, `blob:` and script URLs; say so rather than show nothing.
      const alt = typeof el.properties.alt === 'string' ? el.properties.alt : '';
      warnings.push(`Image "${alt}" has no usable source; upload it as a file of this reading`);
      return;
    }
    const name = src.replace(/^\.\//, '');
    let decoded = name;
    try {
      decoded = decodeURIComponent(name);
    } catch {}
    const lookup = (n: string) => (Object.hasOwn(assets, n) ? assets[n] : undefined);
    const key = lookup(name) ?? lookup(decoded);
    if (typeof key === 'string' && key) el.properties.dataObjectKey = key;
    else warnings.push(`Image "${src}" is not an uploaded file of this reading`);
  });
}

const isBlockElement = (el: Element): boolean =>
  BLOCK_TAGS.has(el.tagName) || (el.tagName === 'div' && classes(el).includes(MATH_DISPLAY_CLASS));

/** Content that stands on its own inside a wrapper: a block, or a figure (known by its own id). */
const isNested = (el: Element): boolean => isBlockElement(el) || el.tagName === 'figure';

/**
 * A block whose text all lies inside nested blocks or figures (a loose list item, a blockquote,
 * a cell holding paragraphs or an image) only wraps them. It gets no id: its text would repeat a child's and take
 * an occurrence from it, so an edit elsewhere in the wrapper would renumber the unchanged child.
 * Anchors in it belong to the nested blocks.
 */
function isWrapper(el: Element): boolean {
  let nested = false;
  let ownText = '';
  const walk = (node: Element) => {
    for (const child of node.children) {
      if (child.type === 'text') ownText += child.value;
      else if (child.type === 'element') {
        if (isNested(child)) nested = true;
        else walk(child);
      }
    }
  };
  walk(el);
  return nested && ownText.trim() === '';
}

function assignIds(tree: Root): { blockMap: BlockEntry[]; figures: FigureEntry[] } {
  const blockMap: BlockEntry[] = [];
  const figures: FigureEntry[] = [];
  const seenText = new Map<string, number>();
  const seenFigure = new Map<string, number>();
  visit(tree, 'element', (el) => {
    if (isBlockElement(el) && !isWrapper(el)) {
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

// Built once: rehype-highlight registers its grammars when a processor is first used.
const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  // Footnote ids without a prefix: the sanitiser adds one, and fixLinks follows it.
  .use(remarkRehype, { clobberPrefix: '' })
  .freeze();
const htmlParser = unified().use(rehypeParse, { fragment: true }).freeze();
const transformProcessor = unified()
  .use(rehypeKatex, { output: 'mathml' })
  .use(rehypeHighlight, { detect: false })
  .use(rehypeSanitize, readingSchema)
  .freeze();
const stringifier = unified().use(rehypeStringify).freeze();

/**
 * The HTML parser drops a newline directly after `<pre>`, so a `pre` whose text starts with one
 * is serialised with one more, as browsers do: the reader's `textContent` then equals the text
 * in the block map, and parsing the stored HTML again yields the same tree.
 */
function stringify(tree: Root): string {
  visit(tree, 'element', (el) => {
    const [first] = el.children;
    if (el.tagName === 'pre' && first?.type === 'text' && first.value.startsWith('\n')) {
      first.value = `\n${first.value}`;
    }
  });
  return stringifier.stringify(tree);
}

/** A sanitised KaTeX error keeps an empty `class`; it carries nothing, so it goes. */
function dropEmptyClasses(tree: Root): void {
  visit(tree, 'element', (el) => {
    const c = el.properties.className;
    if (Array.isArray(c) && c.length === 0) delete el.properties.className;
  });
}

/** Everything `renderReading` and `renderSlides` share: parse, sanitise, and normalise the tree. */
function renderTree(
  source: string,
  format: ReadingFormat,
  assets: Record<string, string>,
): { tree: Root; warnings: string[] } {
  const tree: Root =
    format === 'markdown'
      ? markdownProcessor.runSync(markdownProcessor.parse(source))
      : htmlParser.parse(source);

  const file = new VFile();
  const clean = transformProcessor.runSync(tree, file);

  const warnings: string[] = [];
  // Plugins report what they could not process on the file; the content stays, as plain text.
  for (const message of file.messages) {
    if (message.source === 'rehype-katex') {
      const detail = message.cause instanceof Error ? message.cause.message : message.reason;
      warnings.push(`An equation could not be rendered: ${detail}`);
    } else if (message.source === 'rehype-highlight') {
      warnings.push(`Code could not be highlighted: ${message.reason}`);
    } else {
      warnings.push(message.reason);
    }
  }
  dropEmptyClasses(clean);
  liftDisplayMath(clean);
  paragraphImagesToFigures(clean);
  fixLinks(clean);
  rewriteImages(clean, assets, warnings);
  return { tree: clean, warnings };
}

/**
 * Renders one native reading. `assets` maps image names used in the source to storage keys of
 * the revision's own objects. Raw HTML inside Markdown is dropped; HTML uploads are sanitised.
 * Runs on the calling thread; the ingestion job calls it through `renderReadingInThread`.
 */
export function renderReading(
  source: string,
  format: ReadingFormat,
  assets: Record<string, string> = {},
): RenderedReading {
  const { tree, warnings } = renderTree(source, format, assets);
  const { blockMap, figures } = assignIds(tree);
  const html = stringify(tree);
  return { html, blockMap, figures, warnings };
}

export interface RenderedSlides {
  /** The sanitised HTML of each slide, in order. */
  slides: string[];
  /** Blocks of the whole deck; ids are unique across slides, each entry names its slide. */
  blockMap: BlockEntry[];
  figures: FigureEntry[];
  warnings: string[];
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
const SEPARATOR = /^ {0,3}---\s*$/;

/**
 * A line holding only `---` separates slides. Markdown reads the same line under a paragraph
 * as a heading underline, so a blank line goes before every separator outside code fences.
 */
function isolateSeparators(source: string): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of source.split(/\r\n|\r|\n/)) {
    if (fence === null) {
      const open = FENCE_OPEN.exec(line);
      if (open?.[1]) fence = open[1];
      else if (SEPARATOR.test(line) && (out.at(-1) ?? '').trim() !== '') out.push('');
    } else {
      const close = FENCE_CLOSE.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
    }
    out.push(line);
  }
  return out.join('\n');
}

/**
 * Renders a Markdown slide deck through the reading pipeline: one pass over the whole deck, so
 * block ids are unique across slides, then the result is cut at the top-level thematic breaks
 * (`---`, which Markdown also spells `***` and `___`). Empty slides are dropped. Images are not uploaded files of a deck, so none shows.
 */
export function renderSlides(source: string): RenderedSlides {
  const { tree, warnings } = renderTree(isolateSeparators(source), 'markdown', {});
  const { blockMap, figures } = assignIds(tree);
  const groups: ElementContent[][] = [[]];
  for (const node of tree.children) {
    if (node.type === 'element' && node.tagName === 'hr') groups.push([]);
    else groups.at(-1)?.push(node as ElementContent);
  }
  const slides: string[] = [];
  const slideOf = new Map<string, number>();
  for (const group of groups) {
    if (group.every(isBlank)) continue;
    const slide: Root = { type: 'root', children: group };
    const number = slides.length + 1;
    visit(slide, 'element', (el) => {
      const id = el.properties.dataBlockId;
      if (typeof id === 'string') slideOf.set(id, number);
    });
    slides.push(stringify(slide));
  }
  return {
    slides,
    blockMap: blockMap.map((b) => ({ ...b, slide: slideOf.get(b.id) ?? 1 })),
    figures,
    warnings,
  };
}

/**
 * Read time: gives each uploaded image a URL from `urlFor` (a content-token minting function);
 * an image whose key it refuses keeps no `src` and shows its alt text.
 */
export function resolveReadingImages(html: string, urlFor: (key: string) => string | null): string {
  if (!html.includes('data-object-key')) return html;
  const tree = htmlParser.parse(html);
  visit(tree, 'element', (el) => {
    if (el.tagName !== 'img' || typeof el.properties.dataObjectKey !== 'string') return;
    const url = urlFor(el.properties.dataObjectKey);
    if (url) el.properties.src = url;
  });
  return stringify(tree);
}
