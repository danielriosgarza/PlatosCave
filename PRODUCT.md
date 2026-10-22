# Parallax

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product purpose

Host courses and classes. Students study course material and complete exercises and tests; instructors edit material and review each student's results, comments, and quizzes.

Parallax is also installable and pluggable (owner requirements N1 to N10, 12 October 2026). A person installs it for one project, personalises the site, and builds the courses from a folder of files, the way a documentation site is made. A course taught by one instructor and a research school with several instructors follow the same steps, and each project is its own installation. Parallax as built does not change: slides, readings, exercises, notebooks, tests, authoring, review and their appearance stay as they are.

## Users and workflow

Students and instructors enter through their respective sign-in routes. The student entrance opens enrolled courses with Resume; the instructor entrance opens teaching memberships with Class review and authoring actions. Both move from course selection to topic selection. Entry choice never grants a role. Every topic has five horizontal tabs: Slides, Reading, Exercises, Notebooks, and Tests.

## Capabilities and constraints

- Slides expand to a large stage and full screen.
- Reading supports private notes and highlights; one Ask composer posts comments or questions to an explicit Instructor or Class audience. Drawings attach to figures, bounded sketch areas, or PDF pages.
- Exercises support interaction and feedback.
- Notebooks support execution on an authorised personal computer, local workstation, or SSH server. Parallax keeps the notebook interface; Python/R runs on the selected machine. A compute connector handles SSH or local runtime access, including private-network machines. Rendered Jupyter content, external Colab, and Shiny remain additional modes.
- Tests include code implementation; instructors review student work.
- The first deliverable was a Markdown specification and explorable wireframe, not an implemented application. Amended 12 October 2026: the application has since been built from them (`docs/delivery/plan.md`, Phases 0 to 4), and "Parallax as built" in this file means that application.
- Installation (N1): one command creates a site from a template. The site folder holds only the site's own files. Parallax arrives as versioned pieces, so an upgrade changes a version and no other file of the site. The first instructors, classes and enrolment are set up from the site's configuration, with no hand-written API call.
- Modes (N2): instructor mode installs the courses of one instructor; school mode holds several instructors, each with their courses, in one installation. An instructor's `courses/` folder moves unchanged between the two. A mode adds no role.
- Own pages (N3): a site adds its own pages in JSX and starts from a template that has a front page. Pages are added only: they replace no Parallax screen and do not change its look.
- Conversion (N4, N5): files placed in a course folder become the same material, in the same format and appearance, as the editor produces. Exercises and tests have a file form: the definition the editor saves, written in YAML and checked by the same schemas.
- Levels (N6): level 0 is an open site of plain files with no server, database or sign-in, where anyone reads slides, readings and rendered notebooks, and runs a notebook on their own computer from its page. Amended 21 October 2026: the owner asked that a level 0 visitor compute with their own computer's processor, memory and Python while the notebook stays on the course page; the Parallax connector on that computer runs it, and nothing is saved on the site. Level 1 adds the server, PostgreSQL 16 and a way to sign in, and unlocks accounts, classes, notes, attempts, tests, review, discussion and connected notebooks. Level 2 adds the runner for code questions. A site can move between levels.
- Sign-in (N7): the way people sign in is a plug: an email link, or "sign in with" an OpenID Connect provider. Mail is optional.
- Compute (N8, N9): notebook code never runs on the server that serves the site. Colab over SSH is offered for paid Colab; opening in Colab and uploading stays the route for free Colab. Code questions run in the runner, on a host the operator controls.
- Open enrolment (N10): in an open class at level 1, anyone who signs in joins by a link and uses exercises, notes, tests and notebooks. Comments to the class and questions to instructors are off, and tests are scored and released without an instructor.

## Brand commitments

Use white and neutral-grey grounds, charcoal controls, one sans-serif family, and yellow only on marked passages. Keep slides and notebooks spacious. Interface copy should identify content, actions, audience, and real state; explanations of how the interface is designed belong in the specification.

The user supplied `docs/idea_draft.png` as visual inspiration: course cards with thin progress lines, a compact topic table, a full-width topic page, five understated tabs, large slide/notebook stages, and annotations beside their source passage. Use this reference to guide composition. Its illustrated course data and runtime labels do not establish real services or integrations.

## Evidence on hand

The original user brief and the 29 September 2026 clarification requiring notebook computation on local computers or SSH servers are the sources for the requirements above. `docs/product-spec.md` contains proposed implementation details and identifies assumptions. `docs/wireframe.html` uses fictional statistics material and student records to demonstrate the workflows; it does not yet illustrate the SSH connection setup. Those examples are not evidence of actual courses or customers. For N1 to N10 the sources are `docs/needed_specs.md` (the owner's session of 12 October 2026) and the owner's answers in issue #559.

## Open decisions

Deployment provider, application stack, real course content, connector distribution/operation, supported OS/runtime combinations, and host-specific SSH/VPN configuration remain undecided. Amended 12 October 2026: the identity provider, which this list named until then, is decided, and so is the form in which Parallax itself is distributed (next paragraph). Notebook execution on authorised personal/local computers and SSH servers is required; the connector architecture is the proposed means of providing it. The proposed distinction between reusable courses and class cohorts, and the privacy defaults in the specification, are design assumptions rather than additional user commitments.

Decided on 12 October 2026 for N1 to N10 (the owner's answers are in issue #559; `docs/delivery/plan.md` §8 records each one, and `docs/product-spec.md` §1, §3, §13 and §17 state the commitments): the identity provider is generic OpenID Connect first, beside the email link; Parallax is published as the npm packages `parallax-site` and `create-parallax-site` and as server and runner images, under one version number; own pages are added JSX pages only, and a site does not change the look; a level 0 site serves untrusted content from a second host name and holds no exercise answers, test definitions, notes or accounts; the runner has its own host. Still open, each a later owner decision: a level 0 site on a single host name, exercises checked in the browser, notes kept in the browser, Markdown pages, a site theme, GitHub and ORCID sign-in, pushing a course from a laptop to a remote server, exporting a course from the database to a folder, a level 1 installation without containers, and a runner on the site's host. Owner inputs that no work waits for: the registry accounts and the first release tag, real provider credentials, and one check of Colab over SSH on a paid plan.
