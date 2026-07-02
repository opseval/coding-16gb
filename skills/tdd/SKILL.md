---
name: tdd
description: Use when implementing any new behavior or fixing a bug. Test-first red-green-verify loop — write a failing test from the spec, watch it fail, make it pass, then verify. The test externalizes the spec so a small model can't drift on what "done" means.
---

# tdd — test-first, because the test is the spec

For a small local model, the dominant long-task failure is "what does done mean" drifting away from the
original intent. A test written *first* pins the spec in executable form, so the gate — not the model's
memory — defines success.

## The loop (per behavior or bug)

1. **Red** — write the smallest test that expresses the desired behavior (or reproduces the bug).
   - Python: a `test_*.py` with a `pytest` function.
   - Bash: a `*.bats` case, or a `tests/` script asserting expected output/exit code.
2. **Watch it fail** — run the test and confirm it fails *for the expected reason*. A test that passes
   before you've written the code is testing nothing. Never skip this.
3. **Green** — write the **minimum** code to make that test pass. No extra features.
4. **Verify** — call the `verify` tool. All gates must pass (lint + format + the full test suite, not
   just your new test).
5. **Checkpoint** — `verify` commits on green. Move to the next behavior.

## Rules

- One behavior at a time. Don't write five tests then five implementations.
- If you can't write a test for it, you don't understand the spec yet — clarify before coding.
- Keep tests fast and deterministic (no network, no clock/random unless seeded). Slow tests cook a
  passively-cooled Mac and stall autonomous loops.
- Bug fix? First write the test that fails *because of the bug*, then fix. That test stays as a
  regression guard.
