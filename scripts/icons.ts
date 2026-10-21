// Writes the icon catalogue of interactive exercises (§9) from a copy of the lucide-static npm
// package: `npm pack lucide-static@<version>`, unpack it, then
// `pnpm exec tsx scripts/icons.ts <unpacked>/package`. The three files it writes are generated:
// rerun this script to change them, never edit them. Stored exercises name icons, so the script
// refuses to drop a name the current files accept: a name a newer Lucide renames stays accepted
// as an alias of the new one, as Lucide's own older names are.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const source = process.argv[2];
if (!source) throw new Error('usage: tsx scripts/icons.ts <lucide-static package folder>');

type IconNode = [string, Record<string, string>];
const nodes: Record<string, IconNode[]> = JSON.parse(
  readFileSync(join(source, 'icon-nodes.json'), 'utf8'),
);
const tags: Record<string, string[]> = JSON.parse(readFileSync(join(source, 'tags.json'), 'utf8'));
const { version } = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
const licence = readFileSync(join(source, 'LICENSE'), 'utf8').trim();

const num = (v: number) => String(Number(v.toFixed(4)));
const nums = (text: string) =>
  text
    .trim()
    .split(/[\s,]+/)
    .map(Number);
const ellipse = (cx: number, cy: number, rx: number, ry: number) =>
  `M${num(cx - rx)} ${num(cy)}a${num(rx)} ${num(ry)} 0 1 0 ${num(2 * rx)} 0a${num(rx)} ${num(ry)} 0 1 0 ${num(-2 * rx)} 0z`;

/** One element of an icon as path data; a leading `*` marks a dot filled in the stroke colour. */
function asPath([tag, a]: IconNode, icon: string): string {
  const n = (key: string) => Number(a[key] ?? 0);
  const filled = a.fill === 'currentColor' ? '*' : '';
  switch (tag) {
    case 'path':
      return filled + a.d;
    case 'circle':
      return filled + ellipse(n('cx'), n('cy'), n('r'), n('r'));
    case 'ellipse':
      return filled + ellipse(n('cx'), n('cy'), n('rx'), n('ry'));
    case 'line':
      return `M${a.x1} ${a.y1}L${a.x2} ${a.y2}`;
    case 'polyline':
    case 'polygon': {
      const v = nums(a.points ?? '');
      const pairs = v.flatMap((p, i) => (i % 2 === 0 ? [`${num(p)} ${num(v[i + 1] ?? 0)}`] : []));
      return `M${pairs.join('L')}${tag === 'polygon' ? 'z' : ''}`;
    }
    case 'rect': {
      const [x, y, w, h] = [n('x'), n('y'), n('width'), n('height')];
      // SVG's own rule: a missing radius takes the other's value.
      let rx = a.rx === undefined ? n('ry') : n('rx');
      let ry = a.ry === undefined ? rx : n('ry');
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (rx === 0 || ry === 0) return `M${num(x)} ${num(y)}h${num(w)}v${num(h)}h${num(-w)}z`;
      const arc = (dx: number, dy: number) => `a${num(rx)} ${num(ry)} 0 0 1 ${num(dx)} ${num(dy)}`;
      return [
        `M${num(x + rx)} ${num(y)}h${num(w - 2 * rx)}`,
        arc(rx, ry),
        `v${num(h - 2 * ry)}`,
        arc(-rx, ry),
        `h${num(-(w - 2 * rx))}`,
        arc(-rx, -ry),
        `v${num(-(h - 2 * ry))}`,
        arc(rx, -ry),
        'z',
      ].join('');
    }
    default:
      throw new Error(`${icon}: no path for <${tag}>`);
  }
}

const names = Object.keys(nodes).sort();
// Lucide keeps an icon's older names as copies of its file: an alias is a file with no node,
// and names the icon whose drawing it repeats.
const drawing = (name: string) =>
  readFileSync(join(source, 'icons', `${name}.svg`), 'utf8')
    .split('\n')
    .filter((line) => !line.includes('class="lucide'))
    .join('\n');
