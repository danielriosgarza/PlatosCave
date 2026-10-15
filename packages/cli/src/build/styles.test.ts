import { expect, test } from 'vitest';
import { stylesheetProblems } from './styles';

const file = 'src/pages/front.module.css';
const pc = `${file}: declares a --pc-* property of Parallax`;
const bare = (selector: string) => `${file}: the selector ${selector} has no class`;

test('the stylesheet rule accepts a CSS module whose every selector carries a class', () => {
  const accepted = [
    '.card :is(h1, h2) { margin: 0 }',
    '.x:not(.a, b) {}',
    '.card { color: red; span { color: blue } }',
    '.card { @media (width > 40em) { span { color: blue } } }',
    '@media (width > 40em) { .a { color: red } }',
    '@keyframes spin { from { opacity: 0 } 50% { opacity: .5 } to { opacity: 1 } }',
    '@scope (.card) { span { color: red } }',
    ':local(.x) {}',
    '.é {}',
    '.\\31 23 {}',
    '.a::before { content: "/* not a comment */"; } .b { color: var(--pc-accent) }',
    '.a { background: url(it.png) } /* body { color: red } */',
  ];
  for (const css of accepted) expect(stylesheetProblems(file, css), css).toEqual([]);
});

test('the stylesheet rule refuses what could reach a Parallax screen or token', () => {
  const refused: [string, string[]][] = [
    [
      '.a::before { content: "/*"; } body { --pc-accent: red; } .b::before { content: "*/"; }',
      [pc, bare('body')],
    ],
    ['body {}', [bare('body')]],
    ['.a, p {}', [bare('p')]],
    [':not(.a) {}', [bare(':not(.a)')]],
    [':has(.a) span {}', [bare(':has(.a) span')]],
    ['[class=".a"] {}', [bare('[class=".a"]')]],
    ['@media (width > 40em) { p {} }', [bare('p')]],
    ['@scope (p) { span {} }', [bare('span')]],
    [':global(.a) {}', [`${file}: uses :global`]],
    [':global .a {}', [`${file}: uses :global`]],
    ['.a { :global(body) {} }', [`${file}: uses :global`]],
    ["@import url('x.module.css');", [`${file}: uses @import: import each stylesheet from a page`]],
    ['.a { --pc-accent: red }', [pc]],
    ['.a { --\\70 c-accent: red }', [pc]],
    ["@property --pc-accent { syntax: '<color>'; inherits: true; initial-value: red }", [pc]],
    ['.a { color: red', [`${file}: line 1: Unclosed block`]],
  ];
  for (const [css, lines] of refused) expect(stylesheetProblems(file, css), css).toEqual(lines);
  expect(stylesheetProblems('src/pages/site.css', '.a {}')).toEqual([
    'src/pages/site.css: a site stylesheet is a *.module.css file',
  ]);
});
