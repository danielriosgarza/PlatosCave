#!/usr/bin/env bash
# The installed-package check of docs/design/site.md §12, which needs the npm registry: it packs
# both packages at <version> into <folder>, then creates, installs and builds a site outside the
# repository, and converts fixture files with the installed copy, so its worker threads start there.
set -euo pipefail
version="${1:?usage: packed-install.sh <version> <folder>}"
mkdir -p "${2:?usage: packed-install.sh <version> <folder>}"
here() { pwd -W 2>/dev/null || pwd; } # a path npm and Node read, in Git Bash on Windows too
out="$(cd "$2" && here)"
repo="$(cd "$(dirname "$0")/../../.." && here)"
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT
unset DATABASE_URL

for name in parallax-site create-parallax-site; do
  (cd "$repo" && pnpm exec tsx packages/cli/scripts/pack.ts "$name" "$version" "$out")
done
# What `npm create parallax-site site` runs, from the scaffolder's own tarball.
cd "$temp"
npm exec --yes --package "$out/create-parallax-site-$version.tgz" -- create-parallax-site site
cd site
test "$(npm pkg get dependencies.parallax-site)" = "\"$version\""
# Nothing is published, so the tarball's address stands where the site names the version.
npm pkg set "dependencies.parallax-site=file:$out/parallax-site-$version.tgz"
npm install --no-audit --no-fund
test ! -L node_modules/parallax-site
test "$(node -p "require('./node_modules/parallax-site/package.json').version")" = "$version"
npx parallax build
test -s dist/index.html
echo "packed-install: a site created by create-parallax-site $version is built into dist/"

# A module of the site, so that it finds tsx where the tool's own bin finds it.
cat > check-conversion.mjs <<'EOF'
import fs from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

register();
const [fixtures] = process.argv.slice(2);
const tool = join(process.cwd(), 'node_modules/parallax-site');
const paths = await import(pathToFileURL(join(tool, 'src/paths.ts')).href);
const from = paths.sourceRoot('server');
if (from !== join(tool, 'vendor/server')) throw new Error(`The conversion loads from ${from}`);
const { convertRevision } = await paths.loadSource('server', 'src/content/convert.ts');
const deck = fs.readFileSync(join(fixtures, 'slides/transects.md'), 'utf8');
const sanitised = (d) => /Survey methods/.test(d.html) && !/<script/.test(d.html);
const text = (d) => d.pages.some((page) => page.text.trim());
const cases = [
  ['reading', 'reading/methods.md', 'reading_native', { sourceKey: 'k', format: 'markdown' }, sanitised],
  ['slides', 'slides/transects.md', 'slides_web', { markdown: deck }, (d) => d.slides.length === 2],
  ['notebook', 'notebooks/counts.ipynb', 'notebook', { sourceKey: 'k' }, (d) => d.notebook.cells[0]],
  ['PDF reading', 'reading/paper.pdf', 'reading_pdf', {}, text],
  ['PDF deck', 'slides/zones.pdf', 'slides_pdf', {}, text],
];
for (const [kind, path, type, content, converted] of cases) {
  const read = async () => new Uint8Array(fs.readFileSync(join(fixtures, path)));
  const source = { type, content, objectKeys: ['k'] };
  const { derived } = await convertRevision(source, { read, prefix: 'courses/check' });
  if (!converted(derived)) throw new Error(`The ${kind} ${path} gave ${JSON.stringify(derived)}`);
  console.log(`packed-install: the installed copy converted the ${kind} ${path}`);
}
EOF
node check-conversion.mjs "$repo/packages/cli/fixtures/open-site/instructor/courses/reef-ecology/sampling"
