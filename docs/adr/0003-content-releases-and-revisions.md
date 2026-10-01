# ADR 0003 — Content releases, resource revisions and annotation anchors

**Status:** Accepted, 2026-09-30

## Context

A course holds reusable material; a class pins one immutable release (§1, §12, §13). Drafts autosave with revision-conflict detection; publication validates and snapshots; adoption shows changed resources and affected anchors; started tests stay pinned to their original question and grader revisions; removing a resource never deletes work submitted against it (§12). Annotations record the resource revision and a stable anchor; a new revision maps marks confidently or shows **Needs reattachment** with the original context (§8, A06). Slides remember position per deck revision and preserve old annotations until mapped (§7). Study positions are keyed by resource revision (§13).

## Decision

**Drafts are mutable, revisions and releases are immutable.**

- `topics` and `resources` are draft rows owned by a course. Each has an integer `revision` used for optimistic checks: mutations send `expectedRevision`; a mismatch returns 409 with the server copy so the editor can show a conflict view rather than overwrite (§12).
- Every content change to a resource inserts a `resource_revisions` row: `id`, `resource_id`, `type` (slides_pdf, slides_web, reading_native, reading_pdf, exercise, notebook, shiny, test), `content` (JSON: type-specific definition; for native readings the Markdown or HTML source, inline or as an uploaded object, and its image names; for tests the questions **including hidden checks**), `object_keys` (storage objects, content-addressed `courses/{courseId}/objects/{sha256}`), `derived` (conversion outputs and their `status`; for a native reading the sanitised `html`, `blockMap` and `figures`, for a PDF reading `pageCount` and `pages`, all written by the `reading.ingest` job), `accessible_alternative`, `provenance`, `content_hash`, `created_by`, `created_at`. `resources.head_revision_id` points at the newest. Revisions are never updated except `derived` (written by conversion jobs) and are never deleted while referenced.
- `course_releases` (`course_id`, `version` sequential per course, `created_by`, `validation_report`, `created_at`) with child tables `release_topics` (order, title, objective, prerequisites, completion rule, estimated time) and `release_resources` (`release_topic_id`, `resource_id`, `resource_revision_id`, tab, order, visibility, release date). A database trigger rejects `UPDATE`/`DELETE` on these three tables; archiving a release is a column on `courses`-level history, not a row change.
- `classes.release_id` is the adopted release; `class_release_history` records every adoption (actor, from, to, diff summary). Adoption diff = join of the two releases' `release_resources` by `resource_id`: added, removed, changed revision; plus counts of annotations and assignments referencing changed or removed revisions.
- `assignments` reference `release_resource_id` and `resource_revision_id`; `test_attempts` copy `question_revision_id` and `grader_version` at start, so later releases cannot alter an attempt (A16).
- Reads for a class always go `class → release → release_resources → resource_revisions`; class routes never see draft rows (A26). Instructor preview reads a draft snapshot through the preview principal (ADR-0002) and the `course` scope.

**Publication** runs a validation report (broken references, missing accessible alternatives or transcripts, invalid grading rules, execution configuration outside server bounds, unconverted decks). Errors block; warnings are stored in the report. Publishing is an explicit `course:publisher` action recorded in `audit_events`.

**Anchors** are JSON values with a `kind` discriminator, validated by zod in `packages/contracts/src/anchors.ts`:

| kind | fields | produced by |
| --- | --- | --- |
| `text` | `blockId`, `start`, `end` (code-unit offsets in the block's text content), `quote`, `prefix`, `suffix` (≤ 32 chars each) | native readings, web slides |
| `pdf` | `page` (0-based), `rect` `{x,y,w,h}` normalised 0..1, optional `quote`, optional `strokes` (sketch on the page) | PDF readings and decks |
| `slide` | `page` | slide notes/discussion |
| `figure` | `figureId`, `strokes` (drawing) | sketches on native figures |
| `none` | — | general topic notes |

Reading ingestion (ADR-0001 pipeline) assigns every block element a stable `blockId` = first 12 hex of `sha256(normalisedText + ':' + occurrenceIndex)` recorded in `derived.blockMap`; unchanged paragraphs keep their id across revisions. A block whose text lies entirely in nested blocks (a blockquote or loose list item wrapping paragraphs) only wraps them and gets no id, so it never takes an occurrence from the paragraph it repeats. Zoom, reflow and Focus never touch anchors because anchors reference blocks and normalised page space, not pixels.

**Placement per revision.** `annotations` store the original `resource_revision_id` and `anchor`. `annotation_placements` (`annotation_id`, `resource_revision_id`, `anchor`, `status` ∈ mapped | needs_reattachment | manual, `confidence`) hold the anchor for each revision a class actually uses. When a class adopts a release with a changed revision, a job maps each annotation: exact `blockId` + quote match → `mapped` (1.0); else quote with prefix/suffix search across blocks, accepting a unique match with normalised similarity ≥ 0.9 → `mapped` with that confidence; else `needs_reattachment` retaining the original quote and context. PDF anchors map when the page count and page text hash match, otherwise need reattachment. Instructors can set `manual` placements; students see the original quote until then (A06).

**Study positions** (`user_id`, `class_id`, `resource_revision_id`, tab, position JSON, layout) are upserted per resource revision; a new revision starts from the mapped block when available.

## Consequences

- Storage grows with every draft edit; objects are content-addressed so unchanged files are not duplicated, and a later retention job can prune unreferenced draft revisions.
- Hidden test content lives in revisions; student-facing contracts use response schemas without those fields (structural, tested in P3-16).
- Anchor mapping is heuristic; the threshold is a constant in one module with unit fixtures so it can be tuned.
- The immutability trigger makes mistakes loud: fixing a published typo means a new release, as the spec intends.

## Alternatives considered

- **Mutable releases with "last modified" stamps**: violates A16/A26 and makes anchors ambiguous.
- **Copy-on-publish of every file**: unnecessary with content addressing.
- **Character-offset anchors on the whole document**: break on any edit; block ids plus quote context are the standard (Hypothesis-style) approach.
- **Storing anchors only once and remapping on read**: too slow and non-deterministic; per-revision placements are explicit and auditable.
