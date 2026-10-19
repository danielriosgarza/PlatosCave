import { spawnSync } from 'node:child_process';
import { cpSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The two static hosts of a level 0 site, for the browser suite of `open/` (docs/design/open-site.md
 * §10). It builds the school fixture with the tool's `build` command, as an operator would, into a
 * copy outside the repository whose configuration names these two origins, then serves `dist/site`
 * and `dist/content` as plain files: no fallback page, no rewrite rule, nothing under `/api`. Only
 * the content host gives the answers of hosting requirement 2 (ADR-0002, Open site). Test code: no
 * command of the tool serves a site.
 */
export const SITE = 'http://127.0.0.1:4175';
export const CONTENT = 'http://localhost:4176';
/** The site folder the suite builds, and what the build printed and its exit status. */
export const ROOT = join(tmpdir(), 'parallax-open-site-e2e');
export const BUILD = join(ROOT, 'build.json');
export const DIST = join(ROOT, 'dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.ipynb': 'application/x-ipynb+json',
};

/** The file at an address: exact lookup, or the folder's `index.html`; none outside `tree`. */
export function lookup(tree: string, pathname: string): string | undefined {
  try {
    const [root, path] = [resolve(tree), resolve(tree, `.${decodeURIComponent(pathname)}`)];
    if (path !== root && !path.startsWith(root + sep)) return undefined;
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat?.isDirectory()) return lookup(tree, `${pathname.replace(/\/$/, '')}/index.html`);
    return stat?.isFile() ? path : undefined;
  } catch {
    // A malformed escape, or a name that no file can have.
    return undefined;
  }
}

/** One host serving `tree` at its root; the content host also answers the site's range reads. */
function serve(tree: string, port: number, content: boolean) {
  return createServer((req, res: ServerResponse) => {
    const cors = content && req.headers.origin === SITE;
    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', SITE);
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Range, Accept-Ranges, Content-Length',
      );
      res.setHeader('Vary', 'Origin');
    }
    if (cors && req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Headers': 'range' }).end();
      return;
    }
    const file =
      req.method === 'GET' || req.method === 'HEAD'
        ? lookup(tree, new URL(req.url ?? '/', SITE).pathname)
        : undefined;
    if (!file) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found\n');
      return;
    }
    let bytes = readFileSync(file);
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    const range = content ? /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '') : null;
    if (content) res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
      const [start, end] = [
        Number(range[1]),
        Math.min(Number(range[2] || Infinity), bytes.length - 1),
      ];
      res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
      bytes = bytes.subarray(start, end + 1);
    }
    res.writeHead(range ? 206 : 200, { 'Content-Type': type, 'Content-Length': bytes.length });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  }).listen(port, '127.0.0.1');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  rmSync(ROOT, { recursive: true, force: true });
  cpSync(resolve(import.meta.dirname, '../packages/cli/fixtures/open-site/school'), ROOT, {
    recursive: true,
  });
  const config = join(ROOT, 'parallax.config.ts');
  const origins = readFileSync(config, 'utf8')
    .replace(/app: '[^']*'/, `app: '${SITE}'`)
    .replace(/content: '[^']*'/, `content: '${CONTENT}'`);
  writeFileSync(config, origins);
  const env = { ...process.env };
  delete env.DATABASE_URL;
  const bin = resolve(import.meta.dirname, '../packages/cli/bin/parallax.mjs');
  const run = spawnSync(process.execPath, [bin, 'build'], { cwd: ROOT, env, encoding: 'utf8' });
  const { status, stdout, stderr } = run;
  writeFileSync(BUILD, JSON.stringify({ status, stdout, stderr }));
  if (status !== 0) {
    console.error(stdout, stderr, run.error ?? '');
    process.exit(1);
  }
  serve(join(DIST, 'site'), 4175, false);
  serve(join(DIST, 'content'), 4176, true);
}
