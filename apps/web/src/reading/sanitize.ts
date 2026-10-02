import {
  READING_HTML_ATTRIBUTES,
  READING_HTML_PROTOCOLS,
  READING_HTML_TAGS,
  READING_ID_PREFIX,
} from '@parallax/contracts';
import createDOMPurify from 'dompurify';

/**
 * The browser's own pass over a native reading's HTML before it is inserted on the app origin
 * (ADR-0002 §Readings on the app origin). The server already sanitised it at ingestion with the
 * same allow-list; this pass is defence in depth, so one gap in either layer runs no script here.
 */

const ALL = new Set(READING_HTML_ATTRIBUTES['*']);
const allowedOn = (tag: string, name: string) =>
  ALL.has(name) || (READING_HTML_ATTRIBUTES[tag]?.includes(name) ?? false);

/** Attributes holding an id or a reference to one: prefixed, so they cannot clobber app names. */
const ID_ATTRIBUTES = new Set(['id', 'name', 'aria-describedby', 'aria-labelledby']);

const attributes = [...new Set(Object.values(READING_HTML_ATTRIBUTES).flat())];

/** URL attributes whose schemes the reading schema limits; checked per attribute below. */
const URL_ATTRIBUTES = new Set(Object.keys(READING_HTML_PROTOCOLS));
/**
 * DOMPurify checks every attribute that is not "URI safe" against its URL pattern, which would
 * drop a benign title such as "Note: …". Only attributes that hold a URL keep that check.
 */
const URI_SAFE = attributes.filter(
  (a) => !URL_ATTRIBUTES.has(a) && a !== 'action' && a !== 'itemtype',
);
/** Every scheme any URL attribute allows; the hook narrows it per attribute. */
const SCHEMES = [...new Set(Object.values(READING_HTML_PROTOCOLS).flat())].join('|');
const ALLOWED_URI = new RegExp(`^(?:(?:${SCHEMES}):|[^a-z]|[a-z+.\\-]+(?:[^a-z+.\\-:]|$))`, 'i');

/** A URL is allowed when it has no scheme (relative, `#…`) or one listed for its attribute. */
function urlAllowed(name: string, value: string): boolean {
  // Browsers ignore ASCII whitespace and control characters inside a scheme (`java\tscript:`).
  // biome-ignore lint/suspicious/noControlCharactersInRegex: those are the characters stripped
  const compact = value.replace(/[\u0000-\u0020\u007f]/g, '');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(compact)?.[1]?.toLowerCase();
  if (scheme === undefined) return true;
  return READING_HTML_PROTOCOLS[name]?.includes(scheme) ?? false;
}

let instance: ReturnType<typeof createDOMPurify> | null = null;

function purifier() {
  if (instance) return instance;
  const purify = createDOMPurify(window);
  purify.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName;
    const value = data.attrValue;
    if (!allowedOn(node.localName, name)) data.keepAttr = false;
    else if (URL_ATTRIBUTES.has(name)) {
      data.keepAttr = urlAllowed(name, value);
    } else if (ID_ATTRIBUTES.has(name)) {
      data.keepAttr = value.split(/\s+/).every((ref) => ref.startsWith(READING_ID_PREFIX));
    }
  });
  purify.addHook('afterSanitizeAttributes', (node) => {
    // The only form control a reading holds is a GitHub task-list box, and it cannot be ticked.
    if (node.localName === 'input') {
      node.setAttribute('type', 'checkbox');
      node.setAttribute('disabled', '');
    }
  });
  // Set once: a configuration passed to each `sanitize` call is parsed again every time.
  purify.setConfig({
    ALLOWED_TAGS: [...READING_HTML_TAGS],
    ALLOWED_ATTR: attributes,
    ADD_URI_SAFE_ATTR: URI_SAFE,
    ALLOWED_URI_REGEXP: ALLOWED_URI,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    ALLOW_UNKNOWN_PROTOCOLS: false,
    // Ids are already prefixed by the server; DOMPurify's own prefixing would add a second one.
    SANITIZE_NAMED_PROPS: false,
  });
  instance = purify;
  return purify;
}

/** The reading HTML with anything outside the reading allow-list removed. */
export function sanitizeReading(html: string): string {
  return purifier().sanitize(html);
}
