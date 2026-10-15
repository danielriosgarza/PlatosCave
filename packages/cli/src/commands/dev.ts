import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createServer, type Plugin } from 'vite';
import { buildPaths, hiddenTrees, viteConfig } from '../build/web';
import type { Command } from '../main';
import { sourceRoot } from '../paths';
import type { Site } from '../site/load';
import { LEVEL_0 } from './build';

/**
 * Answers 403 for a request whose file really lies in a course folder or the overlay, by the real
 * paths the build refuses (`hiddenTrees`, taken when the server starts), so that no link in an
 * allowed folder serves one: Vite checks `server.fs.allow` on the path asked for.
 */
function hiddenGuard(root: string, web: string): Plugin {
  const trees = hiddenTrees(root);
  const lies = (url: string) => {
    const path = decodeURI(new URL(url, 'http://dev').pathname);
    // `/@fs/<path>` names a file anywhere (`/@fs/C:/…` on Windows); any other, one of the work tree.
    const named = path.startsWith('/@fs/') && path.slice(4).replace(/^\/(?=[a-z]:)/i, '');
    const file = named ? resolve(named) : join(web, path);
    if (!existsSync(file)) return false;
    const real = `${realpathSync.native(file).replaceAll('\\', '/').toLowerCase()}/`;
    return trees.some((tree) => real.startsWith(`${tree}/`));
  };
  return {
    name: 'parallax:dev-hidden',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        let refused = true;
        try {
          refused = lies(req.url ?? '/');
        } catch {}
        if (!refused) return next();
        res.statusCode = 403;
        res.end('A course folder or the private overlay is not served.\n');
      });
    },
  };
}

/**
 * The development server of a site (docs/design/site.md §5): the compiled site, pages reloaded on
 * save, `/api` proxied as `apps/web/vite.config.ts` does. Files are served from the work tree, the
 * site's `src/`, its logo and the `node_modules` folders the sources resolve from, and nothing else
 * of the site folder: no course folder and not the private overlay, by path or through a link.
 * It leaves `NODE_ENV` as it is, and Node's reads unchecked: the build's read check is `compile`'s.
 */
export function devServer(site: Site, port = 5173) {
  const config = viteConfig(site);
  const { root, app, web } = buildPaths(site.root);
  const modules = [join(root, 'node_modules')];
  for (let dir = sourceRoot('web'); dir !== dirname(dir); dir = dirname(dir)) {
    if (existsSync(join(dir, 'node_modules'))) modules.push(join(dir, 'node_modules'));
  }
  const logo = site.config.logo ? [join(root, site.config.logo.file)] : [];
  return createServer({
    ...config,
    // Vite's own messages, which `build` keeps to warnings: the address, and each error.
    logLevel: 'info',
    customLogger: undefined,
    plugins: [hiddenGuard(root, web), ...(config.plugins ?? [])],
    server: {
      port,
      // Keep the browser's Host, by which the server tells the app host from the content host.
      proxy: { '/api': { target: 'http://127.0.0.1:3000', changeOrigin: false } },
      fs: { strict: true, allow: [app, join(root, 'src'), ...logo, ...modules] },
    },
  });
}

/** `parallax dev`: at level 0 it stops as `build` does; otherwise it serves until Ctrl+C. */
export const run: Command['run'] = async ({ site }) => {
  if (site.config.level === 0) {
    console.error(LEVEL_0);
    return 1;
  }
  const server = await devServer(site);
  await server.listen();
  server.printUrls();
  await new Promise((stopped) => process.once('SIGINT', stopped));
  await server.close();
  return 0;
};
