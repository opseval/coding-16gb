# coding-16gb

A local, offline agentic-coding stack for a **macOS host on Apple silicon with as little as 16 GB of memory**. It gets as
close as a small machine reasonably can to the *hosted coding-agent + frontier-model* experience — using the
**[Pi coding agent](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)** driving a
**local** model, wrapped in scaffolding that makes a small model behave far more reliably than its size
suggests.

Design target: bash/python scripting and general coding, heavy agentic workflows, and long —
sometimes fully autonomous — sessions, all running on-device with no API calls.

## The idea: structure > weights

A 12B model that fits in 16 GB is not a frontier model. Left alone it drifts, fakes "done", forgets the
task, and hallucinates API details. But most of those failures are **process** failures, not knowledge
failures — and process is something the *harness* can own. This repo is that harness: a set of
guardrails, gates, and reminders that turn a small local model into a dependable worker for a well-scoped
task.

## The stack

- **Model:** **Gemma 4 12B** (Google) at 4-bit QAT — modern, open-weight, comfortable + swap-safe fit in
  16 GB. Alternates one keystroke away: `gpt-oss-20b` (max capability, marginal fit) and
  `granite-4-tiny` (fast/cool, simple tasks).
- **Serving:** llama.cpp `llama-server`, one model in 16 GB at a time.
- **Agent:** the Pi coding agent (a minimal, scriptable terminal harness).
- **Scaffolding:** a `frontier-scaffold` extension + a set of skills + an offline `docs` tool (below).

## Requirements

- An Apple-silicon Mac with 16 GB or more of unified memory (tuned for the tightest case — a
  passively-cooled 16 GB machine — and comfortable on bigger boxes).
