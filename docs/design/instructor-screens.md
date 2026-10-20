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
| Course grants (publisher, owner) | **Course staff** page of a course | `listCourseStaff` (new, §5.2), `setPublisher`, `setOwner` | P6-03f |
| Make a class adopt another release | **Releases** page of a class | `listClassReleases`, `previewAdoption`, `adoptRelease` | P6-03g |
| Set one class's terms for a test | **Terms for this class** on the class's Tests tab | `readAssignment`, `updateAssignment` | P6-03h |

Two server changes come with the screens (§5): `createClass` may make its creator an instructor of the new class, and a course owner can list the course's staff. Everything else is the web application. Every **API only** row of the guide's table then has a screen; §8 names what stays without one.

## 2. Where they sit

- **Courses you teach** (`routes/_authed/courses.index.tsx`): a class card's status row gains **Members** (when the account manages the class's members: `me.classes[].manageMembers`, or owns the course) and **Releases** (when it is an instructor of the class), beside **Class review**.
- **Course editor** (`courses.$courseId.edit.index.tsx`): the side area holds, above **Publication**, a **Classes** panel (§3.2) with **Create class** and each class's links, and, for an owner, a **Course staff** link (§3.6). **Publication** keeps its lines on each class's release ("Spring 2027 uses release 3."), as the wireframe's Publication side shows them (`docs/wireframe.html`, edit topic) and as the tests of `apps/web/src/test/authoring.test.tsx` read them there; the Classes panel does not repeat them.
- **Course and class pages** (new routes, under `_authed`): `/courses/$courseId/staff` (§3.6), `/classes/$classId/members` and `/classes/$classId/releases`, each with the class context line that Class review uses (course · class, spec §2: the cohort name stays visible) and a **Back to courses** link.
- **Accept an invitation** (new route `/invitations/$token`, under `_authed` so that sign-in returns to it, as `/join/$code` does). The token is in the path, as an enrolment code is in a join link; P6-03e keeps it out of the request log and of the stored sign-in destination as #685 does for the join code (`redactUrl` scrubs only `token`, `code` and `state` query parameters today).
- **Topic editor**, Slides section: **Add PDF slides** beside **Add web slides**.
- **Class Tests tab**, instructor view (`assessments/TestsPanel.tsx`): **Terms for this class**, above the accommodations that are there today.

## 3. The screens

### 3.1 PDF slides in the editor (P6-03a)

**Add PDF slides** opens a form like **Add reading**: **File (PDF)**, **Title**, **Accessible alternative** (with the hint that a deck of scanned slides needs one), **Add PDF slides**. It uploads with `uploadCourseFile`, then creates the resource with `createResource` (`type: 'slides_pdf'`, `content: { objectKey }`, `objectKeys: [key]`, the alternative when given). The submit button reads **Uploading…** while it waits, and failures are the sentences the upload already gives (`upload.ts`, `failureMessage`). `fileProblem` gains a kind `slides` that accepts only `.pdf`. The new deck's row shows the processing line it shows today (**Waiting to be processed**, **Processing**, **Processed**, **Processing failed** with **Retry processing**).

A PDF deck's row gains **Edit** *title*, which opens the reading editor's fields that a deck has (`ReadingEditor`: title, visibility, accessible alternative, archive), autosaved with `updateResource` as a reading is. Replacing the PDF is a new upload and a new revision through the same form (**Replace PDF**), so a published deck keeps its revision until the next release.

### 3.2 Classes and Create class (P6-03b)

The **Classes** panel lists the course's classes from `getCourseOverview`, each with its name and the links the account may follow: **Members** (for an owner, or an instructor who manages the class's members), **Releases** (for an instructor of the class) and **Class review** (for an instructor of the class). For an owner who does not teach a class, **Members** is the way to it: such a class has no card under **Courses you teach**. An archived class is listed under **Archived** with its name only. The release each class uses stays in **Publication** (§2).

