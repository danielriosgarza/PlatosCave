# Screens for the instructor tasks that are API-only: detailed design (P6-03)

**Status:** proposed in P6-03, 2026-10-20; accepted with its merge. Owner request of 2026-10-20 ([plan](../delivery/plan.md) §10): every row of the [instructor guide](../guide/instructors.md)'s table that reads **API only** gets a screen. The tasks themselves exist: each has its route, its scope and its tests, and the specification already describes them (§3 permissions and invitations, §11 a class's terms for a test, §12 creating classes and adopting releases). What is missing is where an instructor does them. Items P6-03a to P6-03h in the plan implement this design and take their tests from §6. Nothing in it is built yet.

The [wireframe](../wireframe.html) has none of these screens, so they are built from the components that the application already has for the same kinds of task: the dialog of **Create course** and of archiving (`courses/Dialogs.tsx`, `courses/Lifecycle.tsx`), the preview-then-confirm of **Release feedback** (`review/BulkRelease.tsx`), the review table (`review/ClassReview.module.css`), the side panel of the course editor (`authoring/PublishPanel.tsx`), the test terms form (`authoring/TestEditor.tsx`, `SettingsEditor`) and the upload form of a reading (`authoring/AddReading.tsx`), with the tokens of `packages/ui/src/tokens.css` and the rules of [DESIGN.md](../../DESIGN.md).

## 1. What changes

| Task (guide) | Screen | Routes it calls | Unit |
| --- | --- | --- | --- |
| Add a PDF slide deck | **Add PDF slides** in a topic's Slides section, and an edit form for a PDF deck | `uploadCourseFile`, `createResource`, `updateResource` | P6-03a |
| Create a class | **Classes** panel of the course editor, **Create class** dialog | `createClass` (§5.1 adds `teach`) | P6-03b |
| List, remove or change members and grants | **Members** page of a class | `listMembers`, `removeMember`, `setManageMembers` | P6-03c |
| Issue enrolment codes and instructor invitations | **Members** page: **Create enrolment code**, **Invite an instructor**, **Revoke** | `createInvite`, `revokeInvite` | P6-03d |
| Accept an instructor invitation | **Accept an invitation** page at `/invitations/<token>` | `acceptInvitation` | P6-03e |
| Course grants (publisher, owner) | **Course staff** section of the course editor | `listCourseStaff` (new, §5.2), `setPublisher`, `setOwner` | P6-03f |
| Make a class adopt another release | **Releases** page of a class | `listClassReleases`, `previewAdoption`, `adoptRelease` | P6-03g |
| Set one class's terms for a test | **Terms for this class** on the class's Tests tab | `readAssignment`, `updateAssignment` | P6-03h |

Two server changes come with the screens (§5): `createClass` may make its creator an instructor of the new class, and a course owner can list the course's staff. Everything else is the web application. The guide's table then lists no **API only** row except the one §8 leaves out.

## 2. Where they sit

- **Courses you teach** (`routes/_authed/courses.index.tsx`): a class card's status row gains **Members** (when the account manages the class's members: `me.classes[].manageMembers`, or owns the course) and **Releases** (when it is an instructor of the class), beside **Class review**.
- **Course editor** (`courses.$courseId.edit.index.tsx`): the side area holds, above **Publication**, a **Classes** panel (§3.2) and, for an owner, a **Course staff** section (§3.6). Its class list, today inside `PublishPanel`, moves into the Classes panel with each class's release and its links.
- **Class pages** (new routes, under `_authed`): `/classes/$classId/members` and `/classes/$classId/releases`, each with the class context line that Class review uses (course · class, spec §2: the cohort name stays visible) and a **Back to courses** link.
- **Accept an invitation** (new route `/invitations/$token`, under `_authed` so that sign-in returns to it, as `/join/$code` does).
- **Topic editor**, Slides section: **Add PDF slides** beside **Add web slides**.
- **Class Tests tab**, instructor view (`assessments/TestsPanel.tsx`): **Terms for this class**, above the accommodations that are there today.

## 3. The screens

### 3.1 PDF slides in the editor (P6-03a)

**Add PDF slides** opens a form like **Add reading**: **File (PDF)**, **Title**, **Accessible alternative** (with the hint that a deck of scanned slides needs one), **Add PDF slides**. It uploads with `uploadCourseFile`, then creates the resource with `createResource` (`type: 'slides_pdf'`, `content: { objectKey }`, `objectKeys: [key]`, the alternative when given). The submit button reads **Uploading…** while it waits, and failures are the sentences the upload already gives (`upload.ts`, `failureMessage`). `fileProblem` gains a kind `slides` that accepts only `.pdf`. The new deck's row shows the processing line it shows today (**Waiting to be processed**, **Processing**, **Processed**, **Processing failed** with **Retry processing**).

