# Slide decks from an instructor's own files: detailed design (P6-02)

**Status:** proposed in P6-02, 2026-10-20; accepted with its merge. Owner request of 2026-10-20 ([plan](../delivery/plan.md) §10): an instructor feeds Parallax the slides they already have, PowerPoint or PDF, and students see them with their figures and their click animations. It amends spec §7 and §16 (A53 to A56), [ADR-0002](../adr/0002-authorization-and-class-isolation.md) (**Amendment: Decks converted from presentation files**) and [ADR-0003](../adr/0003-content-releases-and-revisions.md) (**Amendment: Decks with steps**). It fits the [course folder design](course-folder.md) and the [open site design](open-site.md): §5 says where it extends them. Items P6-02a to P6-02i in the plan implement it and take their tests from §10. Nothing in it is built yet.

The owner's decisions in the same session (plan §10), which this design takes as fixed:

1. A click animation is shown as **click steps with no script**: each click is a frame, and an effect is shown at its end state. LibreOffice's slideshow script in a frame and a PDF that shows every click at once were the two alternatives the owner did not choose.
2. Conversion runs **on the author's machine first**: `parallax check`, `build` and `sync` convert a presentation file in a course folder. The browser editor keeps PDF decks, and a later item adds a converter service for uploads in the browser (§12).

Terms: a **presentation file** is a `.pptx` (PowerPoint, also written by Keynote and Google Slides on export) or `.odp` (LibreOffice Impress) file. A **frame** is one page of a converted deck: what the slide shows after some number of clicks. A **deck with steps** is a PDF deck whose revision says how many consecutive pages make up each slide. The **converter** is the program of §3; the **tool**, a **course folder**, the **site host** and the **content host** are those of the site toolkit and course folder designs.

## 1. What the instructor does and what students see

The instructor puts `lecture.pptx` in a topic's `slides/` folder and lists it in `topic.yaml` like any deck (`file: slides/lecture.pptx`). `npx parallax check` converts it, or says why it could not. `npx parallax build` (level 0) and `npx parallax sync` (levels 1 and 2) publish the converted deck. The `.pptx` file never leaves the author's machine or the site host: what is stored and served is a PDF that the converter made from it.

A student opens the Slides tab and sees the deck with the instructor's layout, fonts, images, charts and equations as LibreOffice draws them. On a slide with click animations, **Next** and the right arrow reveal one click at a time, then move to the next slide, as in a slide show. A slide that the student opens from the index, from an address or from their remembered place shows its finished state, every click applied. Notes, questions, the page counter and the remembered place belong to the slide, not to a click. Hidden slides, speaker notes, comments, the deck's document properties and its links to files or programs are in no file a student can reach.

The same holds for a PDF deck whose consecutive pages share a page label (§7), which is how Beamer writes the overlays of one frame.

## 2. Shape and trust boundaries

```text
 author's machine or site host
   slides/lecture.pptx ──stdin──▶ converter (container: no network, read-only, limits) ──stdout──▶ PDF + steps
                                   or the machine's own LibreOffice (check and level 0 build only, §3.7)
   .parallax/decks/<sha256>/<converter id>/  deck.pdf  steps.json   (cache, git-ignored)
   parallax build (level 0) ──▶ dist/content/o/<sha256>.pdf  + data file { pdf: { url, pageCount, steps } }
   parallax sync (level 1/2) ──bundle: the PDF as the deck's file, steps in its source──▶ server (as a PDF deck)

 server and browser: unchanged paths of a PDF deck
   worker: extractPdfText (pdf.js) ─▶ derived { pageCount, pages, rasterOnly } ; checks steps against pages
   viewer: draws page start(slide) + step from the content origin, one page at a time
```

| Part | Trusted for | Limits |
| --- | --- | --- |
| the presentation file | nothing: it is course material, untrusted content (course folder design §1), even though it is the author's own | read only by the converter; never stored on the server, never served |
| the converter container | turning one presentation file into one PDF and its steps, with no access to anything else | no network, read-only image, no capabilities, a non-root user, memory, process, CPU and time limits (§3.6); its output is checked like any PDF deck file |
| the machine's own LibreOffice (§3.7) | the same, unconfined, for an author who has no Docker | `check` and the level 0 `build` only, with a note; never `sync` |
| the converted PDF and its steps | nothing more than a PDF deck file from a course folder today | `courseFileCheck('pdf')`, the 25 MiB limit, pdf.js text extraction in a bounded thread, served only from the content origin; steps are checked against the page count (§4.2) |

Nothing here adds a route, a resource type, a migration, a content type or a script on any origin. The server never runs LibreOffice. A deck with steps is a `slides_pdf` resource.

## 3. The converter: `converter/`

### 3.1 Program and image