**Create class** (course owners only, as the route requires) opens a dialog: **Class name** (1 to 120 characters, the route's rule), a checkbox **I teach this class**, checked by default, and **Create class**. With the box checked the request is a membership change and needs a recent sign-in (§5.1); its refusal is handled as §4 says. On success the dialog closes, the panel lists the class, and a status line says **Created Spring 2027.** When **I teach this class** was checked, the class also appears under **Courses you teach**, and the status line adds **You teach it.** A class without a release says so, with the next step: **Adopt a release on the class's Releases page** for a class the account teaches, or **Publish a release first** when the course has none. A name the course already uses, archived classes included, is refused in the dialog (**The course already has a class named Spring 2027.**), since classes are found by name in a site's configuration (`parallax apply` refuses two of one name) and no route renames one; the route itself does not check it.

### 3.3 Members (P6-03c)

`/classes/$classId/members` has three sections, each a table in the review table's style (header row on the secondary surface, the table scrolling inside its own container at 320 px, §4):

- **Instructors**: name, email, **Manages members** (a checkbox, `setManageMembers`) and **Remove**.
- **Students**: name, email and **Remove**. Paginated at 50 in the browser, with a filter by name or email, as a long student list must be (spec §14); `listMembers` answers the whole list, which an open class can make long, and a route with pages is a later item if a class grows past a few thousand.
- **Open invitations** (§3.4).

**Remove** opens the archiving dialog's pattern: title **Remove Ana Silva from Spring 2027?**, a sentence that states the consequence from the route's cascade (`removeMember`): for a student, **They lose access to this class. Their submitted work and grades stay in the class's results.**; for an instructor, also **The instructor invitations they issued and that are still open are revoked**, unless they own the course, and **They stop editing the course's drafts** when they teach no other class of it; then a primary **Remove** and **Cancel**. The table changes only after the server answers. Unchecking **Manages members** confirms in the same way, since it also revokes the open instructor invitations that person issued unless they own the course (`setManageMembers`); the checkbox shows its new state only after the server answers and is disabled while it waits.

### 3.4 Enrolment codes and instructor invitations (P6-03d)

The **Members** page has two actions above **Open invitations**:

- **Create enrolment code** opens a dialog with **Expires** (none, or a date and time, in the browser's zone with the zone named as the accommodations panel names it) and **Uses** (no limit, or a number from 1 to 10 000), then **Create code**.
- **Invite an instructor** opens a dialog with **Email address** and **Expires** (default seven days, at most thirty, the route's rule), then **Create invitation**.

The answer holds the code or the token **once**: the server keeps only its hash. The dialog then shows it and nothing else: for a code, the code (`ABCDE-FGHJK`) and its join link (`<origin>/join/<code>`), for an invitation the link `<origin>/invitations/<token>`, each with **Copy** (which says **Copied** only after the clipboard call resolves) and the sentence **This code is shown once. Copy it now; it cannot be shown again.** (**This link…** for an invitation). Parallax sends no email (spec §12), so the instructor sends the link themselves. Closing the dialog returns focus to the action, and the new invitation is listed.

**Open invitations** lists what `listMembers` returns: kind (**Enrolment code** or **Instructor invitation**), the invited address for an instructor invitation, **Expires**, **Used** (*n* of *max* or *n*), created, and **Revoke**, which confirms in a dialog (**Revoke this enrolment code? Nobody can join with it after this.**). A code's text is not listed, because the server no longer has it.

### 3.5 Accept an invitation (P6-03e)

`/invitations/$token` shows **Accept an instructor invitation** with **Accept invitation**. There is no route that reads an invitation before it is accepted, so the page does not name the class first; on success it says **You now teach Spring 2027 of Reef ecology.** with **Open the course** (to the class's topics) and refreshes the account's contexts (`refreshContexts`), so the class is under **Courses you teach**. `alreadyMember` says **You already teach Spring 2027 of Reef ecology.** Each refusal is a sentence with a way back to **Courses you teach**, as an expired or full class invite must have (spec §4): **This invitation was sent to another address. Sign in with that address to accept it.** (`invite_other_account`), **This invitation does not exist.** (`invite_not_found`), **This invitation was revoked.**, **This invitation has expired. Ask for a new one.**, **This invitation has already been used.** (`invite_full`), **This class is archived.**, **You are a student of this class, so you cannot also teach it.** (`already_member`), and the rate limit's **Too many attempts. Try again in a few minutes.**

### 3.6 Course staff (P6-03f)

`/courses/$courseId/staff`, linked from the course editor's side area for an owner, is a page of its own: the side area's 280 px column cannot hold the list (DESIGN.md: authoring uses a 280 px side area). It lists, from `listCourseStaff` (§5.2), each person who holds a grant on the course, in the review table's style: name, email, **Owner**, **Publisher**, **Edits drafts** (read only: it comes from teaching a class or from being an owner) and the classes they teach. The values are the effective ones of §5.2, so an owner reads as a publisher.

**Owner** and **Publisher** are checkboxes, each changed only after a confirmation dialog that states the consequence (**Make Ana Silva an owner of Reef ecology? Owners can create classes, change every grant and archive the course.**), and each shows its new state only after the server answers. The routes' own rules decide which boxes can change, and the page shows them before a click rather than after a refusal:

- **Publisher** is checked and disabled for an owner, with the note **Owners publish**: `setPublisher` refuses an owner (409 `owner`).
- **Owner** is disabled, with the note **Only someone who edits this course or teaches one of its classes can be an owner**, for a person who does neither (for example one who only publishes): `setOwner` refuses them (409 `not_course_staff`).
- Removing the last owner is refused with **A course needs at least one owner.** (409 `last_owner`); an account that is no longer an owner when its request arrives gets **You are no longer an owner of this course.** (403 `forbidden`), and the page reloads its data.

A person who teaches none of the course's classes and holds no grant is not staff and is not listed.

### 3.7 Releases (P6-03g)

`/classes/$classId/releases` shows **Uses release 3** (or **No release adopted**), then the course's releases, newest first (version, published date). Choosing **Preview changes** on a release shows what `previewAdoption` answers, before anything changes (spec §12: adoption shows changed resources, affected anchors and existing assignments):

- **Added**, **Removed** and **Changed** resources, each with its topic and tab, and for a changed one what changed (**new version**, **title**, **moved to another tab**, **moved to another topic**, **position**, **visibility**, **release date**: one label for each value of `changed[].fields`);
- for each removed or changed resource, **Notes and questions to re-place** (the annotations the instructor can see) and **Started test attempts** (attempts pinned to the earlier version), as counts, with the totals above the lists;
- the sentence **Started tests keep the version they began with. Notes that cannot be placed on the new version are marked Needs reattachment.**

**Adopt release 4** then adopts with `expectedReleaseId` set to the release shown as current. A `release_conflict` (someone adopted meanwhile) reloads the page's data and says **Another instructor changed this class's release. Review the changes again.**; an open class with manually graded tests is refused with **An open class cannot use a release whose tests are graded by an instructor.** Below, **History** lists earlier adoptions (from, to, who, when) from `listClassReleases`. The Releases page needs class instructor membership; the Classes panel links to it only for classes the account teaches.

### 3.8 Terms for this class (P6-03h)

On the class's Tests tab, for an instructor and for each test of the class's release, **Terms for this class** shows the terms in effect (`readAssignment`, `effective`) with the fields of the test editor's **Attempts, timing and release**: attempts, duration, opens and closes, time zone, late submission, results, solutions, reported grade, hidden test details and allowed materials. `SettingsEditor` is private to `TestEditor.tsx` and reads an empty field as inherited, so P6-03h exports it with a mode in which each field shows its effective value. A field, or for `late` and `release` the whole group (the patch replaces those objects whole), that the class sets is marked **Set for this class**, and the others show the test's value. **Save terms** sends only the fields and groups the instructor set for the class, never the effective values shown, so a later change to the test's own terms still reaches the fields the class did not set; it sends them with the revision it read (`expectedRevision`, `null` before the first save) and says **Saved** only after the server answers; **Use the test's terms** clears the class's settings after a confirmation. A 400 shows the server's sentence (**These terms cannot be applied: …**). A `revision_conflict` shows the conflict view of the editor (**Keep my version**, **Use their version**). The form says, as spec §11 does, that a started attempt keeps the terms it began with.

The save is explicit, not autosaved: the route replaces the class's whole set of terms and starts without a revision, and a term saved halfway (an opening time without its closing time) can be refused or can change a running test.

## 4. Rules every screen keeps

- **A sign-in that is not recent.** The member routes, and `createClass` with `teach` (§5.1), need a sign-in in the last 15 minutes; their refusal is a 401 whose `code` is `recent_auth_required`. The screens of §3.2 (with **I teach this class** checked), §3.3, §3.4 and §3.6 read `code`, as `TemplateManager.tsx` does, and say **Changing members needs a recent sign-in. Sign in again, then retry.** with **Sign in again**, which signs out and opens the sign-in page with the current page as its destination (`next`), so the instructor comes back to the same page. What was typed in a dialog is not kept across the sign-in; the dialogs hold a name, an address or a date, so this is accepted rather than stored. Accepting an invitation (§3.5) needs no recent sign-in. The shared **Sign in again** control is new: P6-03b, the first unit that needs it, adds it, and the screens that show the sentence alone today (`TemplateManager.tsx`, `DeviceList.tsx`, `ConnectPanel.tsx`) keep it as it is.
- **Real state only.** A table, a checkbox or a status line changes after the server's answer, never before (CLAUDE.md: never show "Saved" without an acknowledgement). Buttons say what they are doing while they wait (**Creating…**, **Removing…**, **Adopting…**) and are disabled.
- **Refusals are sentences** (`role="alert"`) next to the action that caused them; outcomes are status lines (`role="status"`). There is no toast.
- **Dialogs** are the `Dialog` of `courses/Dialogs.tsx`: focus trapped, Escape closes unless an action is running, focus returns to the opener (spec §14). Destructive actions confirm in one; the primary button repeats the action's name.
- **Archived classes and courses**: a 409 `class_archived` says **This class is archived.**, and `course_archived` **This course is archived.**; the page's data stays as it is, and **Revoke** and **Remove** still work, as their routes allow.
- **Access that ends meanwhile**: a 404 on a page's data, or on an action, shows the application's existing unavailable state (`ClassUnavailable`, `Unavailable` in `components/AccessLost.tsx`), as spec §14 asks when a permission is revoked.
- **Layout and access**: the pages use `.index` width and the review table styles; at 320 px tables scroll in their own containers (DESIGN.md: "Tables scroll inside their own containers") and no control is under 44 × 44 px on a coarse pointer; every control has a label, every table its headers, and each page passes axe in the component tests.

## 5. Server changes

### 5.1 `createClass` may enrol its creator

`createClass` (`packages/contracts/src/routes/members.ts`) gains an optional body field `teach: boolean` (default `false`, so every existing caller is unchanged). With `teach: true` the route first calls `scope.requireRecentAuth()`, as every membership change does (ADR-0002, **Audit**; spec §3: "require authentication again for sensitive membership changes"), and then, in one transaction, creates the class and makes the creator an instructor of it with `ensureInstructor` (`apps/server/src/db/setup.ts`, the function `parallax apply` already uses), under a `ClassManagerScope` resolved for the creator as course owner (`via: 'course_owner'`). It records the audit events both functions record (`class.create`, `membership.add`). A stale sign-in with `teach: true` gets the 401 before any write, so no class is created; without `teach` the route is as today and needs no recent sign-in. The route's scope stays `{ kind: 'course', role: 'owner' }`, so nobody gains a way in they did not have: an owner can already make themselves an instructor of any class of the course by inviting their own address, which needs the same recent sign-in. The response gains `teaching: boolean`.

### 5.2 `listCourseStaff`

`GET /api/courses/:courseId/staff`, registered with `registerRoute`, scope `{ kind: 'course', role: 'owner' }`, with examples, answers `{ staff: [{ userId, name, email, owner, publisher, editor, classes: [{ id, name }] }] }`, where `publisher` and `editor` are the effective grants (`owner || publisher`, `owner || editor`, as `resolveCourse` reads them; `setOwner` writes only `owner` and `editor`): the course's `course_memberships` rows with any grant, joined to the class memberships of the course's classes where the person is an instructor, ordered by name. Only accounts of kind `user` that are not preview accounts are listed, as `listMembers` lists them; a deactivated account that still holds a grant is listed, marked **Deactivated**, with its boxes disabled, since `setOwner` and `setPublisher` answer 404 for it. A non-owner gets 403 and a non-member 404 (ADR-0002). It reads through `forCourse`, so no row of another course is reached.

## 6. Tests

Each screen's component test (Vitest with `stubApi`, `renderApp` and axe, as `test/lifecycle.test.tsx` does) covers its states and refusals, and carries the scenario IDs whose behaviour it shows on a screen:

| Unit | Tests | IDs in their titles |
| --- | --- | --- |
| P6-03a | `apps/web/src/authoring/pdf-slides.test.tsx`: upload, create, the processing line, a refused file, edit and replace | A26 |
| P6-03b | `apps/web/src/authoring/classes.test.tsx` (the dialog, its recent sign-in refusal and **Sign in again**; Publication's class lines unchanged); `apps/server/test/integration/create-class-teach.itest.ts`: a fresh sign-in with `teach` gets the membership and both audit events; a stale sign-in with `teach` gets 401 and leaves no class and no membership; a stale sign-in without `teach` still gets 201; a non-owner is refused | A01, A02 |
| P6-03c | `apps/web/src/members/members.test.tsx`: tables, grant, remove with its dialog, pagination, recent sign-in | A01, A02 |
| P6-03d | `apps/web/src/members/invitations.test.tsx`: the code and the link shown once, copy, revoke, expiry limits | A02 |
| P6-03e | `apps/web/src/members/accept.test.tsx`: success, already a member, each refusal's sentence | A02 |
| P6-03f | `apps/web/src/members/staff.test.tsx` (an owner's **Publisher** checked and disabled, **Owner** disabled for a publisher only, a deactivated account's boxes disabled, each refusal's sentence); `apps/server/test/integration/course-staff.itest.ts`: the list with effective grants, 403 and 404, preview accounts left out, no person or class of another course | A01 |
| P6-03g | `apps/web/src/releases/releases.test.tsx`: preview, adopt, conflict, open-class refusal, history | A16, A26 |
| P6-03h | `apps/web/src/assessments/class-terms.test.tsx`: effective terms, save with revision, conflict, invalid terms, reset | A16 |

`e2e/tests/a02-instructor-screens.e2e.ts` (P6-03e) walks the whole path in the browser: an owner creates a class teaching it, invites an instructor, the invited account accepts by the link, the owner issues an enrolment code, a student joins with it, the instructor adopts a release, and the class's topics show it. `e2e/tests/a20-touch-targets.e2e.ts` gains the new pages (P6-03g). No scenario is added to spec §16: these are screens for scenarios that exist.

## 7. Units

| Unit | Scope | Depends on | Size |
| --- | --- | --- | --- |
| P6-03a | §3.1 | none | M |
| P6-03b | §3.2 and §5.1 | none | M |
| P6-03c | §3.3, its route, the **Members** links on course cards and in the Classes panel | P6-03b | M |
| P6-03d | §3.4 | P6-03c | M |
| P6-03e | §3.5 and the end-to-end path of §6 | P6-03b, P6-03d, P6-03g | M |
| P6-03f | §3.6, its route and link, and §5.2 | P6-03b | M |
| P6-03g | §3.7, its route and link | P6-03c | M |
| P6-03h | §3.8 | none | M |

P6-03b and P6-03f change routes, and P6-03d and P6-03e handle the code and the invitation token (`Security: yes` for all four); the others change the web application only. P6-03c, P6-03f and P6-03g are near the 600-line target of plan §0, which splits a unit that passes it; their first candidates are the student table's pagination and filter (c), the page's refusal states and their test cases (f), and the history list (g). The guide's **What you can do on a screen** table and its sections are updated by the unit that adds each screen.

## 8. Left out and open questions

**For the owner.**

1. Should **I teach this class** be checked by default? This design says yes: the class an owner creates is nearly always one they teach, and the course editor's preview needs a class the owner teaches.
2. Opening a class to anyone with the link (`setClassOpen`) has a route and is set by `parallax apply` on a site, which sets it back on its next run. This design gives it no screen, so a site's configuration stays the one place it is set. A screen is a small later item if wanted for installations without a site configuration.

**Left out:** publishing for a publisher who does not edit the course (the guide notes that such a person publishes through the API only; making the course editor reachable to them is a later item), sending invitations by email (spec §12 assumes no email), invitations for several addresses at once, importing a class list, and moving a student between classes.
