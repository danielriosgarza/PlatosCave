# Parallax

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product purpose

Host courses and classes. Students study course material and complete exercises and tests; instructors edit material and review each student's results, comments, and quizzes.

## Users and workflow

Students and instructors enter through their respective sign-in routes. The student entrance opens enrolled courses with Resume; the instructor entrance opens teaching memberships with Class review and authoring actions. Both move from course selection to topic selection. Entry choice never grants a role. Every topic has five horizontal tabs: Slides, Reading, Exercises, Notebooks, and Tests.

## Capabilities and constraints

- Slides expand to a large stage and full screen.
- Reading supports private notes and highlights; one Ask composer posts comments or questions to an explicit Instructor or Class audience. Drawings attach to figures, bounded sketch areas, or PDF pages.
- Exercises support interaction and feedback.
- Notebooks support execution on an authorised personal computer, local workstation, or SSH server. Parallax keeps the notebook interface; Python/R runs on the selected machine. A compute connector handles SSH or local runtime access, including private-network machines. Rendered Jupyter content, external Colab, and Shiny remain additional modes.
- Tests include code implementation; instructors review student work.
- The current deliverable is a Markdown specification and explorable wireframe. It is not an implemented application.

## Brand commitments

Use white and neutral-grey grounds, charcoal controls, one sans-serif family, and yellow only on marked passages. Keep slides and notebooks spacious. Interface copy should identify content, actions, audience, and real state; explanations of how the interface is designed belong in the specification.

The user supplied `docs/idea_draft.png` as visual inspiration: course cards with thin progress lines, a compact topic table, a full-width topic page, five understated tabs, large slide/notebook stages, and annotations beside their source passage. Use this reference to guide composition. Its illustrated course data and runtime labels do not establish real services or integrations.

## Evidence on hand

The original user brief and the 29 September 2026 clarification requiring notebook computation on local computers or SSH servers are the sources for the requirements above. `docs/product-spec.md` contains proposed implementation details and identifies assumptions. `docs/wireframe.html` uses fictional statistics material and student records to demonstrate the workflows; it does not yet illustrate the SSH connection setup. Those examples are not evidence of actual courses or customers.

## Open decisions

Deployment provider, application stack, real course content, identity provider, connector distribution/operation, supported OS/runtime combinations, and host-specific SSH/VPN configuration remain undecided. Notebook execution on authorised personal/local computers and SSH servers is required; the connector architecture is the proposed means of providing it. The proposed distinction between reusable courses and class cohorts, and the privacy defaults in the specification, are design assumptions rather than additional user commitments.
