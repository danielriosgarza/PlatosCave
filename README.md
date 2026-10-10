# Parallax

Parallax is a course and class web application. Instructors author courses made of topics. Each topic holds five kinds of material: **Slides**, **Reading**, **Exercises**, **Notebooks** and **Tests**. Students study that material in a class, annotate readings, ask questions, work exercises, run notebooks and take tests. Instructors review student work, grade it and export results. There are two roles, student and instructor, and every class is isolated from every other.

The repository directory is PlatosCave; the product is Parallax.

## Current state

The application described in the [product specification](docs/product-spec.md) is implemented. It was built autonomously by Claude sessions; see [the delivery process](docs/delivery/README.md).

## Run it locally

You need Node 22 and pnpm; Postgres runs locally without Docker. In short:

```
corepack enable && pnpm install --frozen-lockfile
pnpm db:local start        # prints DATABASE_URL; export it
pnpm db:migrate
pnpm dev                   # open http://localhost:5173
```

[Getting started](docs/getting-started.md) has the full steps: signing in, becoming an instructor, creating a first course and class, running the checks, and which parts need Docker.

## Documentation

For people using Parallax:

- [Getting started](docs/getting-started.md): run it locally and set up a first course.
- [Instructor guide](docs/guide/instructors.md) and [student guide](docs/guide/students.md): what each role can do.

For people running it:

- [Operations](docs/operations.md): deployment, health, logs, limits, incidents.
- [Backup and restore](docs/backup-restore.md).

For people changing it:

- [Product specification](docs/product-spec.md): the requirements and acceptance scenarios. [PRODUCT.md](PRODUCT.md) lists the owner's commitments.
- [Architecture decisions](docs/adr/): technology stack, authorization and class isolation, content releases, code-execution isolation, notebook connector, testing strategy.
- [Designs](docs/design/): the [runner](docs/design/runner.md) and the [connector](docs/design/connector.md).
- [Visual system](DESIGN.md): palette, typography, dimensions and controls.
- [Delivery plan](docs/delivery/plan.md) and [delivery process](docs/delivery/README.md).
- [Design decisions](docs/design-reconciliation.md) and [Fable's review comments](docs/reviews/fable-2026-09-28.md): how the review was reconciled with the original brief.

The [interactive wireframe](docs/wireframe.html) is a design demonstration, not the application. Open it in a browser. Its course material and student records are fixtures; saves stay in memory and reset on reload. It follows [the supplied layout reference](docs/idea_draft.png).
