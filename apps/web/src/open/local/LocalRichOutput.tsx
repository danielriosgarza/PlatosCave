import createDOMPurify from 'dompurify';
import { useMemo } from 'react';
import styles from '../../notebooks/Notebook.module.css';

/**
 * One rich live output at level 0 (docs/design/open-site.md §14). There is no server to store it
 * on the content origin, so the page shows it itself with the stored-output order of choice
 * (docs/design/connector.md §10.7) and nothing of it on the site's origin: a raster or SVG image
 * from a `data:` address in an `<img>` (an image runs no script), HTML in a frame with every
 * sandbox restriction and an opaque origin of its own, after DOMPurify and under a policy that
 * loads nothing, and Markdown and LaTeX as their source, JSON and text as text. JavaScript outputs and widgets are
 * never run; their text alternative is shown.
 */

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
/** The largest image or HTML output shown, in characters of its bundle entry. */
const MAX_IMAGE_CHARS = 20 * 1024 * 1024;
const MAX_HTML_CHARS = 5 * 1024 * 1024;
const FRAME_MIN = 80;
const FRAME_MAX = 600;

/** The frame's own policy: nothing is fetched, no script runs, inline styles and data images work. */
const FRAME_POLICY =
  "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none'";
const FRAME_STYLE =
  'body{margin:8px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2328;background:#fff}' +
  'table{border-collapse:collapse}th,td{padding:4px 10px;border-bottom:1px solid #d9d9d9;text-align:right}' +
  'img{max-width:100%}';
const FORBID_TAGS = [
  'meta',
  'base',
  'link',
  'form',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'portal',
];

export type LocalShown =
  | { kind: 'image'; src: string; alt: string }
  | { kind: 'html'; srcDoc: string; height: number; scriptsRemoved: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'unsupported'; mimeTypes: string[] };

const textOf = (value: unknown): string | null =>
  typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? value.join('')
      : null;

let purifier: ReturnType<typeof createDOMPurify> | null = null;

/** The output's HTML as a document of its own, with its estimated height. */
export function frameDocument(html: string): {
  srcDoc: string;
  height: number;
  scriptsRemoved: boolean;
} {
  purifier ??= createDOMPurify(window);
  const clean = purifier.sanitize(html, { FORBID_TAGS, WHOLE_DOCUMENT: false });
  const scriptsRemoved = purifier.removed.some(
    (r) =>
      ('element' in r && r.element?.nodeName === 'SCRIPT') ||
      ('attribute' in r && /^on/i.test(r.attribute?.name ?? '')),
  );
  const srcDoc =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_POLICY}">` +
    `<style>${FRAME_STYLE}</style></head><body>${clean}</body></html>`;
  return { srcDoc, height: frameHeight(clean), scriptsRemoved };
}

const LINE_TAGS = new Set('P TR LI BR DIV H1 H2 H3 H4 H5 H6 DT DD CAPTION'.split(' '));

/** A height that shows a typical output whole, as the server estimates it; the reader can resize. */
function frameHeight(clean: string): number {
  // DOMParser builds an inert document: nothing in it loads or runs.
  const doc = new DOMParser().parseFromString(clean, 'text/html');
  let lines = 0;
  for (const el of doc.body.querySelectorAll('*')) {
    if (LINE_TAGS.has(el.tagName)) lines += 1;
    if (el.tagName === 'PRE') lines += (el.textContent ?? '').split('\n').length;
    if (el.tagName === 'IMG') lines += 8;
  }
  return Math.min(FRAME_MAX, Math.max(FRAME_MIN, 32 + lines * 26));
}

/** What to show for one display or result bundle. */
export function localShown(data: Record<string, unknown>): LocalShown {
  const plain = textOf(data['text/plain']);
  const alt = plain && plain.length <= 300 ? plain.trim() : 'Image output';
  for (const type of IMAGE_TYPES) {
    const value = textOf(data[type]);
    if (value === null) continue;
    const compact = value.replace(/\s+/g, '');
    if (compact.length === 0 || compact.length > MAX_IMAGE_CHARS) continue;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) continue;
    return { kind: 'image', src: `data:${type};base64,${compact}`, alt };
  }
  const svg = textOf(data['image/svg+xml']);
  if (svg !== null && svg.length <= MAX_IMAGE_CHARS && /<svg[\s>]/i.test(svg)) {
    return {
      kind: 'image',
      src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      alt,
    };
  }
  // Markdown and LaTeX are shown as their source, not rendered: no server sanitised them here.
  // A text alternative is preferred when it says more than the object's name, as sympy's does.
  const named = plain === null || /^<[\w.]+ object( at 0x[0-9a-f]+)?>$/.test(plain.trim());
  const markdown = textOf(data['text/markdown']);
  if (markdown !== null) return { kind: 'text', text: markdown };
  const latex = textOf(data['text/latex']);
  if (latex !== null) return { kind: 'text', text: named ? latex : (plain as string) };
  const html = textOf(data['text/html']);
  if (html !== null && html.length <= MAX_HTML_CHARS)
    return { kind: 'html', ...frameDocument(html) };
  if (plain !== null) return { kind: 'text', text: plain };
  if (data['application/json'] !== undefined) {
    return { kind: 'text', text: JSON.stringify(data['application/json'], null, 2) ?? '' };
  }
  return { kind: 'unsupported', mimeTypes: Object.keys(data).sort() };
}

export function LocalRichOutput({
  data,
  executionCount,
}: {
  data: Record<string, unknown>;
  executionCount: number | null;
}) {
  const shown = useMemo(() => localShown(data), [data]);
  switch (shown.kind) {
    case 'image':
      return <img className={styles.image} src={shown.src} alt={shown.alt} />;
    case 'html':
      return (
        <>
          <div className={styles.frameBox} style={{ height: shown.height }}>
            <iframe
              className={styles.frame}
              // Every sandbox restriction: no script, an opaque origin, no forms, popups or
              // navigation of this page. The document's own policy loads nothing.
              sandbox=""
              srcDoc={shown.srcDoc}
              title={`Output of cell [${executionCount ?? ' '}]`}
              referrerPolicy="no-referrer"
            />
          </div>
          {shown.scriptsRemoved ? (
            <div className={styles.provenance}>Scripts in this output were removed and not run</div>
          ) : null}
        </>
      );
    case 'text':
      return <pre className={styles.text}>{shown.text}</pre>;
    case 'unsupported':
      return (
        <div className={styles.provenance}>
          This output ({shown.mimeTypes.join(', ')}) is not shown here.
        </div>
      );
  }
}
