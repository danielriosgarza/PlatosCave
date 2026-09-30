---
name: phase-audit
description: Audit Parallax main after a delivery phase closes - verify its acceptance scenarios, find cross-PR drift from spec and ADRs, file fix-up issues, and write the phase summary for the owner. Argument is the phase number.
---

# Phase audit

Argument: phase number N. Repository `danielriosgarza/PlatosCave`, on `main`. Single-PR reviews miss problems that only appear across PRs; find those.

## 1. Verify

1. Read `CLAUDE.md`, `docs/delivery/README.md`, `docs/delivery/plan.md`, all ADRs, and the spec sections covered by phase N.
2. Run the complete check suite on `main` (lint, typecheck, unit, integration, all e2e). Record results.
3. For every scenario ID assigned to phase N (plan coverage table and closed issues), confirm a test named with that ID exists, asserts the spec's observable result, and passes.
4. Look across the phase's merged PRs for:
   - authorization or class-isolation gaps (any route, download, job or WebSocket missing the checks from ADR 0002);
   - inconsistent patterns (two ways of doing the same thing), dead code, TODOs without issues;
   - UI drift from `DESIGN.md` and the wireframe; accessibility basics (keyboard, focus, labels) for built screens;
   - decisions recorded in PR **Decisions** sections that conflict with each other, the spec, or an ADR;
   - anything the next phase will trip over.

## 2. File fix-up issues

One small issue per problem, title `[PN-AUD<k>] …`, labels `plan`, `phase:N`, `audit`, a `model:` label per `docs/delivery/README.md`, `security` when relevant, and `status:ready` (or `status:blocked` with `Depends on:`). Body: problem, evidence (file:line or failing test), expected behaviour with spec/ADR reference, and the scenario IDs involved. Do not fix code yourself.

If the next phase's plan items need refinement based on what was learned, edit those open issues' bodies directly and note the change in a comment.

## 3. Phase summary for the owner

Create an issue titled `Phase N summary`, labelled `summary`. Keep it to one screen:

- **What exists now**, in user terms, and how to try it locally (exact commands).
- **Scenarios passing:** IDs.
- **Decisions made without the owner** worth a look (link PRs), at most five.
- **Risks** and the fix-up issues filed.
- **Anything that needs the owner** (also label those issues `needs-human`).

Your final message starts with `PHASE SUMMARY:` and links the summary issue.
