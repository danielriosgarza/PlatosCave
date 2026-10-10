# Instructor guide

This guide covers what an instructor can do in Parallax today. It lists only what is built. Where a task has an API but no screen yet, the guide says so and names the route.

For installing and starting the app, see [getting-started.md](../getting-started.md). For the full rules, see the [product specification](../product-spec.md).

## What you can do on a screen, and what is API-only

| Task | Today |
| --- | --- |
| Create a course | Screen: **Create course** |
| Add, reorder and archive topics | Screen: course editor |
| Author slides, readings, exercises, notebooks, Shiny apps and tests | Screen: topic editor |
| Publish a release | Screen: **Publish release** |
| Preview the draft as a student | Screen: **Preview student view** |
| Review work, grade, release feedback | Screen: **Class review** |
| Export class results | Screen: **Export results (CSV)** |
| Archive and restore a class or course | Screen: cards on **Courses you teach** |
| Add a PDF slide deck | API only |
| Set one class's terms for a test (dates, attempts, release) | API only |
| Create a class | API only |
| Issue enrolment codes and instructor invitations | API only |
| Accept an instructor invitation | API only |
| List, remove or change members and grants | API only |
| Make a class adopt another release | API only |

There is no screen yet for the API-only rows. The routes named in this guide are defined in `packages/contracts/src/routes/`. A development server also serves them as `/api/openapi.json`; a production server does not.

## Becoming an instructor