`converter/convert.py` (new) is a Python 3 program that drives LibreOffice through its own scripting bridge (UNO, the `python3-uno` package): it starts `soffice --headless` on a private pipe with a fresh profile in a temporary folder, loads the presentation with macros disabled (`MacroExecutionMode` 0) and as hidden, computes the frames of §3.2 on LibreOffice's own model of the deck, exports one PDF with `impress_pdf_Export`, normalises it (§3.4) and writes the result (§3.3). `convert.py --version` prints the LibreOffice version it drives and exits 0 without reading its input. Working on LibreOffice's model, not on the file's XML, means the frames are drawn by the same layout engine as the finished slides: text keeps its place when a paragraph is not yet shown, and paragraph builds, groups and placeholders need no code of their own.

`converter/Dockerfile` (new) builds `parallax-converter` from `ubuntu:24.04` pinned by digest, whose LibreOffice is 24.2, the version every rule of §3.2 to §3.4 was checked on. It installs, with `--no-install-recommends` and pinned package versions, `libreoffice-impress`, `python3-uno` and these fonts: `fonts-crosextra-carlito` and `fonts-crosextra-caladea` (metric-compatible with Calibri and Cambria), `fonts-liberation2` (Arial, Times New Roman, Courier New), `fonts-dejavu`, `fonts-noto-core`, `fonts-noto-cjk` and `fonts-noto-color-emoji`. Its user is `converter` (uid 10001), its entry point the program, and it holds nothing else. P6-02h checks that the image's `--version` reads 24.2.

### 3.2 From clicks to frames

For each slide that is not hidden, in order:

1. The slide's **main sequence** (the effects a slide show plays on clicks) is read from its animation tree. Each group of the sequence whose first effect waits for a click starts a new click; a group whose first effect starts by itself (with or after the previous one) belongs to the click before it, which is the slide's opening when it comes first.
2. A slide with `k` clicks becomes `k + 1` frames, made by duplicating the slide after itself `k` times. Frame `n` (0 to `k`) shows the slide after `n` clicks: a target whose **entrance** effect comes at a later click is hidden in it, and a target whose **exit** effect has come at or before click `n` is hidden in it.
3. A target is a shape, which is hidden by `Visible = false`, or a paragraph of a shape's text, which is hidden by making each of its text portions fully transparent and removing its bullet while keeping its indent (`CharTransparence = 100`, `NumberingIsNumber = false`). Its place in the layout stays, as in a slide show, and LibreOffice writes no text for it into the PDF, so a frame's text layer holds what the frame shows and an answer revealed on a later click is not in an earlier frame's text.
4. **Emphasis** effects (colour, grow, spin, pulse) and **motion paths** leave the target as it is drawn on the slide: the frame shows the target, unmoved and unchanged. An effect of an **interactive sequence** (one started by clicking a shape) is not a click step: its entrance targets are shown from the first frame. Timing, transitions and sounds are not reproduced.
5. A **hidden slide** is removed before export: it is in no frame. **Speaker notes** and **comments** are not exported (the export options `ExportNotesPages` and `ExportNotes` are false).
6. Embedded **video and audio** show as the still image LibreOffice draws for them; the converter adds a warning naming the slide (§3.5).
7. **Fields** are fixed before any slide is duplicated, because a duplicated slide is a page of its own to LibreOffice: a slide-number field would count pages (the frames of slide 1 would read 1, 2, 3 and slide 2 would read 4), and a date or time field set to update would show the day of conversion. Each slide-number field in a slide's text, and the number in the slide's own footer (its header-and-footer settings; the footer's number is hidden on the slide and drawn by a text shape at the master's number placeholder, with its size and character properties), becomes the slide's number among the slides that are shown. A fixed date or time stays as it is. An updating date or time field, in the text or in the footer, is emptied, with the warning `date` (§3.5): LibreOffice's model holds the day of conversion for it, not the text the file last saved, and the converter works on the model (§3.1). The converter also runs with `TZ=UTC`.
8. **Links** that leave the web are removed before export: a URL field whose scheme is not `http`, `https` or `mailto` becomes its own text, and a shape's click action other than such a URL (another file, a program, a macro, a sound, a jump to a slide) is removed. LibreOffice would otherwise write each of them as a PDF link (a `file://` link and a program action both came out as `/URI` links to paths in the review of this design), and **Download** hands the PDF to the student's own reader. A link that is kept is the deck's own `http`, `https` or `mailto` address.
9. The **document properties** (title, subject, author, keywords, description, last modified by) are emptied before export: LibreOffice copies them into the PDF's information dictionary, and the PDF is served to students and, at level 0, to anyone.

