# Site toolkit detailed design (P5-03)

**Status:** accepted with the merge of P5-03, 2026-10-13. Refines the amendment "Distribution" of [ADR-0001](../adr/0001-technology-stack.md) for §13 of the [product specification](../product-spec.md) ("Installation, levels and boundaries"): requirements N1 to N3 and the level 2 runner profile of N9, on the owner's answers Q1 to Q11 and Q27 ([plan](../delivery/plan.md) §8). It is the lasting form of sections 1 to 12 of the plan that planning run R1 landed, [`docs/plans/2026-10-13-design-how-a-parallax-site-is-created-co.md`](../plans/2026-10-13-design-how-a-parallax-site-is-created-co.md), and keeps that plan's numbers for those sections. Where the two differ this document is current, and §16 lists each difference. Items P5-06, P5-07, P5-07a, P5-17, P5-17a, P5-19, P5-22, P5-23, P5-23a and P5-23b in the plan implement it and take their tests from §15. Nothing in it is built yet, and Parallax as built does not change. It decides nothing that belongs to run R2 (the course folder), run R3 (the open site), run R4 (sign-in providers) or the owner: §13 says where those attach and §14 what is open.

Terms: a **site** is a folder that holds one project's own files and names Parallax as its one dependency. The **tool** is the npm package `parallax-site`; its command inside a site is `parallax`. The **scaffolder** is the npm package `create-parallax-site`. A **screen** is an address the Parallax web application answers; a **page** is a JSX file of the site under `src/pages`. An **instructor folder** is a folder with `instructor.yaml` and `courses/`. The **operator** is the person with shell access to the host that runs a site's server.

## 1. Shape and trust boundaries

```text
 site folder (the operator's machine or the site host)
   package.json ──npm install──▶ node_modules/parallax-site    the tool; sources of the web application and of the conversion
   parallax build ──▶ .parallax/app/ (copied sources + generated entry) ──Vite──▶ .parallax/dist ──▶ dist/
   parallax env   ──▶ .env (secrets)   .parallax/site.env (everything else)
   parallax start ──▶ docker compose: postgres · migrate · server (relay, ./dist at /site) · worker · caddy (TLS, two host names)
   parallax apply ──▶ one JSON document on the standard input of apply-site.ts in the server image ──▶ PostgreSQL (internal network)

 runner host (level 2 only)
   runner ──port 5432 over a private network, role parallax_runner──▶ PostgreSQL of the site host
```

A site is a folder with one dependency, `parallax-site`. The package carries the web application's sources; `parallax build` copies them into a git-ignored work tree in the site, adds one generated entry that hands the site's pages to a new mount function of `apps/web`, and runs the same Vite build that `pnpm build` runs today. At level 1 the published server image serves that build through the existing `STATIC_DIR` setting. Setup runs as a script inside the server image, on the server's host.

| Part | Trusted for | Limits |
| --- | --- | --- |
| the site's `src/` (pages, their CSS modules) and its logo | the site owner's own code and file (N3): compiled into the application's bundle and served from the app origin, so at level 1 and above a page runs with the visitor's session | a page cannot sit at a screen's address (§6.3); the stylesheet rule of §6.7 guards against accidents and is not a boundary |
| course folders and the private overlay | nothing: course material is untrusted content and may hold hidden material | the site build imports no file from them and copies none into `dist/` (§6.4, §6.6); converting them is run R2's and run R3's |
| the operator | shell access to the site host: `.env`, the compose files, `parallax apply`, `parallax sync` | no route, no network caller and no credential is added for the operator |
| `parallax apply` | the writes of §8, made for the owning account without a session | scoped tables only through `forCourse` and `forClass` with a scope from `resolveActorScope`; it creates no account |
| the runner host (level 2) | fetching runs as role `parallax_runner`, schema `pgboss_exec` only ([runner design](runner.md) §10.3) | no application secret; ADR-0004 and the sandbox policy do not change |

Existing files that the units of this design edit, and no others: `apps/web/src/main.tsx`, `apps/web/package.json`, `packages/contracts/src/index.ts` (one export line), `apps/server/src/db/migrate.ts`, `apps/server/src/version.ts` (one line), `infra/docker/server.Dockerfile` and `infra/docker/runner.Dockerfile` (both in P5-22 only), `.gitignore`, `vitest.config.ts`, the root `package.json`, `.github/workflows/image.yml`, `pnpm-lock.yaml`, and `docs/adr/0002-authorization-and-class-isolation.md` (one sentence and its status line, in P5-19). No route file, screen, viewer, editor, review screen, route contract, schema file or migration is among them, and the Playwright configuration is not changed.

## 2. Published pieces and names (Q1)

| Piece | Published as | Directory | Holds |
| --- | --- | --- | --- |
| Command-line tool | npm `parallax-site`; the command inside a site is `parallax` | `packages/cli` | the tool and, copied in at pack time, the sources of the web application (`apps/web`, `packages/ui`, `packages/contracts`) and of the conversion entry of P5-09 with its `*.worker.mjs` files |
| Scaffolder | npm `create-parallax-site`, run as `npm create parallax-site` | `packages/create-parallax-site` | the create command and the templates `instructor` and `school` |
| Server image | `ghcr.io/<owner>/parallax-server` on GHCR | `infra/docker/server.Dockerfile` | `apps/server`: API, relay, worker, migrations, operator scripts |
| Runner image | `ghcr.io/<owner>/parallax-runner` on GHCR | `infra/docker/runner.Dockerfile` | `apps/runner`, the runner service |

One version number covers all four (§12). The directory names are fixed and replace the working names. `<owner>` is the repository's GitHub owner. The manifest of `parallax-site` carries `ghcr.io/<owner>` in the field `parallax.registry`, which the release workflow stamps beside the version; a site's tool reads the image names from there and starts the images tagged with its own version. The npm account is an owner input (plan §7). The `@parallax/*` workspace packages stay private. The sandbox runtime images that the runner starts are not published: they stay with `scripts/runner-image.sh` and the digest allow-lists of the [runner design](runner.md) §6, and their references and digests are level 2 inputs of the operator (§11).

**Execution.** The published tool runs its TypeScript sources with `tsx`, as the server image does (ADR-0001, "Server execution"); there is no bundling step. The worker threads of `apps/server/src/content/` that load TypeScript register `tsx` themselves (`reading.worker.mjs`, `notebook.worker.mjs`, `submission-check.worker.mjs`), and `pdf-text.worker.mjs` is plain JavaScript, so they run unchanged from the package.

**Packing.** `packages/cli/scripts/vendor.ts`, run by `prepack`, copies the sources into `packages/cli/vendor/{web,ui,contracts,server,deploy}` without test files; rewrites every `@parallax/…` import specifier in the copies to a relative path, so the tree needs no workspace link, no alias and no loader hook; and follows the relative imports of `apps/server/src/content/convert.ts` (P5-09) to copy exactly the conversion closure. `vendor/deploy` holds `scripts/backup.sh` and `scripts/restore.sh`. Every third-party package the copies import is a dependency of `parallax-site` at the version the source manifest pins; `pg` and `drizzle-orm` are not among them. `vendor/` is git-ignored. In the repository, where it does not exist, `packages/cli/src/paths.ts` resolves the same roots from the workspace. `packages/cli/scripts/pack.ts <package> <version> <folder>` stages a package in a temporary folder, stamps the version there and runs `prepack` and `npm pack`, so a test and the release workflow get stamped tarballs with no change to a tracked manifest.

## 3. Site folder (N1)

It holds only the site's own files; Parallax arrives as the dependency.

