# Course folder detailed design (P5-04)

**Status:** accepted with the merge of P5-04, 2026-10-13. Refines the amendment "Conversion from a folder" of [ADR-0003](../adr/0003-content-releases-and-revisions.md) for §13 of the [product specification](../product-spec.md) ("Installation, levels and boundaries"): requirements N4 and N5, on the owner's answers Q12 to Q16 ([plan](../delivery/plan.md) §8). It is the lasting form of sections 1 to 10 and 13 of the plan that planning run R2 landed, [`docs/plans/2026-10-13-design-conversion-of-a-course-folder-n4.md`](../plans/2026-10-13-design-conversion-of-a-course-folder-n4.md), and keeps that plan's numbers for sections 1 to 10. Where the two differ this document is current, and §14 lists each difference. Items P5-08, P5-08a, P5-08b, P5-08c, P5-08d, P5-09, P5-09a, P5-18, P5-18a, P5-18b, P5-18c and P5-18d in the plan implement it and take their tests from §13. Nothing in it is built yet, and Parallax as built does not change: no table, column, migration, route, route contract, screen or stored format is added. It fits the [site toolkit design](site.md), which gives the site folder, the configuration and `parallax apply`. It decides nothing that belongs to run R3 (what a level 0 build writes and serves) or to the owner: §11 says what later units and run R3 get, and §12 what is open.

Terms: a **course folder** is one folder under `courses/`, with `course.yaml` and one **topic folder** per topic. A **tab folder** is one of `slides/`, `reading/`, `exercises/`, `notebooks/` and `tests/` in a topic folder. A **tree** is a course folder with all it holds. The **overlay** is the directory `private/` at the site root. A **definition** is the YAML file of an exercise or a test. A **folder id** is the `id` of a topic or a resource in `topic.yaml`; a **row id** is the id of its row in the database. The site, the tool and the operator are those of the site toolkit design.

## 1. Shape and trust boundaries

```text
 author's machine           parallax check [--write-ids] ─▶ reader ─▶ problems on the terminal; --write-ids writes ids into topic.yaml
 level 0 (run R3)           parallax build ─▶ readCourseForSite ─▶ SiteManifest, open(file) ─▶ convertRevision ─▶ what run R3 writes
 server's host, levels 1, 2 parallax sync  ─▶ readCourseForSync (the tree and private/) ─▶ one bundle on standard input
                              └▶ sync-course.ts in the server image:  files ─▶ storage      drafts ─▶ the draft services
                                                                      reading.ingest ─▶ the worker      publishRelease ─▶ a release
```

A course folder becomes the material the editor produces through one reader and the functions that exist: the upload rules, the renderers in their worker threads, the draft services and the publication. `parallax check` runs on the author's machine and needs no server. A level 0 build reads the same folder through the reader's site entry and converts with the same conversion entry. At levels 1 and 2 `parallax sync` reads the folder on the server's host and pipes one bundle to a script in the server image; the script writes drafts, the existing job converts, and the existing publication validates and snapshots.

| Part | Trusted for | Limits |
| --- | --- | --- |
| course folders and the overlay | nothing: course material is untrusted content and may hold hidden material | every file passes the upload rules, the renderers and the sanitisers that an editor's upload passes (§8); paths, links and case are checked (§2); what a site build receives holds no definition and no hidden resource (§7) |
| the author, running `check` | their own machine | no server and no database; with `--write-ids` it writes ids into `topic.yaml` and nothing else, and no other command writes into a course folder (§4.1) |
| the operator, running `sync` | shell access to the server's host ([site design](site.md) §1) | no route, no network caller, no credential and no address on a command line; drafts are written under the owning account's `CourseScope` from `resolveActorScope`; no account and no class is created (§10) |
| the worker | converting what `sync` queued | the existing `reading.ingest` job, whose payload carries actor and scope and which resolves the scope again |

Existing files that the units of this design edit, and no others: `packages/contracts/src/index.ts`, one export line each (P5-08a, P5-08d); `apps/server/src/db/content/releases.ts`, `db/jobs/derived.ts`, `db/content/drafts.ts` and `execution/job-builder.ts`, each a move with a re-export or one import line (P5-09a); `db/content/drafts.ts` again, the optional id (P5-18b); `apps/server/src/jobs/reading-ingest.job.ts` and `apps/server/package.json` (P5-09); `packages/cli/src/site/folders.ts`, one call (P5-08); `packages/cli/package.json` and `pnpm-lock.yaml`, the dependency `yaml`, unless that manifest already has it (P5-08b); `packages/cli/scripts/vendor.ts`, one entry file, only if P5-17a left the validator out (P5-08c). No route file, route contract, screen, viewer, editor file, schema file, migration or existing test file is among them. `folders.ts`, `vendor.ts` and the manifest of `packages/cli` are files of run R1's units, changed only where its design attaches this run ([site design](site.md) §6.6, §13).

## 2. Layout (N4)

```text
my-site/
  courses/reef-ecology/               a course folder; its name is part of the course's identity (§4.2)
    course.yaml                       title and public (§3)
    sampling/                         a topic folder; its name is a path and nothing more
      topic.yaml                      the topic's fields and its resources, each with an id (§3, §4.1)
      slides/     transects.md  deck.pdf
      reading/    methods.md  paper.pdf
      notebooks/  counts.ipynb  tide.shiny.yaml
                  counts/data/quadrats.csv    a data file of counts.ipynb, at the workspace path data/quadrats.csv
  private/courses/reef-ecology/       the overlay of this tree, which course.yaml declares public (§6)
    sampling/
      exercises/  estimate.yaml
      tests/      quiz.yaml
                  quiz/q3/main.py             the code file main.py of question q3 of quiz.yaml
```

In a tree declared `public: false` the folders `exercises/` and `tests/` lie in the topic folder itself, beside the other three. In school mode the same course folder lies under `instructors/<name>/courses/`, and its overlay under `private/instructors/<name>/courses/`. The reader takes the path of one course folder and returns no absolute path, mode or instructor, so a `courses/` folder read in either place gives equal results (A38). A tab folder may be absent: git keeps no empty folder.

| Tab folder | File | Becomes | Beside it |
| --- | --- | --- | --- |
| `slides/` | `*.md`, `*.markdown` | `slides_web` | nothing |
| `slides/` | `*.pdf` | `slides_pdf` | nothing |
| `reading/` | `*.md`, `*.markdown`, `*.html` | `reading_native` | nothing |
| `reading/` | `*.pdf` | `reading_pdf` | nothing |
| `notebooks/` | `*.ipynb` | `notebook` | a folder with its data files (below) |
| `notebooks/` | `*.shiny.yaml`, holding `url` and nothing else | `shiny` | nothing |
| `exercises/` | `*.yaml` | `exercise` | nothing |
| `tests/` | `*.yaml` | `test` | a folder with its code files (below) |

**Kinds and order.** An extension is compared in lower case. The kinds of uploaded file are those of `uploadFormats` (`packages/contracts/src/routes/authoring.ts`), as the upload route reads them; `.htm` and `.yml` are not accepted. A Markdown reading gets no local images, because the editor has no way to attach one. Topics are ordered by the `position` each `topic.yaml` states, so the name of a topic folder carries no order, title or identity. Resources are ordered by their place in `resources` of `topic.yaml`, across tabs, which becomes `resources.position`.

**Skipped and unrecognised names.** A name that starts with `.` is skipped everywhere (a `.gitkeep`, for one). A name that starts with `_` is skipped among the direct entries of a course folder, a topic folder and a tab folder, and nowhere else: in the folder beside a notebook or a test it is an ordinary file (a code question may have an `__init__.py`). §6 has the one exception, for a tree declared public. Every other entry must be recognised. Each of these is an error that names the path and what the folder accepts, and nothing is converted while one stands: a file of a kind its folder does not take; a file of a tab folder that no entry of `topic.yaml` lists; an entry whose file is not found (§6 says where a definition is looked for); a folder of a course folder without `topic.yaml`; a folder of a tab folder that is not the folder of a notebook or of a test there; a file in such a folder that the rule below does not account for.

