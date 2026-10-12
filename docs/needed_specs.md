# Needed specifications: Parallax as an installable, pluggable application

**Status:** draft, from the owner's brainstorming session of 2026-10-12. It is the input to a planning session. Nothing in it is built, and it is not yet part of `docs/product-spec.md` or `PRODUCT.md`.

Each statement carries one of three labels:

- **Required**: the owner stated it.
- **Agreed**: proposed in the session and accepted by the owner.
- **Open**: not decided. §6 collects these.

Folder layouts, file names and commands in this document are illustrations, not decisions.

## 1. Purpose

The owner wants to use Parallax the way Docusaurus is used. Docusaurus is a general application for documentation sites: you install it, personalise it, and it turns a folder of files into the documentation. Parallax should work the same way for teaching sites.

Two examples, both to be served by the same steps:

1. **A course.** The owner teaches one class with several topics. They install Parallax, personalise the website, and build the course with what Parallax offers. The website has a simple front page and a link that opens the Parallax interface for the class.
2. **A research school.** The owner organises a school with several instructors. They install Parallax again and do the same. The material stays open after the school.

Each project is its own installation.

**Parallax as built does not change** (Required). Slides, readings, exercises, notebooks, tests, authoring, review and their appearance stay as they are. The work is to make Parallax installable and pluggable.

## 2. Requirements

### N1. Easy installation (Required)

Parallax installs as easily as Docusaurus. One command creates a new site from a template. The site folder holds only the site's own files; Parallax itself arrives as a ready-made, versioned piece.

Today:

- Using Parallax means copying the whole repository. Every workspace package is `private: true` (`package.json`, `apps/*/package.json`, `packages/*/package.json`), and `infra/compose.prod.yml` builds its images from the source tree.
- A production start needs 18 settings without defaults, two host names (app origin and content origin, ADR-0002), a reverse proxy with TLS, and seven services: `migrate`, `api`, `relay`, `worker`, `runner`, `postgres`, `garage` (`docs/operations.md` §First start, §Topology).
- The first class cannot be set up on a screen. Creating a class, issuing an enrolment code, accepting an instructor invitation and adopting a release are API calls (`docs/guide/instructors.md`, first table).
- The only published artefact is the connector, as GitHub release binaries (`docs/operations.md` §Connector downloads).

Needed:

- An install command and a template per mode (N2).
- Parallax delivered as versioned pieces, so that an upgrade changes a version and leaves the site's own files alone.
- Setup from the site's own configuration: the first instructor or instructors, classes and enrolment, with no hand-written API calls.

### N2. Two modes (Required)

- **Instructor mode** installs the courses of one instructor.
- **School mode** is one level higher and allows several instructors, each with their courses.

An instructor's `courses/` folder moves unchanged between the two modes (Agreed).

```text
my-course/                      instructor mode
  parallax.config.ts            mode, name, logo, level, sign-in
  src/pages/index.tsx           the site's own pages (N3)
  courses/
    <course>/ …                 course folders (N4)

my-school/                      school mode
  parallax.config.ts
  src/pages/index.tsx
  instructors/
    <instructor>/
      courses/                  same layout as in instructor mode
```

Today Parallax already holds any number of instructors, each owning courses: an account may create courses when its address is in `INSTRUCTOR_EMAILS` or it already teaches (`docs/delivery/plan.md` §8 item 29), and course and class permissions are per membership (ADR-0002). So both modes fit the existing permission model; a mode is a choice made at installation, not a new permission system. There is no instance-administrator role (plan §8 items 29 and 34).

### N3. The site's own pages, in JSX, from a template (Required)

A site can add its own pages. They are written in JSX and are as flexible as Docusaurus pages. A new site starts from a template that already has a front page.

Today:

- `/` has no page: it redirects to `/courses` or `/signin` (`apps/web/src/routes/index.tsx`).
- The web app is React 19 with Vite and file-based TanStack Router routes (`apps/web/src/routes/`). It is one finished application; nothing builds on top of it.
- The look is defined by `DESIGN.md` and the `--pc-*` tokens in `packages/ui/src/tokens.css`.

Consequence: JSX is code, so each site is built. The site's pages and Parallax's web application are compiled into one site, which means the web application must be usable as a dependency of a site.

The site's JSX is the site owner's own code and is trusted. It runs on the app origin, so on a site with accounts it runs with the visitor's session. Content brought in by students and uploads keeps today's rules (§4).

### N4. Conversion mode (Required)

The author places files in a folder and they become course material, in the same format and with the same appearance as material in Parallax today.

Parallax already converts most file types, one file at a time, when an instructor adds a resource. Conversion mode does the same for a whole folder.

