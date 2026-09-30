---
name: steward
description: Repository conventions for any session driving a Parallax pull request to green - labels, who merges, merge-not-rebase.
---

# Driving a Parallax pull request

Follow step 5 of `.claude/skills/implement-issue/SKILL.md`. In short:

- Bring `main` in with `git merge origin/main`; never rebase, amend pushed commits, or force-push.
- After pushing fixes for a `review:changes-requested` round, reply on each thread and replace the label with `review:pending`.
- The orchestrator merges pull requests that satisfy the merge rule in `docs/delivery/README.md`. Sessions never merge or approve.
- Optional review findings (marked "optional") do not start a push on their own; include clearly correct ones in the next push that already changes the PR.
- A failing test is never "flaky" without evidence; never skip, disable or weaken a test to get green.