**Paths, links and case.** The reader refuses, with the path named and before it opens anything there: a path it takes from a file's content (a `file` of `topic.yaml`, a question id or a `path` of a test definition) that is absolute or climbs out of its folder; a symbolic link or junction, to a file as to a folder, whose target lies outside the folder being read, which is the course folder for the tree and the course's own folder under `private/` for the overlay, so that a link in `reading/` cannot bring in a file of `private/` (a link that stays inside is followed); and two names in one folder, or an entry's `file` and the name on disk, that differ only in case. The last is decided from the directory listing and not by opening the path, because a file system that ignores case opens either spelling. A folder therefore reads the same on Windows and on a host that tells case apart. A link that stays inside a tree declared private can carry the tree's own answer files into what students read (`notebooks/counts/x` leading to `../../tests` makes the definitions and code files data files of the notebook); that is the author's choice, as a copy of those files there would be.

**Files beside a notebook and beside a test.** This is the one rule that locates them. `topic.yaml` lists neither kind: `resources[].file` always names a file directly in a tab folder (§3). A notebook's data files are declared by lying in its folder and in no list. A test's code files are named by the `files` entries of its own definition, and their content lies in its folder.

| Resource | Its folder | Each file in it |
| --- | --- | --- |
| a notebook `notebooks/<name>.ipynb` | `notebooks/<name>/`, always in the tree | is a data file, at any depth. Its workspace path is its path inside that folder, written with `/`: `notebooks/counts/data/quadrats.csv` has the path `data/quadrats.csv`. At most 100 files, each path a `WorkspacePath`; they are taken sorted by path, by code unit |
| a test `tests/<name>.yaml` | `tests/<name>/`, where the definition is: in the tree when it is declared `public: false`, in the overlay when it is declared public (§6) | lies at `<question id>/<path>` and is named by an entry without `content` in the `files` of the code question with that id, `<path>` being that entry's `path` (§5) |

`<name>` is the file's name without its extension `.ipynb` or `.yaml`, spelled as on disk. Nothing lies beside a deck, a reading, a Shiny file or an exercise: an exercise's code step holds its starter text in the definition (`codeStep` in `packages/contracts/src/exercise.ts`). These are errors that name the path: such a folder without its notebook or test; in a test's folder, a file that no such entry names, a file outside a question's folder and a folder that is no code question's id; an entry without `content` whose file is missing; an entry with both `content` and a file.

## 3. `course.yaml` and `topic.yaml` (Q15)

Both are strict zod objects in `packages/contracts/src/courseFolder.ts` (`courseMeta`, `topicMeta`), read as YAML by the rules of §5; an unknown key is an error that names it. Content files carry no front matter, so the bytes stored are the file's bytes.

```yaml
# courses/reef-ecology/course.yaml
title: Reef ecology
public: true
```

```yaml
# courses/reef-ecology/sampling/topic.yaml
id: 5f0c1d8e-3b7a-4c2e-9a41-7d2f6b0e1c33
position: 1
title: Sampling a reef
objective: Plan a transect survey and say what its counts can show.
estimatedMinutes: 90
prerequisites:
  - 0b2f4a6c-8d1e-4f3a-b5c7-9e0a1b2c3d4e
completionRule:
  requires: ['reviewed:*', 'submitted:8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d']
resources:
  - id: c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f
    file: slides/transects.md
    title: Transect surveys
  - id: 7e6d5c4b-3a29-4f18-8e07-6d5c4b3a2918
    file: reading/paper.pdf
    title: Counting fish along a transect
    alternative: The paper's sections as plain text, with each table written out.
    visibility: hidden
  - id: 8a7b6c5d-4e3f-4a2b-9c1d-0e9f8a7b6c5d
    file: tests/quiz.yaml
    title: Sampling quiz
```

| File | Field | Rule | Becomes |
| --- | --- | --- | --- |
| `course.yaml` | `title` | 1 to 160 characters, trimmed, the rule of `POST /api/courses`; required | the course's title when `sync` creates it; the catalogue's title (§11) |
| `course.yaml` | `public` | `true` or `false`; required, no default | where definitions are read from (§6) |
| `topic.yaml` | `id` | a UUID in lower case, written by the tool (§4.1) | identity |
| `topic.yaml` | `position` | whole number, 0 or more; required, and no two topics of a course state the same | the topic's place among the topics, `topics.position` |
| `topic.yaml` | `title` | 1 to 300, trimmed; required | topic title |
| `topic.yaml` | `objective` | at most 2000 | learning objective; absent: empty |
| `topic.yaml` | `estimatedMinutes` | whole number, 0 to 10 000 | estimated time; absent: none |
| `topic.yaml` | `prerequisites` | at most 50 folder ids of topics of this course | the row ids of those topics (§4.3); absent: none |
| `topic.yaml` | `completionRule` | `requires`: a list of `reviewed:*`, `submitted:*` and `submitted:<folder id of a resource of this topic.yaml>` | `{ requires }` with `submitted:<row id>`, the shape the topic form stores (`TopicForm.tsx`); absent: the default rule |
| `topic.yaml` | `resources[]` | at most 200, in display order | one resource each |
| `resources[]` | `id` | as the topic's | identity |
| `resources[]` | `file` | `<tab folder>/<file name>`: a file of the layout table, directly in its tab folder, listed once | type and content |
| `resources[]` | `title` | 1 to 300, trimmed; required | resource title |
| `resources[]` | `visibility` | `visible` or `hidden` | absent: `visible` |
| `resources[]` | `alternative` | text, 1 to 20 000 characters, trimmed | `accessibleAlternative: { text }`, as the editor's forms store it (`AddReading.tsx`); absent: none |

These are all the fields a folder states: a file's name gives no title, and a folder states no release date, class, assignment or grant and nothing about the look. The limits of title, objective, estimated time and prerequisites are those of the draft contracts (`packages/contracts/src/routes/drafts.ts`); the bounds of 200 resources and of the alternative's length are the folder's own. References are by folder id, so they hold when a folder or a file is renamed and when topics change places; `check --write-ids` has written an id before another topic names it. `topicPayload` in contracts turns both kinds of reference into the stored values in one step, given the function from folder id to row id: `prerequisites` as an array of topic row ids, `completionRule` as `{ requires }`. A prerequisite that is no topic's id, and a requirement that is no id of a resource of the same file, are errors. An invalid file is reported one line per problem, with file, field and line, and stops the command with exit code 1 before anything is written. The form of such a line:

```text
courses/reef-ecology/sampling/topic.yaml: resources[1].visibility: expected "visible" or "hidden" (line 14)
```

## 4. Identity (Q14)

### 4.1 Topics and resources: the folder id

Each topic and each resource has an `id` in its topic's `topic.yaml`. The id belongs to the entry, so it stays through a rename of a file or of a topic folder, a new order, and a move of a file with its entry to another topic. A missing id is an error that names file and field and the command to run. No id stands twice in one course, on topics and resources together: that is an error that names both places and is never repaired. `check` accepts any well-formed id: a folder does not show an id's history.

`parallax check --write-ids` is the one command that writes an id, on the author's machine. It reads the folder's structure as the reader's site entry does (layout, paths, both metadata files, every file listed once) and, when nothing is wrong there but ids that are missing, gives each topic and each entry without an `id` a fresh random UUID. It writes ids and nothing else: entries and titles are the author's to write; existing ids, comments and order stay byte for byte; each file is replaced atomically after a check that it did not change meanwhile; every field it set is printed. While another error stands (an unlisted file, an entry whose file is gone) it writes nothing in the course and prints the errors, so a renamed file whose `file` was not corrected cannot become a new resource. A second run changes no file. `check` without the flag, `sync` and `build` write nothing into a course folder.