Rules 7 and 8 also cover the **master pages** that the shown slides use (`getMasterPages()`), since a template's shapes are drawn on every slide that uses it: a link on a master shape is removed as on a slide, and a master shape that holds a slide-number or date field is copied, before any slide is duplicated, onto each shown slide that uses the master, at the bottom of the slide's drawing order and with the field replaced as rule 7 says for that slide, and then removed from the master. The footer placeholders of a master are not copied: the slide's footer settings of rule 7 govern them.

The steps are the list of frame counts per slide, `[1, 1, 4, …]`; their sum is the number of pages of the PDF.

Rules 1 to 6 were checked in this session against two decks built with python-pptx and hand-written timing XML: three paragraphs built one per click (four frames, the bullets of unrevealed paragraphs absent, text kept in place), a picture's entrance with the title's exit on the next click, a hidden slide (left out, steps without it), and a paragraph shown automatically when the slide opens followed by one on a click (two frames, the first already showing the automatic one). A slide with a 1.6 MB picture and seven frames gave a 477 KB PDF against 461 KB for the same slide as one page: LibreOffice writes a repeated image once. Rules 7 to 9 and the master pages come from the review of this design, which found each of those leaks or wrong numbers on LibreOffice 24.2.7.2 and checked the fixes there: slide-number fields replaced by text and the footer's number drawn by a text shape read 1, 1, 1, 2, 3 on a deck whose first slide has two clicks; a URL field and a click action outside `http`, `https` and `mailto` left no link; emptying the document properties removed them from the PDF. It also found that an updating date's stored text is not in LibreOffice's model, hence the emptying of rule 7.

### 3.3 Input, output and exit codes

