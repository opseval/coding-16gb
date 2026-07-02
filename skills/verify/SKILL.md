---
name: verify
description: Use before claiming ANY step or task is complete. Runs the project's deterministic gates (ruff, pytest, shellcheck, bats) via the verify tool. A step is done only when verify returns PASS. The harness owns the verdict, not the model.
---

# verify — the harness owns "done"

You may **not** declare a step or task complete on your own judgment. Small models routinely report
success on code that doesn't run. The `verify` tool runs real gates and reports their exit codes; the
exit codes decide.

## The rule

> A step is DONE only when `verify` returns **VERDICT: PASS**.

## How to use it

- After finishing an atomic step from `PLAN.md`, **call the `verify` tool** (no arguments runs all
  detected gates).
- Read the verdict:
  - **PASS** — all gates green. Check the step off in `PLAN.md`. (On a git repo, `verify` has already
    committed a checkpoint.)
  - **FAIL** — at least one gate failed. The step is **not** done. Read the gate output, fix the
    specific failure, and call `verify` again.
  - **NO GATES** — no python/bash files or tools were found to check. This does **not** count as done;
    add a test or a runnable check first (see the `tdd` skill).

## Gates that run (when present)

| Files present | Gates |
|---|---|
| `*.py`, `pyproject.toml`, `setup.py` | `ruff format --check`, `ruff check`, `pytest -q` (if tests) |
| `*.sh`, `*.bash` | `shellcheck -S style` |
| `*.bats` | `bats tests` |

## Don't game it

- Don't delete or weaken tests to make `verify` pass — that's a failure, not a success.
- Don't claim "verify passes" without actually calling the tool. The reviewer/watchdog checks.
- Two consecutive FAILs on the same step → stop and replan (see the `autonomy` skill).
