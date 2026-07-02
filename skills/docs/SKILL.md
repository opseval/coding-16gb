---
name: docs
description: Use before writing code that depends on exact API syntax — specific CLI flags, keyword-argument names, or format placeholders — for python, bash, node, javascript, typescript, or git. Confirms the real signature OFFLINE via the `docs` tool instead of guessing. Reach for it whenever you are about to write an exact name you are not 100% sure of.
---

# docs — confirm the signature before you write it

Your memory of *exact* names is unreliable: a `git --pretty=format:` specifier, a `subprocess.run`
keyword, a `node:fs` option, an `argparse` parameter. A wrong flag or kwarg is a **silent** bug — the
code often runs, just wrong — and it costs a whole write→run→fix cycle to catch. The `docs` tool has the
real, **offline** documentation for python, bash, node, javascript, typescript, and git. One lookup is a
single cheap turn; skipping it is the expensive path.

Do not rely on your own recall for exact names. Look it up first.

## The procedure — do this BEFORE writing the call

1. **Name the exact bits you're unsure of.** Before writing, list the specific flags, keyword args, or
   format placeholders the code needs. e.g. *"I need git's short-hash + author + relative-date
   `--pretty=format:` specifiers."*
2. **Look each one up** with the `docs` tool:
   ```
   docs({ doc: "git", query: "git log" })
   docs({ doc: "python", query: "subprocess.run" })
   ```
   - Scope with `doc` (`python|bash|node|javascript|typescript|git`) when you know the ecosystem;
     omit it to search all installed docsets.
   - Query by the symbol/command name — you don't need the exact entry name. `docs` matches across
     separator styles (`Array.prototype.reduce`, `git-rebase`, `subprocess-run` all resolve).
3. **Write the code against the retrieved signature.** Copy the exact names from the result; do not
   re-guess them from memory once you have the real answer in front of you.
4. **On a miss:** `docs` returns nearby suggestions — try one. If the docset genuinely lacks the entry,
   fall back to the tool's own `--help`/`-h` via `bash`, and note the gap.

## When to use it

- **Look it up:** exact CLI flags, `--pretty=format:`/`strftime` placeholders, keyword-argument names
  and defaults, option-object keys — anything where a wrong exact name fails silently.
- **Skip it:** plain language/control flow, obvious basics you write daily, or an ecosystem `docs`
  doesn't cover (it only has python/bash/node/javascript/typescript/git).

## Fits the plan/verify loop

- During `plan`, add a first step like *"confirm the exact APIs via `docs`"* for any task with
  non-trivial signatures — that makes the lookup a checked step, not an afterthought.
- One `docs` lookup up front beats three `verify` FAIL cycles chasing a wrong argument name.
