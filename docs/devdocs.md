# Offline docs — the `docs` tool

The local model hallucinates API signatures (wrong kwargs, invented flags). The `verify` gate
catches *broken* code but not confidently-wrong-yet-valid code. The `docs` tool closes that gap:
it returns the **real** signature from bundled [DevDocs](https://devdocs.io) docsets, fully offline.

## Why an extension tool and not MCP

Pi ships **no MCP client** by design (README: *"No MCP. Build CLI tools with READMEs … or build an
extension that adds MCP support."*). So consuming a DevDocs *MCP server* would mean writing an MCP
client ourselves — pure overhead. Instead `docs` is a normal Pi tool (like `verify`), and it reads
DevDocs' JSON **straight off disk** — no server, no VM in the hot path.

## Layout

```
~/.pi/devdocs/docs/<slug>/{index.json,db.json,meta.json}   # DevDocs' native shape; NOT in git
extensions/lib/devdocs-core.mjs                            # pure search/render (zero Pi deps)
extensions/devdocs.ts                                      # the Pi `docs` tool (thin wrapper)
```

## Setup

```bash
scripts/devdocs-download.sh        # python~3.13 bash node javascript typescript git (~17MB gz)
scripts/devdocs-download.sh rust   # add more; any slug from https://devdocs.io
scripts/devdocs-download.sh --list # what's installed
scripts/devdocs-smoke.sh           # unit tests + a live round-trip
```
`install.sh` creates the dir; `PI_DEVDOCS_DIR` overrides it.

## Using it (the model calls this itself)

```
docs({ query: "subprocess.run", doc: "python" })   # scoped to one docset
docs({ query: "printf" })                           # searches all installed docsets
docs({ query: "commit --amend", doc: "git", limit: 3 })
```
Returns the matched entry's signature + short description, plus nearby matches. On a missing docset
or no match it returns a one-line hint (never an error), so the model can recover.

## How the model is driven to use it (installed automatically)

Everything here is deployed by `scripts/install.sh` (the `devdocs.ts` extension + the `docs` skill +
`enableSkillCommands` in settings), and `install.sh --with-docs` also fetches the docsets — so a
standard install gives a fully live docs capability, no manual wiring.

On-device testing established a concrete principle for small local models: **a ≤14B model discounts
the system prompt but acts on the recent conversation.** A system-prompt "prefer docs" nudge got
*zero* lookups; the *identical* text injected as a **conversation message** got the model to look up
`git --pretty=format` specifiers on its own before writing. So `devdocs.ts` injects the docs procedure
as a foreground `before_agent_start` message (hidden, `display:false`) whenever docsets are installed —
the model reaches for `docs` unprompted, every session, with no per-prompt action. Set
`PI_DOCS_NUDGE=0` to disable it.

Two layers, both installed:
- **Automatic** — the hidden per-prompt nudge above (default on).
- **Explicit** — `/skill:docs` (or the `docs` skill via `plan`) for a fuller, deliberate lookup procedure.

## Optional: the DevDocs web UI (container)

For a human browsing UI + easy docset refresh, `scripts/devdocs-container.sh up` runs the official
DevDocs image on http://localhost:9292 via **Colima**, bind-mounting the same `~/.pi/devdocs/docs`.
It's opt-in — even a tuned Colima VM reserves ~1–2 GiB that competes with the model on 16 GB, so
start it on demand and `down` it when done. The `docs` tool never needs it.
