---
name: autonomy
description: Use for long-running or unattended sessions. Discipline for git checkpoints, revert-and-replan, stop-and-replan triggers, repo retrieval, context hygiene, and staying within budget on a 16 GB Apple-silicon Mac.
---

# autonomy — survive a long session without a human

On a small local model, a multi-hour unattended run fails by accumulating: drift, broken-state pile-ups,
context bloat, and thermal throttling. This skill is the discipline that keeps a run healthy.

## Work in a safe sandbox

- Operate inside a **dedicated git worktree** (`git worktree add ../proj-agent -b agent/session`), so the
  blast radius is this branch only.
- The `frontier-scaffold` extension already **blocks** `sudo`, `rm -rf` on absolute/home paths, `curl|sh`,
  and `git push`, and **auto-blocks** network installs in unattended (print) mode. Don't try to route
  around it — if a step truly needs a blocked command, write it in `PLAN.md` for a supervised run.

## Checkpoint and revert — never pile onto a broken state

- Each green `verify` is an automatic commit. Treat commits as your save points.
- If you've broken things and a fix isn't obvious, **revert** instead of layering fixes:
  `git reset --hard HEAD~1`, then re-attempt the step from a known-good base.

## Stop-and-replan triggers (codify these)

Stop forward work, append a one-line post-mortem to `NOTES.md`, and revise `PLAN.md` when:

- `verify` FAILs twice in a row on the same step,
- you've edited the same file 3+ times without a green `verify`,
- you notice you're repeating earlier actions (a loop), or
- context was compacted twice while on one step (a drift signal).

## Context hygiene (you have a small window)

- **Retrieve, don't slurp.** Use `grep`/`find` (ripgrep/fd are in `~/.pi/agent/bin`) to pull the 20–50
  relevant lines. Never `read` a whole large file when a search will do.
- **Confirm signatures, don't guess.** Call the `docs` tool (offline DevDocs — python/bash/node/js/ts/git)
  to check an unfamiliar stdlib/CLI signature *before* you write it. A hallucinated kwarg or flag costs a
  whole `verify` cycle; a 1-line `docs` lookup is far cheaper.
- Keep a `NOTES.md` scratchpad of decisions and dead-ends; re-read it after a compaction.
- Prefer many small, verified steps over one giant turn — small turns compact cleanly and keep the plan
  anchor effective.

## Narrow critic before the gates

Before calling `verify`, sanity-check yourself in one line: *Did I add/adjust a test? Does it cover the
edge case I changed? Did I actually run it?* If any answer is "no", fix that first. The critic surfaces
problems; `verify` still makes the call.

## Thermal + budget reality (passively-cooled 16 GB Mac)

- Sustained decode heats the chassis; near ~95 °C macOS throttles the GPU ~40%. Prefer **bursts**: after
  a few minutes of heavy tool/decode activity, a short idle gap helps it recover.
- Respect the watchdog's wall-clock and iteration caps. If you're not converging, stopping to replan is
  cheaper than grinding.
- For a subtask the local model can't crack after a replan, hand **that step** to the cloud model
  (`Ctrl+P` → `openai-codex/gpt-5.5`) and bring the result back. Hybrid beats stubborn pure-local.