### 4.2 What identifies a course

**A course is the pair of the account that owns its instructor folder and the name of its course folder.** `course.yaml` holds no id, and an `id` key there is an unknown key, which is an error (§3). The owner is the account with the verified address of the instructor folder's `instructor.yaml` ([site design](site.md) §7). Nothing else is part of the identity: not the mode, not the instructor folder's name, not the title, not the path of the site.

The name has one source: the name the directory listing gives for the course folder, never the spelling of a reference to it. A reference, which is `classes[].course` in the configuration or the `<course>` argument of `sync`, must equal that name exactly. One that differs only in case or in Unicode form is refused with both spellings named, as §2 refuses a `file`: a file system that ignores case opens the folder under either spelling, and two spellings would give two ids. `sync` checks its arguments so (§10), and the configuration's loader checks `classes[].course` so for every command (§11).

| Change | What the next `sync` does |
| --- | --- |
| The course folder is renamed | Another name is another course: a second course is created, with topics, resources and releases of its own, and `parallax apply` then creates the configuration's classes in it. The first course stays as it is, with its classes, notes and attempts; nothing follows to the second |
| The course folder is copied, under another name or into another instructor folder | The copy reaches rows of its own, although its `topic.yaml` files carry the same folder ids: every row id is derived inside the course's id (§4.3) |
| The address in `instructor.yaml` changes | Another account is another owner: a second course under the new account, once that person has signed in. The first stays with the earlier account |
| The instructor folder is renamed, or `courses/` moves between the modes | The same course, while the address and the course folder's name stay |
| A topic folder or a file is renamed, a topic changes its position, `title` in `course.yaml` changes | The same course; topics and resources keep their folder ids (§4.1). An existing course keeps the title it was created with (§10) |

Keeping a course through a rename of its folder or through a new owner address is not built (§12).

### 4.3 Database ids

Row ids follow by derivation; nothing is stored to map them. `uuid5(namespace, name)` is the version 5 UUID of RFC 9562, over the UTF-8 bytes of `name`.

```text
courses.id   = uuid5(0b6a98fa-33c2-51ab-9808-310d3f212845, "<owner account id>/<course folder name>")
topics.id    = uuid5(<courses.id>, "topic:<folder id>")
resources.id = uuid5(<courses.id>, "resource:<folder id>")
```

For the owner account `3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d` and the folder `reef-ecology` the course is `cdd107dd-d688-5d66-bfaf-2c8faa8f0434`; in it the topic of §3 is `889e96fe-a12c-5a3f-b3f8-c7d0b6776086` and its first resource `724bf106-f625-58f0-81a3-dedf684e762c`. The same folder therefore reaches the same rows on every sync, and an interrupted sync continues where it stopped. The course is created through `createCourse`, which takes an id; `createTopic` and `createResource` gain an optional `id` argument, as `createCourse`, `createClass` and `publishRelease` have, and no route passes it. A row with a version 5 id was made from a folder; the editor's rows have random ids (version 4). That is how `sync` tells its own rows from the editor's without stored state. Release, revision and object ids stay random.

### 4.4 A changed id

