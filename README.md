# Parallax

Specification, interactive design study and (in progress) implementation of a course and class application.

- [Product specification](docs/product-spec.md): the unified requirements and acceptance scenarios.
- [Interactive wireframe](docs/wireframe.html): course selection, topics, five material tabs, annotations, exercises, assessment, and instructor review. Open it in a browser.
- [Design decisions](docs/design-reconciliation.md): how Fable’s review and counterproposal were reconciled with the original brief.
- [Visual system](DESIGN.md): palette, typography, dimensions, and controls.

The design follows [the supplied layout reference](docs/idea_draft.png). **Layout notes** exposes the dimensions and palette; **Preview role** switches the sample student and instructor views. Both controls live in the demonstration footer.

All course material and student records are fixtures. Saves remain in memory and reset on reload. No authentication, code execution, external computing session, submission, or grade delivery occurs. The optional inline preview remembers navigation choices only.

Instructors can export a class's results as CSV and archive or restore a class (course owners and class membership managers) or a course (owners); an archived class or course stays readable and takes no changes until restored. Students can download their own annotations and posts for a class as JSON. See [operations](docs/operations.md).

Implementation is delivered autonomously by Claude sessions:

- [Architecture decisions](docs/adr/): technology stack, authorization and class isolation, content releases, code-execution isolation, notebook connector, testing strategy.
- [Delivery plan](docs/delivery/plan.md): phases, work items and acceptance-scenario coverage.
- [Delivery process](docs/delivery/README.md): how issues, implementer and reviewer sessions, merging and escalation work, and when a human is needed.

[Fable’s review comments](docs/reviews/fable-2026-09-28.md) and the design decisions remain in Markdown. `docs/wireframe.html` is the sole HTML wireframe. The product name is **Parallax**; the repository directory remains **PlatosCave**.