const byDrawing = new Map<string, string[]>();
for (const name of names)
  byDrawing.set(drawing(name), [...(byDrawing.get(drawing(name)) ?? []), name]);
const aliases = new Map<string, string>();
for (const file of readdirSync(join(source, 'icons')).sort()) {
  const alias = file.replace(/\.svg$/, '');
  if (!file.endsWith('.svg') || nodes[alias]) continue;
  const same = byDrawing.get(drawing(alias)) ?? [];
  if (same.length !== 1) throw new Error(`alias ${alias} repeats ${same.length} icons`);
  aliases.set(alias, same[0] as string);
}
for (const name of [...names, ...aliases.keys()]) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error(`unexpected icon name ${name}`);
}
// Every name the current files accept must stay accepted.
const current = join(root, 'packages/contracts/src/iconNames.gen.ts');
if (existsSync(current)) {
  const text = readFileSync(current, 'utf8');
  const listed = (constant: string) =>
    new RegExp(`${constant} =\\s*'([^']*)'`).exec(text)?.[1]?.split(' ').filter(Boolean) ?? [];
  const before = [...listed('ICON_NAMES'), ...listed('ICON_ALIASES').map((p) => p.split(':')[0])];
  const lost = before.filter((n) => n && !nodes[n] && !aliases.has(n));
  if (lost.length) {
    throw new Error(
      `these names are accepted now and would no longer be, so stored exercises using them would be refused: ${lost.join(', ')}. Add each as an alias of the icon that replaces it.`,
    );
  }
}
const known = (name: string) => [
  name,
  ...[...aliases].flatMap(([a, n]) => (n === name ? [a] : [])),
];
const quote = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const key = (name: string) => (/^[a-z][a-z0-9]*$/.test(name) ? name : quote(name));
const notice = (what: string) =>
  [
    '/*!',
    ` * ${what}`,
    ` * Generated by scripts/icons.ts from lucide-static ${version} (https://lucide.dev): do not edit.`,
    ' *',
    ...licence.split('\n').map((line) => (line ? ` * ${line}` : ' *')),
    ' */',
  ].join('\n');

const files = {
  'packages/contracts/src/iconNames.gen.ts': [
    notice('The names of the icons an interactive exercise can draw.'),
    '',
    `export const ICON_NAMES = ${quote(names.join(' '))};`,
    '',
    "/** Lucide's older names, each `alias:name`. */",
    `export const ICON_ALIASES = ${quote([...aliases].map(([a, n]) => `${a}:${n}`).join(' '))};`,
    '',
  ],
  'apps/web/src/exercises/interactive/iconPaths.gen.ts': [
    notice('The icons an interactive exercise draws, on a 24-unit square, as SVG path data.'),
    '',
    "/** Each icon's elements, split by `|`; a leading `*` marks a dot filled in the stroke colour. */",
    'export const ICON_PATHS: Readonly<Record<string, string>> = {',
    ...names.map((name) => {
      const paths = (nodes[name] ?? []).map((node) => asPath(node, name));
      if (paths.some((p) => p.includes('|'))) throw new Error(`${name}: | in path data`);
      return `  ${key(name)}: ${quote(paths.join('|'))},`;
    }),
    '};',
    '',
  ],
  'apps/web/src/authoring/iconTags.gen.ts': [
    notice('Search words for the icons an interactive exercise can draw.'),
    '',
    "/** Each icon's search words and older names, separated by `,`. */",
    'export const ICON_TAGS: Readonly<Record<string, string>> = {',
    ...names.map(
      (name) =>
        `  ${key(name)}: ${quote([...new Set([...(tags[name] ?? []), ...known(name).slice(1)])].join(','))},`,
    ),
    '};',
    '',
  ],
};
for (const [file, lines] of Object.entries(files)) {
  writeFileSync(join(root, file), lines.join('\n'));
}
execFileSync('pnpm', ['exec', 'biome', 'format', '--write', ...Object.keys(files)], {
  cwd: root,
  stdio: 'inherit',
});
console.log(`${names.length} icons and ${aliases.size} older names from lucide-static ${version}`);