```text
my-site/
  package.json           "parallax-site": "1.4.0" (exact): the one place that names the Parallax version
  .npmrc                 package-lock=false: the site keeps no lock file
  parallax.config.ts     mode, name, logo, level, sign-in, origins, instructors, classes (§4)
  tsconfig.json
  src/pages/index.tsx    the site's own pages, JSX only (§6); styles in *.module.css beside them
  instructor.yaml        instructor mode: name and email of the one instructor (§7)
  courses/<course>/…     instructor mode; the layout inside a course folder is run R2's
  instructors/<name>/    school mode: instructor.yaml and courses/<course>/…, the same layout
  compose.yml  Caddyfile  compose.level2.yml  compose.runner.yml      the installation (§9, §11)
  .gitignore             node_modules/  dist/  .parallax/  .env  .env.*  *.env  backups/  private/
```

Generated and git-ignored: `.env` (secrets); `.parallax/` (the work tree `app/`, the compile's own output `dist/` of §6.4, the Vite cache `vite/`, `site.env`, the backup overlay `compose.backup.yml` of §10, and at level 2 `pg_hba.conf` and `runner/runner.env`); `dist/` (the compiled site that is served); `backups/`. `private/` stands for the private overlay of run R2, and the name `docs/design/course-folder.md` gives it wins.

The site keeps no lock file: the template's `.npmrc` sets `package-lock=false`, so `npm install` writes none. No file of the site other than `package.json` names the version: the compose files take the image references from `.parallax/site.env`, which `parallax env` derives from the installed package. An upgrade therefore changes `package.json` and no other tracked file of the site (A37): the install and the rebuild replace only git-ignored files. §14 names the limit of this: the files copied from the template. The templates hold `.gitignore` and `.npmrc` as `_gitignore` and `_npmrc`, and the create command writes them under their real names, because npm does not deliver files of those two names in a published package.

## 4. `parallax.config.ts`

The default export of the file, written with `defineConfig` from `parallax-site`, which only gives the editor the type.

```ts
import { defineConfig } from 'parallax-site';

export default defineConfig({
  mode: 'instructor',
  name: 'Statistics for Biologists',
  logo: { file: 'src/logo.png', alt: 'Statistics for Biologists' },
  level: 1,
  origins: { app: 'https://stats.example.org', content: 'https://content.stats.example.org' },
  signIn: { email: { from: 'Statistics <login@example.org>' } },
  classes: [
    { course: 'statistics', name: 'Spring 2027' },
    { course: 'statistics', name: 'Open course', open: true },
  ],
});
```

| Field | Rule | Used for |
| --- | --- | --- |
| `mode` | `'instructor'` or `'school'`; required | where instructor folders are looked for (§7) |
| `name` | 1 to 80 characters, no control character; required | the props of the site's own pages only (§6.6) |
| `logo` | optional `{ file, alt }`: `file` is the path, from the site folder, of a PNG, JPEG or WebP file that lies inside the site folder and outside the course folders and the private overlay; `alt` is its alternative text, 1 to 120 characters. SVG is not accepted | the props of the site's own pages only |
| `level` | `0`, `1` or `2`; required | what each command does (§5); moving between levels is a change of this value |
| `origins.app`, `origins.content` | two origins, `https`, or `http` on a loopback host; their host names must differ (the server's own rule, `apps/server/src/config.ts`); required | levels 1 and 2: `APP_ORIGIN`, `APP_HOST`, `CONTENT_ORIGIN`, `CONTENT_HOST`; level 0: the two outputs of run R3 |
| `origins.shiny` | optional list of origins, none of them the app or the content origin | `SHINY_ORIGINS` (existing setting); at level 0, run R3 |
| `signIn` | `{ email?: { from }, providers?: [{ id, name, issuer, clientId }] }`: each provider is the server's `providerSettings` (`packages/contracts/src/routes/auth.ts`: strict, so no logo or colour; an https issuer) and the ids are unique; at level 1 and above a way to sign in is required, `email`, `providers` or both; unused at level 0 | `MAIL_TRANSPORT` (`smtp` with `email`, `none` without), `MAIL_FROM`, `OIDC_PROVIDERS`; in `.env`, the relay's address with its password is `SMTP_URL` and the client secrets are `OIDC_CLIENT_SECRETS` |
| `instructors` | references to instructor folders, never addresses. School mode: the names of the folders under `instructors/`, required and unique. Instructor mode: the one reference `'.'` (the site root), which is the default | who has instructor access: `INSTRUCTOR_EMAILS`, taken from the listed folders' `instructor.yaml`; the accounts `apply` looks up |
| `classes[]` | `{ course, name, open, instructors }`. `course` is `<course>` in instructor mode and `<name>/<course>` in school mode. `name` is 1 to 80 characters and unique within its course. `open` defaults to `false` (joined with an enrolment code); `true` means joined by the open join link. `instructors` is optional: references from the top-level list, by default the folder that holds the course | `apply` (§8) |
| `runner` | `{ host, databaseHost, runtimes }`: two addresses, and the sandbox runtimes with their images and digests in the form of the existing `RUNNER_RUNTIMES` setting; a runtime without a digest is refused. Required at level 2, unused below | §11 |

**Validation.** The schema `siteConfig` is a strict zod object in `packages/contracts/src/site.ts`, with `instructorMeta` (the content of `instructor.yaml`: `{ name, email }`, strict) and `siteCatalogue` (§6.6) beside it; P5-19 adds `siteSetup` (§8) to the same file. Every command first loads the file with `tsImport` from `tsx/esm/api`, parses the default export and, on failure, prints one line per issue (`parallax.config.ts: classes[1].course: no folder courses/genetics`) and exits 1 before it writes anything. An unknown key is an error that names the key. The loader (`packages/cli/src/site/load.ts`) adds the checks that need the folder: the logo exists, inside the site and outside the course folders and the private overlay; the mode's folders exist; every listed instructor folder exists and has a valid `instructor.yaml`; every instructor folder on disk is listed; no two carry one address; every `classes[].course` is a folder; every class instructor is in the list. Loading and building import no database driver and run with `DATABASE_URL` unset.

## 5. Commands

`parallax <command>` runs in a site folder. `packages/cli/src/main.ts` discovers one module per command in `src/commands/<name>.ts`, as the server discovers its route modules (`loadModules` in `apps/server/src/app.ts`), so a later unit adds a file and edits no shared list. An unknown command lists the commands.

| Command | Does | Unit |
| --- | --- | --- |
| `npm create parallax-site <folder> [-- --template instructor\|school]` | creates the folder from a template (default `instructor`); writes `package.json` with the scaffolder's own version as the exact version of `parallax-site`; asks nothing, uses no network, runs no install; refuses a folder that is not empty | P5-17 |
| `parallax dev` | validates; Vite development server for the compiled site, pages reload on save; `/api` is proxied to `http://127.0.0.1:3000` with the browser's `Host`, as `apps/web/vite.config.ts` does. At level 0 it stops as `build` does | P5-07c |
| `parallax build` | validates; levels 1 and 2: compiles `src/pages` and the web application into `dist/` (§6.4); level 0: calls the build of P5-14, and until that unit merges stops with a message, so nothing can serve a level 0 site before P5-15 | P5-07 |
| `parallax env` | levels 1 and 2: creates or completes `.env`, never changing a value that is there; rewrites `.parallax/site.env` from the configuration and the installed version (§9); at level 2 also `.parallax/pg_hba.conf` and `.parallax/runner/runner.env` (§11) | P5-23a |
| `parallax start` | `env`, `build`, then `docker compose pull` and `up -d --wait`; `migrate` runs before the services. Safe to run again: no generated secret changes and the running services stay up | P5-23a |
| `parallax upgrade` | the upgrade of §10 | P5-23 |
| `parallax apply` | setup from the configuration (§8) | P5-23a (command), P5-19 (server side) |

A command that needs a server (`env`, `start`, `upgrade`, `apply`) stops at level 0 and says that level 0 has no server. `check` and `sync` are run R2's commands (§13).

**A first installation, in order:** `npm create parallax-site`, `npm install`, the configuration, `parallax start`, each listed instructor signs in once in the browser, `parallax sync` (P5-18), `parallax apply`. Conversion comes before setup because a class belongs to a course, and `apply` creates classes only for courses that exist (§8). Spec §13 names the same steps for a move to level 1 without fixing their order; this is the order.

## 6. Site pages (N3; Q8 to Q11)

### 6.1 The web application as a dependency (P5-06)

New `apps/web/src/app.tsx` exports `createApp(site?)` and `mount(root, site?)`. `main.tsx` shrinks to a call of `mount` with no argument; the two style imports and the router's `Register` declaration move to `app.tsx` unchanged. `site` is `{ pages: { path, load }[], props }`. `apps/web/package.json` gains `exports` for `./app` and `./pages`; nothing imports the package today.

`createApp` adds one code-based route per page beside the generated children: `createRoute({ getParentRoute: () => routeTree, path, component: lazyRouteComponent(load) })`, then `routeTree.addChildren([...kept, ...added])`. `kept` is `routeTree.children` as generated, read once when `app.tsx` loads. Every call starts from `kept`, so a second `createApp` (a hot reload, a test) does not pile pages up, and a call without pages gives exactly the generated tree: the application is today's, and `/` keeps its redirect to `/courses` or `/signin`. The generated index route, recognised by identity with the `Route` that `routes/index.tsx` exports, is left out only when a page has the path `/`. No route file and not `routeTree.gen.ts` is edited.

New `apps/web/src/sitePages.tsx` holds what both shells share: the page types; `siteRoutes(parent, site)`, which run R3's level 0 shell can call with its own root; a `Link` for pages; and the pure address rules `pageAddress(file)`, `normalise(address)` and `screenAt(address, patterns)`. `normalise` decodes percent-escapes, lower-cases and drops a trailing slash, so `/courses/` and `/%63ourses` are both `/courses`. `createApp` throws when a page other than `/` is, after `normalise`, at a screen's address, so a caller that skips the build check still cannot replace a screen.

### 6.2 From files to addresses

`src/pages/index.tsx` is `/`, `about.tsx` is `/about`, `team/index.tsx` is `/team`. A page is a `.tsx` or `.jsx` file whose default export is a component. A segment is lower-case letters, digits and hyphens, and a file with any other segment stops the build, so an address has no parameter; a name that starts with `_` is a helper, not a page. Two files with one address (`about.tsx` and `about/index.tsx`) stop the build, which names both. A `.md` or `.mdx` file under `src/pages` stops the build: pages are JSX only (Q11).

### 6.3 Added pages only (Q8, A39)

`packages/cli/src/site/pages.ts` reads the application's addresses from the keys of `FileRoutesByTo` in `routeTree.gen.ts`, the generated list of every address a route answers (eight today), and fails loudly if that block is missing. The build stops before Vite starts when a page's address, after `normalise`, matches one of them (`$name` matches any one segment), or lies under `/api`, `/assets` or `/content`, which the server answers itself (`apps/server/src/http/static.ts`, `http/content.ts`). So `courses.tsx` and `courses/index.tsx` are both refused. The message names both:

```text
src/pages/classes/demo/review.tsx would be at /classes/demo/review, the address of the Parallax screen /classes/$classId/review. A site adds pages and cannot replace a Parallax screen: move or rename the page.
```

`/` is the one exception, because it has no page today. A later version of Parallax may add a screen at an address a site already uses; that site's build then stops with this message and the owner renames the page. It is the one case in which a new version asks for an edit in the site.

### 6.4 One compiled site (P5-07)

`packages/cli/src/build/web.ts` does four things:

1. It copies the `web`, `ui` and `contracts` sources into `.parallax/app/`; the copy is skipped when its version marker matches.
2. It writes there `web/src/site-pages.gen.ts` (one `{ path, load: () => import('<relative path to the page>') }` per page, and the props of §6.6), `web/src/site-entry.gen.tsx` (`mount(root, { pages, props })`) and a copy of `index.html` whose only change is the script address.
3. It runs Vite with `configFile: false`, root `.parallax/app/web`, `publicDir: false`, `cacheDir` `.parallax/vite`, `outDir` `.parallax/dist` with `emptyOutDir: true`, and the plugins of `apps/web/vite.config.ts` in the same order: `tanstackRouter({ target: 'react', autoCodeSplitting: true })`, then `react()`.
4. When Vite has finished, it puts the result into the site's `dist/`: the new files first, `index.html` last, then it removes the files the new build does not have. The directory `dist/` itself is kept, because a running server has it mounted (§6.5).

Steps 1 to 3 are the compile and step 4 puts it in place; `build` does both, and `upgrade` separates them (§10). So `dist/` never holds a half-written build or a file of an earlier one, and a build that fails leaves it as it was. Compiling straight into `dist/` would give neither: Vite does not empty an `outDir` outside its root unless it is told to, and it empties one before it writes.

The router plugin regenerates an identical `routeTree.gen.ts` inside the copy and splits the routes as today. This is why the build runs on a copy outside `node_modules`: the code splitter only knows route files the generator has listed (`routesByFile`, `router-code-splitter-plugin.js`), and the generator writes files. Nothing is written under `node_modules` or into the repository's `apps/web`. If the router plugin misbehaves on the copy, the fallback is `enableRouteGeneration: false`, which loses route splitting and nothing else.

One small Vite plugin resolves bare imports: from a file of the work tree as if the file sat at its original location, and `react`, `react/jsx-runtime` and `parallax-site/pages` from a site page to the package's own copies, with `resolve.dedupe` for `react`, `react-dom`, `@tanstack/react-router` and `@tanstack/react-query`. The build therefore does not depend on how a package manager lays out `node_modules`. `parallax-site/pages` gives a page the page types and the `Link` of §6.1; its types are `packages/cli/pages.d.ts`. The same plugin stops the build when the logo or a file that `src/` imports resolves into a course folder (`courses/`, `instructors/<name>/courses/`) or the private overlay, and names the importing file and the path.

**As built (P5-07).** The copy is skipped only in a packed tool (`vendor/` exists); in the repository, where the sources change under one version, it is made on every build. `tsconfig.base.json` is copied to `.parallax/`, because the copied `tsconfig.json` files extend `../../tsconfig.base.json`; a packed tool carries it at its root. Vite also gets `envDir: false` (the site's `.env` is never read), `sourcemap: false` (maps would publish the sources of the site's pages), absolute `outDir` and `cacheDir`, and `NODE_ENV=production` for the time of the build; the router plugin gets a `tmpDir` under `.parallax/vite`, since it would otherwise write `.tanstack/` into the working directory. Instead of `resolve.dedupe`, which would look in `.parallax/app/web` where there is no `node_modules`, the plugin resolves `react`, `react-dom`, `@tanstack/react-router` and `@tanstack/react-query` from the web sources for every importer. A course folder or the overlay is recognised by its path in the site and by where it really lies, the target of every link in it included, and each refusal is one line. Besides an import and a file the bundle holds, the build refuses such a file when Node reads it while the build runs, because Vite reads some files without asking a plugin: the asset of a `new URL(…, import.meta.url)` or of a stylesheet's `url()`, `?inline` included, and the stylesheet of an `@import` or a `composes`. A worker, which Vite bundles on its own, gets the same plugin, and `assetsInlineLimit: 0` emits every asset as a file, so the final check sees it. Removing the earlier build's chunks at once is accepted for `build` on a running site: a tab that still holds the earlier `index.html` and then loads a removed route chunk shows the route's error with Retry, and a reload gets the new build.

### 6.5 Serving at level 1

`dist/` has the form the server already serves: `index.html` and `assets/`. `compose.yml` mounts it read-only at `/site` and sets `STATIC_DIR=/site`, which replaces the image's default (`infra/docker/server.Dockerfile`). No server code changes and no route is added. Pages are served under the app origin's existing headers (`script-src 'self'`).

### 6.6 Page data (Q9)

A page receives props fixed at build time and nothing else: `{ site: { name, logo, entry }, catalogue }`. `logo` is absent or `{ src, alt }`: the address of the compiled file and its alternative text. `entry` is the address of the Parallax interface for the level: `/courses` at level 1 and above, and the level 0 shell gives its own (run R3), so a page links to it without knowing the level. `catalogue` is `{ instructors: [{ slug, name, courses: [{ slug, title }] }] }`: display names and course titles from the folder, each with its folder's name as `slug`. Its strict schema `siteCatalogue` has no field for an email address, a topic, a resource or a definition, and `packages/cli/src/site/folders.ts` builds it from the instructor folders that `loadSite` returns (P5-07b), each with its `instructor.yaml` and the listed names of its course folders, and scans nothing again: it opens no file inside a course folder and leaves the address out. In instructor mode the site root, whose reference `.` is no folder's name, has the slug `instructor`. The title is the course folder's name until run R2 names a metadata source. No runtime API for pages is offered or supported, and no `/api/*` route is added.

### 6.7 Look (Q10)

`mount` takes no theme, style or component. Site pages render inside the unchanged root layout (`routes/__root.tsx`), below Parallax's global bar; with a front page, the bar's "Parallax" link opens the front page instead of redirecting, which follows from `/` being free. The site's name and logo exist only in the props of the site's pages, and no Parallax screen reads them. The document title stays `Parallax`; a page module may export `title`, which the page's route sets while the page is shown and restores when it is left.

The build stops when a stylesheet imported from `src/` is not a `*.module.css`, declares a `--pc-*` property, uses `:global`, or has a selector without a class (`packages/cli/src/build/styles.ts`), so a site stylesheet cannot reach a Parallax screen or a token. The logo is the owner's own file, compiled like the page that shows it and served from `/assets/` on the app origin, which the present `img-src 'self'` allows. The rule on untrusted images (ADR-0002) covers what comes with course material and from other people; it does not cover this file.

## 7. Modes, ownership and the catalogue (N2; Q4 to Q6)

The mode is the value `mode`. An instructor folder is the site root in instructor mode and each `instructors/<name>/` in school mode. `courses/` has the same layout in both, so it moves between the modes unchanged. `instructor.yaml` holds `name` and `email`, and the address decides ownership: the account with that verified address owns the courses under that folder, in both modes. Accounts stay keyed by a verified address, and setup never creates one (§8).

The configuration names the instructor folders that have instructor access (`instructors`). A folder on disk that is not listed, or a listed folder that is missing, stops every command with a message that names the folder. There is no role, no instance administrator and no new permission: ownership is the existing course owner grant, and instructor access is the existing `INSTRUCTOR_EMAILS` list and the existing memberships. School mode is one installation with several instructors. A school site's catalogue page is the template's front page: it lists the instructors, then each one's courses, from the build-time catalogue. `/courses` and its screen do not change.

## 8. Setup from configuration (Q7; A51)

`parallax apply` runs on the server's host. The command builds one JSON document from the configuration and the instructor folders (schema `siteSetup` in `packages/contracts/src/site.ts`; each instructor carries the path of its `instructor.yaml`, for messages) and pipes it to `docker compose run --rm -T server node_modules/.bin/tsx src/scripts/apply-site.ts`, as the managed connector's script is run today ([operations](../operations.md)). No address and no code is put on a command line. The script reads `DATABASE_URL` from the service's environment on the internal network: no HTTP call, no route, no network caller and no new credential. Its caller is the operator. A malformed document exits 2 and changes nothing.

| Step | How | Second run |
| --- | --- | --- |
| Instructor access | for each listed instructor folder, the active account (kind `user`, not deactivated) with the folder's address, found by the new `findInstructorAccount`. An account row exists only after a verified sign-in (`userForVerifiedEmail`, `db/auth/accounts.ts`), and `apply` never creates one. If an account is missing, setup stops before any write, names each `instructor.yaml` whose address has no account and says that the person signs in once first. `parallax env` writes the same addresses as `INSTRUCTOR_EMAILS` | account exists |
| Course | the course a folder syncs to, through the lookup P5-18 provides; a folder not yet synced is reported as pending | a lookup: it writes nothing |
| Class | `CourseScope` from `resolveActorScope(db, ownerId, { kind: 'course', role: 'owner' }, courseId)`; the new `findClassByName` (through `forCourse`) returns the course's classes of that name: one is the class; with none the existing `createClass` makes it; with two or more, made through the existing routes, the item is refused and their ids are named | class exists |
| Class instructors | `ClassManagerScope` from `resolveActorScope` with the grant `manage_members`; the new `ensureInstructor(db, scope, userId)` gives the class instructor membership and course draft editing, as `acceptInstructorInvite` does (`db/invites.ts`); an account that is a student of the class is refused, as an invitation refuses it | membership exists |
| Access | `open` is set through the data-access function of P5-10 when it differs; if `listMembers` shows no open enrolment invitation, the existing `issueInvite` issues one. The code, or for an open class the join link of P5-11, is printed once and written nowhere | invitation exists; nothing is shown again |
| Adopted release | for a class with no release: the course's newest release (the new `latestRelease`, through `forCourse`), adopted with the existing `adoptRelease` under the `ClassScope` of the class's first instructor | class has a release |
| Audit | one event of setup's own for each class it changes (`recordSetup`, below) | nothing changed, no event |

Every scoped table is reached through `forCourse` or `forClass` with a scope from `resolveActorScope`; `users` and `courses` are not scoped tables (`apps/server/src/db/scoped.ts`). The account check stops the whole run; after it each class is one transaction. A refused item is reported with its cause and the exit code is 1; the others still run. Setup needs no stored state: a class is found by course and name, access by the open invitation, instructors by membership, adoption by `classes.release_id`. Run R1 therefore asks P5-18 for no schema, and P5-19 adds no migration. The existing setup routes stay. A class renamed in the configuration is a new class: the earlier one stays as it is, and `apply` never renames, archives or deletes.

**Where the code lives.** The repository's lint rule lets only modules under `apps/server/src/db/` build a query or open a transaction (`apps/server/lint/raw-db-query.grit`; ADR-0002, "Scoped tables"). `apply-site.ts` therefore parses the document, opens the database as `register-managed-connector.ts` does (`withDatabase`), calls functions of the new `apps/server/src/db/setup.ts` and prints what they return. The class's transaction, and everything that runs inside it, is in `setup.ts`. The existing functions take the database handle and open a transaction of their own, which inside the class's transaction is a savepoint; `setup.ts` hands them the transaction in the handle's place, so no existing data-access file and not `auth/scope.ts` changes.

**Enrolment codes.** When `apply` has ended, the plain code exists only in what the operator's terminal showed. The database holds its hash, and no template, fixture or file of the site holds a code. If it is lost, an instructor of the class issues a new code in the web application, through the existing invitation route.

**Recent sign-in and the audit trail.** The routes that issue an invitation or change a grant call `scope.requireRecentAuth()` (ADR-0002, spec §3). `apply` has no session: the operator, on the server's host, makes these changes for the owning account through the data-access functions, under scopes from `resolveActorScope`, whose `requireRecentAuth()` still always throws. No route loses its call. P5-19 records this exception in ADR-0002, beside the sentence on sensitive membership changes, names it in that ADR's status line, and adds this sentence:

> `parallax apply` (P5-19) is the one caller that makes these changes without a session: run by the operator on the server's host, it issues enrolment invitations and gives instructors their class membership and course editing for the owning account, through the data-access functions under scopes from `resolveActorScope`, and it appends one `setup.apply` audit event for each class it changes. The routes keep `requireRecentAuth()`, which always throws on such a scope.

The events the existing functions write name the owning account as actor, as they would from that person's own session. So that the trail shows that setup made a change, `recordSetup` appends, in the class's transaction, one event with the action `setup.apply`, no actor (a system action), the class as scope and target, and in `after` the account it acted for and the names of the changes. No route writes that action, and it needs no migration: `action` is free text and `after` is JSON.

## 9. One-host installation (Q2)

`compose.yml` in the template, started by `parallax start`.

| Service | Runs | Networks | Notes |
| --- | --- | --- | --- |
| `postgres` | `postgres:16.15`, profile `bundled` | `backend` (internal) | a volume; no published port. `parallax env` leaves the profile off when the operator put the `DATABASE_URL` of an existing PostgreSQL 16 into `.env` |
| `migrate` | the server image, `tsx src/db/migrate.ts`, once | `backend`, `egress` | waits for `postgres` when it is bundled (`required: false`); the other services wait for `service_completed_successfully`. `egress` is its route to an existing PostgreSQL: `backend` is internal and has none |
| `server` | the server image, `tsx src/main.ts relay`: exactly one process, which serves every path ([operations](../operations.md), Routing) | `backend`, `egress`, `edge` | `./dist` read-only at `/site`; the volume `storage`; `STORAGE_DRIVER=fs`; the readiness probe of `infra/compose.prod.yml` |
| `worker` | the server image, `tsx src/main.ts worker` | `backend`, `egress` | the same `storage` volume |
| `caddy` | a pinned `caddy` image | `edge` | ports 80 and 443; `Caddyfile`; a volume for certificates |

There is no runner service, no Docker socket and no object store. Every service that reads `DATABASE_URL` (`migrate`, `server`, `worker`, and the backup container of §10) is on `backend` for the bundled database and on `egress`, which is not internal, for an existing one. `Caddyfile` has two site blocks, `{$APP_HOST}` and `{$CONTENT_HOST}`, each `reverse_proxy server:3000`: Caddy obtains a certificate for each name, upgrades WebSockets and forwards `Host` unchanged, which is how the one server tells the two origins apart (ADR-0002). The `edge` network has a fixed subnet and Caddy a fixed address there, and `TRUST_PROXY` is that address. Both subnets are stated in `compose.yml` and nowhere else. `infra/compose.prod.yml` and its test stay as they are.

**Secrets.** `parallax env` generates `POSTGRES_PASSWORD`, `SESSION_SECRET`, `CONTENT_TOKEN_SECRET` and `READY_PROBE_TOKEN` (and `RUNNER_DB_PASSWORD` at level 2) with `crypto.randomBytes` on the operator's machine, in a form that is safe inside a connection URL, into `.env` (mode 0600), which the template's `.gitignore` lists. The compose files name each secret as `${VAR:?}` and hold no literal value. The two secrets the operator types are needed only for a sign-in method the configuration lists, so `compose.yml` gives `server` and `worker` the references `${SMTP_URL:-}` and `${OIDC_CLIENT_SECRETS:-}` and holds no value of either; a value in `.env` reaches a container only through such a reference, and `start` checks them (below).

**Everything else** is derived into `.parallax/site.env`: `APP_HOST`, `CONTENT_HOST`, the two origins, `MAIL_TRANSPORT` (`smtp` when `signIn.email` is set, `none` when it is absent), `MAIL_FROM`, `OIDC_PROVIDERS` (only the providers `signIn.providers` lists, with no secret), `INSTRUCTOR_EMAILS`, `SHINY_ORIGINS`, the image references (`PARALLAX_SERVER_IMAGE`, `PARALLAX_RUNNER_IMAGE`), the compose profile (`COMPOSE_PROFILES`), and at level 2 `RUNNER_RUNTIMES`, which the server reads, and `RUNNER_DATABASE_HOST` (§11), which `compose.level2.yml` reads with an existing PostgreSQL too. The services read the file as `env_file`, so a later version can add a setting without a change to the site's compose file, and `packages/cli/src/host/compose.ts` gives every `docker compose` call the files for the level and both environment files, so the `${VAR}` references of the compose files are filled from them. The file holds no secret.

The operator types the two host names once, as `origins` in `parallax.config.ts`, and the sign-in settings: `signIn` in the same file, and in `.env` `SMTP_URL` for email links and `OIDC_CLIENT_SECRETS` (`{"<id>":"<secret>"}`) for providers. `start` stops early, before any compose call and without printing a secret, when `signIn.email` is set and `SMTP_URL` is empty, or when a provider that `signIn.providers` lists has no secret in `OIDC_CLIENT_SECRETS`; it asks for no `SMTP_URL` when `signIn.email` is absent.

## 10. Upgrade (Q3; A52)

Changing the version is the upgrade: the operator edits the version of `parallax-site` in `package.json`, runs `npm install`, then `parallax upgrade`. At level 0 an upgrade is the version change, `npm install` and `parallax build`.

1. `env`, the compile of the new site into `.parallax/dist` (§6.4, steps 1 to 3) and `docker compose pull`, while the old version still serves the old `dist/`. A failure there interrupts nothing: no service has stopped and `dist/` is untouched.
2. `docker compose stop server worker`: the services that write.
3. A backup into `backups/<UTC time>`. A failed backup starts no migration and leaves `dist/` as it was: the command ends, names the stage and gives the command that starts the old services again (`docker compose start server worker`).
4. The compiled site is put into `dist/` (§6.4, step 4), then `up -d --wait`, in which `migrate` runs before the new services. A failed migration leaves `server` and `worker` stopped, and the message names the backup.

The new site is not put into `dist/` before step 4, because `dist/` is the directory the old server has mounted: put there earlier, it would be served by the old server, and it would stay there after a failed pull or backup.

**Where the backup runs.** The existing `scripts/backup.sh`, carried in the package, runs in a one-shot container of `postgres:16.15`, the bundled database's image, which has `pg_dump` 16, bash and the GNU tools the script needs. `packages/cli/src/host/backup.ts` writes `.parallax/compose.backup.yml` with the one service `backup` and runs `docker compose -f compose.yml -f .parallax/compose.backup.yml run --rm --no-deps backup`, so the site's `compose.yml` keeps its five services. The container joins `backend`, where bundled PostgreSQL answers although it publishes no port, and `egress` for an existing PostgreSQL. It gets the same `DATABASE_URL` and `PGPASSWORD` as `server` (the bundled database's password reaches the services as `PGPASSWORD`, not in the URL), runs as the operator on a POSIX host, the `storage` volume read-only as `STORAGE_DIR`, `PG_BIN` set to the image's PostgreSQL 16 directory, the script read-only, and `backups/` as its target.

**The guard.** `apps/server/src/db/migrate.ts` gains `assertNotNewer`: it compares the newest `created_at` in `drizzle.__drizzle_migrations` with the newest `when` of the package's `drizzle/meta/_journal.json` and, when the database is newer, exits non-zero with a message that names both dates and says what to do. Without it drizzle's migrator applies nothing and an older server starts on a newer schema. Migrations only move forward; rollback is installing the earlier version and restoring the backup taken before the upgrade with the shipped `restore.sh` ([backup and restore](../backup-restore.md)).

## 11. Level 2 runner profile (N9; Q27)

Level 1 needs no runner. Level 2 adds a runner on a separate host that the operator controls. The template has no profile that puts a runner on the site's host, and ADR-0004 and the sandbox policy of `apps/runner` are not changed. Level 2 adds three inputs, all typed in the `runner` field of `parallax.config.ts`: `host` (the runner host's address), `databaseHost` (the site host's address on the private network) and `runtimes`.

**On the runner host.** `compose.runner.yml` is copied there with `.parallax/runner/runner.env`. It has one service, `runner`, with the hardening of `infra/compose.prod.yml` (`cap_drop`, `no-new-privileges`, the socket's group, `RUNNER_PULL=never`, `RUNNER_DOCKER_RUNTIME` default `runsc`, the 80 s stop grace) and exactly the variables the runner reads ([runner design](runner.md) §7.1). `runner.env` holds `PARALLAX_RUNNER_IMAGE`, from which `compose.runner.yml` names its image, `RUNNER_DATABASE_URL` for the role `parallax_runner`, `RUNNER_IMAGES` derived from `runner.runtimes`, and no application secret. `parallax env` prints the pull commands for the runner host, where nothing is pulled at run time.

**How the runner host reaches PostgreSQL.** Directly on port 5432, over a private network between the two hosts: a provider's private network, or a WireGuard link the operator sets up. Parallax does not encrypt this connection; it relies on that network. On the site host, `parallax start` at level 2 adds `compose.level2.yml`, which changes only `postgres`: it publishes PostgreSQL only on `runner.databaseHost` and starts it with `hba_file` set to the generated `.parallax/pg_hba.conf`. Docker publishes no port of a container that is only on internal networks, so the file also gives `postgres` a network of its own that is not internal.

A custom `hba_file` replaces every rule of the image's own file, so the generated `pg_hba.conf` has exactly three rules, and nothing else matches. The first is `local all all trust`, the line the image's own file has for the Unix socket inside the `postgres` container. The image's first start on a fresh volume connects over that socket, and so does `start` below; no other container and no other host can reach it. The other two are the only `host` lines: the application role from the `backend` subnet, which `packages/cli/src/host/siteEnv.ts` reads from the site's `compose.yml`, and `parallax_runner` from `runner.host/32`, both only to the application database and with `scram-sha-256`. So the file admits nothing else from the network, and it has no line for a loopback address, because nothing in the container connects over TCP. It holds no secret and is written readable for the container's `postgres` user.

`start` then sets the role's login, its password (the generated `RUNNER_DB_PASSWORD`) and its connection limit with one `ALTER ROLE`, sent on standard input to `psql` in the `postgres` container (`docker compose exec -T postgres psql`), which connects over the socket; and `site.env` carries `RUNNER_RUNTIMES` from `runner.runtimes`. With an existing PostgreSQL there is no `postgres` container and `start` does none of this: the operator's database administrator applies the same rule and sets the password, and `RUNNER_DATABASE_URL` is typed into `runner.env`. The existing role keeps its grants: schema `pgboss_exec` only (`scripts/runner-role.sql`).

## 12. Release (Q1)

`.github/workflows/package-release.yml` follows `connector-release.yml`. Triggers: a tag `parallax-v<version>`; a pull request that changes the workflow, the two manifests, `packages/cli/scripts/**`, `infra/docker/**` or the conversion closure that `vendor.ts` packs (`apps/server/src/content/**` and the files outside it that the closure imports, today `apps/server/src/config.ts` and `apps/server/src/execution/**`); `workflow_dispatch` with `dry_run` true by default. Workflow permissions are `contents: read`. The conversion sources are among the paths because the installed-package check below is the one place in this design where the conversion runs from an installed copy, and `package-release.test.ts` fails when the closure reaches a file that the paths do not name. The other sources the tool carries (`apps/web`, `packages/ui`, `packages/contracts`, `packages/cli/src`) do not start the workflow: `pack.test.ts` and the A37 end-to-end test, which builds a site from packed tarballs, check them on every pull request.

Job `build` holds no secret. It takes the version and the `publish` flag from `packages/cli/scripts/release.ts`, which states the connector workflow's rule as a tested function: the tag's version, or `0.0.0-dryrun.<sha>` with the full commit hash and `publish=false`; a manual run stays a dry run unless `dry_run` is off and the ref is a tag. A tag that is not `parallax-v` and a semantic version of at most 128 characters without build metadata (a Docker tag holds no `+` and no more) stops the run, and so does a publishing tag whose commit is not on `main`. It builds the two images from the revision as it is, without pushing, with the version as the build argument `PARALLAX_VERSION`, exports them as archives, loads the archives back and checks the label `org.opencontainers.image.version` of both images, the version the server reports and the owner of its storage directory. It then runs the pack check (`pack.test.ts`), stamps the version into both manifests and the image namespace into `parallax.registry` in the run's checkout, packs both packages with `pack.ts`, runs the installed-package check (`packages/cli/scripts/packed-install.sh`: a site created from the scaffolder's tarball outside the repository with no workspace link is installed and built, and the conversion entry runs from the installed copy with `DATABASE_URL` unset on a reading, a deck, a notebook and two PDFs), and has `release.ts` write the release manifest: the checksums of the tarballs and of the image archives (read in chunks, so an archive may pass 2 GiB), the image references and the source revision. Every run, a dry run too, uploads the image archives, the tarballs and the release manifest as one artifact, kept 30 days on a run that publishes and 3 otherwise, so a dry run hands over and checks what `publish` would push.

Job `publish` runs only when `publish` is true, which a pull request never is. It alone has `packages: write` and alone names `secrets.NPM_TOKEN`: its first step only as `secrets.NPM_TOKEN != ''`, so that step sees `true` or `false` and a tag without the secret stops there, before anything is pushed; the value reaches only the one step that publishes. `NPM_TOKEN` is a secret of the environment `release`, which `publish` alone names and which the owner limits to `parallax-v*` tags ([operations](../operations.md#package-releases)), so the run of a pull request cannot read it even from an edited copy of the workflow (owner decision of 2026-10-20, P5-AUD14). GHCR is reached with `secrets.GITHUB_TOKEN`. It builds nothing and installs nothing: it has no checkout, sets up neither Node nor pnpm, and no step runs `docker build`, `buildx`, `npm ci`, `npm install`, `pnpm`, `npx`, `tsx` or `node`; it uses the runner's own `docker`, `npm`, `curl` and `jq`. It downloads the artifact, checks the tarballs and the image archives against the release manifest, and stops before any push when npm already holds either package at the version or GHCR either image tag, or when either registry answers anything but "not found", so that a run of the workflow as written never replaces a published image or version. The environment keeps the npm token from a run that is not for a release tag; that a release tag is the owner's rests on the tag ruleset and the environment's required reviewer of [operations](../operations.md#package-releases), and the images, pushed with the run's `GITHUB_TOKEN`, are not guarded by the environment (the known limit there). It then loads the two images, which `build` built from the tagged revision, and pushes them, adding each image's digest, known only after the push, to the release manifest. It then publishes the tarballs unchanged with `npm publish ./release/<file> --ignore-scripts` (npm reads a path without `./` as a GitHub repository), `parallax-site` and then `create-parallax-site` (a prerelease under the npm tag `next`), and uploads the completed release manifest as an artifact of the run. No session pushes a tag; the first release tag is the owner's.

**The published pieces as packed.** Both manifests are publishable: no `private`, `engines` with the root's `node >=22.12`, and `publishConfig` for the public npm registry; in the repository they carry `0.0.0`. `parallax-site` also lists `@types/react` and `@types/react-dom`, which the pages of a site need for their types. Both images take the build argument `PARALLAX_VERSION` (default `0.0.0`) as their label; the server image sets it as the variable of that name, which `apps/server/src/version.ts` reads, and creates `/var/lib/parallax/storage` owned by `node` as its `STORAGE_DIR`, so a volume mounted there (§9) starts owned by the user the server runs as.

## 13. Where other runs attach

| Run | Attaches at | Until it lands |
| --- | --- | --- |
| R2 (P5-04; units P5-08, P5-09, P5-18) | the layout inside a course folder; the commands `check` and `sync` as the files `src/commands/check.ts` and `src/commands/sync.ts`, `sync` running its server script with `runInServer` of `src/host/compose.ts`, as `apply` does; the lookup that gives the course a folder syncs to, which `apply` calls; the source of a course's title for the catalogue; the directory name of the private overlay; the conversion entry that the tool packs | a class whose course is not synced is reported as pending; the title is the folder's name; this document writes `private/` |
| R3 (P5-05; units P5-14 to P5-16) | the level 0 build as `packages/cli/src/open/`, called from the level switch in `src/commands/build.ts`; whether its shell mounts site pages with `siteRoutes`; the address it gives as `site.entry`; what `origins` and `origins.shiny` produce at level 0 | `build` and `dev` stop at level 0 |
| R4 (P5-12, P5-13) | landed with P5-12 and P5-13 ([ADR-0002](../adr/0002-authorization-and-class-isolation.md), Amendment: Identity providers): `signIn.providers` in `siteConfig` (§4); the provider variables in `src/host/siteEnv.ts` (P5-23a), which emits a provider's settings only for a provider the configuration lists, and the references of `compose.yml` (P5-23b), both as §9 states them | landed |

If run R2 offers no course lookup, P5-19 cannot finish and is labelled `needs-human`.

## 14. Open questions, what is left out, and known limits

**For the owner.** None is decided here, and no unit waits for an answer.

1. The templates are written at level 1, the level this design can build, serve and install. Should level 0 be the default once run R3 has decided whether its shell mounts site pages?
2. How does a level 2 operator get the sandbox runtime images without a copy of the repository? Q1 names the images a host runs as "server, runner", so a release publishes the runner service only. Should a release publish the runtime images as well?
3. The licence named in the two published manifests. It is needed before the first release tag.
4. Is an SVG logo wanted? This design accepts PNG, JPEG and WebP only.

**Left out on purpose, each a later owner decision** (`needs-human` if a unit is asked for one): moving a class to a later release and replacing a lost enrolment code from the command line (the existing routes stay for both); TLS for PostgreSQL between the two hosts; a command that restores a backup; a profile with the runner on the site's host; a site theme; Markdown pages; a runtime API for pages; pages with parameters in their address. Owner inputs that no unit waits for: the npm account and the first tag `parallax-v<version>` (plan §7).

**Known limits.**

- Setup waits for a first sign-in: `apply` stops until every listed instructor has signed in once, so a first installation has a step the operator cannot do alone. A mistyped address in `instructor.yaml` gives no one the courses: setup names the file and stops.
- The site records no versions of transitive dependencies; `parallax-site` pins its direct dependencies exactly, which fixes those only.
- The installation files (`compose.yml`, `Caddyfile`, `compose.level2.yml`, `compose.runner.yml`) and `.gitignore` are copied from the template once, as Q2 has it ("a compose file in the template"). A later version can add a setting that is not a secret through `site.env` (§9). One that needs a new required secret, volume, service or Caddy rule asks for an edit of those files, so the claim that a new version changes `package.json` alone (A37) holds for a version that needs none of these.
- The runner link relies on a private network and on `pg_hba` by address, which holds only where PostgreSQL sees the runner host's own address.
- At level 2 the network that lets PostgreSQL publish its port would also give the `postgres` container a route out, which it has neither at level 1 nor in `infra/compose.prod.yml`. `compose.level2.yml` therefore sets Docker's `enable_ip_masquerade: "false"` on that network. On a Linux engine (a privileged `docker:dind`, in the review of pull request #671) Docker then added no `MASQUERADE` rule for its subnet, a container on it could not connect out, and the published port was still reached with the client's own address as the source, so `pg_hba` by address holds. Docker Desktop does not honour the option: in a run there the port was published and a container on such a network still connected out. On a Desktop host the route out stays.
- The fixed subnets of `edge` and `backend` can collide with networks already on a host; each is one line in `compose.yml`. Caddy's certificates need public DNS for both names and ports 80 and 443.
- Until the owner answers question 2, a level 2 operator builds the runtime images with `scripts/runner-image.sh` from a copy of the repository.

## 15. Tests by item

The `Verify` line of each entry in plan §9 is the full list; this table names the files and the scenario tests. `pnpm test` needs no network; the one test that installs from the npm registry is the A37 end-to-end test. No existing test file is modified by any of these units.

| Item | Tests |
| --- | --- |
| P5-06 | `apps/web/src/app.test.tsx`, `apps/web/src/sitePages.test.tsx` (component project) |
| P5-07a | `packages/contracts/src/site.test.ts`, `packages/cli/src/site/load.test.ts` |
| P5-07 | `packages/cli/src/a37-site-build.test.ts`: `A37 a site builds with its front page at / beside the Parallax screens`, with sentinel strings planted in the fixture's course files, in a hidden definition of its private overlay and in its instructor addresses, none of which may be in an emitted file. `packages/cli/src/a39-site-pages.test.ts`: `A39 a site page at the address of a Parallax screen stops the build and names both`, whose refused cases include a course folder and an overlay that are links, files that Vite reads itself and a worker |
| P5-07c | `packages/cli/src/site/folders.test.ts`, on the instructor folders that `loadSite` returns, with the title of `course.yaml` and the folder's name where it has none. It adds to the A37 test the catalogue clause, and to the A39 test a global stylesheet and a `--pc-*` declaration; two tests with plain titles: `parallax dev` and `parallax --help` |
| P5-17a | `packages/cli/src/pack.test.ts` |
| P5-17 | `packages/create-parallax-site/src/a37-create.test.ts`: `A37 one command creates a site of either mode, and only package.json names the Parallax version`. `e2e/tests/a37-template-site.e2e.ts`, on packed tarballs: `A37 a site created from the instructor template shows its front page at / and links to the Parallax interface` and `A37 a new version changes package.json and no other tracked file` |
| P5-19 | `apps/server/test/integration/a51-setup-from-config.itest.ts`: `A51 setup from the configuration creates instructor access, classes and enrolment with no API call, and a second run changes nothing`. `apps/server/src/scripts/apply-site.test.ts` |
| P5-22 | `packages/cli/scripts/release.test.ts`, `apps/server/src/infra/package-release.test.ts`, and the workflow's dry run on the pull request |
| P5-23a | unit tests beside `packages/cli/src/host/{secrets,siteEnv,compose}.ts` and `packages/cli/src/site/setup.ts`, with the process runner injected, so no Docker is needed |
| P5-23b | `apps/server/src/infra/compose-site.test.ts` |
| P5-23 | `packages/cli/src/commands/upgrade.test.ts`: `A52 an upgrade backs up before it migrates, and a failed backup starts no migration`. `apps/server/test/integration/a52-migrate-guard.itest.ts`: `A52 an upgrade migrates forward and a database newer than the package is refused`. `apps/server/src/infra/compose-site-env.test.ts`. `apps/server/test/onehost/a52-one-host.docker.itest.ts`, in CI only: `A52 the one-host installation answers on both host names` |

## 16. Differences from the plan of run R1, and what was checked

**Differences.** Each follows from the repository, from how Docker, the `postgres` image or Vite behave, or fixes a detail that two units share; none adds a commitment. Items 8 to 11 come from the review of this document (pull request #566).

1. **§8, where the class's transaction is opened.** The plan has the script compose the data-access functions with each class in one transaction. The lint rule of `apps/server/lint/raw-db-query.grit` refuses `transaction` on a database handle outside `apps/server/src/db/`, and `createDb` outside `main.ts` and `db/`. The transaction is therefore opened in `db/setup.ts`, and the script gets its handle from the existing `withDatabase`.
2. **§8, the join link.** For an open class `apply` prints the join link of P5-11, so P5-19 depends on P5-11 as well. Session order already puts P5-11 first.
3. **§6.1.** The plan says that without pages `createApp` passes the generated tree on untouched. Here every call starts from `kept`, which is the same for a first call and also holds after a call with pages.
4. **§4.** `name`, `origins.app` and `origins.content` are stated as required. The plan's table says so only for `mode` and `level`; Q2 and Q20 need two host names at every level.
5. **§9 and §11, details fixed here** because P5-23a writes them and P5-23b reads them: the names `PARALLAX_SERVER_IMAGE`, `PARALLAX_RUNNER_IMAGE` and `COMPOSE_PROFILES` in `.parallax/site.env`; both environment files on every `docker compose` call; and the `backend` subnet, which is read from `compose.yml` and not repeated. Generated secrets are safe inside a connection URL, because the database passwords go into one ([operations](../operations.md), First start).
6. **§11.** `backend` is an internal network, and Docker publishes no port of a container that is only on internal networks, so `compose.level2.yml` also gives `postgres` a network that is not internal. It still changes only `postgres`.
7. **ADR-0001's status line** is written in the form the other amended ADRs use, not in the plan's wording.
8. **§9, `migrate`.** The plan's table puts `migrate` on `backend` only. `backend` is internal, so with the bundled database off `migrate` could not reach the PostgreSQL that `DATABASE_URL` names, and `server` and `worker`, which wait for it, would never start. `migrate` is on `egress` as well, like every other service that reads `DATABASE_URL`.
9. **§11, the socket rule.** The plan's `pg_hba.conf` has the two network rules, and "nothing else matches". A custom `hba_file` replaces the image's own rules, the socket's included, so the image's first start on a fresh volume and `start`'s `psql` would be refused. The file keeps the image's `local all all trust`, the two network rules are its only `host` lines, and §11 says how `start` runs `psql`.
10. **§6.4 and §10, `dist/`.** The plan compiles straight into `dist/`, the directory the running server has mounted, and says of the upgrade's first step that a failure there interrupts nothing. Vite does not empty an `outDir` outside its root, and a finished build would be served by the old server at once and stay after a failed pull or backup. The compile goes to `.parallax/dist` and is put into `dist/` afterwards; `upgrade` does that only after the backup.
11. **§12.** The plan has `publish` build the images again, in the one job that may write packages. Here `build` hands them over and `publish` builds nothing. The pull-request paths gain `apps/server/src/content/**`, because ADR-0001 says "the workflow or what it packs" and no other test runs the conversion from an installed copy.

**Checked in the repository** on 2026-10-13, at `7a2582f7`, where the plan or an earlier document states a fact about it:

- `apps/web`: `main.tsx` holds the two style imports and the `Register` declaration; `package.json` has no `exports`, and nothing imports `@parallax/web`; `vite.config.ts` has the two plugins in the order given and proxies `/api` with the browser's `Host`; `FileRoutesByTo` has eight keys; `routeTree.children` is an array (`_addFileChildren` stores `Object.values`), and the route's `update` returns the route itself, so the generated index route is the `Route` of `routes/index.tsx`; the global bar's "Parallax" link goes to `/`.
- Router plugin and Vite: the plugin's generator takes Vite's `root` and writes `routeTree.gen.ts`; the code splitter reads the generator's `routesByFile`. Vite 8.3.1 leaves an `outDir` outside its root as it is unless `emptyOutDir` is set (`resolveEmptyOutDir`), and empties one when rendering starts, before it writes (`prepareOutDir`).
- `apps/server`: `STATIC_DIR` and the rule that the two host names differ are in `config.ts`; `/api`, `/assets/` and `/content/:token` are answered by the server; three of the four `*.worker.mjs` files register `tsx` themselves and the fourth, `pdf-text.worker.mjs`, is plain JavaScript (the plan names the first kind only); `resolveActorScope` returns scopes whose `requireRecentAuth()` always throws, and the member routes call it; `createClass`, `issueInvite`, `listMembers`, `adoptRelease` and `acceptInstructorInvite` have the signatures §8 relies on; `classes` is a course-scoped table, and `users` and `courses` are not scoped; `audit_events.actor_id` is nullable, `action` is text and `after` is JSON; `migrate.ts` runs drizzle's migrator, and the journal carries `when`.
- Infrastructure: `infra/compose.prod.yml` has the runner hardening and the readiness probe named above and uses `postgres:16.15`; the server image sets `STATIC_DIR` and runs as `node`; `image.yml` starts for a new `packages/*/package.json`; `connector-release.yml` has the shape §12 follows; `scripts/backup.sh` needs `DATABASE_URL`, `STORAGE_DIR` and `pg_dump`, and its target must not exist.
- Tests: the `integration` project of `vitest.config.ts` excludes only the runner's `*.docker.itest.ts`, so a Docker test under `apps/server/test/integration/`, where the earlier entry of P5-23 put it, would run in `pnpm test:integration` without the image. P5-23 therefore uses `apps/server/test/onehost/` and a project of its own. The scenario checker scans every test file of the repository, `packages/` included.

**Probed** on the same day, in scratch files that are not committed, on Windows with Node 22.12:

- A component test built the routes of §6.1 on the generated tree. A page at `/about` rendered under the global bar while `/` still redirected; a page at `/` rendered with no redirect while `/signin` stayed the sign-in screen; a second call held each page once; a call without pages gave the generated tree again.
- A script copied the sources of `apps/web`, `packages/ui` and `packages/contracts` to a folder outside the repository, rewrote the 99 `@parallax/…` specifiers to relative paths, and ran the build of §6.4 with a resolver of the kind described there. It emitted `index.html`, the two site pages, a separate chunk for the sign-in screen and the PDF worker files, as `pnpm build` does; the regenerated `routeTree.gen.ts` was identical; one copy each of `react`, `react-dom`, `@tanstack/react-router` and `@tanstack/react-query` was bundled; no module came from the repository's sources; and the repository's working tree was unchanged. `resolve.dedupe` made no difference there.
- For items 6, 8 and 9, with Docker on the same machine and the image `postgres:16.15`. On a fresh volume, an `hba_file` with the two network rules alone ended the container with exit code 2 (`no pg_hba.conf entry for host "[local]"`, from the image's own `psql`). With `local all all trust` added, the first start completed, the `ALTER ROLE` sent to `psql` in the container was applied, and a connection to `127.0.0.1` inside the container was refused. On a volume first started with the image's own file, the two-rule file let the server start and refused `psql` in the container. A container on an internal network alone had no default route, and one that was also on a network that is not internal had one. A port asked for on a container that was on an internal network alone was not published, and with a second network it was.

The first two probes did not install a packed `parallax-site`, start a server or open a browser: P5-07's A37 test, P5-17's end-to-end test and P5-22's installed-package check do that. The third did not start the template's compose files, which do not exist yet, and no test of the plan starts level 2.
