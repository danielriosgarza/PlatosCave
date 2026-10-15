/** A stylesheet by its extension, preprocessors included. */
export const STYLESHEET = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)$/i;

/**
 * Whether a selector names a class (or `&`, the class around it) outside the arguments of a
 * pseudo-class: `:not(.a)` selects elements without the class, on any screen.
 */
const classed = (selector: string) =>
  /\.-?[_a-zA-Z]|&/.test(selector.replace(/:[\w-]+\([^()]*\)/g, ''));

/**
 * Why a stylesheet of the site cannot be used, one line each (docs/design/site.md §6.7): it is not
 * a CSS module, it declares a `--pc-*` property, it uses `:global` or `@import`, or a selector has
 * no class. So a site stylesheet cannot reach a Parallax screen or token by accident; this is a
 * guard, not a boundary. `file` names it in the lines.
 */
export function stylesheetProblems(file: string, css: string): string[] {
  if (!/\.module\.css$/i.test(file)) return [`${file}: a site stylesheet is a *.module.css file`];
  // Without comments and strings, which may hold any character.
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(["'])(?:\\.|(?!\1).)*\1/g, '""');
  const problems: string[] = [];
  const refuse = (why: string) => problems.push(`${file}: ${why}`);
  if (/(^|[{;\s])--pc-[\w-]*\s*:/.test(text)) refuse('declares a --pc-* property of Parallax');
  if (/:global\b/i.test(text)) refuse('uses :global');
  if (/@import\b/i.test(text)) refuse('uses @import: import each stylesheet from a page');
  // The text before each `{` is a selector or an at-rule; keyframes name steps, not elements.
  let depth = 0;
  let keyframes = -1;
  let start = 0;
  for (const { 0: brace, index } of text.matchAll(/[{};]/g)) {
    const head = text.slice(start, index).trim();
    start = index + 1;
    if (brace === '}') depth -= 1;
    if (brace === '}' && depth === keyframes) keyframes = -1;
    if (brace !== '{') continue;
    if (/^@(-\w+-)?keyframes\b/i.test(head) && keyframes < 0) keyframes = depth;
    const selectors = head.startsWith('@') || keyframes >= 0 ? [] : head.split(',');
    const bare = selectors.find((selector) => !classed(selector));
    if (bare !== undefined) refuse(`the selector ${bare.trim()} has no class`);
    depth += 1;
  }
  return problems;
}
