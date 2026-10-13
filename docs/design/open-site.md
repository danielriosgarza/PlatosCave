# Open site detailed design (P5-05)

**Status:** accepted with the merge of P5-05, 2026-10-13. Refines the amendment "Open site (level 0)" of [ADR-0002](../adr/0002-authorization-and-class-isolation.md) for §13 of the [product specification](../product-spec.md) ("Installation, levels and boundaries"): level 0 of requirement N6, on the owner's answers Q17 to Q21 ([plan](../delivery/plan.md) §8). It is the lasting form of sections 1 to 8 and 10 of the plan that planning run R3 landed, [`docs/plans/2026-10-13-design-the-open-site-n6-level-0-answers.md`](../plans/2026-10-13-design-the-open-site-n6-level-0-answers.md), and keeps that plan's numbers for those sections. Where the two differ this document is current, and §13 lists each difference. Items P5-14, P5-14a, P5-14b, P5-14c, P5-15, P5-16 and P5-16a in the plan implement it and take their tests from §10. Nothing in it is built yet, and Parallax as built does not change: the application of levels 1 and 2 gains no route, screen or stylesheet and loses none (§8). It fits the [site toolkit design](site.md) and the [course folder design](course-folder.md): §7 has what they left to this run, and §13 where it refines them. It decides nothing that belongs to the owner: §12 says what is open.

Terms: the **build** is `parallax build` at level 0. The **shell** is the level 0 viewer in `apps/web/src/open/`. An **object** is a file of untrusted content: a PDF, an image, an SVG, the HTML document of a notebook output, the notebook file composed for download. A **data file** is a JSON file that the build writes for the shell. The **site host** and the **content host** are the hosts of `origins.app` and `origins.content`. A **course reference** is a course as `classes[].course` spells it: `<course>` in instructor mode, `<name>/<course>` in school mode. The site, the tool, a page and a screen are those of the site toolkit design; a course folder, a tree, the overlay, a definition and a folder id are those of the course folder design.

## 1. Shape and trust boundaries

```text
 author's machine   parallax build, level 0 ─▶ readCourseForSite ─▶ upload rules ─▶ convertRevision ─▶ publicationReport
                      └▶ one write path ─▶ .parallax/open/{site,content} ─▶ audit of every file ─▶ dist/site   dist/content
 static hosting     site host    ◀─ dist/site      index.html at every address, assets/ (compiled shell), JSON data files
                    content host ◀─ dist/content   o/<sha256>.<ext>: every object, and nothing else
 visitor's browser  shell ─GET *.json, site host─▶ the existing viewers ─img, frame with sandbox="", PDF bytes─▶ content host
```

`parallax build` at `level: 0` turns a site's course folders into plain files for two host names, and the shell shows slides, readings and rendered notebooks from those files: no server, no database, no sign-in, no request to `/api`. The build reads a course folder through the reader's site entry, checks and converts it with the functions of level 1, and writes everything through one write path, whose audit reads every file again before anything is put in place. What stands in for authorisation is omission when the site is built (§5); what stands in for the content origin is the second host name (§9).