- [Homebrew](https://brew.sh), and via it `llama.cpp` and `node`.
- Python 3 with `huggingface_hub` (for model/docset downloads).

## Quickstart

```bash
xcode-select -p >/dev/null 2>&1 || xcode-select --install   # Xcode Command Line Tools (git + compilers) — a fresh Mac has none; wait for it to finish
git clone https://github.com/opseval/coding-16gb.git && cd coding-16gb
brew install llama.cpp node && pip3 install --user -U huggingface_hub   # if `brew` is missing: https://brew.sh
#   pip --user CLIs (hf) install off-PATH; add them for login shells:
echo 'export PATH="$(python3 -m site --user-base)/bin:$PATH"' >> ~/.zprofile && source ~/.zprofile
npm i -g @earendil-works/pi-coding-agent

./scripts/install.sh --with-docs        # copy-deploy into ~/.local + ~/.pi/agent, add `coding` to PATH, fetch docsets
source ~/.zprofile                      # or open a new shell — puts `coding` on PATH
coding models                           # Gemma 4 12B (~7 GB); --alt for the gpt-oss reasoning fallback
sudo sysctl iogpu.wired_limit_mb=14336  # GPU wired ceiling (a ceiling, not a reservation; never 16000 on 16 GB)
coding serve gemma                      # start the model server (its own terminal)
coding smoke                            # verify the endpoint + tool-calls
```

After install the clone is no longer referenced — you can delete it. (Working *on* the repo? Use
`./scripts/install.sh --link` for live-edit config.) Then start coding from any directory:

```bash
coding                                   # interactive Pi with the full scaffolding + tools wired (opens in $PWD)
```

Or run unattended, with checkpoints, caps, and thermal cooldown:

```bash
coding watch my-session "Build <thing> until the tests pass; append <<DONE>> to NOTES.md when complete."
```

## How the scaffolding works

Each piece targets a specific way a small model fails.

**`frontier-scaffold` extension** (`extensions/frontier-scaffold.ts`) — the harness owns what the model
can't be trusted with:

- **Guardrail.** Blocks `sudo`, `rm -rf` on absolute/home paths, `curl | sh`, outward `git push`, and
  auto-blocks network installs in unattended mode. It also blocks **foreground servers and watchers**
  (`uvicorn`, `npm run dev`, `tail -f`, `tsc --watch`, `celery worker` …) that would hang the agent —
  the agent's shell tool waits for the command to exit and a server never does — handing back a
  background-and-poll or `timeout` recipe instead of a flat refusal (`PI_SCAFFOLD_STALLGUARD=0` opts out).
- **`verify` gate.** A deterministic done-gate (ruff / pytest / shellcheck / bats). The model may **not**
  declare a step complete on its own judgment; exit codes decide. On all-green it commits a git
  checkpoint. *The harness owns the verdict, not the model.*
- **Plan anchor.** Re-injects your `PLAN.md` into context every turn, so recency can't override the
  original goal on a long session.

**`context-guard` extension** (`extensions/context-guard.ts`) — bounds context *inside* a long agent
run. The agent only compacts *between* turns, so one many-round turn can grow past the point where the
model's output budget collapses (an unrecoverable wedge). The guard runs on every model request: it
caps/elides old tool output, and if a compaction's own summary wouldn't fit the window it substitutes a
deterministic digest. It reads the active model's context window at runtime, so it needs no tuning.

**Skills** (`skills/`) — on-demand procedures the model loads for a task: `plan` (write an atomic,
verifiable `PLAN.md` first), `verify` (use the gate), `tdd` (test-first), `autonomy` (survive a long
unattended run), and `docs` (below).

**Offline `docs` tool** (`extensions/devdocs.ts`) — a small model hallucinates exact API details
(a `subprocess` kwarg, a `git --pretty=format:` placeholder, a `node:fs` option). The `docs` tool
returns the **real signature** from bundled [DevDocs](https://devdocs.io) docsets (python, bash, node,
javascript, typescript, git), read straight off disk — fully offline, no server, no MCP. See
[docs/devdocs.md](docs/devdocs.md).

## The 12B limitations we had to overcome

Building this surfaced concrete limits of a ~12B local model, and a specific fix for each:

| Limitation | What it looks like | The fix |
|---|---|---|
| **Drift / losing the thread** | recency overrides the original instruction on a long task | `PLAN.md` re-injected into context every turn |
| **Over-claiming "done"** | reports success on code that doesn't run | the `verify` gate — exit codes decide, not the model |
| **Unsafe autonomy** | a stray destructive command in an unattended run | the guardrail blocks/confirms dangerous commands |
| **Hallucinated API details** | confident-but-wrong flags, kwargs, format placeholders | the offline `docs` tool returns the real signature |
| **Weak metacognition** | the model rarely *knows* it's unsure, so it won't self-check | make the check part of the workflow, not the model's judgment |

The last row is the deepest one, and it produced the most useful insight in the whole project:

> **A small model discounts the system prompt but acts on the recent conversation.**

We wanted the model to *reach for the `docs` tool on its own*. Putting a "prefer looking things up"
instruction in the **system prompt** — even a mandatory one the model provably read back verbatim —
produced **zero** lookups: it trusted its memory and moved on. The identical instruction injected as a
**foreground conversation message** flipped the behavior: the model looked up the real `git` format
placeholders *before* writing the script, then coded against them.

So `frontier-scaffold` and the `docs` nudge deliberately put their steering in the **conversation**
(a re-injected plan, a hidden per-prompt message, a gate result the model has to read) rather than in the
system prompt where a small model tunes it out. That single placement principle is why the scaffolding
works. The `docs` nudge is automatic and on by default (disable with `PI_DOCS_NUDGE=0`); for a deeper,
deliberate lookup you can also invoke the `docs` skill explicitly.

**Honest limits that remain.** This is a small model on a memory- and thermally-constrained machine: sustained throughput is
modest, and quality/consistency trail a frontier model — so scope work to well-defined, verifiable
steps (the scaffolding is built for exactly that). Keep effective context small on long sessions;
compaction is tuned for it, and one model fits in 16 GB at a time.

## Usage

- **Interactive:** `coding` — Pi with the model, tools, extensions, and skills all wired, opening in the
  current directory. Switch models with `Ctrl+P`, or preselect with `coding serve <model>`.
- **Autonomous:** `coding watch <session> "<task>"` — resumes on a loop with git checkpoints,
  wall-clock/iteration caps, thermal cooldown, forced compaction when the session grows large, and a
  `<<DONE>>` completion signal.
- **Offline docs setup / refresh:** `coding docs` (add any slug from devdocs.io);
  `scripts/devdocs-smoke.sh` to verify. An optional browsable DevDocs web UI is available via
  `scripts/devdocs-container.sh` (opt-in; uses Colima).

## Layout

| Path | Purpose |
|------|---------|
| `scripts/` | install, model serving, autonomous watchdog, smoke tests, docset tooling |
| `pi-config/` | `models.json` + `settings.json` deployed to `~/.pi/agent/` |
| `extensions/` | the `frontier-scaffold`, `context-guard`, and `docs` (`devdocs`) Pi extensions |
| `skills/` | `plan` / `verify` / `tdd` / `autonomy` / `docs` procedures |
| `docs/` | the `docs`-tool design + rationale |

## Config knobs

- `PI_DOCS_NUDGE=0` — disable the automatic docs nudge.
- `PI_DEVDOCS_DIR` — override the docsets dir (default `~/.pi/devdocs/docs`).
- `PI_SCAFFOLD_GUARD=0` / `PI_SCAFFOLD_AUTOCOMMIT=0` / `PI_SCAFFOLD_PLAN=<file>` — tune the scaffold.
- `PI_TOOLS`, `PI_SKILLS`, `PI_THINKING`, and the caps in `scripts/pi-watch.sh` — tune autonomous runs.
- `PI_COMPACT_AT` — token threshold (default 20480) at which `pi-watch.sh` forces a compaction
  between iterations. Print mode never auto-compacts, so a small local model would otherwise starve its
  own output budget as context approaches the window; the watchdog compacts (via `scripts/pi-compact.py`)
  to keep each iteration's context low. Set to 0 to disable.

Deploy is copy-based: `./scripts/install.sh` copies the harness into `~/.local/share/coding` + `~/.pi/agent`
and puts a `coding` command on PATH, so the clone is deletable afterward. `coding status` shows what's
deployed; `coding uninstall` removes it (add `--purge` to also delete the models and docsets). To develop
on the repo with live-edit config instead, use `./scripts/install.sh --link` (symlinks, repo stays the
source of truth).

## License

The code in this repository is licensed under the [MIT License](LICENSE) — permissive: use, modify, and
redistribute it freely, keeping the copyright and license notice.

This covers *this repository's* code only. The tools and data it installs or downloads at runtime — the
Pi coding agent, llama.cpp, the language models, and DevDocs documentation — are each covered by their
own licenses; review those before redistributing them.