| Tab | File | Becomes (resource type, ADR-0003) | Converted today |
| --- | --- | --- | --- |
| Slides | Markdown deck, slides separated by `---` | `slides_web` | Yes; inline text only, images are not shown (plan §8 item 5) |
| Slides | PDF | `slides_pdf` | Yes; API only, no screen |
| Reading | Markdown or HTML | `reading_native` | Yes |
| Reading | PDF | `reading_pdf` | Yes; 25 MB limit |
| Notebooks | `.ipynb` plus data files | `notebook` with workspace files | Yes |
| Notebooks | address of a Shiny app | `shiny` | Yes; shown only for an origin in `SHINY_ORIGINS` |
| Exercises | none | `exercise` | No file form: filled in as a form (N5) |
| Tests | none | `test` | No file form: filled in as a form (N5) |

Illustration of one course folder. The five folders match the five tabs, which also settles whether a `.md` or `.pdf` file is a slide deck or a reading:

```text
courses/
  <course>/
    <nn-topic>/
      slides/
      reading/
      notebooks/
      exercises/
      tests/
```

Needed besides the files themselves:

- A place for what the editor records beside a file: topic title, learning objective, estimated time, prerequisites and completion rule; resource title, visibility and accessible alternative.
- A stable identity for each topic and resource across conversions. Converting a changed folder must produce new revisions of the same resources and a new release, so that notes, highlights and attempts stay attached. The existing model does this by `resource_id` (ADR-0003: adoption compares releases by `resource_id`, and annotations are mapped across revisions).
- Publication checks. Conversion must stop on the problems that block publication today (ADR-0003 §Publication).

Today there is no way to load a course from files, and no course export or import between installations.

### N5. A file form for exercises and tests (Required to build; form Agreed)

Exercises and tests need a file form so that conversion mode covers all five tabs.

Agreed form: the file holds the same definition the editor saves, written by hand in YAML and checked by the same schemas. The editor and the file are two ways to produce one thing, and nothing in the stored format changes.

- Exercise: `exerciseV1` in `packages/contracts/src/exercise.ts` (`schema: exercise.v1`, 1 to 20 steps of kind `numeric`, `single_choice`, `multiple_choice`, `ordering`, `matching`, `text`, `simulation` or `code`, optional `credit`).
- Test: the question kinds `choice`, `numeric`, `explanation` and `code`, rubric criteria and `assignmentSettings` in `packages/contracts/src/test.ts`.
- Code questions: the code files (editable, hidden, reference solution) sit beside the definition file.

This keeps plan §8 item 6 ("versioned JSON validated by zod; no DSL"). Writing questions inside Markdown was considered and set aside: it is a new format to design and maintain.

```yaml
schema: exercise.v1
steps:
  - id: predict
    kind: numeric
    title: Predict
    prompt: What is the mean of 2, 4 and 9?
    answer: 5
    tolerance: 0.01
    hints:
      - Add them, then divide by three.
    feedback:
      correct: Yes. 15 divided by 3.
      incorrect: Check the sum first.
```

A test definition holds its hidden checks and solutions (plan §8 item 7). A course folder kept in a public repository would publish them.

### N6. Database and other services as plugs that unlock functions (Required; levels Agreed)

The database and the mail sender are as pluggable as possible. Adding a plug unlocks functions. The owner's example: a course can be open to everyone, or it can serve a group of students, and only the second needs a database.

Agreed levels:

| Level | Plugged in | Unlocks |
| --- | --- | --- |
| **0. Open site** | Nothing: no server, no database, no sign-in | Anyone reads slides, readings and rendered notebooks. The site is plain files and can be hosted anywhere, like a Docusaurus site |
| **1. Class** | The Parallax server (`api`, `relay`, `worker`), PostgreSQL, and a way to sign in (N7) | Accounts, classes, private notes and highlights, saved exercise attempts, tests, review and grading, comments and questions, notebook execution through the connector |
| **2. Code checks** | The runner | Sample runs and automatic grading of code questions |

- **Level 0 is the largest new piece.** Today every screen reads through `/api/*`, every class read goes `class → release → release_resources → resource_revisions` (ADR-0003), and conversion runs as background jobs in the worker. Level 0 needs the same viewers fed from files produced at build time, and conversion that runs without a database.
- **Level 1 without level 2 exists today.** With no runner process the rest of the application works (`docs/getting-started.md` §Where code runs).
- **A site can move between levels** (Agreed). Example: the school runs at level 1 during the school and at level 0 afterwards, so it stays open at no running cost.
- **Database** (Agreed): it stays PostgreSQL 16, so nothing inside Parallax changes (ADR-0001; the job queues live in it). The plug is where it lives: the installer brings one, or the site names an existing one with `DATABASE_URL`, which works today.
- **Object storage** is already a plug: `STORAGE_DRIVER` is `fs` (a folder, the default) or `s3` (`apps/server/src/config.ts`). A small installation can run without Garage.