There is no separate instructor account. The same account can be a student and an instructor ([spec §3](../product-spec.md#3-sign-in-and-permissions)).

An account can create courses in one of two ways.

1. Its email address is listed in the `INSTRUCTOR_EMAILS` setting. The operator sets this when the server starts. It holds comma-separated addresses, trimmed and compared without regard to case. See `.env.example`.
2. The account already teaches something: it is an instructor of a class, or it holds any permission on a course (owner, editor or publisher).

Signing in through **Instructor sign in** does not grant anything. If your account has no instructor access, **Courses you teach** says **This account has no instructor access**. Ask the operator to add your email to `INSTRUCTOR_EMAILS`. Or ask a course owner, or an instructor who manages a class's members, to issue you an instructor invitation, as described under [Inviting people](#inviting-people-and-managing-members). There is no screen for accepting one.

Sign in with your email address. Choose **Send sign-in link** and open the link you receive.

If you also study in a class, **Student view** and **Instructor view** switch between the two contexts.

## Creating a course

1. Open **Courses you teach**.
2. Choose **Create course**.
3. Enter the **Course title**, then choose **Create course**.

The page then says the course was created and that you own it. You can edit the course from its card under **Courses**.

Each course card shows your permission. A person can hold one or more of these:

| Permission | Shown as | Allows | How someone gets it |
| --- | --- | --- | --- |
| Owner | **Owner** | Everything below, plus archiving the course and creating classes | The creator of the course. Another owner can grant it with `PUT /api/courses/{courseId}/members/{userId}/owner`, to a person who teaches a class of the course or holds draft editing |
| Editor | **Editor** | Edit course drafts | By accepting an instructor invitation to a class of the course. Owners hold it too. For anyone who is not an owner, it ends when the person teaches no class of the course |
| Publisher | **Publisher** | Publish releases | An owner grants it with `PUT /api/courses/{courseId}/members/{userId}/publisher`. The course editor opens only for an owner or an editor, so on a screen a publisher can publish only if they are also an editor |

A person can hold **Editor and publisher**. See the table in [spec §3](../product-spec.md#3-sign-in-and-permissions).

## Creating a class

A class is one cohort of a course. It has its own members, release and results.

There is no screen for this yet. Send `POST /api/courses/{courseId}/classes` with the body `{ "name": "Spring 2027" }`. Only a course owner may do this. The new class has not adopted a release (see [Releases](#publishing-and-releases)).

## Inviting people and managing members

There is no screen for any of this yet. Unless a row says otherwise, these routes are for the course owner or an instructor with the membership-management grant.

Issue a code or an invitation with `POST /api/classes/{classId}/invites`. This needs a recent sign-in. The code is returned once and cannot be read again.

- Student enrolment code. Body: `{ "kind": "enrolment" }`. You may add `expiresAt` and `maxUses` (1 to 10000). Students enter the code under **Join a class** in the **Invitation code** field. A code only ever creates student memberships.
- Instructor invitation. Body: `{ "kind": "instructor", "email": "..." }`. It is for one email address and works once. It expires after seven days unless you set `expiresAt`, and never later than 30 days. Parallax does not email it. The response has a `code`; hand that code to the invitee yourself. The invitee, signed in with that email address, sends it as `token` to `POST /api/invitations/accept` with the body `{ "token": "..." }`. Any signed-in user may call that route, but only the account with the invited email address can use the code. It gives the class instructor role and course draft editing.

Other routes:

| Task | Route | Notes |
| --- | --- | --- |
| List members and open invitations | `GET /api/classes/{classId}/members` | |
| Revoke a code or invitation | `DELETE /api/classes/{classId}/invites/{inviteId}` | Needs a recent sign-in |
| Remove a student or instructor | `DELETE /api/classes/{classId}/members/{userId}` | Needs a recent sign-in |
| Grant or revoke membership management | `PUT /api/classes/{classId}/members/{userId}/manage-members` with `{ "granted": true }` | Needs a recent sign-in. For instructors only |
| Grant or revoke publishing | `PUT /api/courses/{courseId}/members/{userId}/publisher` with `{ "granted": true }` | Owner only. Needs a recent sign-in |
| Grant or withdraw ownership | `PUT /api/courses/{courseId}/members/{userId}/owner` with `{ "granted": true }` | Owner only. Needs a recent sign-in |

A removed student's work stays visible in review, grading and the results export. Once you choose a test under **Assignment**, Class review lists removed students who submitted an attempt for it under **Removed students**.

Students can join with a code. They cannot become instructors that way.

## Authoring material

Open **Courses you teach**, then the course card. The editor lists the **Topics** and shows a **Publication** panel.

Edits change the course draft only. Classes keep the release they use until they adopt another. Drafts autosave and show the save state. If another editor changed the same item, you get a conflict view and nothing is overwritten silently ([spec §12](../product-spec.md#12-instructor-workflow)).

### Topics

- Enter a name under **New topic title** and choose **Add topic**.
- Use **Earlier** and **Later** to reorder topics.
- Use **Archive** *topic name* and **Restore** *topic name* to hide or bring back a topic.
- Choose a topic title to open **Edit topic**.

In **Edit topic** you set the **Title**, **Learning objective** and **Estimated study time (minutes)** (a whole number). You can also choose **Prerequisites** and a **Completion rule**:

- All ungraded material reviewed and graded work submitted.
- Only the requirements I choose.

Below the topic form, **Resources** has one section for each tab students see: **Slides**, **Reading**, **Exercises**, **Notebooks** and **Tests**. Each resource shows its type and whether it is **Visible to students** or **Hidden from students**. Choose **Edit** *resource title* to change it.

Readings, web slides, Shiny apps, exercises and tests open an edit form with a title and a **Visibility** setting. The form also has a button to archive or restore the resource:

| Resource | Archive button | Restore button |
| --- | --- | --- |
| Reading | **Archive this reading** | **Restore this reading** |
| Web slides | **Archive these slides** | **Restore these slides** |
| Shiny app | **Archive this Shiny app** | **Restore this Shiny app** |
| Exercise | **Archive this exercise** | **Restore this exercise** |
| Test | **Archive this test** | **Restore this test** |

Notebooks and PDF slides have no edit form. A notebook only offers **Workspace files of** *notebook title*.

### Slides

Only web slides can be added on a screen.

1. Under **Slides**, choose **Add web slides**.
2. Enter the **Title** and the **Slides (Markdown)** text.
3. Choose **Add web slides**.

A line holding only `---` (or `***` or `___`) starts the next slide. Images are not shown, so describe diagrams in text. See [spec §7](../product-spec.md#7-slides).

A PDF slide deck is listed under **Slides** as **PDF slides**. Its processing state reads **Processed** when it is done. There is no screen for adding one. Upload the PDF to `POST /api/courses/{courseId}/uploads`, then create the resource with `POST /api/courses/{courseId}/topics/{topicId}/resources` and the type `slides_pdf`. The route contracts give the exact bodies.

### Reading

Under **Reading**, choose **Add reading**.

1. Choose a **File (Markdown, HTML or PDF)**. The file must not be empty and at most 25 MB.
2. Enter a **Title**.
3. Fill in **Accessible alternative** when readers need text instead of the file. A scanned PDF is the usual case.
4. Choose **Add reading**.

A Markdown or HTML file becomes a native reading. A PDF becomes a **PDF reading**. Processing shows one of **Waiting to be processed**, **Processing**, **Ready to publish**, **Processing failed** or **Not processed yet**. If it fails, use **Retry processing**. See [spec §8](../product-spec.md#8-reading-notes-highlights-drawings-comments-and-questions).

### Exercises

1. Under **Exercises**, choose **Add exercise**, enter **New exercise title** and choose **Create exercise**.
2. Choose **Edit** *exercise title*.
3. Set **Exercise title** and **Visibility**.
4. Under **Credit**, leave **Points (leave empty for ungraded practice)** empty for practice. If you enter points, choose a **Hint policy**:
   - Hints do not change the credit.
   - Each step solved with hints earns reduced credit.
   - A step solved with hints earns no credit.
5. Pick a **Step type** and choose **Add step**. The types are **Numeric answer**, **Single choice**, **Multiple choice**, **Ordering**, **Matching**, **Explanation**, **Simulation control** and **Code task**.

An exercise has up to 20 steps. It cannot be published until it has a valid definition. The editor lists what to fix. See [spec §9](../product-spec.md#9-interactive-exercises).

### Notebooks, Shiny and Colab

Under **Notebooks** you can add two kinds of resource.

**Add notebook**

1. Choose a **File (Jupyter notebook)**. It must be an `.ipynb` file.
2. Enter a **Title**.
3. Under **Workspace files**, use **Add data files** for data that is copied into a learner's workspace when they connect.
4. Choose **Add notebook**.

You can review the declared files later with **Workspace files of** *notebook title*. A notebook is never run on upload.

**Add Shiny app**

1. Enter a **Title** and the **Address** of the running app.
2. Fill in **Accessible alternative**. Without it, the publication check warns you.
3. Choose **Add Shiny app**.

Students see the app only when the host has approved its origin. Otherwise the publication check warns you. An embedded Shiny app does not grade anything by itself ([spec §10.7](../product-spec.md#107-rendering-colab-and-shiny)).

**Colab.** There is nothing to configure for Colab. The student's notebook view has a **Work in Colab** section. Students open the notebook in Colab on Google's computers, and hand it back by uploading an `.ipynb` file. As an instructor you see **Student submissions** in that section, with a **Student** column and a **Download** button for each file.

Connecting to a personal computer or SSH account is a student and instructor workflow of its own. It is not part of authoring.

### Tests

1. Under **Tests**, choose **Add test**, enter **New test title** and choose **Create test**.
2. Choose **Edit** *test title*.
3. Set **Test title** and **Visibility**.
4. Fill in the defaults under **Attempts, timing and release**. A class can override them (see below):
   - **Attempts allowed**
   - **Duration (minutes, empty for untimed)**
   - **Time zone shown to students**, as an IANA name such as `Europe/Madrid`
   - **Opens** and **Closes**
   - **Late submission**: **Not accepted after closing** or **Accepted and marked late until**
   - **Results released**: **By an instructor** or **At a set time** (see below)
   - **Solutions**: **Never shown** or **Shown with results**
   - **Reported grade**: **Latest attempt**, **Highest attempt** or **Chosen by an instructor**
   - **Show hidden test details with results**
   - **Allowed materials**
5. Choose a **Question type** and then **Add question**. The types are **Quiz (choice)**, **Numeric answer**, **Explanation** and **Code**.

Each question has an id, points and a prompt. Quiz questions have options. Questions can have a rubric; without manual criteria the question is scored automatically. A test has up to 100 questions.

The times you enter are in your browser's time zone. A class's own terms for a test have no screen. Set them with `PUT /api/classes/{classId}/resources/{resourceId}/assignment`. Defaults and rules are in [spec §11](../product-spec.md#11-tests-including-code-implementation).

**Code questions.** A code question has these parts:

- The prompt, which states the input and output contract.
- A runtime, chosen under **Language and version** from the approved ones. Until you do, it shows **Choose a runtime**.
- **Files**. Editable files are the student's answer and start with this content. Hidden files are not shown to students.
- **Allowed packages**, which students see with the question.
- **Limits**: **Wall time (seconds)**, **Memory (MiB)** and **Captured output (bytes)**. Each shows its default as a placeholder.
- **Checks**. Each is **Sample (shown to students)** or **Hidden (never shown)**.

Checks compare a value in one of these ways: **Call a function and compare the result**, **Run the program and compare its output**, or **Run a script (its own exit status decides)**.

**Preview run** lets you try a saved question. Choose **Run sample checks** or **Run all checks, hidden included**. It needs the draft to be saved and a class of this course that you teach. The run uses the reference solution in place of a student's code.

Student code runs in an isolated worker, never in the app. Hidden checks and solutions are not sent to the browser before the release policy allows it.

### The publication check

The editor checks your saved drafts. The **Publication** panel shows **Publication check: no blocking problems**, or the number of blocking problems. Problems under **Blocks publication** stop you from publishing. Items under **To review** are warnings. Test and exercise editors show their own problems too.

## Publishing and releases

Publishing turns the current draft into a numbered, unchangeable release. Only an owner or a publisher can do it ([spec §3](../product-spec.md#3-sign-in-and-permissions)).

1. Open the course editor or any topic editor. These open only for an owner or an editor.
2. In **Publication**, read the check. Fix any blocking problem.
3. Choose **Publish release** *N*. The panel then says **Release** *N* **created.**

The panel also lists each class and the release it uses, or says it **has not adopted a release**. Publishing moves no class. A class stays on its release until it adopts another.

Without publisher permission the button is disabled and the panel says so. A publisher who is not an editor cannot open the editor. For them publishing is API-only: `POST /api/courses/{courseId}/releases`.

### Adopting a release

Adoption is API-only today.

- `GET /api/classes/{classId}/releases` lists releases and past adoptions.
- `GET /api/classes/{classId}/adoption?releaseId=...` shows what would change.
- `POST /api/classes/{classId}/adopt` with `{ "releaseId": "...", "expectedReleaseId": ... }` moves the class. `expectedReleaseId` is the release the class used when you looked at the diff. If another adoption happened first, the call is refused with `release_conflict`.

Tests that students already started stay on the version they started with ([spec §12](../product-spec.md#12-instructor-workflow)).

### Scheduled releases

A screen can set these only as defaults for a test, in the test editor:

- **Test results.** Set **Results released** to **At a set time**, then enter **Results released at**.
- **Test availability.** **Opens**, **Closes** and **Late submissions accepted until** control when students can work.

A class can override these defaults before it uses a release. That is done with `PUT /api/classes/{classId}/resources/{resourceId}/assignment`, for which there is no screen. Other release times have no screen either.

## Previewing as a student

Preview shows the draft with a class's student rules, using a separate preview identity. Notes and attempts made there stay out of the class.

1. Open **Edit topic**.
2. If you teach more than one class of the course, pick one under **Preview as a student of**.
3. Choose **Preview student view**.

If you teach no class of the course, the page says **You teach no class of this course.** You need a class first.

A **Draft preview** banner stays at the top of the page. Choose **Exit draft preview** to return to the editor.

## Reviewing and grading

Open **Class review** from the card of a class under **Courses you teach**.

### The student table

The table has these columns: **Student**, **Exercises**, **Test**, **Questions**, **Last submitted** and **Review**. Use **Previous page** and **Next page** when the class is large.

The filters are **Topic**, **Assignment**, **Student** and **Status**. **Status** is **All students** or **Needs review**. When no row matches, **Show all students** clears the filters.

Choose a test under **Assignment** to get the test-only controls: a checkbox column for releasing feedback, and **Preview release**. The same choice lists **Removed students** who submitted an attempt for that test. Choose one to open their attempt.

Choose a student's name to open their work. The heading shows their name, with **Previous student** and **Next student** beside it. They follow the current filtered list. The student view has these tabs:

- **Results**
- **Exercises**
- **Submissions**
- **Comments & questions**

Private study notes are not shown. **Comments & questions** lists shared threads, with their audience and **Open** or **Resolved** state. You can read them here. This page has no reply or resolve control.

### Grading a test attempt

1. Under **Results**, choose **Open grading** for an attempt.
2. Read the answer or code on one side. Code questions show an **Execution result** line and each check's outcome.
3. On the other side, enter points for each rubric criterion, or **Points for question** *n* when there is no rubric. Add **Feedback on question** *n*.
4. For code, use **Line to comment on** and **Add line comment** to comment on one line.
5. Add **Feedback to** *student name* for the whole attempt.
6. Choose **Save draft grade**.

A saved grade is a draft. The page says **Draft saved. The student cannot see it until you release it.** A **Total** line shows the points. It ends with **incomplete: some questions have no points** until every question has points.

Two more actions are available once a grade has been saved:

- **Override grade** sets a new total. It needs a **Reason**.
- **Regrade from latest results** reruns automatic scoring. It needs a **Reason**.

Both open a small form. They save with **Save override as draft** or **Save regrade as draft**. The original result stays in **Grade history**. You must save any edits first.

### Releasing feedback

Releasing is separate from saving.

- One student. Choose **Release feedback**. A preview lists the student and grade. Then choose **Confirm release to 1 student**. Afterwards the button reads **Feedback released**.
- Several students. First choose a test under **Assignment**. In the table, tick the checkbox on the row of each student with a draft grade. Then choose **Preview release (**n**)**. The preview lists who will get feedback and who will not, such as students whose grade still has unmarked questions. Then choose **Confirm release to** *n* **students**.

If a grade changed while you were looking, nothing is released. The page shows what a release would do now.

A grade cannot be released while questions are unmarked. Mark them or override the grade first.

### Extensions and extra attempts

On the **Tests** tab of a topic in a class, open a test. An instructor then sees **Extensions and extra attempts**. Choose a student under **Student**. Fill in **Extra attempts**, **Extra minutes** or **New closing time**. Give a **Grant reason, shown with the grant**, then choose **Grant**. A new grant replaces the student's earlier one and moves the deadline of an attempt in progress.

## Exporting results

1. Open **Class review**.
2. Choose **Export results (CSV)**.
3. When the page says how many attempts were exported, choose the **Download** link with the file name.

The file holds test attempts of the selected class only. The link works for a few minutes. After that, the page says **The download link has expired. Export again.** The file is also deleted from storage after about a day ([operations](../operations.md)). The file contains students' names and grades, so handle it as personal data.

## Archiving and restoring

Archiving makes a class or course read-only. Members can still read everything. Nothing new can be written until it is restored.

On **Courses you teach**:

- **Archive class** appears on the card of a class you teach, if you own the course or manage that class's members. It is hidden while the course is archived.
- Under **Courses**, **Archive course** appears on a course card. It is available to owners only.

Choose the button, read the question, and confirm with the same button. Use **Cancel** to stop. The page reports the result only after the server answered.

To undo, choose **Restore class** or **Restore course** in the same way. Restore the course before its classes. A class that was archived on its own stays archived after its course is restored.

The **Archived** filter shows archived items. Archiving a course also stops edits to its draft and new releases.

Who may do what is also described in [operations](../operations.md).
