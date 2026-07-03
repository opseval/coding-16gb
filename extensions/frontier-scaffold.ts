/**
 * frontier-scaffold — the "structure > weights" enforcement layer for Pi.
 *
 * A small local model (≤14B) drifts, fakes "done", and occasionally runs something
 * destructive over a long autonomous session. This extension makes the *harness* own
 * the things the model can't be trusted to:
 *
 *   1. Guardrail   — block sudo / rm -rf / curl|sh / outward git push via `tool_call`.
 *                    ALSO blocks foreground servers/watchers (uvicorn, npm run dev, tail -f,
 *                    tsc --watch …) that would hang the agent loop — Pi's bash tool waits for
 *                    the command to exit and a server never does (a real on-device stall).
 *                    Auto-blocks in print mode (-p) where there is no UI to confirm,
 *                    so unattended runs are safe by default. Rules + tests live in
 *                    lib/bash-guard-core.mjs.
 *   2. verify tool — deterministic done-gate (ruff / pytest / shellcheck / bats).
 *                    The model may never self-declare done; exit codes decide.
 *                    On all-green it git-commits a checkpoint. *Harness owns the verdict.*
 *   3. Plan anchor — inject ./PLAN.md into the system prompt for every model call
 *                    (before_agent_start, ephemeral — no session accumulation).
 *
 * Loaded automatically from ~/.pi/agent/extensions/. No build step (jiti).
 * Grounded in the installed Pi v0.75.5 extension API.
 *
 * Env knobs:
 *   PI_SCAFFOLD_AUTOCOMMIT=0   disable the auto git checkpoint on green verify
 *   PI_SCAFFOLD_PLAN=PLAN.md   plan filename to inject (default PLAN.md)
 *   PI_SCAFFOLD_GUARD=0        disable the bash guardrail entirely (NOT recommended for autonomy)
 *   PI_SCAFFOLD_STALLGUARD=0   disable ONLY the foreground-server/watcher block (for a supervised run)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// Guardrail rules (HARD/STALL/SOFT classification) live in a zero-dep, unit-tested sibling core.
import { classifyBash, stallGuidance, softReason } from "./lib/bash-guard-core.mjs";

const AUTO_COMMIT = process.env.PI_SCAFFOLD_AUTOCOMMIT !== "0";
const GUARD_ON = process.env.PI_SCAFFOLD_GUARD !== "0";
const STALL_GUARD = process.env.PI_SCAFFOLD_STALLGUARD !== "0";
const PLAN_FILE = process.env.PI_SCAFFOLD_PLAN ?? "PLAN.md";
const PLAN_INJECT_CAP = 6000; // chars of PLAN.md injected into the system prompt

// --- bash guardrail: HARD/STALL/SOFT rules + classifier are in lib/bash-guard-core.mjs (unit-tested) ---

function which(bin: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${bin}`], { encoding: "utf8" }).status === 0;
}

function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 600_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  return { ok: r.status === 0, code: r.status ?? -1, out };
}

// gitignore-aware project files (tracked + untracked, excluding ignored), so verify never lints
// vendored .sh or flips python-detection on a .py inside .venv. Falls back to a pruned walk.
function projectFiles(cwd: string): string[] {
  const r = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, encoding: "utf8" });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.split("\n").filter(Boolean);
  try {
    return (readdirSync(cwd, { recursive: true, encoding: "utf8" }) as string[])
      .filter((f) => !/(^|\/)(node_modules|\.git|\.venv|venv|dist|build|vendor|\.tox)(\/|$)/.test(f));
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  // ---------- 1. guardrail ----------
  if (GUARD_ON) {
    pi.on("tool_call", async (event, ctx) => {
      if (!isToolCallEventType("bash", event)) return;
      const cmd = String(event.input.command ?? "");
      const { verdict, why } = classifyBash(cmd);

      // HARD — always blocked, both modes.
      if (verdict === "hard") {
        return { block: true, reason: `Blocked: ${why}. Adjust the command or stop and replan.` };
      }
      // STALL — a foreground server/watcher hangs the loop identically in every mode, so block both
      // (unless disabled) and hand back the non-blocking recipe instead of a flat refusal.
      if (verdict === "stall" && STALL_GUARD) {
        return { block: true, reason: stallGuidance(why!, cmd) };
      }
      // SOFT — confirm interactively, block in autonomous (-p) mode. A command may be BOTH stall and
      // soft (`pip install x && npm run dev`); classifyBash returns stall first, so when the stall
      // block is disabled we still enforce SOFT via softReason() rather than dropping it silently.
      const soft = verdict === "soft" ? why : softReason(cmd);
      if (soft) {
        if (!ctx.hasUI) {
          return { block: true, reason: `Blocked in autonomous mode: ${soft}. If this is required, note it in PLAN.md for a supervised run.` };
        }
        const ok = await ctx.ui.confirm("Allow command?", `${soft}:\n\n${cmd}`);
        if (!ok) return { block: true, reason: `Denied by user: ${soft}.` };
      }
    });
  }

  // ---------- 2. verify: the deterministic done-gate ----------
  pi.registerTool({
    name: "verify",
    label: "Verify (gates)",
    description:
      "Run the project's deterministic quality gates (ruff format+lint, pytest, shellcheck, bats) and report PASS/FAIL. " +
      "A step is DONE only when this returns PASS. You may NOT declare a task complete without a passing verify. " +
      "On all-green in a git repo it commits a checkpoint.",
    promptSnippet: "Run project gates (ruff/pytest/shellcheck/bats); a step is done only when verify PASSes",
    promptGuidelines: [
      "Call verify after each atomic step in PLAN.md; do not claim a step is done until verify returns PASS.",
      "If verify FAILs twice in a row on the same step, stop and replan instead of piling on fixes.",
    ],
    parameters: Type.Object({
      scope: Type.Optional(StringEnum(["python", "bash", "all"] as const)),
      commit: Type.Optional(
        Type.Boolean({ description: "Override auto-commit on green (default: env PI_SCAFFOLD_AUTOCOMMIT)." }),
      ),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const cwd = ctx.cwd;
      const scope = (params.scope as string) ?? "all";
      const files = projectFiles(cwd);
      const shFiles = files.filter((f) => f.endsWith(".sh") || f.endsWith(".bash"));
      const hasPy = files.some((f) => f.endsWith(".py")) || existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "setup.py"));
      const hasBats = files.some((f) => f.endsWith(".bats"));

      const gates: { name: string; ok: boolean; code: number; out: string }[] = [];
      const add = (name: string, r: { ok: boolean; code: number; out: string }) => {
        onUpdate?.({ content: [{ type: "text", text: `${r.ok ? "✓" : "✗"} ${name}` }] });
        gates.push({ name, ...r });
      };

      if ((scope === "all" || scope === "python") && hasPy) {
        if (which("ruff")) {
          add("ruff format --check", run("ruff", ["format", "--check", "."], cwd));
          add("ruff check", run("ruff", ["check", "."], cwd));
        }
        if (which("pytest") && files.some((f) => /(^|\/)test_.*\.py$|_test\.py$/.test(f))) {
          add("pytest", run("pytest", ["-q"], cwd));
        }
      }
      if ((scope === "all" || scope === "bash") && shFiles.length && which("shellcheck")) {
        // -S warning, not the default -S style: don't fail the gate on SC2006/SC2086 quoting nags.
        add("shellcheck", run("shellcheck", ["-S", "warning", ...shFiles], cwd));
      }
      if ((scope === "all" || scope === "bash") && hasBats && which("bats")) {
        add("bats", run("bats", ["tests"], cwd));
      }

      const ran = gates.length > 0;
      const pass = ran && gates.every((g) => g.ok);
      let commitNote = "";
      const wantCommit = params.commit ?? AUTO_COMMIT;
      if (pass && wantCommit && existsSync(join(cwd, ".git"))) {
        run("git", ["add", "-A"], cwd);
        const msg = `verify: green [${gates.map((g) => g.name.split(" ")[0]).join(",")}]`;
        const c = run("git", ["commit", "-m", msg], cwd);
        commitNote = c.ok ? `\n\nCheckpoint committed: ${msg}` : `\n\n(no changes to commit)`;
      }

      ctx.ui.setStatus("verify", pass ? "verify: PASS" : ran ? "verify: FAIL" : "verify: no gates");
      const header = !ran
        ? "VERDICT: NO GATES — no python/bash files or required tools (ruff/pytest/shellcheck/bats) found. This does NOT count as done."
        : pass
          ? "VERDICT: PASS — all gates green. This step may be marked done."
          : "VERDICT: FAIL — at least one gate failed. The step is NOT done. Fix or replan.";
      const body = gates
        .map((g) => `\n--- ${g.name} (exit ${g.code}) ${g.ok ? "PASS" : "FAIL"} ---\n${g.out.slice(0, 1500)}`)
        .join("\n");
      return {
        content: [{ type: "text", text: header + body + commitNote }],
        details: { pass, ran, gates: gates.map((g) => ({ name: g.name, ok: g.ok, code: g.code })) },
      };
    },
  });

  // ---------- 3. plan anchor: inject PLAN.md into the system prompt ----------
  // before_agent_start fires once per user prompt; the system prompt it returns is used for EVERY
  // model call in that agent run (incl. every turn of an autonomous -p loop), and is ephemeral
  // (rebuilt each run from the file on disk) so nothing accumulates in the session.
  pi.on("before_agent_start", async (event, ctx) => {
    const planPath = join(ctx.cwd, PLAN_FILE);
    if (!existsSync(planPath)) return;
    let plan = "";
    try { plan = readFileSync(planPath, "utf8"); } catch { return; }
    if (!plan.trim()) return;
    const clipped = plan.length > PLAN_INJECT_CAP ? plan.slice(0, PLAN_INJECT_CAP) + "\n…(truncated)" : plan;
    const block =
      `\n\n## Active plan (${PLAN_FILE}) — present in your system prompt for every step\n\n` +
      clipped +
      `\n\nWork the next unchecked step only. A step is DONE only when the \`verify\` tool returns PASS. ` +
      `If you've failed the same step twice, write a one-line post-mortem to NOTES.md and revise ${PLAN_FILE}.`;
    return { systemPrompt: event.systemPrompt + block };
  });

  pi.on("session_start", async (_e, ctx) => {
    ctx.ui.setStatus("frontier-scaffold", `scaffold on${GUARD_ON ? " · guard" : ""}${AUTO_COMMIT ? " · checkpoint" : ""}`);
  });
}