Spec §1 already foresees open access: "Public course browsing can be added later."

### N7. Sign-in as a plug; mail becomes optional (Agreed)

The owner asked to review what the mail sender is for. Its only use today is to send the sign-in link: `EmailLinkProvider` in `apps/server/src/auth/email-provider.ts` is the one caller of the mailer. Invitations are not emailed.

So the plug is the way people sign in:

- **Email link.** Exists today. Needs a mail sender (`MAIL_TRANSPORT=smtp`, `SMTP_URL`, `MAIL_FROM`).
- **"Sign in with…"** an account people already have: a university account, Google, GitHub or ORCID were named as candidates. Needs no mail sender. New, but the slot exists: the `IdentityProvider` interface in `apps/server/src/auth/identity-provider.ts`, whose comment reserves it for institutional sign-in.

At level 0 nobody signs in and there is no mail. Spec §3 and plan §7 already list the identity provider as a later decision, so this fills an open decision; it does not reverse one.

### N8. Notebook code never runs on the server that serves the site (Required; already true)

Notebook cells run on a computer the person is authorised to use: their own computer or an SSH server, reached through the connector, which dials out to Parallax (ADR-0005). Colab is a separate route: the student opens the notebook in Colab and uploads the file back. A connector operated by the institution ("managed" mode) is built on the connector side only and awaits an owner decision (issue #460, plan §8 item 34).

**Colab over SSH is to be offered as an option** (Required). Findings of 2026-10-12:

- Google's `google-colab-cli` has a `colab ssh` command: SSH over WebSocket, with a `--proxy-mode` that serves as an OpenSSH `ProxyCommand` (pull request 88, merged 2026-07-29). The README lists Linux and macOS only.
- The Colab FAQ disallows, on free runtimes without a compute-unit balance, "remote control such as SSH shells, remote desktops" and "bypassing the notebook UI to interact primarily via a web UI"; such runtimes may be terminated without warning. A paid plan with a positive balance removes these restrictions. So the option is for paid Colab only, and the existing open-and-upload route remains the one for free Colab.
- It does not connect today. The connector dials `host:port` itself with Go's `x/crypto/ssh`, optionally through a jump host, and v1 has no `ProxyCommand` (plan §8 item 31). Colab's SSH exposes no `host:port`.

Sources: <https://research.google.com/colaboratory/faq.html>, <https://github.com/googlecolab/google-colab-cli>, <https://github.com/googlecolab/google-colab-cli/pull/88>.

### N9. Code questions run on the operator's side (Required)

Code questions in exercises and tests may run on the operator's infrastructure, in the runner. The owner expects simple questions and a small load. This is level 2 of N6.

### N10. Open enrolment at level 1 (Required, decided before the levels of N6 were drawn)

For a site where anyone may join and do the work, the owner decided:

- Visitors sign in and can use exercises, notes, tests and notebooks.
- In an open group, comments to the class and questions to instructors are off, so that nobody has to moderate or answer for as long as the site is open.

It follows, and was not contradicted, that nobody grades in an open group: tests are scored automatically and results are released without an instructor.

Today: an enrolment code can have no use limit and no expiry (`maxUses` and `expiresAt` are nullable, `packages/contracts/src/routes/members.ts`), and any address may create an account. There is no join link: a student types the code on `/courses`. The `classes` table has two discussion-policy flags and none that turns posting off (`apps/server/src/db/schema/memberships.ts`). Test results are released "by an instructor" or "at a set time", and a question with manual rubric criteria needs a grader (`docs/guide/instructors.md` §Tests).

## 3. What stays the same

- The information structure (course, class, topic, five tabs), the screens and their appearance.
- The content model: mutable drafts, immutable releases, a class adopts a release (ADR-0003).
- Structural authorisation at level 1 and above: every `/api/*` route declares a scope, and a non-member gets 404 (ADR-0002).
- Where code runs: notebooks through the connector, code questions in the runner's sandboxes (ADR-0004, ADR-0005).

## 4. Constraints the plan must respect

- **Untrusted content.** Notebook HTML outputs, images, SVG, uploads and PDFs are sanitised and served from a separate content origin; JavaScript outputs are never served (`CLAUDE.md`, ADR-0002). A level 0 site has no server to mint content tokens, so it needs an equivalent separation for the same content.
- **Hidden material.** Hidden checks, solutions and correct answers must not reach a browser before the release policy allows it (plan §8 item 7). This limits what level 0 can ship and what a public course repository can hold (N5).
- **Migrations** are added only by items in the migration chain (plan §0). A per-class setting such as "posting off" (N10) is a schema change.
- **Product commitments.** `PRODUCT.md` and `docs/product-spec.md` are the sources of truth, and delivery sessions do not change product behaviour on their own. N1 to N10 are owner decisions that add behaviour, so the plan needs items that record them in both documents, and ADRs where an existing decision is extended.
- **Brand commitments.** `PRODUCT.md` fixes the look (white and neutral-grey grounds, charcoal controls, one sans-serif family, yellow only on marked passages). How far a site may change it is open (§6).
- **The repository is public.** Templates and examples carry no secrets, real credentials or personal data.

## 5. Directions considered and rejected

Recorded so that the plan does not return to them.

- **One shared installation that serves many projects, with per-project settings, as the main model.** Rejected: each project is its own installation. School mode is still one installation with several instructors.
- **A "material / event / engine" model with settings as the central idea.** Rejected in favour of install, personalise, build.
- **JSX or MDX inside course content** (a reading or slide that holds a live component). Rejected: the content model and the converters do not change.

## 6. Open questions for the planning session

Distribution and installation (N1):

- **Q1.** In what form is Parallax delivered: npm packages, container images, or both, and where are they published?
- **Q2.** What does an easy level 1 installation look like on one host: which services, how TLS and the two host names are handled, and how few settings can remain?
- **Q3.** How does a site upgrade Parallax, given that migrations only move forward (`docs/operations.md` §Upgrades and rollback)?

Modes (N2):

- **Q4.** In school mode, who administers the installation and adds instructors: the configuration (as `INSTRUCTOR_EMAILS` does today) or a new role?
- **Q5.** How does an instructor folder map to an account that owns its courses?
- **Q6.** What does "one level higher" mean for a visitor: does the site list instructors and then their courses?
- **Q7.** Does the site's configuration declare classes, their access and their enrolment, and does it replace the API-only steps of today?

Own pages (N3):

- **Q8.** Do own pages stop at added pages, or may a site also replace Parallax's own screens? Only added pages were confirmed.
- **Q9.** May own pages read Parallax data, for example to list courses on the front page?
- **Q10.** May a site change the look (the `--pc-*` tokens), given the brand commitments in `PRODUCT.md`?
- **Q11.** Are Markdown pages wanted beside JSX pages?

Conversion (N4, N5):

- **Q12.** Where does conversion run at level 1, and how does its result reach the server? At level 0 it runs at build time on the author's machine.
- **Q13.** When a course comes from a folder, can it also be edited in the web editor, and which side wins?
- **Q14.** How are topics and resources identified across conversions, including after a rename or a move?
- **Q15.** Where do topic and resource metadata live (one file per topic, front matter, or both)?
- **Q16.** How are hidden checks and solutions kept out of a public course repository?

Levels (N6, N10):

- **Q17.** At level 0, are exercises checked in the browser (answers are then in the page, acceptable for practice only) or switched off?
- **Q18.** At level 0, are notes and highlights off, or kept in the visitor's browser only?
- **Q19.** At level 0, what is shown for tests, for Shiny apps and for the Colab route?
- **Q20.** How is untrusted notebook output isolated on a level 0 site (§4)?
- **Q21.** When a site moves from level 1 to level 0, what happens to accounts, attempts and grades?
- **Q22.** Do the open-enrolment rules of N10 still hold now that level 0 exists, or does an open site always mean level 0?
- **Q23.** Is "posting off" a per-class setting, and is automatic release of results enforced for an open class or left to the author?

Sign-in (N7):

- **Q24.** Which "sign in with" providers come first?
- **Q25.** `INSTRUCTOR_EMAILS` and instructor invitations are bound to an email address. How do they work with a provider that does not release a verified address?

Compute (N8, N9):

- **Q26.** How does Colab over SSH connect: `ProxyCommand` support in the connector, a local tunnel the person opens with `colab ssh --proxy-mode` and a loopback target (connector design §8 allows loopback with `--allow-net`), or the connector running inside the Colab runtime with a `local` target? The second and third are untested ideas, and the third was not discussed with the owner. All three fall under the same Colab terms.
- **Q27.** Does the runner share the site's host or have its own? The owner accepted code questions "in the server"; `docs/operations.md` and `docs/design/runner.md` §10.1 recommend a separate host because the runner holds the Docker socket.

## 7. Documents this work touches

- `PRODUCT.md` and `docs/product-spec.md`: record N1 to N10 once the open questions are settled (spec §1 access and first deployment, §3 sign-in, §13 data and service boundaries, §17 decisions before deployment).
- `docs/adr/`: ADR-0001 (distribution), ADR-0002 (an open site without a server; content isolation at level 0; further identity providers), ADR-0003 (conversion from a folder and resource identity), ADR-0005 (Colab over SSH).
- `docs/delivery/plan.md`: a new phase with its items, and its place in the migration chain.
- `docs/getting-started.md`, `docs/operations.md`, `docs/guide/instructors.md`: installation, levels, modes and conversion.
