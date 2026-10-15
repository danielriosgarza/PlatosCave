import postcss, { type AtRule, type CssSyntaxError, type Node, type Rule } from 'postcss';

/** A stylesheet by its extension, preprocessors included. */
export const STYLESHEET = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)$/i;

/** An escape (`\31 `, `\.`) or a string, in one pass so that neither hides the other. */
const TOKEN = /\\[\da-f]{1,6}\s?|\\[\s\S]|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/gi;
/** A custom property's name with its escapes resolved: `--\70 c-accent` is `--pc-accent`. */
const unescaped = (name: string) =>
  name.replace(/\\([\da-f]{1,6})\s?|\\([\s\S])/gi, (_, hex: string | undefined, char: string) =>
    hex ? String.fromCodePoint(Number.parseInt(hex, 16)) : char,
  );

/**
 * Whether a selector names a class (or `&`, the class around it) that the element it selects must
 * carry. Strings, attribute selectors and the arguments of `:not()` and `:has()` do not count:
 * `:not(.a)` selects the elements without the class, on any screen. An escaped or non-ASCII class
 * name counts, and so does a class among the arguments of `:is()`, `:where()` or `:local()`.
 */
function classed(selector: string): boolean {
  let text = selector.replace(TOKEN, (token) => (token[0] === '\\' ? '_' : '""'));
  text = text.replace(/\[[^\]]*\]/g, '');
  // The innermost brackets first: those of :not() and :has() go, the others become <…>.
  for (let before = ''; before !== text; ) {
    before = text;
    text = text.replace(/(:[\w-]+)?\(([^()]*)\)/g, (_, pseudo = '', inside: string) =>
      /^:(not|has)$/i.test(pseudo) ? '' : `${pseudo}<${inside}>`,
    );
  }
  return /\.-?[_a-z\u0080-\uffff]|&/i.test(text);
}

/**
 * Whether a rule's selectors need no class of their own: in `@keyframes` they name steps; inside a
 * style rule nesting scopes them to it, and inside `@scope` of a class to that class.
 */
function exempt(rule: Rule): boolean {
  const around: (AtRule | Rule)[] = [];
  for (let at = rule.parent as Node | undefined; at; at = at.parent as Node | undefined) {
    if (at.type === 'atrule' || at.type === 'rule') around.push(at as AtRule | Rule);
  }
  if (around.some((at) => at.type === 'atrule' && /keyframes$/i.test(at.name))) return true;
  const scope = around.find((at) => at.type === 'rule' || /^scope$/i.test(at.name));
  return scope !== undefined && (scope.type === 'rule' || classed(scope.params));
}

/**
 * Why a stylesheet of the site cannot be used, one line each (docs/design/site.md §6.7): it is not
 * a CSS module, it declares a `--pc-*` property, it uses `:global` or `@import`, or a selector has
 * no class. So a site stylesheet cannot reach a Parallax screen or token by accident; this is a
 * guard, not a boundary. PostCSS reads the stylesheet. `file` names it in the lines.
 */
export function stylesheetProblems(file: string, css: string): string[] {
  if (!/\.module\.css$/i.test(file)) return [`${file}: a site stylesheet is a *.module.css file`];
  const problems = new Set<string>();
  const refuse = (why: string) => problems.add(`${file}: ${why}`);
  const token = 'declares a --pc-* property of Parallax';
  try {
    const root = postcss.parse(css);
    root.walkDecls((decl) => {
      if (unescaped(decl.prop).startsWith('--pc-')) refuse(token);
    });
    root.walkAtRules((at) => {
      const name = at.name.toLowerCase();
      if (name === 'import') refuse('uses @import: import each stylesheet from a page');
      if (name === 'property' && unescaped(at.params.trim()).startsWith('--pc-')) refuse(token);
      if (/:global\b/i.test(at.params)) refuse('uses :global');
    });
    root.walkRules((rule) => {
      if (/:global\b/i.test(rule.selector)) refuse('uses :global');
      if (exempt(rule)) return;
      const bare = rule.selectors.find((selector) => !classed(selector));
      if (bare !== undefined) refuse(`the selector ${bare} has no class`);
    });
  } catch (error) {
    const { reason, line } = error as CssSyntaxError;
    refuse(`line ${line}: ${reason}`);
  }
  return [...problems];
}
