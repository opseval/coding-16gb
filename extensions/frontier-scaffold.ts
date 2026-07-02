/**
 * frontier-scaffold — the "structure > weights" enforcement layer for Pi.
 *
 * A small local model (≤14B) drifts, fakes "done", and occasionally runs something
 * destructive over a long autonomous session. This extension makes the *harness* own
 * the things the model can't be trusted to:
 *
 *   1. Guardrail   — block sudo / rm -rf / curl|sh / outward git push via `tool_call`.
 *                    Auto-blocks in print mode (-p) where there is no UI to confirm,
 *                    so unattended runs are safe by default.
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
 *   PI_SCAFFOLD_GUARD=0        disable the bash guardrail (NOT recommended for autonomy)
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const AUTO_COMMIT = process.env.PI_SCAFFOLD_AUTOCOMMIT !== "0";
const GUARD_ON = process.env.PI_SCAFFOLD_GUARD !== "0";
const PLAN_FILE = process.env.PI_SCAFFOLD_PLAN ?? "PLAN.md";
const PLAN_INJECT_CAP = 6000; // chars of PLAN.md injected into the system prompt

// --- bash guardrail ---
// HARD_DENY: always blocked (no override). All rules match across newlines/positions.
const HARD_DENY: { re: RegExp; why: string }[] = [
  { re: /(^|[;&|\n])\s*sudo\b/, why: "sudo is denied" },
  { re: /--no-preserve-root\b/, why: "rm --no-preserve-root (root-wipe override)" },
  // recursive + force rm targeting an absolute (non-tmp), home, or parent path — any flag order/form
  { re: /\brm\b(?=[^\n]*(?:-[a-z]*r|--recursive))(?=[^\n]*(?:-[a-z]*f|--force))(?=[^\n]*(?:\s|=|["'])(?:\/(?!(?:private\/)?tmp\/)|~|\$HOME|\.\.))/, why: "recursive+force rm on absolute/home/parent path" },
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(bash|sh|zsh|python3?)\b/, why: "remote pipe-to-shell (curl|sh)" },
  { re: />\s*\/dev\/(r?disk|sd|nvme)/, why: "raw block-device write" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//, why: "dd to a device" },
  { re: /\b(mkfs|diskutil\s+erase|fdisk)\b/, why: "disk-format command" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/, why: "fork bomb" },
  { re: /(^|[;&|\n])\s*git\s+push\b/, why: "git push is outward — denied in autonomous mode" },
];
// SOFT_DENY: confirm in interactive (UI) mode, block in autonomous (print) mode.
const SOFT_DENY: { re: RegExp; why: string }[] = [
  { re: /\b(pip3?|uv|npm|pnpm|yarn|brew|cargo|gem|go|poetry|pipx)\s+(install|add|i|sync|ci|tool)\b/, why: "network package install" },
  { re: /(^|[;&|\n]|\s)npx\b/, why: "npx (fetches and runs a package)" },
  // recursive rm of the project cwd itself (.  ./…  *) — destroys .git checkpoints too
  { re: /\brm\b(?=[^\n]*(?:-[a-z]*r|--recursive))[^\n]*(?:\s|=|["'])(?:\.(?:\/|\s|$)|\*)/, why: "recursive rm of the project cwd / glob" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, why: "destructive git op" },
];

function matchDeny(cmd: string, list: { re: RegExp; why: string }[]): string | null {
  for (const { re, why } of list) if (re.test(cmd)) return why;
  return null;
}

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
      const hard = matchDeny(cmd, HARD_DENY);
      if (hard) return { block: true, reason: `Blocked: ${hard}. Adjust the command or stop and replan.` };
      const soft = matchDeny(cmd, SOFT_DENY);
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