A PDF deck's row gains **Edit** *title*, which opens the reading editor's fields that a deck has (`ReadingEditor`: title, visibility, accessible alternative, archive), autosaved with `updateResource` as a reading is. Replacing the PDF is a new upload and a new revision through the same form (**Replace PDF**), so a published deck keeps its revision until the next release.

### 3.2 Classes and Create class (P6-03b)

The **Classes** panel lists the course's classes from `getCourseOverview`: the class's name, its release (**Uses release 3** or **No release adopted**), and the links the account may follow (**Members**, **Releases**, **Class review**). An archived class is listed under **Archived** with its name only.

**Create class** (course owners only, as the route requires) opens a dialog: **Class name** (1 to 120 characters, the route's rule), a checkbox **I teach this class**, checked by default, and **Create class**. On success the dialog closes, the panel lists the class, and a status line says **Created Spring 2027.** When **I teach this class** was checked, the class also appears under **Courses you teach**, and the status line adds **You teach it.** A class without a release says so, with the next step: **Adopt a release on the class's Releases page** (or **Publish a release first** when the course has none).

### 3.3 Members (P6-03c)

`/classes/$classId/members` has three sections, each a table in the review table's style (header row on the secondary surface, the table scrolling inside its own container at 320 px, spec §14):

- **Instructors**: name, email, **Manages members** (a checkbox, `setManageMembers`) and **Remove**.
- **Students**: name, email and **Remove**. Paginated at 50, with a filter by name or email, as a long student list must be (spec §14).
- **Open invitations** (§3.4).

**Remove** opens the archiving dialog's pattern: title **Remove Ana Silva from Spring 2027?**, a sentence that states the consequence from the route's cascade (**They lose access to this class. Their submitted work and grades stay in the class's results.** for a student; for an instructor, also **Their open instructor invitations are revoked.**), a primary **Remove** and **Cancel**. The table changes only after the server answers. The grant checkbox shows its new state only after the server answers too, and is disabled while it waits.

### 3.4 Enrolment codes and instructor invitations (P6-03d)

The **Members** page has two actions above **Open invitations**:

- **Create enrolment code** opens a dialog with **Expires** (none, or a date and time, in the browser's zone with the zone named as the accommodations panel names it) and **Uses** (no limit, or a number from 1 to 10 000), then **Create code**.
- **Invite an instructor** opens a dialog with **Email address** and **Expires** (default seven days, at most thirty, the route's rule), then **Create invitation**.

The answer holds the code or the token **once**: the server keeps only its hash. The dialog then shows it and nothing else: for a code, the code (`ABCDE-FGHJK`) and its join link (`<origin>/join/<code>`), for an invitation the link `<origin>/invitations/<token>`, each with **Copy** (which says **Copied** only after the clipboard call resolves) and the sentence **This code is shown once. Copy it now; it cannot be shown again.** (**This link…** for an invitation). Parallax sends no email (spec §12), so the instructor sends the link themselves. Closing the dialog returns focus to the action, and the new invitation is listed.

**Open invitations** lists what `listMembers` returns: kind (**Enrolment code** or **Instructor invitation**), the invited address for an instructor invitation, **Expires**, **Used** (*n* of *max* or *n*), created, and **Revoke**, which confirms in a dialog (**Revoke this enrolment code? Nobody can join with it after this.**). A code's text is not listed, because the server no longer has it.

### 3.5 Accept an invitation (P6-03e)

`/invitations/$token` shows **Accept an instructor invitation** with **Accept invitation**. There is no route that reads an invitation before it is accepted, so the page does not name the class first; on success it says **You now teach Spring 2027 of Reef ecology.** with **Open the course** (to the class's topics) and refreshes the account's contexts (`refreshContexts`), so the class is under **Courses you teach**. `alreadyMember` says **You already teach Spring 2027 of Reef ecology.** Each refusal is a sentence with a way back to **Courses you teach**, as an expired or full class invite must have (spec §4): **This invitation was sent to another address. Sign in with that address to accept it.** (`invite_other_account`), **This invitation does not exist.** (`invite_not_found`), **This invitation was revoked.**, **This invitation has expired. Ask for a new one.**, **This invitation has already been used.** (`invite_full`), **This class is archived.**, **You are a student of this class, so you cannot also teach it.** (`already_member`), and the rate limit's **Too many attempts. Try again in a few minutes.**

### 3.6 Course staff (P6-03f)

For a course owner, the course editor's **Course staff** section lists the people who hold a grant on the course (§5.2): name, email, **Owner**, **Publisher**, **Edits drafts** (read only: it comes from teaching a class), and the classes they teach. **Owner** and **Publisher** are checkboxes (`setOwner`, `setPublisher`), each changed only after a confirmation dialog that states the consequence (**Make Ana Silva an owner of Reef ecology? Owners can create classes, change every grant and archive the course.**; removing the last owner is refused by the server with **A course needs at least one owner.**). A person who teaches none of the course's classes and holds no grant is not staff and is not listed.

### 3.7 Releases (P6-03g)

`/classes/$classId/releases` shows **Uses release 3** (or **No release adopted**), then the course's releases, newest first (version, published date). Choosing **Preview changes** on a release shows what `previewAdoption` answers, before anything changes (spec §12: adoption shows changed resources, affected anchors and existing assignments):

- **Added**, **Removed** and **Changed** resources, each with its topic and tab, and for a changed one what changed (**new version**, **title**, **moved to another topic**, **position**, **visibility**, **release date**);
- for each removed or changed resource, **Notes and questions to re-place** (the annotations the instructor can see) and **Started test attempts** (attempts pinned to the earlier version), as counts, with the totals above the lists;
- the sentence **Started tests keep the version they began with. Notes that cannot be placed on the new version are marked Needs reattachment.**

**Adopt release 4** then adopts with `expectedReleaseId` set to the release shown as current. A `release_conflict` (someone adopted meanwhile) reloads the page's data and says **Another instructor changed this class's release. Review the changes again.**; an open class with manually graded tests is refused with **An open class cannot use a release whose tests are graded by an instructor.** Below, **History** lists earlier adoptions (from, to, who, when) from `listClassReleases`. The Releases page needs class instructor membership; the Classes panel links to it only for classes the account teaches.

### 3.8 Terms for this class (P6-03h)

On the class's Tests tab, for an instructor and for each test of the class's release, **Terms for this class** shows the terms in effect (`readAssignment`, `effective`) with the fields of the test editor's **Attempts, timing and release** (`SettingsEditor`): attempts, duration, opens and closes, time zone, late submission, results, solutions, reported grade, hidden test details and allowed materials. A field the class sets is marked **Set for this class**; the others show the test's value. **Save terms** sends the class's settings with the revision it read (`expectedRevision`, `null` before the first save) and says **Saved** only after the server answers; **Use the test's terms** clears the class's settings after a confirmation. A 400 shows the server's sentence (**These terms cannot be applied: …**). A `revision_conflict` shows the conflict view of the editor (**Keep my version**, **Use their version**). The form says, as spec §11 does, that a started attempt keeps the terms it began with.

The save is explicit, not autosaved: the route replaces the class's whole set of terms and starts without a revision, and a term saved halfway (an opening time without its closing time) can be refused or can change a running test.

## 4. Rules every screen keeps

- **A sign-in that is not recent.** The member routes need a sign-in in the last 15 minutes; their refusal is a 401 whose `code` is `recent_auth_required`. Every screen of §3.3 to §3.6 reads `code`, as `TemplateManager.tsx` does, and says **Changing members needs a recent sign-in. Sign in again, then retry.** with **Sign in again**, which signs out and returns to the same page after sign-in. The form keeps what was typed.
- **Real state only.** A table, a checkbox or a status line changes after the server's answer, never before (CLAUDE.md: never show "Saved" without an acknowledgement). Buttons say what they are doing while they wait (**Creating…**, **Removing…**, **Adopting…**) and are disabled.
- **Refusals are sentences** (`role="alert"`) next to the action that caused them; outcomes are status lines (`role="status"`). There is no toast.
- **Dialogs** are the `Dialog` of `courses/Dialogs.tsx`: focus trapped, Escape closes unless an action is running, focus returns to the opener (spec §14). Destructive actions confirm in one; the primary button repeats the action's name.
- **Archived classes**: a 409 `class_archived` says **This class is archived.** and leaves the page's data as it is; **Revoke** and **Remove** still work, as their routes allow.
- **Layout and access**: the pages use `.index` width and the review table styles; at 320 px tables scroll in their containers and no control is under 44 × 44 px on a coarse pointer; every control has a label, every table its headers, and each page passes axe in the component tests.

## 5. Server changes

### 5.1 `createClass` may enrol its creator

`createClass` (`packages/contracts/src/routes/members.ts`) gains an optional body field `teach: boolean` (default `false`, so every existing caller is unchanged). With `teach: true` the route creates the class and then, in the same transaction, makes the creator an instructor of it with `ensureInstructor` (`apps/server/src/db/setup.ts`, the function `parallax apply` already uses), under a `ClassManagerScope` resolved for the creator as course owner (`via: 'course_owner'`). It records the audit events both functions record (`class.create`, `membership.add`). The route's scope stays `{ kind: 'course', role: 'owner' }`, so nobody gains a way in they did not have: an owner can already make themselves an instructor of any class of the course through an invitation to their own address. The response gains `teaching: boolean`.

### 5.2 `listCourseStaff`

`GET /api/courses/:courseId/staff`, registered with `registerRoute`, scope `{ kind: 'course', role: 'owner' }`, with examples, answers `{ staff: [{ userId, name, email, owner, publisher, editor, classes: [{ id, name }] }] }`: the course's `course_memberships` rows with any grant, joined to the class memberships of the course's classes where the person is an instructor, ordered by name; preview accounts are left out, as `listMembers` leaves them out. A non-owner gets 403 and a non-member 404 (ADR-0002). It reads through `forCourse`.

## 6. Tests

Each screen's component test (Vitest with `stubApi`, `renderApp` and axe, as `test/lifecycle.test.tsx` does) covers its states and refusals, and carries the scenario IDs whose behaviour it shows on a screen:

| Unit | Tests | IDs in their titles |
| --- | --- | --- |
| P6-03a | `apps/web/src/authoring/pdf-slides.test.tsx`: upload, create, the processing line, a refused file, edit and replace | A26 |
| P6-03b | `apps/web/src/authoring/classes.test.tsx`; `apps/server/test/integration/create-class-teach.itest.ts`: `teach` adds the instructor membership and the audit events; without it nothing changes; a non-owner is refused | A01, A02 |
| P6-03c | `apps/web/src/members/members.test.tsx`: tables, grant, remove with its dialog, pagination, recent sign-in | A01, A02 |
| P6-03d | `apps/web/src/members/invitations.test.tsx`: the code and the link shown once, copy, revoke, expiry limits | A02 |
| P6-03e | `apps/web/src/members/accept.test.tsx`: success, already a member, each refusal's sentence | A02 |
| P6-03f | `apps/web/src/members/staff.test.tsx`; `apps/server/test/integration/course-staff.itest.ts`: the list, 403 and 404, preview accounts left out | A01 |
| P6-03g | `apps/web/src/releases/releases.test.tsx`: preview, adopt, conflict, open-class refusal, history | A16, A26 |
| P6-03h | `apps/web/src/assessments/class-terms.test.tsx`: effective terms, save with revision, conflict, invalid terms, reset | A16 |

`e2e/tests/a02-instructor-screens.e2e.ts` (P6-03e) walks the whole path in the browser: an owner creates a class teaching it, invites an instructor, the invited account accepts by the link, the owner issues an enrolment code, a student joins with it, the instructor adopts a release, and the class's topics show it. `e2e/tests/a20-touch-targets.e2e.ts` gains the new pages (P6-03g). No scenario is added to spec §16: these are screens for scenarios that exist.

## 7. Units

| Unit | Scope | Depends on | Size |
| --- | --- | --- | --- |
| P6-03a | §3.1 | none | M |
| P6-03b | §3.2 and §5.1 | none | M |
| P6-03c | §3.3, the class pages' route and the course card links | none | M |
| P6-03d | §3.4 | P6-03c | M |
| P6-03e | §3.5 and the end-to-end path of §6 | P6-03b, P6-03d, P6-03g | M |
| P6-03f | §3.6 and §5.2 | P6-03b | M |
| P6-03g | §3.7, its route and link | P6-03c | M |
| P6-03h | §3.8 | none | M |

P6-03b and P6-03f change routes (`Security: yes`); the others change the web application only. The guide's **What you can do on a screen** table and its sections are updated by the unit that adds each screen.

## 8. Left out and open questions

**For the owner.**

1. Should **I teach this class** be checked by default? This design says yes: the class an owner creates is nearly always one they teach, and the course editor's preview needs a class the owner teaches.
2. Opening a class to anyone with the link (`setClassOpen`) has a route and is set by `parallax apply` on a site, which sets it back on its next run. This design gives it no screen, so a site's configuration stays the one place it is set. A screen is a small later item if wanted for installations without a site configuration.

**Left out:** sending invitations by email (spec §12 assumes no email), invitations for several addresses at once, importing a class list, and moving a student between classes.
