---
name: plan
description: Use at the very start of any non-trivial coding task, and whenever the goal is unclear or you've drifted. Produces an atomic, verifiable PLAN.md and keeps all work anchored to it. Essential for small local models on long sessions.
---

# plan — plan before you act

A small model's biggest failure mode on a long task is losing the thread: recency overrides the
original instruction, and "done" drifts. This skill front-loads an explicit, checkable plan that the
harness re-injects every turn (the `frontier-scaffold` extension reads `PLAN.md` automatically).

## Do this first, before any edit

1. **Restate the goal** in one sentence. If it's ambiguous, ask — do not guess.
2. **Write `PLAN.md`** in the repo root as a numbered list of *atomic* steps. Each step must be:
   - one small, self-contained change, and
   - paired with how it will be **verified** (a test name, or "run `verify`").
3. Keep it short — 3 to 8 steps. If it needs more, the task is too big: split it.

### PLAN.md template

```markdown
# Goal
<one sentence>

# Acceptance
- [ ] <observable condition that means the whole task is done>

# Steps
1. [ ] <atomic change> — verify: <test or gate>
2. [ ] <atomic change> — verify: <test or gate>
3. [ ] <atomic change> — verify: <test or gate>
```

If any step uses non-trivial API syntax (exact CLI flags, keyword args, `--pretty=format:`/`strftime`
placeholders, option keys), make an early step *"confirm the exact signatures via `docs`"* — don't plan to
write exact names from memory. See the `docs` skill.

## While working

- Work the **next unchecked step only**. Don't skip ahead.
- Check a step off **only after the `verify` tool returns PASS** for it.
- If you learn something that changes the plan, **edit `PLAN.md`** before continuing — keep it true.
- If you fail the same step twice, stop: append a one-line post-mortem to `NOTES.md`, then revise the plan.

The plan is the contract. The model narrates; `PLAN.md` + `verify` decide what's done.