`sync` sees what `check` cannot. It stops, with exit code 1 and no topic, resource, revision or release changed, when in one run a resource it made is no longer listed and a new folder id stands at the file path that resource last recorded (the `path` and `resource` of its head's provenance, §10). The message names the file and both folder ids and says to put the earlier id back. That is the case of an id removed and written again by `--write-ids`, and of an id edited by hand. Only with `--accept-new-ids` does `sync` go on: it creates the new resource, archives the earlier one and reports the earlier id; putting the id back and syncing again restores it. Every other new id is created without a stop. A resource's type never changes: a different kind of file under an old id is refused, and the entry needs a new id.

## 5. YAML exercises and tests (N5)

A definition is parsed as one YAML 1.2 document with the core schema, by the package `yaml`. The caller passes `schema: 'core'` and `resolveKnownTags: false`, so neither a `%YAML 1.1` directive in a file nor an explicit tag brings in another type. No date is created (a timestamp stays a string), a quoted number or boolean stays a string, and no tag outside the core schema is interpreted: nothing is constructed or run for it, and its node is read as the plain value it wraps. Anchors and aliases are expanded, within the parser's alias limit, so the value is the one the definition gives when written out. The result must be a JSON value: maps with string keys, lists, strings, finite numbers, booleans and null. Refused, each with file and line: a key that stands twice in one map, an alias that points into its own node (a cycle), a key that is not a string, a number that is not finite, and a second document. The parser itself reports the first and the last of these. `yaml.ts` finds the other three on the document's nodes, which carry the lines, before it takes the value: afterwards a number key is a string like any other (§14).

That value, which is what `JSON.parse` gives for the same definition written as JSON, goes unchanged to `exerciseV1` or `testV1` (`packages/contracts/src/exercise.ts`, `test.ts`), and the schema's result is what is stored. One step comes before the schema, for a test only: an entry of a code question's `files` that has no `content` gets it from its code file (§2), as UTF-8 text or, with `encoding: base64`, as base64 of the bytes, so two questions may each have a `main.py`. The schema has not run by then, so this step itself refuses a question id or a `path` that is absolute or climbs out of the test's folder, before it opens a file (§2). A code file read as text that is not valid UTF-8 is an error that names it. Nothing else is added. A file is therefore accepted exactly when the schema accepts the same definition (A42), and a rejected file names the field in the form of §3: `tests/quiz.yaml: questions[2].files[0].path: no file tests/quiz/q3/main.py`.

## 6. Private overlay and hidden material (Q16)

The overlay is `private/` at the site root, the name the [site design](site.md) §3 already writes and the template ignores in git. It mirrors the path from the site root: `private/courses/<course>/<topic>/…` and `private/instructors/<name>/courses/<course>/<topic>/…`. A course's folder there holds topic folders with `exercises/` and `tests/` and nothing else; any other entry in it is an error that names the path.

A tree is declared by `public` in `course.yaml`. The field has no default, so an undeclared tree stops `check`, `sync` and a level 0 build, which are the commands that read a tree (§12 has the question this leaves for the owner). Answer-bearing is every file under a topic's `exercises/` or `tests/` folder: every exercise definition (each step has feedback), every test definition and every code file.

| The tree is declared | Definitions and code files are read from | An error that names the path |
| --- | --- | --- |
| `public: true` | the overlay, at the same path from the course folder; `topic.yaml` in the tree still lists each entry with its title | any file under an `exercises/` or `tests/` folder of the tree, one whose name starts with `_` included: there only a name that starts with `.` is skipped |
| `public: false` | the tree | any file in the course's folder of the overlay |

A definition present in both places is therefore an error under either declaration, and its message names both. The rules on what the overlay holds apply where it is read: in `sync`, and in `check` at level 1 and above.

A definition that is listed and found in neither place stops `sync` with exit code 1 and the path it expected, and `check` at level 1 and above does the same. At level 0 `check` reads as a level 0 build reads: it opens no definition, prints the note that definitions are not read at level 0 and, when nothing else is wrong, exits 0, because a checkout of a public repository has no `private/` and a level 0 build needs none. The overlay takes exercises and tests only; §12 names what that leaves in a public repository.

## 7. The reader (P5-08, P5-08f)

`packages/cli/src/folder/read.ts` has three entries; P5-08 builds the first, P5-08f the other two:

```ts
readCourseForSync(dir, { overlay?: string }): Promise<{ manifest: CourseManifest | null; problems: Problem[]; open(file): Readable }>
readCourseForSite(dir): Promise<{ manifest: SiteManifest | null; problems: Problem[]; open(file): Readable }>
readCourseHeader(dir): { title: string } | undefined          // course.yaml's title and nothing else
type Problem = { severity: 'error' | 'warning' | 'note'; code: string; path: string; overlay?: true; field?: string; line?: number; message: string }   // overlay: the path is from the course's folder in private/
```

`manifest` is null while an error stands, so no caller can convert a refused tree. Paths in a manifest are relative to the course folder, with `/`; the commands print them from the site root. Topics and resources carry their folder ids, never row ids: the reader knows no owner. The schemas in contracts (P5-08a) are the exact statement of both manifests; this is what they carry.

| | `CourseManifest` (schema `courseManifest`), for the operator | `SiteManifest` (schema `siteManifest`, strict), an allow-list for a site build |
| --- | --- | --- |
| Course | title, `public` | title |
| Topics, in `position` order | id, position, title, objective, estimated time, prerequisites, completion rule | id, position, title, objective, estimated time, prerequisites; no completion rule, which can name a hidden resource and which the student view does not carry either |
| Resources of each topic, in entry order | every one: id, type, title, visibility, alternative, path, `overlay`, and its source | the visible ones only; a hidden resource is not in it |
| Source of a deck, a reading, a notebook, a Shiny app | `{ file }` for a PDF, a reading and a notebook (a notebook also lists its data files with their paths), `{ markdown }` for web slides, `{ url }` for Shiny | the same |
| An exercise or a test | `{ definition }`: the parsed value, code files filled in | its id, title, topic, position and visibility, and no more: the schema has no field for a definition, a source, a code file, an answer, feedback, a hint, a solution or a rubric |
| `files` | each file that is stored as an object, with `sha256`, `size` and format; a notebook's data files stand before the notebook | the same, for the resources it holds |

A folder states no release date, so there is no resource to leave out by date. `readCourseForSite` takes no overlay and opens no file under `exercises/`, `tests/` or `private/`: it lists those folders of a tree declared public to refuse what lies there, as `check` does, and its `open` gives only the files its manifest lists. `sync`, and `check` at level 1 and above, call `readCourseForSync`; a level 0 build, and `check` at level 0, call `readCourseForSite`; the catalogue calls `readCourseHeader`, which returns the title when `course.yaml` has a valid one and nothing otherwise, and reports no problem. So nothing these units hand to a site build or a catalogue holds a test definition or an exercise's answers, feedback, hints or solutions. The reader, the YAML forms and `check` import no database driver; of the server's sources `check` loads only the validator of §8, through `paths.ts`.

## 8. Conversion and checks without a database (P5-09, P5-09a, P5-08d, P5-18d)

**The conversion entry.** `apps/server/src/content/convert.ts` exports `convertRevision(source, io)`: `source` is `{ type, content, objectKeys }` as a revision stores them, and `io` gives `read(key, maxBytes)`, the key prefix for a notebook's output objects and an abort signal. It returns `{ derived, objects }` and stores nothing. It is the body of `ingestRevision` (`apps/server/src/jobs/reading-ingest.job.ts`) moved with its limits, content schemas and messages; it calls `renderReadingInThread`, `renderSlidesInThread`, `renderNotebookInThread` and `extractPdfText` unchanged, in their bounded threads. `ingestRevision` keeps its signature, reads objects from storage, calls the entry and stores the notebook's objects with `storeCourseObject` as today, and the job file exports again every name it exported. The entry runs no cell: a notebook is imported with its stored outputs. Outputs that are objects (notebook HTML, images, SVG) stay objects for the content origin, no JavaScript output is produced, and the three app-origin surfaces keep their two sanitisers. This design writes no level 0 output and decides nothing about how one is served.

**The validator.** `validate` (`apps/server/src/db/content/releases.ts`) moves unchanged to `apps/server/src/content/validation.ts`, with `needsAlternative`, `shinyOriginApproved` and `ValidateOptions`, typed over the fields it reads; `releases.ts` imports it and exports it under the same names. `DerivedStatus` with `derivedReady`, and `canonical` with `revisionHash`, move the same way to the leaf modules `content/derived-status.ts` and `content/canonical.ts`, re-exported from `db/jobs/derived.ts` and `db/content/drafts.ts`, and `execution/job-builder.ts` imports `canonical` from the leaf. `revisionHash` moves because `isFolderHead` of P5-18a needs it in a module without database imports (§10). The validator's import closure then holds no file under `db/` or `auth/`: today it reaches `db/` through `testPublicationIssues`, `job-builder.ts` and `canonical`, and through `derivedReady`. No body, message, code or signature changes; if one would have to, P5-09a stops and is labelled `needs-human`. The validator is an entry of its own: `convert.ts` does not import it.

**The upload rules.** They are stated as functions over bytes in `packages/contracts/src/courseFiles.ts`: the format by extension from `uploadFormats`; at most `MAX_UPLOAD_BYTES` (25 MiB); not empty; a PDF starts with `%PDF-`; a text format is valid UTF-8 without a NUL byte; a notebook passes `parseNotebook`; a data file is not empty and at most 25 MiB; at most 100 data files with `WorkspacePath` paths; the stored content types (`text/markdown`, `text/html`, `application/pdf`, `application/x-ipynb+json`, and `application/octet-stream` for a data file); and `declareWorkspaceFiles`, which restates the editor's `declareFiles`. The contracts index exports this file and `courseFolder.ts`, and the web application imports that index, so neither uses a Node built-in: bytes are `Uint8Array`, and hashing is the caller's. `apps/server/src/content/folder-input.ts` (P5-18d) is the server's side: it applies those rules to a file while it streams into storage, compares its size and `sha256` with the manifest, and builds the notebook that names its stored data files.

The route keeps its own copy (`checked` in `authoring.routes.ts`) and the editor its `declareFiles` (`apps/web/src/authoring/workspaceFiles.ts`); no unit may edit either. Two named tests hold the copies equal. `packages/contracts/src/courseFiles.test.ts`, which `pnpm check` runs, compares `declareWorkspaceFiles` with the editor's unchanged `declareFiles` and checks the limits, signatures, encodings and notebook imports. It loads the editor's module when it runs, from a path it builds, and not through a static import: that module imports the web client, which reads `import.meta.env`, and the contracts package is compiled with the types of Node only, so `tsc` there must not follow it. The A40 test of P5-18 sends the same accepted and refused files through the upload route and through `sync` and compares objects, types and messages. A change to `declareFiles` without the same change in the copy fails the first, and a change to `checked` fails the second.

## 9. `parallax check` (P5-08f, P5-08c)

It needs no server and runs at every level, for every course folder of the site. P5-08f builds the command with the reader's problems: layout, paths, both metadata files, ids, references, definitions against their schemas, a Shiny address against `shinyContentProblem`, and the overlay rules. P5-08c adds `--write-ids` (§4.1), the upload rules on every file, and `publicationReport(manifest, derived, options)`, which hands the manifest to the unchanged `validate` in the shape of loaded drafts and returns its `ValidationReport`, each issue with its folder path: the same codes and messages as publication.

| Code of `validate` | `check` | Why |
| --- | --- | --- |
| `empty_release`, `empty_topic` | reports | read from the manifest |
| `broken_reference`, `invalid_exercise` | reports | read from the manifest; in a run of `check` the reader has named the same cause before, with file and field |
| `unapproved_shiny_origin` | reports | `origins.shiny` of the site configuration |
| `missing_alternative` | reports as a warning | as an error it needs `derived.rasterOnly`, which only a conversion gives |
| `invalid_test`, `script_only_hidden_checks` | does not | a test is checked against `testV1` only. Three of a test's publication rules need the server's runtimes (the runtime is offered, its packages, the job its checks form). Four that need none share the code `invalid_test` with them, so the report cannot keep one kind by code; it leaves that code out, and the warning `script_only_hidden_checks` with it (§12) |
| `unconverted_deck`, `unprocessed_reading` | cannot | they need the state of a conversion: the worker gives it at `sync`, a build at level 0 |
| `no_revision` | cannot arise | every entry of a manifest has its file or its definition |

`validate` itself calls `testPublicationIssues` for every test and reports a PDF deck without derived output, so `publicationReport` leaves out of its report the two codes of a test's publication rules, and the two conversion codes when it was given no conversion results. A caller that converts passes its results in `derived`; a failed reading or deck then gives those two codes, and a raster-only deck without an alternative gives `missing_alternative` as an error. A level 0 build converts, so it has publication's report to stop with (A40; §11). From a `SiteManifest`, whose exercise and test entries hold no definition, the validator gets the other resources only. `check` ends with one line that names what it left out: the publication rules of tests, conversions, the course's other drafts, and a server whose settings differ from the configuration. Errors exit 1, warnings and notes exit 0, a usage or configuration problem exits 2.

## 10. `parallax sync` (Q12, Q13)

`parallax sync [<course> …] [--overwrite-editor] [--accept-new-ids]`, run by the operator in the site folder at level 1 or 2. `<course>` is a reference as in `classes[].course`, and without one every course of the site is synced. A reference must name a course folder exactly as the listing spells it (§4.2), and the name that goes into the bundle is the listed one. The command reads every chosen course and its overlay with `readCourseForSync` and stops with exit code 1 on any error, before any run. Each course is then one run of `src/scripts/sync-course.ts` in the server image, started with `runInServer` as `apply` is ([site design](site.md) §8). A refused course does not stop the others, and the command exits with the highest code.

The script receives one bundle on standard input: the header as one line of JSON (`syncHeader`: the address in `instructor.yaml` and that file's path, the course folder's name, the manifest, the options), then the bytes of `manifest.files` in order, each exactly the `size` its entry states, and nothing after. It is a stream: the command pipes each file from disk and the script checks each one while it goes into storage, so a course is never held in memory; a short, long or altered file ends the run with exit code 2 before a draft is written. The definitions travel inside the manifest, already parsed. Nothing is mounted, the container needs no access to the site folder, and the script reads `DATABASE_URL`, the storage settings, `INSTRUCTOR_EMAILS`, `SHINY_ORIGINS` and `RUNNER_RUNTIMES` from the service's environment. In order:

1. *Owner.* The active account (kind `user`, not deactivated) with the address. If there is none, `sync` stops before any write, names `instructor.yaml` and says that the person signs in once first. It creates no account.
2. *Course.* The derived id (§4.3). A course that does not exist is created with `createCourse` and the title of `course.yaml`, only when the address is in the server's `INSTRUCTOR_EMAILS` (the first half of `mayCreateCourse`). `resolveActorScope(db, owner, { kind: 'course', role: 'owner' }, id)` gives the `CourseScope`; a course the account no longer owns is refused, and so is an archived course. The title of an existing course is not changed: no service renames a course.
3. *Objects.* Each file passes the upload rules (`folder-input.ts`) while it streams into `storeCourseObject` with the route's content type. A data file's object id is read with `courseObjectId`, as the workspace-file route does, and the notebook is stored after its data files.
4. *Plan.* The drafts are read, and a pure function (`planSync`) compares them with the manifest: topics and resources to create, change, move, restore or archive, and refusals. Folder ids in `prerequisites` and `completionRule` become row ids here (`topicPayload`). No draft has changed yet.
5. *Refusals.* If the plan holds one (an editor's head, a new id at a recorded path, another kind of file under an old id), `sync` stops with exit code 1 and names each file. No topic, resource, revision or release has changed by then: what exists is content-addressed objects and, on a first sync, the empty course.
6. *Drafts.* `createTopic`, `updateTopic`, `createResource` and `updateResource` (`db/content/drafts.ts`) with the derived ids and each row's `expectedRevision`. A conflict (someone saved meanwhile, or another sync made the row) stops with exit code 3. When its writes are done `sync` takes the fingerprint of all drafts: a hash over what a release snapshots, which is each live topic's and resource's id and fields and each head revision's id.
7. *Conversion.* For each head revision of a processed type (`isProcessed`) without a status, `enqueueIfUnprocessed`, the call the draft routes make; a failed head is queued again with `enqueueReadingIngest`, as the retry route does. `sendScopedJob` puts the owner as `actorId` and the course as scope into the payload, and the worker resolves the scope again. `sync` polls `listResourceJobStatus` until every head is ready or failed.
8. *Publication.* `publishFolderRelease` (`db/content/sync.ts`) opens one transaction, takes the lock on the course row that publication takes, reads the drafts with their rows locked and compares their fingerprint with the one of step 6. A difference means that someone saved while `sync` waited: the run ends as a conflict, with no release and exit code 3, and the next run plans against the changed drafts. A fingerprint equal to that of the newest release means there is nothing to publish. Otherwise it calls `publishRelease` with the transaction in the handle's place, where its own transaction is a savepoint, and with the server's `SHINY_ORIGINS` and `RUNNER_RUNTIMES`, as the route calls it. Before the commit the fingerprint of the snapshot is compared once more, so a row that someone added after the read rolls the release back as the same conflict. A second `sync` that runs at the same time finds its drafts equal to the newest release and publishes nothing more.

`sync` writes no audit event of its own: `course.create` and `release.publish`, which the functions it calls write, name the owning account as actor, and each revision's provenance says that it came from a folder. Queries and transactions are in `apps/server/src/db/content/sync.ts` only, as the repository's lint rule requires; `folder-sync.ts`, `publish-drafts.ts` and the script call data-access functions and build no query. Scoped tables are reached through `forCourse` with the scope of step 2; `users` and `courses` are not scoped tables. `publishRelease` is typed for the database handle, which a transaction is not, so `sync.ts` passes its transaction with a cast and changes no existing signature.

**What is stored.** `revisionPayload` in contracts builds these values, from the storage key of each file and, for a notebook's data files, their object ids and sizes; it is the one function `sync` and a level 0 build use. Title, visibility, order and alternative go through the same services.

| Type | `sync` stores | The editor stores the same because |
| --- | --- | --- |
| `slides_web` | `content: { markdown }`, the file's text as UTF-8, without a byte-order mark and with line ends as LF, so a deck saved with CRLF and with LF is one text and one revision; no object | `WebSlides.tsx` posts `{ markdown }` from a text area |
| `slides_pdf` | the file as `application/pdf`; `content: { objectKey }`, `objectKeys: [key]` | the upload and create calls of `docs/guide/instructors.md` (Slides) |
| `reading_native` | the file as `text/markdown` or `text/html`; `content: { sourceKey, format }`, `objectKeys: [key]` | `AddReading.tsx` |
| `reading_pdf` | the file as `application/pdf`; `content: { objectKey }`, `objectKeys: [key]` | `AddReading.tsx` |
| `notebook` | without data files the file as it is and `content: { sourceKey }`; with them the notebook that `declareWorkspaceFiles` gives, which sets `metadata.parallax.files` to `{ path, resourceId }` (`resourceId` is the data file's object id), and `content: { sourceKey, workspaceFiles }` with `{ path, resourceId, size }` each; `objectKeys: [notebook, …data]` | `AddNotebook.tsx` and `declareFiles`; `courseFiles.test.ts` holds the two functions equal |
| `shiny` | `content: { url }` | `ShinyApp.tsx`; `createResource` runs `shinyContentProblem` |
| `exercise` | `content`: the result of `exerciseV1` | `createResource` runs `exerciseProblems` on what the form posts |
| `test` | `content`: the result of `testV1` | the form posts the definition; publication validates it |

**Which side wins.** The folder declares, for a topic, its title, objective, estimated time, prerequisites, completion rule and position; for a resource, its topic, order, title, visibility, alternative and content. An absent optional field declares the value the editor's empty form gives. `sync` sets the fields of a draft row to the folder's whenever they differ and asks nothing: no stored state says who changed a title. Content is different, because a revision records where it came from. A revision made from a folder has `provenance = { source: 'folder', course, topic, resource, path, overlay, digest }`: the course folder's name, the two folder ids, the file's path from the course folder, whether it was read from the overlay, and `digest`, which is `revisionHash` (in `db/content/drafts.ts` today, in the leaf of §8 after P5-09a) of its type, content, object keys and alternative with provenance null. A head revision came from the folder exactly when its provenance has that source and `digest` equals the digest of what the revision itself stores (`isFolderHead`). `updateResource` carries provenance forward when the editor saves (the web editor never sends the field), so after an editor's edit the stored content no longer matches `digest` and the head counts as the editor's, also on a resource that `sync` created; a later save that puts the folder's content back matches again.

- `sync` refuses, unless `--overwrite-editor` is given, to replace a head that is the editor's with different content, to archive a resource whose head is the editor's, and to archive a topic that holds an editor-made resource. With the flag the folder's content becomes the new head and the editor's revision stays in the history.
- If the editor's head already equals the folder's content, `sync` records a revision with the same content and the folder's provenance.
- When the content is unchanged `sync` sends no revision field, so a file that is only renamed or moved gets no revision: its title, topic and position are updated on the draft row, and the head's provenance keeps the earlier path.
- A topic or a resource with a random id was made in the editor and is left as it is; the report counts them. A version 5 row that the folder no longer lists is archived with `updateTopic` or `updateResource`, never deleted: the next release leaves it out, and it can be restored.
- The folder declares no release date, class, assignment or grant, and `sync` never reads or writes one: a release date set through the API stays as it is.

**Waiting, reports and what a stop leaves.** The wait ends when every head is ready or failed, when nothing has changed for 60 s while no head is running (no worker took the jobs), or after 30 minutes. In the last two cases `sync` does not publish: it prints the report of `validateDrafts`, which names each head still being processed, and exits 3; the queued jobs stay queued, and a worker that starts later finishes them. A failed conversion is not handled specially: publication is called and blocks with the existing `unprocessed_reading` or `unconverted_deck` message. `sync` prints, per course, the counts (created, new revisions, moved, archived, unchanged, editor only), then `release <n> published` with its warnings, or that there is nothing to publish, or `not published` with every error and warning of the `ValidationReport`: its code, its message and the folder path of its `resourceId`. Every printed line states a real result, and `published` is printed only after `publishRelease` returned a release.

| Exit code | Meaning |
| --- | --- |
| 0 | published, or nothing to publish |
| 1 | refused or blocked: folder errors, no account, an address outside `INSTRUCTOR_EMAILS`, a course the account does not own or an archived one, editor heads, a new id at a recorded path, validation errors |
| 2 | usage, level 0 (which has no server), or a malformed bundle |
| 3 | not finished, and safe to run again: a time-out, no worker, queue or storage unavailable, a concurrent save, a draft that changed during the wait |

A stop after step 6 leaves drafts written as an editor's save leaves them, queued jobs that a worker will finish, and no release; classes read releases only, so no student sees a change, and the next run publishes. `sync` deletes no topic, resource, revision, release or object, changes no release and no column of a revision (`derived` is the job's), creates no class and moves no class to a release: adoption stays with the routes and `parallax apply`.

## 11. What later units and run R3 get

| Later unit | Gets | From |
| --- | --- | --- |
| P5-17 (template courses), P5-07 (fixture site) | the layout of §2, `topic.yaml` with ids written (§3, §4.1) and the overlay at `private/` (§6). P5-17's courses also have `course.yaml`, so that a site made from a template passes `parallax check` as it is. They are written with `public: true`: the template ignores `private/` in git, which is the layout of a tree declared public (§12 puts the value to the owner) | this document, on `main` from session 1 |
| P5-07a (the loader), P5-23a (the document `apply` sends) | the rule of §4.2 that a course folder's name has one source: the loader accepts a `classes[].course` only when it equals the listed name of a course folder, and the document names each course by that listed name | this document |
| P5-07c (catalogue title) | `readCourseHeader(dir)`. P5-07 is built first, with an empty catalogue; P5-07c builds the catalogue in `folders.ts` ([site design](site.md) §6.6) and makes the one call, which shows the title of `course.yaml` and keeps the folder's name where the file is absent or gives no valid title (owner decision, 2026-10-14: the call moved from P5-08, which no longer touches `folders.ts`). P5-07's fixture courses carry no `course.yaml`. From then on the catalogue opens `course.yaml` and no other file of a course folder | P5-08f |
| P5-14 (level 0 build) | `readCourseForSite(dir)` with its `SiteManifest` and `open`; `revisionPayload` and `topicPayload`; `convertRevision`; the upload rules of `courseFiles.ts`; `publicationReport` | P5-08a, P5-08d, P5-08, P5-08f, P5-09, P5-08c, all before session 3 |
| P5-17a (packing) | `apps/server/src/content/convert.ts` and what it imports: no file under `db/`, neither `pg` nor `drizzle-orm`. Beyond its entry: `vendor.ts` follows the relative imports of `validation.ts` as it follows those of `convert.ts`. `packed-check.test.ts` of P5-08c fails if the validator is not in the packed copy, and P5-08c then adds that one entry file itself | P5-09, P5-09a |
| P5-19 (`apply`) | `findSyncedCourse(db, ownerId, folderName): Promise<string \| null>`, the lookup the [site design](site.md) §8 asks of this run. `ownerId` is the account `apply` found for the instructor folder that holds the course; `folderName` is the course folder's name as the listing spells it (§4.2), the last part of a `classes[].course` that the loader accepted; null means not yet synced, which `apply` reports as pending. Also `findFolderOwner(db, email)`, the lookup of step 1, which is the one the site design calls `findInstructorAccount`: P5-19 builds on it, so the rule has one implementation. And `syncCourse`, for the synced fixture course of its A51 test | P5-18b, session 1a; P5-18 |
| P5-23a (host commands) | nothing is asked of it: `sync.ts` is built after it and calls `runInServer` of `src/host/compose.ts` as `apply` does, with a byte stream as standard input | P5-18c |
| P5-24 (documentation) | the commands `check` and `sync` as built | P5-08c, P5-18c |

**For run R3** (P5-05). The hand-over to a level 0 build is the row of P5-14 above and nothing more. Run R3 decides: whether a level 0 address uses a folder id or a name; where a build gets the storage keys and object ids that `revisionPayload` takes, there being no course and no database; what a build does with a notebook's data files, which the manifest carries; what it shows for a topic whose only resources are exercises and tests, which `publicationReport` on a `SiteManifest` reports as `empty_topic`; and, in the entry of P5-14, the test that shows a level 0 build stopping with publication's report (the second clause of A40 at level 0).

## 12. Open questions, what is left out, and known limits

**For the owner.** Neither question is decided here, no unit waits for an answer, and this design adds no commitment beyond N1 to N10 and the answers Q12 to Q16.

1. The specification says that "both the check and the build refuse an answer-bearing definition in the public tree" (§13). This design, as the landed plan does, takes "the build" to be the one that reads course folders, the level 0 build. At levels 1 and 2 `parallax build` compiles the site's pages and opens only `course.yaml`, for the title; there `sync` converts and refuses, and `check` refuses at every level. Should `parallax build` at levels 1 and 2 refuse as well? **Answered by the owner on 2026-10-14 (package session 2, [#613](https://github.com/danielriosgarza/PlatosCave/issues/613#issuecomment-6176994000)): no.** The build at levels 1 and 2 does not refuse a leaking public tree and needs no `private/`; ADR-0003, "Hidden material", names the level 0 build since P5-07.
2. The template courses are written with `public: true`, the value under which nothing answer-bearing can lie in the tree. Is that the start a new site should have?

**Left out on purpose, each a later owner decision** (`needs-human` if a unit is asked for one): a release date per resource in `topic.yaml` (only the API sets one today); changing a course's title after its first sync; keeping a course through a rename of its folder or a new owner address; repairing or re-keying the ids of a course that has been synced; writing the editor's changes back into a folder; moving a course to another owner through `sync`; creating an account; a flag that adopts the new release for a class; images beside a Markdown reading; `.yml` beside `.yaml`. A follow-up outside this phase: letting the upload route call `courseFiles.ts` would remove the second copy of its rules, but it edits a route.

**Known limits.**

- Identity rests on three stateless rules: derived ids, the UUID version as the mark of a folder-made row, and the digest in provenance. Each is small and tested by case, but a mistake in one detaches notes.
- A course is tied to the owner's account and the folder's name (§4.2). The name enters as the listing spells it, so a folder renamed only in case or in Unicode form is another course. The catalogue shows the title of `course.yaml`, and `/courses` the title the course was created with.
- The stop for a changed id compares the path the head's provenance holds, which after a rename without a change of content is the earlier path: a changed id at the new path is then created without a stop, and the report names the earlier id.
- `check` is not the whole of publication. The publication rules of a test, conversions it did not run, the course's other drafts and a server whose settings differ from the configuration show only at `sync` or in a build. Five of a test's rules need no runtime and still wait for `sync`: the assignment settings, rubric points above the question's, a file both editable and hidden, a code question without a public check, and hidden checks that are all scripts.
- Publication snapshots the whole course, so an editor's unpublished changes that were there before a `sync` are published with it, as publishing does today; only a save during the wait stops the run. A `sync` of an unchanged folder therefore changes no row and makes no release when the drafts equal the newest release, and publishes when they do not.
- Waiting for the worker: a busy worker can look like none, and `sync` then stops with exit code 3 although nothing is wrong; running it again finishes the work. The bounds are constants in one module.
- If `runInServer` of P5-23a takes text only, P5-18c passes the stream through the same injected runner with the arguments `compose.ts` exports.
- A resource marked `hidden` is hidden from students and left out of a level 0 build, but its file lies in the tree: in a public repository it is public. The overlay takes exercises and tests only (Q16).
- Files are stored as they are on disk, so a checkout that converts line ends gives other bytes and, on the next `sync`, new revisions; only a web deck's text is normalised (§10). The resource route takes request bodies of 1 MiB, so a deck or a definition larger than that can come from a folder and cannot be saved again in the editor.
- Aliases are expanded before the schema sees the value, so a definition can be larger than its file; the parser's alias limit bounds it. A merge key is not part of YAML 1.2: `<<` is read as an ordinary key, which the schemas treat as any unknown key.

## 13. Tests by item

The `Verify` line of each entry in plan §9 is the full list; this table names the files and the scenario tests. All but the integration tests run in `pnpm check`, with `DATABASE_URL` deleted from the environment, on temporary folders, forward-slash paths and explicit sorting, so they pass on Windows. The integration tests use real PostgreSQL and no container of their own. No existing test file is modified by any of these units. Fixtures use the fictional course "Reef ecology" by Ana Lima, `ana.lima@example.org`, and hold no secret.

| Item | Tests |
| --- | --- |
| P5-08a | `packages/contracts/src/courseFolder.test.ts` |
| P5-08d | `packages/contracts/src/courseFiles.test.ts` |
| P5-08b | `yaml.test.ts`, `definition.test.ts`, `overlay.test.ts` and `listing.test.ts` in `packages/cli/src/folder/` |
| P5-09a | `apps/server/src/content/validation.test.ts`; the existing unit and integration tests of publication, unmodified |
| P5-18a | `folder-ids.test.ts` and `folder-plan.test.ts` in `apps/server/src/content/` |
| P5-18b | `apps/server/test/integration/folder-courses.itest.ts` |
| P5-09 | `apps/server/src/content/convert.test.ts`: `A40 conversion runs with DATABASE_URL unset and imports no database module` and `A40 conversion preserves bounded rendering and omits JavaScript outputs`. `apps/server/test/integration/a40-conversion-output.itest.ts`: `A40 the database-free conversion entry equals ingestion output for the same sources` |
| P5-08 | In `packages/cli/src/`: `a38-course-folder-modes.test.ts`: `A38 a courses/ folder placed unchanged under instructors/<name>/ yields the same topics and resources`. `a40-folder-mapping.test.ts`: `A40 each file of a course folder maps to the type, order, title and stored content the editor records`. `a42-yaml-definitions.test.ts`: `A42 a YAML exercise or test is accepted exactly when the schema accepts the same definition, and a rejected file names the field`. `folder/read.test.ts` |
| P5-08f | In `packages/cli/src/`: `a43-public-tree.test.ts`: `A43 a public tree that holds a test or exercise definition is refused and the file is named`. `commands/check.test.ts`, `folder/read.test.ts`, `folder/imports.test.ts` |
| P5-08c | `ids.test.ts`, `publication.test.ts` and `packed-check.test.ts` in `packages/cli/src/folder/` |
| P5-18d | `apps/server/src/content/folder-input.test.ts` |
| P5-18 | `apps/server/test/integration/a40-folder-conversion.itest.ts`: `A40 a synced course folder holds the types, stored content and derived output the editor produces for the same files` and `A40 a problem that blocks publication stops sync with the report of the existing validation and leaves no release`. `a41-folder-resync.itest.ts`: `A41 a changed folder gives new revisions of the same resources and a new release, and a note stays attached or shows Needs reattachment`, `A41 a second sync of an unchanged folder creates no revision and no release` and `A41 a head revision that came from the editor is not overwritten unless sync is told to` |
| P5-18c | `packages/cli/src/folder/bundle.test.ts`, `packages/cli/src/commands/sync.test.ts`, `apps/server/src/scripts/sync-course.test.ts` |

The second clause of A40 ("a problem that blocks publication stops conversion with the same report") has three places: at level 1 the second A40 test of P5-18; for `check`, `publication.test.ts` of P5-08c, which compares `publicationReport` with `validate` code by code and message by message, under a plain title because an added item lists no scenario; at level 0 the test that run R3 names for P5-14 (§11).

## 14. Differences from the plan of run R2, and what was checked

**Differences.** Each follows from the repository or from a probe, or fixes a detail that two units share; none adds a commitment, and §12 puts to the owner the two places where a reading of a commitment is involved (items 6 and 7).

1. **§5, tags and directives.** The plan says that no date is created and no tag outside the core schema is interpreted. With the defaults of the package `yaml`, an explicit `!!timestamp`, `!!binary`, `!!set` or `!!omap` is interpreted although the core schema has none of them (a `Date`, bytes, a `Set`, a `Map`), and a file that starts with `%YAML 1.1` is read with the 1.1 types (a date, `yes` as true, a merged `<<`) unless the caller names the schema. The parser is therefore called with `schema: 'core'` and `resolveKnownTags: false`, and then the plan's sentences hold.
2. **§5, what the parser refuses.** The parser reports a key that stands twice and a second document. It reports neither a cycle, nor a key that is not a string (it turns the key into text), nor a number that is not finite. `yaml.ts` finds those three on the document's nodes; the plan does not say where.
3. **§3, limits.** The plan gives the limits as those of the draft contracts. Four are; the bounds of 200 resources in a topic and of the alternative's 20 000 characters are the folder's own, the contracts having none. The alternative is trimmed, as the forms the plan cites trim it.
4. **§10, what is stored.** `objectKeys: [key]` is stated for the two readings as well; the plan's table has it for the PDF deck and the notebook, and `AddReading.tsx` sends it for both readings. The content of a notebook's `workspaceFiles` is stated (`{ path, resourceId, size }`, as `AddNotebook.tsx` sends it).
5. **§4.4 and §10, "no row changed".** The plan says of a refusal that no row has changed, and of the same moment that objects and the empty course exist. This document names the rows: no topic, resource, revision or release. The two A41 clauses in P5-18's entry say the same.
6. **§6, "every command" and "the build".** The plan says that an undeclared tree stops every command, and its ADR text that a file in a public `exercises/` folder stops "the check, the build and the conversion". By the plan's own sections 7 and 13 the build of levels 1 and 2 calls `readCourseHeader` only and keeps the folder's name when `course.yaml` is absent. So the commands that stop are those that read a tree: `check`, `sync` and a level 0 build. This document says that, and §12 asks the owner, because spec §13 says "the build" without a level.
7. **§11 (the plan's section 13), fixtures and templates.** One row of the plan gives P5-07's fixture courses a `course.yaml`, and the next relies on its absence for P5-07's tests to stay as they are. Here P5-07's fixture courses carry none; P5-08's Verify names the test of `readCourseHeader`, and P5-07c's the title and the fallback in the catalogue, which the plan's Step leaves untested. The template courses of P5-17 need a value for `public`, which has no default and for which the plan names none: they are written with `true`, and §12 asks the owner.
8. **§7, the site manifest's topics** carry no completion rule. The plan says "the same topics"; a rule can name a hidden resource, which the allow-list keeps out, and `getClassRelease` gives a student none.
9. **§9, why `check` leaves a test's publication rules out.** The plan's reason is that they need the server's runtimes. Three do (`codeIssues` in `execution/publication.ts`: the runtime, its packages, the job); five do not, and four of those share the code `invalid_test` with the three. The decision stands, with its real reason, and §12 names what it costs.
10. **§8 and §10, `revisionHash`.** The plan puts `isFolderHead` into `folder-plan.ts`, a module "without database imports", and has it compare `revisionHash`, which lives in `db/content/drafts.ts` beside the query builder. P5-09a therefore moves `revisionHash` to the leaf with `canonical`, and P5-18a depends on P5-09a. Both are in session 1a, whose longest chain stays at three.
11. **§4.2, one source for a course folder's name.** The plan derives the course id from "the folder name" and gives it two readers: `sync`, from the path it reads, and `apply`, from the text of `classes[].course`. On a file system that ignores case the two can differ and give two ids. The name is the listed one, and a reference must equal it.
12. **Details fixed here** because one unit writes them and another reads them: a notebook's data files are taken sorted by path and stand before their notebook in `files` (their object ids go into the notebook that is stored); `revisionPayload` and `topicPayload` are given keys and ids by their caller; a code file read as text must be valid UTF-8, and the code-file step checks a question id and a `path` before it opens a file, the schema not having run yet; the rule on links holds for a link to a file as for one to a folder; the overlay of a course holds nothing but `exercises/` and `tests/`, and for a tree declared `public: false` no file at all, which makes "a definition in both places" an error under either declaration. Where two rules of the plan meet, the stricter holds: under `exercises/` and `tests/` of a tree declared public a name that starts with `_` is refused, not skipped (§6).
13. **§10, step 2.** A course that exists and that the account no longer owns is refused: `resolveActorScope` gives no scope for it. The plan names the missing and the archived course only. The script's settings and the cast for `publishRelease` are named.
14. **§8.** `courseFolder.ts` and `courseFiles.ts` use no Node built-in, because the web application imports the contracts index (27 imports today). The plan does not say it.
15. **Plan §9.** `Depends on` of P5-14 gains P5-08c, of P5-19 P5-18b and of P5-24 P5-18c: the plan's table of seams gives the first two, and for P5-24 it leaves the order to the session. With it the longest chain of session 4 is still four (23a → 18c → 24 → 25).
16. **The site design.** It names P5-18 for the course lookup and for the command `sync` (§5, §8, §13) and `findInstructorAccount` for the account of an address (§8). The lookup and `findFolderOwner` are P5-18b's, on which P5-18 and P5-19 depend, and the command is P5-18c's. Its §2 packs the conversion closure, and this design adds the validator's (§11). Its §6.6 says the catalogue opens no file inside a course folder; from P5-08 on it opens `course.yaml`. Its §4 has the loader check that every `classes[].course` is a folder, which §4.2 here makes exact. None of these is a disagreement on a decision, and that document is not edited.

**Checked in the repository** on 2026-10-13, at `9f7bd9ec`. Every file and line the plan cites was opened and is as the plan says; this document names the files without the line numbers, which move.

- `apps/server`: `createTopic`, `updateTopic`, `createResource`, `updateResource`, `revisionHash` and `canonical` in `db/content/drafts.ts`, where `updateResource` carries provenance forward and no other module uses `revisionHash`; in `execution/publication.ts` only `codeIssues` reads the runtimes; `validate`, its three helpers and `publishRelease` with the course row lock in `db/content/releases.ts`; `createCourse`, `createClass` and `publishRelease` take an id, and no function updates `courses.title`; ids of `topics` and `resources` default to `gen_random_uuid()`; `resolveActorScope`, `mayCreateCourse`, `storeCourseObject`, `courseObjectId`, `sendScopedJob`, `listResourceJobStatus`, `enqueueIfUnprocessed`, `enqueueReadingIngest`, `isProcessed` and `withDatabase` have the signatures §10 relies on; a write to an archived course is refused in `registerRoute`, not in the services, so `sync` checks it; `job-builder.ts` and `assessments/terms.ts` import `canonical` from `db/content/drafts.ts`; `config.ts` imports nothing of `db/` or `auth/`; nothing imports `@parallax/server` by name, and its manifest has no `exports` yet; the lint rule of `apps/server/lint/raw-db-query.grit` allows queries, transactions and `createDb` only under `db/`, in `main.ts` and in test files; drizzle's nested transaction is a savepoint.
- `packages/contracts`: `uploadFormats` and `MAX_UPLOAD_BYTES`; `exerciseV1`, `testV1` and `codeFile` (`path`, `content`, `encoding`, `editable`, `hidden`); a code step of an exercise has `starter` and no file; `WorkspacePath` and `RunnerPath` refuse a segment that starts with `.`; the draft contracts' limits; no source file of the package uses a Node built-in.
- `apps/web`: the bodies that `AddReading.tsx`, `WebSlides.tsx`, `AddNotebook.tsx`, `ShinyApp.tsx` and `TopicForm.tsx` send, `declareFiles`, and the limit of 100 workspace files; no form sends `provenance`.
- Tests and tooling: every test file the entries name as a guard exists; the `unit` project of `vitest.config.ts` collects `packages/**/*.test.ts` and `apps/server/src/**/*.test.ts`; `yaml` 2.9.1 is a development dependency of `apps/server` and `packages/ui`, whose tests read YAML files, so `packages/cli` takes the same version.

**Probed** on the same day, in scratch files that are not committed, on Windows with Node 22.12:

- The package `yaml` 2.9.1, version 1.2 and core schema: an untagged timestamp and a quoted number stay strings; an unknown tag gives a warning and the plain value; an alias is expanded; a second key and a second document are errors with a line; a cycle, a number key and `.inf` are not errors; beyond its alias limit the parser throws; `<<` is an ordinary key. With a first line `%YAML 1.1` and no schema named, a date was created, `yes` was true and `<<` merged; with `schema: 'core'` none of that happened. Differences 1 and 2 come from these runs.
- A test file in `packages/contracts/src/` that imports `apps/web/src/authoring/workspaceFiles.ts` from a path built at run time: it loads in the `unit` project, `declareFiles` returns and throws as in the browser, and `tsc` of the contracts package does not follow the import.
- A junction made with `fs.symlinkSync(target, link, 'junction')` needs no privilege, `lstat` reports it as a link and `realpath` gives its target; it links folders only, so a test of a link to a file gives the listing entry and its target (§2). A file is opened under either spelling of its name while the listing gives the one on disk, and a second name that differs only in case cannot be created.
- The three ids of §4.3, with a version 5 function that reproduces the DNS example of RFC 9562.
- `tsc` of the server refuses a transaction where `publishRelease` takes the handle (`$client` is missing), which is why §10 names the cast.

Nothing here read a folder, parsed a definition against a schema, wrote a draft or started a worker: the tests of §13 do that.