| Part | Trusted for | Limits |
| --- | --- | --- |
| course folders | nothing: untrusted content that may hold hidden material | read only through `readCourseForSite`; every file passes the upload rules, the renderers and the sanitisers of level 1; no file under `exercises/`, `tests/` or `private/` is opened (§10) |
| the site's `src/` and logo | the owner's own code, compiled into the shell as at level 1 ([site design](site.md) §1) | cannot import a course file (P5-07's resolver), and the audit of §4 finds a course file's bytes under `site/` |
| `dist/site` | the shell and data that passed a schema | holds no object; the three app-origin surfaces arrive as HTML strings in JSON and pass `sanitizeReading` before insertion |
| `dist/content` | nothing | objects only, each named by its digest; no page, script or data of the site |
| the static hosts | serving files | they enforce nothing: no token, no expiry, no date, no header of ours (§12) |

## 2. Output and addresses

The build writes into the git-ignored work folder `.parallax/open/` and, after the audit of §4, replaces the content of `dist/` with the two trees. A build that stops leaves `dist/` as it was.

```text
dist/site/                                      for the site host
  index.html                                    the shell; also the address /
  assets/…                                      the compiled shell and the site's own pages
  <page>/index.html                             one copy of index.html per site page (about/index.html)
  courses/index.html      courses/catalogue.json                        the catalogue (openCatalogue)
  courses/<ref>/index.html      courses/<ref>/course.json               a course's topic index (openCourse)
  courses/<ref>/<topic id>/<tab>/index.html                             five addresses per topic
  courses/<ref>/<topic id>/topic.json                                   the lists of the five tabs (openTopic)
  courses/<ref>/<topic id>/<resource id>.json                           one deck, reading, notebook or Shiny app (openResource)
dist/content/o/<sha256>.<ext>                   for the content host
```

- *Addresses.* The catalogue is `/courses`, a course `/courses/<ref>`, a topic `/courses/<ref>/<topic id>/<tab>`, and `?resource=<resource id>` picks a resource of a tab (`&page=<n>` a slide). `<tab>` is one of `slides`, `reading`, `exercises`, `notebooks` and `tests`. `<ref>` is the course reference, each folder name percent-encoded in an address and written as the listing spells it on disk. A topic and a resource are named by their **folder id**, as level 1 names them by id: a link survives a renamed file or topic folder, and no rule for slugs is added. A course has no id in a folder ([course folder design](course-folder.md) §4.2), so it is named by its folder, the name the catalogue already carries. `/courses` is also `site.entry`, the address a front page links to ([site design](site.md) §6.6), at every level.
- *Plain files.* Every address has its own `index.html`, a byte-identical copy of the shell's, so a link straight to a topic needs no rewrite rule and no fallback page, and a site page keeps the address it has at levels 1 and 2 (`/about`, from `about/index.html`). Beyond serving the files written, the host is asked for one thing, which static hosting gives: a folder's `index.html` answers the folder's address (§12). Routes of 1, 2, 3 and 4 segments under `/courses` are disjoint (course in instructor mode, course in school mode, topic in instructor mode, topic in school mode), so the shell needs no mode to route.
- *One path, one output.* Two outputs at one path, also when they differ only in case, stop the build and name both (a course folder called `catalogue.json`, for one).
- *Reserved addresses.* `/courses` and one to four segments under it belong to Parallax at every level: P5-16a adds the patterns `OPEN_ADDRESSES` to the conflict rule of `packages/cli/src/site/pages.ts`. A site page then stops the build at the same addresses at level 0 and at levels 1 and 2: an address of the generated route list or under `/api`, `/assets` or `/content`, as today ([site design](site.md) §6.3), and an address of `OPEN_ADDRESSES`, which adds, at levels 1 and 2, addresses under `/courses` that are no screen today (`/courses/intro`). So a site whose pages build at one level build at the other.
- *Objects.* `contentType → ext` is a fixed table in `openSite.ts`: `application/pdf` pdf, `application/x-ipynb+json` ipynb, `image/png` png, `image/jpeg` jpg, `image/gif` gif, `image/webp` webp, `image/svg+xml` svg, `text/html; charset=utf-8` html. A static host picks the content type from the extension, so the table is what stands in for the type a content token carries. Any other type stops the build; no JavaScript type is in the table.

## 3. Static data: `packages/contracts/src/openSite.ts` (P5-14a)

Four strict schemas (`z.strictObject`) for the data files the shell reads, and a fifth, `openNotebookFile`, for the notebook file a visitor downloads. The contracts index exports the file and the web application imports that index, so it uses no Node built-in. Ids are the folder id schema that `siteManifest` uses.

| Schema, file | Built from | Keeps | Drops | Replaces |
| --- | --- | --- | --- | --- |
| `openCatalogue`, `catalogue.json` | no student view exists (`listCourses` lists a person's classes); the shape is `siteCatalogue` of P5-07a | instructor display names, course titles | has no field for an address, a class, a count or a topic | `classId` and `courseId` by `ref`, the course reference |
| `openCourse`, `course.json` | `getClassTopics.response` and `classTopic` | `course.title` as `title`, `instructors`; per topic `topicId`, `number`, `title`, `objective`, `estimatedMinutes`, `presence`, `firstTab` | `release` (id and version), `course.id`, `cohort` (a class), `resume` and `savedTab` (saved positions), `reviewed` (progress), `state`, `availableAt`, `requires` (a lock needs an account or a date) | `topicId` is the topic's folder id |
| `openTopic`, `topic.json` | `deckSummary`, `readingSummary`, `notebookSummary`; for Exercises and Tests `releasedResource` | `title`; a reading's `kind`; a notebook entry's `type` (`notebook` or `shiny`) | `revisionId`, `position`, `lastRevisionId`; of `releasedResource` also `id`, `type`, `tab`, `position`, `visibility`, `releaseAt`, `credit` | `resourceId` is the resource's folder id. An exercise or test entry is `{ resourceId, title }` and nothing more |
| `openResource`, `<resource id>.json`, a union on `type` with four branches | `slides`: `getSlides.response`. `reading`: `getReading.response`. `notebook`: `getNotebook.response` with `notebookView` as it is. `shiny`: `getShiny.response` | `title`, `pdf.pageCount`, `web.slides`, `kind`, `html`, every field of `notebookView`, a Shiny app's `url` and `origin` | `revisionId`, `status`, `error` (only converted material is written), `pdf.expiresAt` (an expiring token link), `sourceKey` (a storage key) | `pdf.url` and every output `url`: a permanent address on the content origin. A notebook's `sourceKey` by `file`, the address of the notebook file composed for download (`openNotebookFile`), not of the stored `.ipynb`. A Shiny `url` is always there (Q19), and `origin` is null when `origins.shiny` does not list it |

The table leaves these shapes, each strict at every level except `notebook`, which is `notebookView` as it is:

```ts
openCatalogue: { mode: 'instructor' | 'school', instructors: [{ name, courses: [{ ref, title }] }] }
openCourse:    { title, instructors: string[], topics: [{ topicId, number, title, objective, estimatedMinutes, presence, firstTab }] }
openTopic:     { slides: [{ resourceId, title }], reading: [{ resourceId, title, kind }], notebooks: [{ resourceId, title, type }],
                 exercises: [{ resourceId, title }], tests: [{ resourceId, title }] }
openResource:  { type: 'slides', title, pdf: { url, pageCount } | null, web: { slides } | null }
             | { type: 'reading', title, kind, html: string | null, pdf: { url, pageCount } | null }
             | { type: 'notebook', title, file, notebook }
             | { type: 'shiny', title, url, origin: string | null }
```

There is no branch of `openResource` for an exercise or a test, and no file is written for one. The writer serialises the **parse result**, never its input, so a key that a nested non-strict schema (`notebookView`) does not name cannot be emitted, and a key that a strict schema does not name stops the build. One branch differs from its student view by the owner's answer and not only by what it drops: at level 1 an app on an origin that is not approved is neither framed nor linked (`getShiny` gives no `url`), and at level 0 it always keeps its link (Q19).

The file also exports:

- `courseRef(mode, instructor, course)`, the course reference;
- `openPaths` (`catalogue`, `course(ref)`, `courseData(ref)`, `topic(ref, topicId, tab)`, `topicData(ref, topicId)`, `resourceData(ref, topicId, resourceId)`), which the build and the shell both use. Each is an address from the site's root, with every folder name percent-encoded (`/courses/Reef%20ecology/course.json`); the build writes the file whose path is that address decoded;
- `OPEN_ADDRESSES` (`/courses`, `/courses/$a`, `/courses/$a/$b`, `/courses/$a/$b/$c`, `/courses/$a/$b/$c/$d`);
- `objectExtension(contentType)`, the table of §2;
- `viewNotebook(stored, urlFor, html)`, the read-time step of the notebook route (`notebookView` in `apps/server/src/http/routes/notebooks.routes.ts`, which imports `db/` and cannot be loaded by the tool) restated without the server. `urlFor` gives the address of an object, and `html` sets the image addresses in an HTML string; the build passes `resolveReadingImages` for it. A test in the server package holds `viewNotebook` equal to what the server does.

No policy function is exported: `index.html` carries no content security policy (§9).

`openNotebookFile` is the schema of the one notebook file the build writes: a notebook in nbformat 4.5 composed from the rendered view (`notebookView` after `viewNotebook`), strict at every level. A Markdown cell holds the sanitised rendered HTML with image addresses on the content origin, a raw cell its text, and a code cell its source with `execution_count: null` and `outputs: []`; each cell keeps its id; `metadata` is empty except the language name, which stands at `language_info.name` when the view states a language. The schema has no field for an attachment, for other metadata or for a stored output's payload, so the download holds none, a JavaScript payload included.

## 4. The build: `packages/cli/src/open/` (P5-14b, P5-14c, P5-14)

- `origins.ts` (P5-14b): `assertSeparateHosts({ app, content })`. Host names are compared in lower case, without port, scheme or a trailing dot. `127.0.0.1` and `localhost` differ (the development pair of ADR-0002); `localhost:4310` and `localhost:4311` do not.
- `output.ts` (P5-14b), the one write path: `createOutput({ workDir, contentOrigin })` returns `object(bytes, contentType)` (writes `content/o/<sha256>.<ext>`, returns its address on the content origin), `data(path, schema, value)` (writes `JSON.stringify(schema.parse(value))` at a `.json` path under `site/`), `shell(path, bytes)` (a file of the compiled shell), `address(path)` (a copy of the shell's `index.html`), `untrusted(sha256)` (the digest of a course file the build opened) and `finish()`. Only `object` takes content bytes, and it can write only under `content/`. `finish()` is the audit: it reads every file of the work folder again. Under `site/` a file must be a recorded shell file with the recorded bytes, an `index.html` equal to the shell's, or a data file that still passes the schema its name gives; no file may have the digest of an object or of a course file; every object address in a data file (`pdf.url`, `file`, an output's `url`, a `src` in an HTML string) must be on the content origin at a path the build wrote. Under `content/` a file must be `o/<its own sha256>.<ext of the table>`. Any failure is a `BuildStop` that names the file. `placeOutput(workDir, distDir)` runs only after it.
- `download.ts` (P5-14b): `notebookDownload(view: NotebookView): OpenNotebookFile`, the notebook file a visitor downloads, composed from the rendered view as `openNotebookFile` states it (§3). `buildCourse` writes `JSON.stringify(openNotebookFile.parse(…))` through `out.object` with the type `application/x-ipynb+json`. The notebook's own `.ipynb` is read for conversion, its digest goes to `out.untrusted`, and its bytes are written nowhere.
- `course.ts` (P5-14c): `buildCourse({ dir, ref, instructors, shinyOrigins }, out)` for one course folder. (a) `readCourseForSite(dir)`; an error problem stops the course with the reader's lines, as `parallax check` prints them. (b) The upload rules of `courseFiles.ts` on every file the manifest lists, data files included. (c) For each resource, `revisionPayload` and `convertRevision`. (d) `publicationReport(manifest, derived, { approvedShinyOrigins: shinyOrigins, runtimes: [] })`. (e) Data and objects through `out`. Image sources in HTML are set by `resolveReadingImages` of `apps/server/src/content/reading.ts`, loaded through `paths.ts` like the conversion entry; notebooks go through `viewNotebook`, and a notebook's `file` is the object that `notebookDownload` gives. `presence` comes from the resources of the manifest, which holds the visible ones only (§5), and `firstTab` from the rule of §4 of the specification (`tabs.find`: the first of the five tabs that is present). `buildCourse` writes every resource the manifest hands it and selects none: it has no filter for visibility or for dates (§5).
- `build.ts` (P5-14): `buildOpenSite(site, { shell })`. It checks the hosts, builds every course of every instructor folder (`src/site/folders.ts`), prints every problem of every course and stops if one is an error, writes `catalogue.json`, calls `shell(site, out)`, writes the address copies (the screens of §2 and each page that `src/site/pages.ts` finds), runs `finish()` and places the output. It is called from the level switch of `packages/cli/src/commands/build.ts`.
- `shell.ts`: the type `ShellCompiler` and, in P5-14, `noViewerYet`, which stops with the message and exit code that P5-07 gave the level 0 stop. P5-16a adds `compileOpenShell` and switches the command to it (§6).

*Storage keys and object ids.* There is no course row, so the key of a file is `open/objects/<sha256 of its bytes>`, the form `objectKey` gives with the prefix `open`, and `open` is the prefix handed to `convertRevision` for a notebook's output objects. `io.read(key, maxBytes)` answers from the reader's `open(file)`, with the size limit a storage read has. The build writes an object from its own read of the file, because a conversion may take the buffer it was given. There is no object row, so no object id: `revisionPayload` is called for a notebook **without data files**, the form of a notebook that has none, and the notebook's bytes are the file's own. Those bytes go to conversion only: the file a visitor downloads is composed (§3).

*A notebook's data files.* They are checked by the upload rules, so the same folder is accepted or refused at both levels, and they are not converted, not written and not listed: the student view of level 1 has no field for them, and they reach a student only inside a connected session. Whether a level 0 site should offer them is an open question (§12).

*A topic with only exercises and tests.* `publicationReport` on a site manifest reports it as `empty_topic`, a warning. The build drops that warning for a topic that lists an exercise or a test, builds the topic like any other, and keeps the warning for a topic with no visible resource, which is built too. The topic index marks Exercises and Tests as present, `firstTab` is the first populated tab, and the three material tabs show the existing empty lines.

*What stops a build.* Exit code 1 for each. A warning stops none.

| Rule | Enforced in | Tests |
| --- | --- | --- |
| The two origins share a host | `siteConfig` (P5-07a), when any command loads the configuration; again `assertSeparateHosts`, the first step of `buildOpenSite` | `origins.test.ts` (P5-14b); `A45 a level 0 build without a distinct content origin stops` (P5-14) |
| An untrusted object would land under `site/` | `output.ts`: the write path, and the audit in `finish()` | `output.test.ts` (P5-14b); `A45 untrusted objects are written only under content/, and a build stops when one would land under site/` (P5-14) |
| An object of a type outside the table, a JavaScript type among them | `object()` | `output.test.ts`; `A45 no JavaScript output is in a level 0 build` (P5-14) |
| An answer-bearing file in a tree declared public; any other reader error | `readCourseForSite` | `A43 parallax build at level 0 refuses a public tree that holds a definition, as parallax check does` (P5-14) |
| A file the upload rules refuse; an error of publication's report | `courseFiles.ts`; `publicationReport` | `course.test.ts` (P5-14c); `A40 a level 0 build stops with the report of the existing validation and writes no site` (P5-14) |

These are checks of the tool's own configuration and its own output. No command and no test contacts a deployed host or reads a response header of one.

## 5. What a build leaves out

The list is in the amendment (§9). It holds by structure, in three places: the reader's site entry hands the build no definition and no hidden resource; the schemas have no field for a definition, an answer, feedback, a hint, a solution, a check, a rubric, a release date, a class, an account or a grade; and no file is written for an exercise or a test. Practice exercises checked in the browser are not built: no checking code and no answer reaches the output. A notebook's own `.ipynb` is not written: the page shows its stored outputs through the rendered view, and the file offered for download is composed without outputs, attachments or metadata beyond the language name (§3), so the download holds no stored output, and a payload that the renderer does not store, a JavaScript output's among them, is in no emitted file. The build runs no notebook cell: `convertRevision` imports a notebook with its stored outputs, and a static host runs nothing, so no notebook code runs where the site is served. Moving a site from level 1 to level 0 is a change of `level` and `parallax build`: the build reads the folder, and no unit of this design exports or publishes anything from a database into a site (Q21).

*Hidden and future-dated resources: the build has no filter of its own.* The reader's site manifest holds the visible resources only, so a resource marked hidden in `topic.yaml` is never handed to the build, and a folder states no release date, so there is no resource to leave out by date ([course folder design](course-folder.md) §7). The build therefore adds no check of visibility and none of dates: it takes no build time and does not call `openToStudent` of `apps/server/src/content/availability.ts`, and no unit of this design edits `packages/cli/scripts/vendor.ts` to pack that file or any other. No date field is added to the folder: no unit adds a key to `topic.yaml` or to any other file of a folder, and the reader's schemas are not edited. The amendment says that the date rule binds any later form of the folder that states one. That a hidden resource is left out is shown on the output by a named test of P5-14c in `packages/cli/src/open/course.test.ts`, `test('a resource marked hidden in topic.yaml has no entry, no data file and no object')`: the fixture's hidden resource, a PDF reading, is in no list of `topic.json`, no `<resource id>.json` exists for it and no object under `content/` has the digest of its file, while the visible PDF reading beside it has all three. The A43 leak test of P5-14 plants sentinels in the same resource's title and file and finds them in no emitted file (§10).

## 6. The shell: `apps/web/src/open/` (P5-15, P5-16)

`app.tsx` exports `createOpenApp(site?)` and `mountOpen(root, site?)`. The router has its own root route, with `OpenBar` and an outlet. No file under `apps/web/src/open/` imports `routes/__root.tsx`, `GlobalBar`, `useSession`, the route tree or `call` of `api/client`.

| Screen | Existing parts, unchanged | What they are given | Absent |
| --- | --- | --- | --- |
| Bar (`OpenBar.tsx`) | the classes of `GlobalBar.module.css` | "Parallax" to `/`, "Courses" to `/courses`, the skip link | sign-in, provider buttons, account, class control |
| Catalogue and topic index (`Course.tsx`) | `Page.module.css`, `TopicIndex.module.css`, `TAB_LEGEND`, `usePageTitle` | `openCatalogue`; in school mode each instructor's name as a heading, then that instructor's courses. `openCourse`: number, title, presence, time, a link to the first tab | Resume, Reviewed, locks, the annotations download |
| Topic (`Topic.tsx`) | `TopicHeading`, `TabRow`, `ResourceToolbar`, `ToolsHost`, `useFocusMode` | a `ClassTopics` value made from `openCourse` (`cohort` is the text "Open to everyone") | `ReviewPanel`, `PreviewBanner` |
| Slides | `SlideViewer` | `url` or `slides`, `pageCount`, `initialPage` from `?page`, `source.key: null`, `onPage` that does nothing; no `renew`, no `notes` | Notes, the API download |
| Reading | `NativeReading`, `PdfReading` | `html`; or `url`, `pageCount`, a `renew` that answers null; `initial: null`, `onPosition` that does nothing, `source.key: null`; no `onRoot`, no `sketch` | margin, notes, highlights, sketches, discussion, saved place |
| Notebooks | `NotebookView`, `ShinyEmbed`, the classes of `Notebook.module.css` and `Shiny.module.css` | `notebook`; the label "Saved outputs"; Outline, Show or Hide code and outputs; a plain link "Download notebook without outputs" to `file`. No `OutputSourceLink` or `RenewOutputLinks` provider | Connect, live notebook, submission form, "Download original notebook" |
| Exercises, Tests (`ClassOnly.tsx`) | the list classes of `Exercise.module.css` | titles from `openTopic` | Start, attempts, any definition |

P5-15 builds `app.tsx`, `OpenBar.tsx`, `OpenUnavailable.tsx`, `data.ts`, `Topic.tsx` and `panels.tsx` (Slides and Reading, and the titles of the other three tabs); P5-16 builds `Course.tsx`, `NotebooksPanel.tsx`, `OpenShiny.tsx`, `OpenColab.tsx` and `ClassOnly.tsx`, with their routes and panels.

- *No request to `/api`.* `data.ts` is the only module of the shell that fetches: `GET` of the three kinds of data file by `openPaths`, with `credentials: 'omit'`, parsed by its schema; a 404 gives `OpenUnavailable` ("This page is not available"), any other failure the existing `RetryNotice`. The viewers call the API only from `SourceDownload`, which they render only when `source.key` is set or inside an `OutputSourceLink` provider; the shell gives neither. A download is a plain link to the object on the content origin. The rule on imports above is about the shell's own files: the module `api/client` is still compiled into the shell, because parts it composes import that module (`topics/topics.ts`, where `TAB_LEGEND` and the type `ClassTopics` are, and `SourceDownload`). That no request is made is shown by the tests that record every request (§10), not by the import graph.
- *Sanitisers.* `SlideViewer`, `NativeReading` and `Markdown` call `sanitizeReading` as today, and `StoredFrame` keeps `sandbox=""`. The shell adds no `dangerouslySetInnerHTML`.
- *Nothing kept.* The shell writes nothing to `localStorage`, `sessionStorage`, IndexedDB or a cookie; the router's scroll restoration stays off, as in the application.
- *Site pages.* `createOpenApp(site)` mounts the site's pages with `siteRoutes(root, site)` of `apps/web/src/sitePages.tsx`, below the bar. A page at `/` is the front page; without one `/` goes to `/courses`. A page at an address of `OPEN_ADDRESSES` makes `createOpenApp` throw.
- *Compile (P5-16a).* The compile function of `packages/cli/src/build/web.ts` gains one option, `entry`, whose default is today's; with `open` the generated entry calls `mountOpen` from `apps/web/src/open/app.tsx` (`exports` of `apps/web/package.json` gains `./open` in P5-15). `compileOpenShell` hands the compiled files to `out.shell` and adds nothing to `index.html`, which carries no content security policy: the amendment names what stands in for the app origin's header (§9).
- *Look and copy.* No stylesheet is added: every class comes from an existing CSS module, on the `--pc-*` tokens, and nothing lets a site change the look. Fixed copy: "Open to everyone"; "No course has been published on this site."; "Exercises are done in a class."; "Tests are taken in a class."; "No exercises have been added"; "No tests have been added"; "Saved outputs"; "Download" for a PDF deck or reading; "Download notebook without outputs" for a notebook; for a Shiny app that is not framed, the state "Not embedded on this site" and the link "Open externally"; under "Work in Colab", the first sentence of the existing note ("Colab runs on Google’s computers, separately from Parallax."), the existing steps without the submission step, the first of them naming "Download notebook without outputs", the link "Open in Colab", and "Notebooks are handed in in a class." Copy that exists is written as its source spells it: "Saved outputs", "Work in Colab" with its note and steps, "Open in Colab", "Open externally", and the empty lines of the three material tabs ("No slides have been added", "No reading has been added", "No notebook has been added"). No text claims that something was saved, connected or submitted; "Saved outputs" is the existing label for the outputs a notebook file was stored with.

## 7. Decisions that the other designs left to this run

| Left by | Question | Decision |
| --- | --- | --- |
| site design §13 | where the build lives | `packages/cli/src/open/`, called from the level switch of `commands/build.ts` |
| | does the shell mount site pages | yes, with `siteRoutes` and its own root |
| | `site.entry` | `/courses`, the same address at every level, so a front page's link survives a change of level |
| | `origins` at level 0 | `origins.app`: the host `dist/site` is made for, compared with the content host and named in the build's last line. `origins.content`: the base of every object address |
| | `origins.shiny` at level 0 | the approved list given to `publicationReport`; `origin` of a Shiny entry, which alone lets `ShinyEmbed` frame it. An app elsewhere keeps its external link and is not framed |
| | `parallax dev` at level 0 | keeps stopping, with a message that names `parallax build` and the two folders |
| course folder design §11 | folder id or name in an address | folder id for a topic and a resource, folder name for a course (§2) |
| | storage keys and object ids for `revisionPayload` | `open/objects/<sha256>`; no object id, a notebook is built without data files (§4) |
| | a notebook's data files | checked, not written (§4) |
| | a topic with only exercises and tests | built and listed; its `empty_topic` warning is dropped (§4) |
| | the level 0 test of A40 | `a40-open-build-publication.test.ts` in P5-14 (§10) |
| | `topicPayload` | not called: the build writes no prerequisite and no completion rule |

## 8. Existing files that the units edit

Of Parallax as built: `packages/contracts/src/index.ts`, one export line (P5-14a), and `apps/web/package.json`, one `exports` line (P5-15); neither changes what the application does. Of the test tooling: `e2e/tsconfig.json`, one word (P5-16a; §10). Documents: `docs/adr/0002-authorization-and-class-isolation.md` and `docs/delivery/plan.md` (P5-05). Of earlier Phase 5 units, only where this design attaches to them: `packages/cli/src/commands/build.ts` (P5-14, P5-16a), `commands/dev.ts`, `build/web.ts` and `site/pages.ts` (P5-16a). No route file, route contract, screen, viewer, editor, review screen, schema file, migration, server route, stylesheet or existing test file is edited, and neither are `apps/server/src/http/content.ts`, `apps/web/src/styles/global.css`, `vitest.config.ts` and `e2e/playwright.config.ts`: the browser tests get a folder, a configuration file and a workflow of their own (`e2e/open/`, `e2e/playwright.open.config.ts` and `.github/workflows/open-site.yml`, all new), and `.github/workflows/ci.yml` is not edited. The application of levels 1 and 2 is today's: `apps/web/src/open/` is reached only from `open/app.tsx`, which neither `main.tsx` nor `app.tsx` imports, so it gains no screen, `/` keeps its redirect unless a site supplies a front page, and the level 1 compile keeps its entry. The draft, release and adoption model, where code runs, provider buttons and the `open` default are not touched. No unit adds a route, a network caller, a credential, a migration, a field of `exerciseV1` or `testV1`, a theme, a shared installation, a settings model or JSX or MDX in course content.

## 9. The amendment, and where its rules are realised

The rules of level 0 are the amendment "Open site (level 0)" of ADR-0002, which P5-05 lands with this document. This section does not restate them; it says where each is realised.

| Paragraph of the amendment | Realised in | Shown by |
| --- | --- | --- |
| No server and no scope to resolve | the build reads folders only (§4); the shell fetches data files only and keeps nothing (§6) | A44, A46 |
| What a build leaves out | the reader's site entry, the schemas, and no file for an exercise or a test (§3, §5) | A43; `course.test.ts` of P5-14c |
| The equivalent of the content origin | the two trees, the table of eight types and the composed notebook file (§2 to §4); `sandbox=""` and the two sanitisers (§6) | A45, A44 |
| The rule that stops a build | the table of §4 | A45, A43, A40 |
| What the build checks, and what it cannot | no command contacts a host, and `index.html` carries no policy (§4, §6) | §12 has what follows from it |
| Hosting requirements | no code of the tool: the static server of the browser suite gives exactly these two (P5-16a), and the guide of P5-24 states them | A44 and A45 in a browser |

## 10. Tests by scenario

A test that realises a scenario carries the ID first in its title; tests of P5-14a, P5-14b and P5-14c have plain titles, because those items list no scenario (plan §6 says that no done file lists a new ID before session 2). No test mocks a database, and none needs one. The `Verify` line of each entry in plan §9 is the full list of assertions; this section names the files and, once, the four checks below.

| Scenario | Part | Unit | File |
| --- | --- | --- | --- |
| A40 | level 0: publication's report stops the build | P5-14 | `packages/cli/src/a40-open-build-publication.test.ts` |
| A43 | leak; no file opened under `exercises/`, `tests/` or `private/`; refusal by the build | P5-14 | `packages/cli/src/a43-open-build-omits.test.ts` |
| A44 | shell: Slides and Reading; the browser sanitiser alone on those two surfaces | P5-15 | `apps/web/src/open/a44-open-shell.test.tsx` |
| A44 | tabs: Notebooks, Exercises, Tests, Shiny, Colab, catalogue; the browser sanitiser alone on the three app-origin surfaces | P5-16 | `apps/web/src/open/a44-open-tabs.test.tsx` |
| A44 | browser, on two origins | P5-16a | `e2e/open/a44-open-site.e2e.ts` |
| A45 | build | P5-14 | `packages/cli/src/a45-open-build-origins.test.ts` |
| A45 | browser, on two origins | P5-16a | `e2e/open/a45-open-site-isolation.e2e.ts` |
| A46 | all | P5-14 | `packages/cli/src/a46-open-build-no-database.test.ts` |

With plain titles: `packages/contracts/src/openSite.test.ts` and `apps/server/src/open-site-parity.test.ts` (P5-14a); `output.test.ts`, `origins.test.ts` and `download.test.ts` in `packages/cli/src/open/` (P5-14b); `course.test.ts` there (P5-14c); `pages.test.ts` there (P5-16a).

Two parts move from where the plan first had them: the browser parts of A44 and A45 go from P5-15 to P5-16a, and P5-15 and P5-16 cover A44 in the component project. The shell, the compile, the two static hosts and the browser tests do not fit one unit of 600 lines (§11), session 3 can take no added item, and the browser tests need a way to serve the build's output, so they cannot come before P5-15. The level switch therefore stays closed until P5-16a: `parallax build` at level 0 completes only in the pull request that shows A44 and A45 in a browser. That is stricter than the rule that nothing can serve a level 0 site before P5-15. After P5-14, P5-15 and P5-16 the command at level 0 checks and converts and then stops with the message of `noViewerYet`; from P5-16a it writes a site a browser can open; `parallax dev` stops at level 0 throughout.

**Four checks, each in a named test.** This is the one statement of them. Where §1, §4, §5 and §6 and the entries of plan §9 speak of these proofs, they mean the tests named here.

1. *The build opens no file under `exercises/`, `tests/` or `private/`.* The proof is the file-read guard of `packages/cli/src/open/testing.ts`, which P5-14c starts and P5-14 extends: a module preloaded into the child process that runs the build, which rejects and records every call of `node:fs` and `node:fs/promises` that opens the content of a file (a read, an open, a read stream, a copy) below a folder named `exercises`, `tests` or `private` of the site being built, and lets directory listings through, because the reader lists those folders of a tree declared public to refuse what lies there. `test('A43 a level 0 build opens no file under exercises/, tests/ or private/')` (P5-14, `a43-open-build-omits.test.ts`) runs the whole build under the guard, for a public course with its overlay and for a course declared `public: false`, and fails as soon as the guard has recorded one read. `test('buildCourse opens no file under exercises/, tests/ or private/')` (P5-14c, `course.test.ts`) shows the same for one course, and shows that the guard works: a read planted there is rejected and recorded.
2. *Every planted sentinel is found in the fixture first, and is in no emitted file.* `test('A43 no file of a level 0 build holds a hidden check, a solution or a correct answer')` (P5-14, the same file). Sentinel strings are planted in each exercise's prompt, answers, feedback, hints and solution, in each test's questions, correct answers, rubric, public and hidden checks and code files, in the hidden resource's title and file, and in a file of `private/`, for both kinds of tree. The test first finds every sentinel in the fixture, so that a search which finds nothing proves something. Then it reads every emitted file as bytes, under `site/`, `content/` and `.parallax/open/`, searches each for every sentinel and finds none.
3. *Every key of every data file is one the schemas declare.* `test('A46 a level 0 build runs with DATABASE_URL unset, loads no database module and holds no account, attempt or grade')` (P5-14, `a46-open-build-no-database.test.ts`) checks every key of every emitted data file, at every nesting level, against the `openSite` schemas.
4. *The browser sanitiser holds by itself.* `test('A44 the three app-origin surfaces pass through sanitizeReading at level 0')` (P5-16, `a44-open-tabs.test.tsx`, component project) gives hostile HTML to each of the three app-origin surfaces past the conversion step, in data files that hold it as if conversion had not cleaned it: a web slide, a native reading, and a notebook's Markdown cell and its Markdown or LaTeX output each carry `<script>`, `<img onerror>` and a `javascript:` link, and each page then has no `script` element, no handler attribute and no `javascript:` address. `test('A44 slides and readings pass through sanitizeReading at level 0')` (P5-15, `a44-open-shell.test.tsx`) is the same check for the two surfaces that unit has. Both run in `pnpm check` and need no build, so this check does not wait for the browser suite. That suite repeats it in a real browser on built files (`test('A45 the browser cleans the three app-origin surfaces of an altered data file')`, P5-16a), as a second run and not as the proof. The other layer by itself, conversion, is shown in `course.test.ts` of P5-14c: hostile sources give data without script.

*Environment.* The unit and component tests run in `pnpm check` on Windows, with `DATABASE_URL` deleted from the environment, on temporary folders, forward-slash paths and explicit sorting. The two browser files are a suite of their own in `e2e/open/`, which the existing configuration does not collect (it collects `tests/` only). `pnpm --filter @parallax/e2e exec playwright test --config playwright.open.config.ts` runs them with no PostgreSQL, no API server and no Docker: locally on Windows with the Chromium the existing suite uses (a session without it leaves the suite to CI, row P-d), and in CI in the workflow `.github/workflows/open-site.yml`, on an image that has the browser of Playwright 1.56.1 and with no database service. The suite builds the fixture with the real command and serves `dist/site` at `http://127.0.0.1:4175` and `dist/content` at `http://localhost:4176`, two host names that the host rule tells apart; requests to the fixture's Shiny origin are answered by Playwright's route, so no test contacts another host. `e2e/tsconfig.json` names the folders that `pnpm typecheck` reads in that package (`*.ts` and `tests`), so P5-16a adds `open` to it. The existing `pnpm build && pnpm test:e2e` stays as it is. No step of the suite runs `playwright install`.

## 11. Units, sizes and sessions

Sizes are the landed plan's estimates in changed lines (its section 11), counted as plan §0 counts them, with fixtures left out.

| Unit | Session | Estimate | First to split off |
| --- | --- | --- | --- |
| P5-14a | 1a | 391 | `viewNotebook` with its parity test |
| P5-14b | 1a | 520 | `download.ts` with its test |
| P5-14c | 2a | 420 | the refusal cases of the test |
| P5-14 | 3 | 550 | the A40 file with its fixture |
| P5-15 | 3 | 526 | the site pages of `app.tsx` with their two tests |
| P5-16 | 3 | 535 | Shiny and the Colab route with their test |
| P5-16a | 4 | 553 | the reserved addresses (`site/pages.ts` with `open/pages.test.ts`) |

*Why four added items.* P5-14 as first written holds about 1,880 lines (schemas, write path and notebook download, conversion of a course, site build, four scenario files) and P5-15 with P5-16 about 1,610 (shell, compile, two hosts, browser tests, workflow), and a unit that would pass 600 is split, never enlarged. No two of the four fit one pull request of 600 lines: the two smallest come to 811.

*Placement by the rule for added items* of the `package-development` skill. Session 1 had started. **P5-14a** depends on P5-05 (session 1) and P5-08a (session 1a): session 1a is the earliest that has not started. **P5-14b** depends on P5-14a and P5-07a: session 1a again, which then holds 8 units (the limit), no run, and chains of at most three (08a → 14a → 14b). **P5-14c** depends on P5-08 and P5-09 (session 2), P5-08c (session 2a) and P5-14b: session 2a, which then holds 3 units and the chain 17a → 08c → 14c. **P5-16a** depends on P5-14 and P5-16 (session 3): session 3 holds 8 units and its chain 14 → 15 → 16 → 17 is four long, so it goes to session 4, which then holds 8 units; 16a → 24 → 25 is a chain of three. The work is 40 units in the same 6 sessions. Sessions 1a, 3 and 4 are then full: a part split off later needs a further session, and the unit that splits says so in its report.

## 12. Open questions, what is left out, and known limits

**For the owner.** None is decided here, and no unit waits for an answer; a unit that is asked for one is labelled `needs-human`. Questions 1 to 6 are the landed plan's. Question 7 comes from the review of P5-02 and was carried over to this unit.

1. Should a level 0 site offer a notebook's data files for download beside the notebook file? This design checks them and leaves them out, because the student view of level 1 has no place for them.
2. Should the guide (P5-24) recommend response headers for hosts that can set them: `Content-Security-Policy: sandbox` and `X-Content-Type-Options: nosniff` on the content host, the app origin's policy with `frame-ancestors` on the site host? The tool would still check none.
3. Is a local preview of a level 0 site wanted (two local hosts started by a command)? `parallax dev` stops at level 0, and no unit adds a way to serve a site.
4. Should a level 0 site show a resource's accessible alternative? The folder states one, publication requires one for a raster-only deck, and the student view of level 1 shows none, so level 0 shows none.
5. The shell mounts site pages, which answers what the site design asked first ([site design](site.md) §14, question 1): should the templates of P5-17 default to level 0? They stay at level 1 until the owner says so.
6. Still open from the course folder design ([course folder design](course-folder.md) §12): whether `parallax build` at levels 1 and 2 also refuses an answer-bearing definition in a tree declared public. At level 0 the build refuses, as `parallax check` does (§4).
7. A site that moves from level 1 to level 0 is rebuilt from the folder (Q21), so material that was made or last changed in the editor, and is not in the folder, is not on the level 0 site. The build cannot say so, because it reads no database. Is a warning wanted at level 1 before such a move? Today `parallax sync` names each file whose head came from the editor and counts the rows made in the editor ([course folder design](course-folder.md) §10); the guide of P5-24 can point to that.

**Left out on purpose, each a later owner decision** and none built: a level 0 site on one host name or under a path; exercises checked in the browser; notes, highlights or a reading place kept in the browser; a release date stated in the folder; a site theme; export of anything from the database into a site.

**Known limits.**

- A static host enforces nothing. It sends no `sandbox` policy, no `nosniff`, no `Content-Disposition` and no `frame-ancestors`, mints no token and knows no date. Level 0 rests on omission at build time, two origins, `sandbox=""` on the frame, and the sanitisers at conversion and in the browser. A file on the content host opened on its own runs as that host and reaches nothing of the site, which the A45 browser test shows; it is still not what level 1 gives. The build checks none of this on a deployed host, by decision.
- No policy in `index.html`. A level 0 site sends no content security policy unless its operator sets headers. A site page can then load a script or an image from another origin, which the header blocks at level 1, and for the three app-origin surfaces the two sanitisers are the whole defence (question 2).
- The second host name has a cost. A level 0 site needs two host names, each serving its tree at the root. Two project pages of one account on a shared host have one host name, and a site under a path is not a host of its own: the build stops.
- Hosts differ in what they add. A host that forbids framing or cross-origin embedding (`X-Frame-Options`, `Cross-Origin-Resource-Policy: same-origin`) shows no HTML output or image, and one without the answers of hosting requirement 2 shows no PDF, each with a plain message. Addresses rely on the directory index that every static host has, `/` included, and on the name of a course folder being served as it is spelled.
- The notebook download is not the class's file. At level 1 a student downloads the stored `.ipynb` with its outputs. At level 0 the download has no outputs, no attachments and no metadata beyond the language name, and its Markdown cells hold rendered HTML; the page shows the stored outputs. The file names no kernel, so the program that opens it chooses one.
- Material made in the editor is not on a level 0 site, and nothing in the build warns of it (question 7). A resource marked `hidden` is left out of the build, but its file and its title lie in the tree ([course folder design](course-folder.md) §12).
- The warning for a Shiny app on an origin that is not listed is the validator's line, unchanged: its sentence says what a class shows ("Preview · no session"), while a level 0 page says "Not embedded on this site" and keeps the link.
- The browser proof comes last. A44 and A45 run in a browser only in session 4. Until then the switch is closed, so no site can be built; the cost is that a fault of the shell on real hosts shows late.
- A second browser workflow. The level 0 suite runs in `.github/workflows/open-site.yml`, beside the `e2e` job of `ci.yml`, which it does not lengthen. A pull request then waits for one more check, and the workflow needs an image that has the browser of Playwright 1.56.1.
- One restatement. `viewNotebook` restates server code that the tool cannot load; the parity test of P5-14a fails when either side changes alone.
- Names of units not yet built. `readCourseForSite`, `convertRevision`, `publicationReport`, `siteRoutes`, the compile function of `build/web.ts` and the loader are known from two designs only. A different signature changes glue, not the design; a missing entry point (the validator or `reading.ts` not in the packed copy) is caught by the test of P5-14c.
- Size of a course. Objects are read into memory one at a time and conversions run one after another; a large course builds slowly. `dist/content` is written anew by every build, so the address of an object that a course no longer has stops answering.
- Sizes are estimates, and three sessions are full (§11). P5-14b, P5-14, P5-15, P5-16 and P5-16a are estimated at 520 to 553 lines; a further split needs a further session, which raises the count of sessions to seven.

## 13. Differences from the landed plan and from the two earlier designs, and what was checked

**Differences from the landed plan.** Each follows from the repository or from a probe, or fixes a detail that one unit writes and another reads; none adds a commitment, and none changes a decision of the landed plan's sections 1 to 8.

1. **§8, §10 and P5-16a, `e2e/tsconfig.json`.** The landed plan gives the browser suite a folder of its own and names no existing file of `e2e/` among those edited. That package's `tsconfig.json` includes `*.ts` and `tests` only, so `pnpm typecheck` would not read the two files of `e2e/open/`. P5-16a adds `open` to that list, one word, and its entry names the file.
2. **§6, the import rule.** The landed sentence that no file under `apps/web/src/open/` imports `call` of `api/client` is true of the shell's own files. The module is still compiled in, through `topics/topics.ts` and `SourceDownload`, so a test that follows the import graph would fail. The proof that no request is made is the recorded requests of the A44 tests.
3. **§3 and P5-14a, the parity test.** The fixture module `apps/server/test/fixtures/notebook.ts` has the notebook as text (`labNotebookFile`) and a helper that needs a database (`labNotebookDerived`). The test runs in `pnpm check`, so it renders `labNotebookFile` with `renderNotebook` and compares the two functions on that.
4. **§10, the file-read guard.** The kinds of call are named (a read, an open, a read stream, a copy), so that "opens the content of a file" is not read as `open` alone. A probe showed where a preloaded guard reaches (below).
5. **§3, shapes and paths, fixed here** because P5-14a writes them and P5-14b, P5-14c, P5-15 and P5-16 read them: the four shapes written out from the landed table; `openPaths` gives addresses with folder names percent-encoded, and the build writes the file at the decoded path; the language name of a composed notebook stands at `language_info.name`, where nbformat has it.
6. **§6, copy.** Copy that the landed plan calls existing is written as its source spells it: the note's sentence has a typographic apostrophe. "No exercises have been added" and "No tests have been added" are the shell's own lines; the screens of level 1 say "Nothing is available under Exercises for this topic yet."
7. **§9, §11 and §12.** The landed plan's section 9 is the text of the amendment, which is in ADR-0002; §9 here says where each of its paragraphs is realised. §11 keeps the landed estimates of the seven code units. §12 adds question 7 and three limits (the kernel, the Shiny warning, material made in the editor).
8. **The size of P5-05.** The landed plan counts itself into this unit (569 lines, 150 of them for this document) and has this document cite what does not fit. The landed plan is committed unchanged and counted apart, as for P5-03 and P5-04, so this document states every section in full.

**Where this design refines the two earlier designs.** Neither document is edited, and none of these is a disagreement on a decision.

- [Site design](site.md) §6.3: the conflict rule also refuses a page at an address of `OPEN_ADDRESSES`, at every level (§2). §6.4 and §6.5: at level 0 `dist/` holds the two trees `site/` and `content/`, not `index.html` and `assets/`. §6.6: `site.entry` is `/courses` at level 0 as well. §6.7: at level 0 a site page renders below `OpenBar` in the shell's own root, not in `routes/__root.tsx`.
- Site design §5 and §13: it has `build` stop at level 0 until P5-14 merges, and nothing serve a level 0 site before P5-15. Here the command converts from P5-14 on and the switch opens in P5-16a (§10); `dev` keeps stopping. P5-16a edits three files of run R1's units beyond the places that §13 names: one option in `build/web.ts`, the patterns in `site/pages.ts` and the message of `commands/dev.ts`.
- [Course folder design](course-folder.md) §11: its row for P5-14 hands the reader's site entry, `revisionPayload`, `convertRevision`, the upload rules and `publicationReport` to the build; the unit that calls them is now P5-14c, and `topicPayload` is not called. Its question 1 (§12) stays open (question 6 here).

**Checked in the repository** on 2026-10-13, at `9e22334a`, where the landed plan or this document states a fact about it.

- `packages/contracts`: every field that §3 keeps, drops or replaces, in `routes/topics.ts`, `slides.ts`, `readings.ts`, `notebooks.ts`, `releases.ts` and `notebook.ts`; `tabs` is slides, reading, exercises, notebooks, tests; `notebookView` is not strict; a cell id is the notebook's own or `cell-<index>`, both of which the import contract accepts; a Shiny address is https, or http on a loopback host.
- `apps/server`: `notebookView` in `http/routes/notebooks.routes.ts`, which imports `db/notebooks`; `loadShiny` gives no `url` for an origin that is not approved; `resolveReadingImages` in `content/reading.ts`, which the conversion reaches through `reading.worker.mjs` and `notebook.ts`; ingestion removes the `src` of every image that is not an uploaded file of the reading, so converted HTML holds no address but those the build sets; `objectKey` gives `<prefix>/objects/<sha256>`; the renderer stores five image types and `text/html; charset=utf-8`; `empty_topic` and `unapproved_shiny_origin` are warnings and `empty_release` an error; `http/content.ts` and `app.ts` send the headers and the cross-origin answers that the amendment names; the renderers start their worker threads from files.
- `apps/web`: the props of `SlideViewer`, `NativeReading`, `PdfReading`, `NotebookView` and `ShinyEmbed`; `SourceDownload` is rendered only with `source.key` or inside an `OutputSourceLink` provider, and the other fields of `source` are read only there and by `notes`; `StoredFrame` has `sandbox=""`; a PDF deck is read by range requests and a PDF reading is fetched whole, both from script; none of the composed parts uses the router, the query client or the session; browser storage is used only by the test workspace and the reading margin; the router is created without scroll restoration; the generated route list has eight addresses, three of them under `/courses`.
- Tests and tooling: the `unit` project collects `packages/**/*.test.ts` and `apps/server/src/**/*.test.ts`, and the `component` project `apps/web/src/**/*.test.tsx`; `e2e/playwright.config.ts` collects `tests/` and has a global setup and a web server that need PostgreSQL; the scenario checker reads every `.e2e.ts` file of the repository; the `e2e` job of `ci.yml` installs Chromium itself; ports 4175 and 4176 are named nowhere else.

**Probed** on the same day, in scratch files that are not committed, on Windows with Node 22.12.

- zod 4.6.5 on a strict object that holds `notebookView`: a key that no schema names is dropped from the parse result at the non-strict levels and refused at a strict level with the key named, and parsing the written text again changes nothing. The same keys are in the output when the input is serialised.
- A notebook composed as §3 states, with `language_info.name` and with empty `metadata`, passes `parseNotebook`.
- A module preloaded with `--import` that replaces the read, open and read-stream functions of `node:fs` and `node:fs/promises` and calls `syncBuiltinESMExports`: under `tsx`, a read through a named import was refused and recorded in the main thread and in a worker thread started from a file, also when the preload came from `NODE_OPTIONS`, and directory listings went through. A worker started from evaluated CommonJS text was not reached; the build starts none.

Nothing here read a course folder, converted a file, built a site or opened a browser: the tests of §10 do that.
