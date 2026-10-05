import type { LiveOutput } from '@parallax/contracts';
import createDOMPurify from 'dompurify';

/**
 * What a live output becomes before anything is shown (docs/design/connector.md §10.4, §14; the
 * A09 suite). A kernel's output is untrusted. Text is text, an image is a data URL of a few known
 * image types, and HTML is sanitised with the allow-list the server's notebook sanitiser uses for
 * stored HTML (`outputSchema` in `apps/server/src/content/notebook.ts`) and shown only in a frame
 * with every sandbox restriction. A representation this does not know is named, not run.
 */

/** The most text one execution shows; the rest is dropped and the cell says so. */
export const MAX_LIVE_TEXT_CHARS = 50_000;

export type ShownOutput =
  | { kind: 'text'; stream: 'stdout' | 'stderr'; text: string }
  | { kind: 'error'; name: string; value: string; traceback: string }
  | { kind: 'image'; url: string; alt: string }
  | { kind: 'html'; doc: string; scriptsRemoved: boolean }
  | { kind: 'unsupported'; mimeTypes: string[] };

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes are control characters
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (text: string) => text.replace(ANSI, '');

const asText = (value: unknown): string | null =>
  typeof value === 'string'
    ? value
    : Array.isArray(value) && value.every((v) => typeof v === 'string')
      ? value.join('')
      : null;

const BASE64 = /^[A-Za-z0-9+/=\s]+$/;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif'] as const;

/** The tags and attributes of an HTML output: the server's schema, plus styles and data images. */
const FORBIDDEN_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'noscript',
  'template',
  'textarea',
  'title',
  'head',
  'form',
  'input',
  'button',
  'select',
  'option',
  'link',
  'meta',
  'base',
  'frame',
  'frameset',
  'applet',
  'svg',
  'math',
];
const FORBIDDEN_ATTRS = ['srcdoc', 'formaction', 'action', 'ping'];
const ALLOWED_URI =
  /^(?:https?:|mailto:|data:image\/(?:png|jpe?g|gif|webp);base64,|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

let purifier: ReturnType<typeof createDOMPurify> | null = null;
const purify = () => {
  if (purifier) return purifier;
  purifier = createDOMPurify(window);
  // `style` elements stay (pandas and most libraries use them); the frame has no script anyway.
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (node.localName === 'a') {
      node.setAttribute('rel', 'noopener noreferrer');
      node.setAttribute('target', '_blank');
    }
  });
  return purifier;
};

const FRAME_STYLE =
  'body{margin:8px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2328;background:#fff}' +
  'table{border-collapse:collapse}th,td{padding:4px 10px;border-bottom:1px solid #d9d9d9;text-align:right}' +
  'img{max-width:100%}';

/** The frame document of one HTML output: sanitised content in a page of its own, with no script. */
export function htmlFrameDocument(html: string): { doc: string; scriptsRemoved: boolean } {
  const p = purify();
  const clean = p.sanitize(html, {
    FORBID_TAGS: FORBIDDEN_TAGS,
    FORBID_ATTR: FORBIDDEN_ATTRS,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    ADD_TAGS: ['style'],
    WHOLE_DOCUMENT: false,
  });
  const scriptsRemoved =
    /<script[\s>]/i.test(html) || /\son[a-z]+\s*=/i.test(html) || /javascript:/i.test(html);
  const csp = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'";
  return {
    doc:
      `<!doctype html><html><head><meta charset="utf-8">` +
      `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
      `<style>${FRAME_STYLE}</style></head><body>${clean}</body></html>`,
    scriptsRemoved,
  };
}

/** What to show for one kernel output; the best representation it holds that is safe to show. */
export function shownOutput(output: LiveOutput): ShownOutput {
  switch (output.output_type) {
    case 'stream':
      return { kind: 'text', stream: output.name, text: stripAnsi(output.text) };
    case 'error':
      return {
        kind: 'error',
        name: stripAnsi(output.ename),
        value: stripAnsi(output.evalue),
        traceback: stripAnsi(output.traceback.join('\n')),
      };
    case 'display_data':
    case 'execute_result':
      return fromBundle(output.data);
  }
}

function fromBundle(data: Record<string, unknown>): ShownOutput {
  const html = asText(data['text/html']);
  if (html !== null) return { kind: 'html', ...htmlFrameDocument(html) };
  for (const type of IMAGE_TYPES) {
    const raw = asText(data[type]);
    if (raw !== null && BASE64.test(raw)) {
      return {
        kind: 'image',
        url: `data:${type};base64,${raw.replace(/\s+/g, '')}`,
        alt: asText(data['text/plain']) ?? 'Image output',
      };
    }
  }
  const svg = asText(data['image/svg+xml']);
  if (svg !== null) {
    // In an <img> an SVG cannot run script or load anything; the frame is for HTML.
    return {
      kind: 'image',
      url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`,
      alt: asText(data['text/plain']) ?? 'Image output',
    };
  }
  const text = asText(data['text/markdown']) ?? asText(data['text/plain']);
  if (text !== null) return { kind: 'text', stream: 'stdout', text: stripAnsi(text) };
  return { kind: 'unsupported', mimeTypes: Object.keys(data).sort() };
}

export type GroupedOutput = ShownOutput & { key: number; generation: number };

/** Consecutive text of one stream joins into one block, as a terminal would show it. */
export function groupOutputs(
  items: { eventSeq: number; generation: number; output: LiveOutput }[],
): { shown: GroupedOutput[]; truncated: boolean } {
  const shown: GroupedOutput[] = [];
  let chars = 0;
  let truncated = false;
  for (const item of items) {
    const next = shownOutput(item.output);
    if (next.kind === 'text') {
      const room = MAX_LIVE_TEXT_CHARS - chars;
      let text = next.text;
      if (text.length > room) {
        text = text.slice(0, Math.max(room, 0));
        truncated = true;
      }
      chars += text.length;
      const last = shown[shown.length - 1];
      if (
        last?.kind === 'text' &&
        last.stream === next.stream &&
        last.generation === item.generation
      ) {
        last.text += text;
      } else if (text.length > 0) {
        shown.push({ ...next, text, key: item.eventSeq, generation: item.generation });
      }
    } else {
      shown.push({ ...next, key: item.eventSeq, generation: item.generation });
    }
  }
  return { shown, truncated };
}