The program reads the presentation file from its standard input, at most `MAX_PRESENTATION_BYTES` (200 MiB, which leaves room for embedded media that the frames will not play; `packages/contracts/src/converter.ts` holds the constant, and the program's test checks that `convert.py` uses the same number), and takes one argument, `pptx` or `odp`, or `--version` alone. It writes to standard output one JSON line and then the PDF:

```json
{"format":1,"pages":12,"steps":[1,1,4,3,1,1,1],"bytes":845213,"warnings":[{"slide":4,"code":"media","message":"slide 4 holds a video; it shows as a still image"}],"libreoffice":"24.2.7.2"}
```

followed by exactly `bytes` bytes of PDF. The schema of the line is `converterResult` in `packages/contracts/src/converter.ts` (new), strict: `steps` as `deckSteps` of `packages/contracts/src/deckSteps.ts` gives it (a list of 1 to `MAX_SLIDES` (500) whole numbers from 1 to `MAX_STEPS_PER_SLIDE` (99)) whose sum is `pages`, `pages` at most `MAX_DECK_PAGES` (2000), `bytes` at most `MAX_UPLOAD_BYTES` (25 MiB, the limit `courseFileCheck('pdf')` holds a PDF deck to), `libreoffice` at most 32 characters, and at most 100 `warnings`, each with a `code` of §3.5's enum, a `slide` number and a message of at most 200 characters (counted as the schema counts them, in UTF-16 code units). The converter truncates a longer message, and when a deck has more than 100 warnings it writes the first 99 and one last `more` warning that counts the rest. `MAX_SLIDES` moves from `apps/server/src/content/convert.ts` to `deckSteps.ts`, which `convert.ts` imports, so that the contracts can name it; `MAX_STEPS_PER_SLIDE` and `MAX_DECK_PAGES` are new there. Exit 0 on success; exit 1 with one line of explanation on standard error when the file cannot be read or converted (not a presentation, encrypted, empty, over a limit, no slide that is shown); exit 2 on a usage error.

What the program writes is treated as untrusted: a flaw in LibreOffice could make it write anything. The tool reads at most 160 KiB for the line, which holds the longest line the schema allows with every character escaped (100 warnings of 200 characters at 6 bytes each and about 50 bytes of keys is 125,000 bytes; 500 steps take at most 1,500), and refuses a longer line or one that does not parse; it refuses a `bytes` over the limit before reading further, reads exactly `bytes` more, and refuses the result if one more byte follows or the stream ends early; it keeps at most 4 KiB of standard error, and only for the message of a refusal. The PDF then meets the checks every PDF deck file meets (§2).

### 3.4 The same file gives the same bytes

LibreOffice writes the time of export into the PDF: its creation date, the document ID and a checksum (`/CreationDate`, `/ID`, `/DocChecksum`). Two conversions of one file in this session differed in those three places only. The converter rewrites each in place, at its own width: the date's digits become `20000101000000` (with `TZ=UTC` the date ends in `Z'`; a date with an offset, `+02'00'`, keeps its width and gets `+00'00'`), and the ID and the checksum become the first 32 hex digits of the SHA-256 of the file with both blanked. A date or time field in a slide would also make the bytes change from day to day; rule 7 of §3.2 keeps a fixed one and empties an updating one. Every byte offset in the file is kept, so the cross-reference table stays valid; after the rewrite the two conversions were identical. A converter version and a presentation file therefore always give the same PDF, so `parallax sync` sees an unchanged deck as unchanged (ADR-0003, amendment of P5-04: a revision is new only when its content changes) and a level 0 build writes the same object.

### 3.5 Warnings

The program reports, per slide, without stopping: `media` (a video or a sound shows as a still image), `font` (a font the deck names is replaced; it compares each `CharFontName` used with `fc-match`'s answer in the container), `effect` (an emphasis effect or a motion path is shown unchanged), `interactive` (an interactive sequence's targets are shown from the first frame), `link` (a link to another file, a program or a slide is removed, rule 8 of §3.2), `date` (an updating date or time field is emptied, rule 7), `more` (the number of warnings past the first 99, §3.3). The tool prints each warning under the deck's path, as `check` prints a publication warning, and a warning never stops a command.

### 3.6 Running it in a container

The tool runs `docker run --rm -i --name parallax-convert-<random> --network none --read-only --init --tmpfs /tmp:rw,noexec,nosuid,nodev,size=1g --memory 2g --memory-swap 2g --pids-limit 256 --cpus 2 --cap-drop ALL --security-opt no-new-privileges --user 10001:10001 --log-driver none <image> pptx`, with `TZ=UTC` and the file on standard input and no mount, other variable or published port. After 300 seconds the tool runs `docker kill` on the named container, since ending the `docker run` client alone would leave the container running. The process runner of `host/compose.ts` inherits standard output and has no time limit, so the converter gets a variant of it that captures the output with the bounds of §3.3, times out and kills. This is the runner's policy (ADR-0004: no network, read-only root, tmpfs, equal memory and swap, a process limit, no capabilities, no new privileges, a fixed user, input on stdin only) with the sizes a LibreOffice process needs. The image is `${parallax.registry}/parallax-converter:<version>`, computed from the installed tool as `siteEnv.ts` computes the server's (§8), and is pulled once when missing, by `docker pull` in a step of its own before the conversion's 300 seconds start, so a slow first pull is not taken for a conversion that ran too long.

### 3.7 The machine's own LibreOffice

Only when Docker cannot be used at all (no `docker` program, or `docker version` cannot reach a daemon), `check` and the level 0 `build` run the same program with the machine's LibreOffice and the Python that comes with it, with a fresh temporary profile, `TZ=UTC`, links not updated on load (`UpdateDocMode` no update, as in the container) and the same 300-second limit and output bounds. The tool finds them in LibreOffice's own program folder: on Windows `C:\Program Files\LibreOffice\program\` (`soffice.exe` and the `python.exe` beside it), on macOS `/Applications/LibreOffice.app/Contents/MacOS/` (`soffice` and `python`), and on Linux `soffice` on the `PATH` with a `python3` that imports `uno` (the `python3-uno` package). Before the first conversion, it prints once per command: `Converting presentation files with this machine's LibreOffice <version>, outside any container; a site built with Docker uses the pinned converter, whose fonts may differ.` A file that the container refused, failed on or was killed over (memory, processes, time) is never tried again on the machine's LibreOffice, and a failed pull of the image is an error, not a reason to fall back: the unconfined path is for an author without Docker, not a second chance for a file the container would not convert. `sync` never uses it: it runs on the site host, which has Docker at levels 1 and 2. With neither Docker nor LibreOffice, `check` prints a warning per presentation file (`not converted: converting a presentation file needs Docker or LibreOffice`) and exits as before, and `build` and `sync` stop with that line as an error. An author can always export the deck to PDF instead.

For this path the published tool carries the program: `converter/convert.py` is a vendored source of `parallax-site` (`vendor/converter/`, beside `web`, `ui`, `contracts` and `server`; `SOURCES` in `packages/cli/scripts/vendor.ts`, `sourceRoot` in `packages/cli/src/paths.ts`), and the pack test checks that it is in the tarball.

### 3.8 The cache

The tool keeps each result in `.parallax/decks/<sha256 of the presentation file>/<converter id>/`, as `deck.pdf` and `steps.json` (the result line without `bytes`). The converter id is `image-<hex>` for the container, where `<hex>` is the 64 hex digits of the image id that `docker image inspect` reports as `sha256:<hex>` (a colon is not allowed in a Windows file name), and `local-<LibreOffice version>-<SHA-256 of convert.py>` for §3.7, with the version from `convert.py --version`, so a new program converts again. `steps.json` also records the PDF's size and SHA-256. A result is used without running the converter only when `steps.json` parses with `converterResult` again and `deck.pdf` has the recorded size and digest; any other entry is removed and made again. `.parallax/` is already git-ignored, and `upgrade` changes the image id, so a new version converts again.

## 4. A deck with steps

### 4.1 The revision

A `slides_pdf` revision's content gains an optional `steps`: `{ objectKey, steps? }`, with `steps` as in §3.3. It is part of the content, so it is part of the revision's identity and is immutable with it (ADR-0003). A revision without `steps` is a deck of one-page slides, as every deck is today, and nothing about it changes.

### 4.2 Conversion on the server and in a build

`convertRevision` (`apps/server/src/content/convert.ts`), in its PDF deck branch, parses `steps` with `deckSteps` (`packages/contracts/src/deckSteps.ts`) and, after `extractPdfText`, refuses with an `IngestError` a deck whose steps do not add up to its pages: `The deck's steps add up to 14 pages, but the PDF has 12.` It computes `rasterOnly` on the finished frames, the last page of each slide, since a slide's earlier frames carry part of its text by design. `derived` keeps `pageCount` and `pages` per page, as today, and gains `steps`: the deck's effective steps, `content.steps` when the revision has them and otherwise those of §7, or no `steps` for a deck of one-page slides. Every reader of §4.3 and §6 takes the steps from `derived.steps` and nowhere else, so they are computed in one place, and the readers that see only `derived` (`outputsOf` through `layoutOf`, whose queries in `apps/server/src/db/annotations/annotations.ts` select `type` and `derived`) need no other column. The rule runs wherever `convertRevision` runs: in the worker at levels 1 and 2 and in the level 0 build.

### 4.3 Slides and pages

In a deck with steps, every page number that the server keeps or receives for the deck counts **slides**, not PDF pages:

- the remembered place (`study_positions.position.page`): `savePosition` refuses a page above the number of slides, `derived.steps.length`, instead of `pageCount`;
- a `slide` anchor's `page` and a `pdf` anchor's `page` (0-based, ADR-0003): a slide note is on the slide; a `pdf` anchor, which the slide viewer does not create today, lies on the slide's finished frame;
- `mapAnchor` (`apps/server/src/annotations/mapping.ts`): `outputsOf` gives, for a deck with steps, one text hash per slide, that of its finished frame, so a note keeps its slide when a new revision of the deck changes the slides' clicks but not their finished text, and shows **Needs reattachment** otherwise, as the rule for PDF decks already says;
- exports (`lifecycle.ts`) print `slide n` from the same number, which is now the slide's.

`getSlides` returns the steps beside the link, from `derived.steps`: `pdf: { url, expiresAt, pageCount, steps: number[] | null }`.

### 4.4 Publication

The publication check keeps its rules for PDF decks: `unconverted_deck` while the deck is not converted, and `missing_alternative` as an error when `rasterOnly` is true (now computed on finished frames) and as a warning otherwise. A deck whose steps do not match its pages never converts, so it never publishes.

## 5. The course folder and the tool

### 5.1 Layout

The layout table (`courseFolder.ts`, `layout`; course folder design §2) gains two rows: `slides/` takes `*.pptx` and `*.odp`, each becoming `slides_pdf` through the converter. They are folder-only kinds, like `data`: they are not `uploadFormats`, and the editor and the upload route do not change. A presentation file has nothing beside it. `TAKES` names them (`slides/ takes .md, .markdown, .pdf, .pptx, .odp`). The check of a presentation file is its size and its ZIP signature (`PK\x03\x04`) before conversion; the converter's own refusal is the rest.

### 5.2 The manifest and the bundle

The reader converts each presentation file it lists (§3.6 to §3.8) and records the result as the deck's file: the manifest's `files[]` entry for `<topic>/slides/lecture.pptx` names the converted PDF's `sha256` and `size` with `format: 'pdf'`, and `open()` of that path reads the cached `deck.pdf`. The resource's source becomes `{ file: 'slides/lecture.pptx', steps: [...] }` (`withSource`, for `slides_pdf` only), and `revisionPayload` puts `steps` into the revision's content. The server's `bundleProblem` already requires a PDF deck's file to be a PDF, and `storeFiles` checks it with `courseFileCheck('pdf')`, so the server receives and stores exactly what it would for `slides/lecture.pdf` with steps. `syncHeader` and `BUNDLE_FORMAT` do not change: a source with `steps` is a new optional field that an older server would refuse, which the one-version rule of the site toolkit design (§10) already rules out.

### 5.3 The commands

- `check` converts the presentation files of the courses it reads (from the cache when it can) and prints the converter's warnings and refusals with the path; then it reads as today. A conversion that is refused is an error at the deck's path. `LEFT_OUT` stays as it is.
- `build` at level 0 converts as `check` does and writes the deck as a PDF deck: `dataOf` gives `{ type: 'slides', title, pdf: { url, pageCount, steps }, web: null }`. `openResource`'s slides branch gains an optional `steps` (`openSite.ts`, strict, as §4.1), which the audit of `output.ts` needs no new rule for: the object is a PDF as before. The presentation file's digest is recorded with `out.untrusted`, so no file under `site/` can hold it.
- `sync` at levels 1 and 2 converts in the container and fails with the converter's line when it cannot; the bundle is §5.2's.

## 6. The viewer

`SlideViewer` (`apps/web/src/slides/SlideViewer.tsx`) gains a prop `steps?: number[]`. Without it nothing changes. With it:

- Its state is the slide (`page`, 1-based, as today) and a `step` (0-based) within it. It draws PDF page `start(page) + step`, where `start` is 1 plus the frame counts of the slides before. `onPage`, `NotesContext.page`, the counter, the progress bar, the index and `?page` all count slides: the viewer's own count is `steps?.length ?? pageCount`, while the route's `pageCount` stays the PDF's number of pages.
- **Next**, the right arrow and a tap on the next control show the slide's next step, or the next slide's first step after its last; **Previous** and the left arrow show the previous step, or the previous slide's last step before its first, as a slide show does. Next is disabled on the last step of the last slide and Previous on the first step of the first. The focus and key rules of spec §7 are unchanged.
- A slide reached any other way (the index, the address, the remembered place, the deck's first opening) shows its **last** step, its finished state, so a student who comes back to a slide does not have to click through it again.
- On a slide with more than one step, a status after the counter reads `Step 2 of 4` (a polite live region of its own; the counter's text and the slide's label `Slide n of N` stay as they are). The element that holds the drawing carries `data-page` (the slide) and `data-step`.
- A step change keeps the zoom and the pan; a slide change resets the pan, as today. While a step is shown, pdf.js reads the next frame's page in the background, so a click does not wait for the network; it never reads more than that one page ahead (spec §7: loading one page must not require downloading every page).
- `SlidesTab` passes `deck.pdf.steps`; the level 0 shell (`apps/web/src/open/panels.tsx`) passes `data.pdf.steps`.

`SlideNotes` does not change: it is given the slide, so a note, a draft and a question stay on the slide across its steps.

## 7. PDF decks with overlays

A PDF deck whose consecutive pages share a page label is shown as one slide with steps: LaTeX Beamer gives the overlays of one frame the frame's number as their label. In the PDF deck branch of `convertRevision`, the pdf.js worker also reads the page labels (`getPageLabels`); when the revision has no `content.steps`, every page has a non-empty label and at least one label repeats on consecutive pages, the run lengths of equal consecutive labels are the deck's steps and `derived.steps` holds them (§4.2); a label that comes back after other labels starts a new run. Runs that `deckSteps` would refuse (a run over 99 pages, more than 500 runs) give no steps, not a refusal: the deck is one slide per page, as today. A retry of a revision converted before this lands would gain steps and read its saved places and slide anchors as slides; no installation has such a released deck before the first release (0.1.0), so this is accepted. `content.steps` (a converted presentation file) wins because the converter knows the clicks. This works for a PDF deck from a course folder and for one uploaded in the editor alike. A PDF without page labels, or whose labels never repeat, is one slide per page, as today.

## 8. Release and distribution

The release publishes a third image, `ghcr.io/<owner>/parallax-converter:<version>`, under the one version: `release.ts` names it beside `server` and `runner`, `package-release.yml` builds, checks (label, and `convert.py --version` reading 24.2) and pushes it, and the step of P5-AUD14 that stops on a version already published covers it. The `converter` job of `image.yml` (P6-02h) builds it and runs the A53 container tests on a pull request that changes `converter/**`, the converter's contracts or the job itself; it is not in `ci.yml`, so a pull request that does not touch the converter spends no time on it. The tool computes the reference as `siteEnv.ts` computes the server's, from `parallax.registry` and its own version, in a new `packages/cli/src/host/converter.ts`; a level 0 build, which has no `site.env`, uses the same function. In the repository (version `0.0.0`) the tool looks for the image `parallax-converter:dev`, which `pnpm converter:image` builds from `converter/Dockerfile`; the A53 container tests use it in that job, and the program's own tests use the machine's LibreOffice where the session has one.

## 9. Amendments

- **Spec §7** gains, after its first paragraph: presentation files in a course folder are converted to PDF decks with click steps by the site tool (§1 to §3 of this design, in the spec's words), and the viewer rules of §6; and, after "Remember the last slide": in a deck with steps the remembered place, the page number and notes count slides.
- **Spec §16** gains A53 to A56 (§10).
- **ADR-0002, Amendment: Decks converted from presentation files**: a presentation file is untrusted course material that only the converter reads, which removes links outside the web, slide numbers and dates that would change, and document properties from the slides and the master pages they use, in the container of §3.6 or, for `check` and a level 0 build without Docker, the author's own LibreOffice; the server never runs LibreOffice; what reaches the server, a build or a browser is a PDF deck file, checked and served as one; no script is added on any origin.
- **ADR-0003, Amendment: Decks with steps**: a PDF deck's revision may say how many consecutive pages make up each slide; in such a deck positions and slide and PDF anchors count slides, and a slide's text hash is that of its finished frame.
- **Course folder design §2** gains the two layout rows and a pointer to §5 here; **open site design §3** gains `steps` in the slides branch.

## 10. Tests by scenario

| ID | Scenario (spec §16) | Tests |
| --- | --- | --- |
| A53 | A presentation file in a course folder becomes a PDF deck with one page per click step: each step shows what the slide shows after that click, with the deck's images and text; hidden slides, speaker notes and comments are in no file of the deck; converting the same file again gives the same bytes. | `converter/test/a53-convert.docker.test.ts` (P6-02h), skipped without the image (`describe.skipIf(!imagePresent)`, as A13 is) and mandatory in the `converter` job, where a `test.runIf(process.env.CI)` case requires Docker and the image: the fixture decks of P6-02a converted in the image give the frames and steps of §3.2, read with pdf.js (each page's text, and the image paint operations of its operator list for a picture's entrance and exit); no page holds a hidden slide's title, a speaker note, a comment, a document property of the fixture, or a link that is not `http`, `https` or `mailto`, including a `file://` link on a master shape; a slide-number footer, a slide-number field in a slide's text and one in a master's text box read the slide's number on every frame; a deck with an updating date field shows no date where the field was, warns `date`, and gives the same bytes under `TZ=UTC` and `TZ=Europe/Berlin`. `packages/cli/src/a53-presentation-folder.test.ts` (P6-02e): a course folder with `slides/lecture.pptx` checks, builds at level 0 with `steps` in the data file and the PDF object, and its sync bundle carries the PDF and the steps, with the converter's process replaced. The program's own tests (P6-02a, P6-02i) run with the machine's LibreOffice where it is present and carry no scenario ID, so the scenario gate counts only the container tests |
| A54 | In a deck with steps, Next and the right arrow show the next step and then the next slide, Previous goes back through the steps; a slide opened from the index, an address or the remembered place shows its last step; the counter, the remembered place and slide notes count slides. | `apps/web/src/slides/a54-steps.test.tsx` (P6-02c), and `e2e/tests/a54-deck-steps.e2e.ts` with a world fixture deck with steps (P6-02c) |
| A55 | A deck whose steps do not add up to its pages is refused at conversion; a deck with steps whose finished slides carry no text cannot be published without a text alternative; a note on a slide stays on it when a new revision changes the slide's clicks but not its finished text. | `apps/server/src/content/a55-deck-steps.test.ts` and `apps/server/test/integration/a55-deck-steps.itest.ts` (P6-02b) |
| A56 | A PDF deck whose consecutive pages share a page label is shown as one slide with steps. | `apps/server/test/integration/a56-overlays.itest.ts` (P6-02g): a PDF written with `/PageLabels` by the extended `makePdf` fixture, released in a deck, gives `steps` from `getSlides`, and a saved place past its last slide is refused |

P6-02b, the first unit to add a test carrying one of these IDs, widens `RANGE` in `scripts/check-scenarios.ts` to `5[0-6]` and amends ADR-0006's statement of the range; its scope names both files.

## 11. Units

| Unit | Scope | Depends on | Size |
| --- | --- | --- | --- |
| P6-02b | Steps in a PDF deck, server side: `deckSteps` and its limits in `packages/contracts/src/deckSteps.ts` (new, with `MAX_SLIDES` moved there), the check against pages, `derived.steps` and `rasterOnly` on finished frames in `convertRevision`, `getSlides`' `steps`, `savePosition` counting slides, `outputsOf` per slide; the scenario range and ADR-0006 | P6-02 | M |
| P6-02a | The converter program, part 1: `converter/` as a workspace package (pinned `pdfjs-dist`, a typecheck, the `converter` Vitest project run by `pnpm test`, Docker tests excluded); `convert.py` with §3.2 rules 1 to 6, §3.3 (input, `--version`, the bounded result, exit codes) and the warnings of §3.5 those rules give; `converterResult` and `MAX_PRESENTATION_BYTES` in `packages/contracts/src/converter.ts` (new); `converter/fixtures/make.py` with the click, hidden-slide, notes and comment fixtures | P6-02b | M |
| P6-02i | The converter program, part 2: §3.2 rules 7 to 9 on slides and master pages, the normalisation of §3.4, and their fixtures (fields in text, footer and master; a fixed and an updating date; `file://` and program links on a slide and on a master; document properties) | P6-02a | M |
| P6-02h | The converter image and its job: `converter/Dockerfile`, the root script `converter:image`, the Docker Vitest project, the `converter` job of `image.yml`, `a53-convert.docker.test.ts`, and ADR-0006's projects and jobs | P6-02i | M |
| P6-02c | The viewer steps through a deck: `SlideViewer`, `SlidesTab`, `slides.ts`, the level 0 shell's slides branch, `openResource`'s `steps`, and the level 0 build's `dataOf` writing them from `derived.steps` | P6-02b | M |
| P6-02d | The tool runs the converter: `packages/cli/src/host/converter.ts` (image reference, the pull, the container of §3.6 with its capturing, timed and killing process runner, the fallback of §3.7 with its program lookup, the cache of §3.8, the bounds of §3.3), and `converter` as a vendored source of `parallax-site` with its pack test | P6-02h | M |
| P6-02e | Presentation files in a course folder: the layout rows, `TAKES`, the size and ZIP check, the reader's conversion and `open()`, `withSource`'s `steps` and `revisionPayload`, `check`, `sync`, the level 0 build's `untrusted`; a fixture course of its own with a presentation file | P6-02c, P6-02d | M |
| P6-02f | Publishing the converter: `release.ts` and `package-release.yml` (with the published-version check of P5-AUD14 extended to the image), with their tests, and the user documentation | P6-02e, P5-AUD14 | M |
| P6-02g | PDF decks with overlays: page labels in the pdf.js worker, `derived.steps` from them when the revision has none, the `makePdf` fixture with `/PageLabels`, and the A56 test | P6-02b | S |

Sizes are estimates under the 600-line rule of §0, which splits a unit that passes it. The converter program is split in two now (a and i), since it is over 1,000 changed lines with its fixtures and tests. If another unit passes the target, its first split candidates are: for P6-02c, the level 0 shell and `dataOf` apart from the app viewer; for P6-02d, the fallback of §3.7 and its program lookup apart from the container and the cache; for P6-02e, the level 0 build apart from `check` and `sync`. Every unit with `Security: yes` (P6-02a, P6-02i, P6-02h, P6-02d, P6-02e, P6-02f, P6-02g) gets `/security-review` from its reviewer.

## 12. Open questions, what is left out, and known limits

**For the owner.** None blocks a unit.

1. Uploading a presentation file in the browser editor needs the converter beside the server: a service of the compose files with the policy of §3.6, fed through the worker. It is a later item, as decided.
2. Should a deck offer its original presentation file for download? This design never stores it. Spec §7 allows a presentation file to be attached; the converted PDF is what **Download** gives today.
3. Motion paths could be shown at their end point (the path's last point moves the shape); this design shows the shape where the slide draws it. Worth it if decks with motion paths are common.
4. A slide reached other than by Next, the deck's first opening included, shows its finished state (§6), so a student who opens a deck sees the first slide's builds already applied and steps only from the second slide on. Spec §7 records this; the alternative is to open a deck at the first slide's first step.

**Left out:** a gVisor runtime for the converter's container (the runner's `RUNNER_DOCKER_RUNTIME` is a setting of the runner service, and the tool has none), timing (automatic advance), transitions, sounds, video playback, triggers, zoom and morph transitions, slide masters' own animations, and Keynote's `.key` files (Keynote exports `.pptx`).

**Known limits.** LibreOffice's rendering of a `.pptx` is close to PowerPoint's but not identical: SmartArt uses the picture PowerPoint stores for it, some chart styles and 3D effects are simplified, and a font that is in neither the deck nor the container is replaced (warning `font`). Embedding fonts in PowerPoint (**Save → Embed fonts**) avoids the last. The converter image is large (several hundred megabytes, most of it LibreOffice and the CJK fonts) and is pulled once per machine. **Download** gives the converted PDF, so a slide with three clicks is four pages there, and the PDF carries no alternative text for images (LibreOffice's export is not tagged). At level 0 the presentation file stays in the course folder, so a public repository publishes its hidden slides and speaker notes, whatever the site serves; the user documentation says so.

## 13. What was checked in this session

On LibreOffice 24.2.7 with `python3-uno` and Chromium in the cloud container: the prototype of §3.2 on the two decks described there (frames compared by their text with `pdftotext` and by eye at 30 dpi); the determinism of §3.4 (two conversions identical after the rewrite, `pdftotext` still reads every page); the size check of §3.2; LibreOffice's own SVG export with its slideshow script (it plays the clicks in Chromium, which is the alternative the owner did not choose). The prototype is not in the repository; P6-02a writes the converter from §3 with its tests. The review of this design added the field, link and property rules of §3.2 and the output bounds of §3.3 after reproducing each problem on LibreOffice 24.2.7.2.
