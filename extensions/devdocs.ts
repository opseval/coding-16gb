/**
 * devdocs — an offline documentation lookup tool for Pi.
 *
 * Pi has no MCP (by design). This registers a `docs` tool that reads bundled DevDocs docsets
 * (~/.pi/devdocs/docs/<slug>/{index,db}.json) straight off disk and returns the real API
 * signature for a symbol/flag, so a small local model can CONFIRM syntax instead of guessing.
 *
 * The search/render logic lives in the zero-dependency sibling `lib/devdocs-core.mjs`. We locate
 * it via the realpath of THIS file (install.sh symlinks the extension into ~/.pi/agent/extensions/,
 * so import.meta.url is that symlink; realpathSync resolves it back to the repo, where lib/ lives).
 *
 * Loaded automatically from ~/.pi/agent/extensions/. No build step (jiti).
 *
 * A small (<=14B) model won't spontaneously reach for a tool from passive tool metadata — its
 * metacognition ("am I uncertain?") is too weak. So the harness makes the nudge ACTIVE: a
 * before_agent_start hook injects a one-line docs-preference instruction into the system prompt
 * every turn (chained after frontier-scaffold's PLAN anchor), the same structure-over-weights move.
 *
 * Env:
 *   PI_DEVDOCS_DIR   overrides the docsets dir (default ~/.pi/devdocs/docs).
 *   PI_DOCS_NUDGE=0  disable the system-prompt docs-preference injection (tool still available).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

export default async function (pi: ExtensionAPI) {
  const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const core = await import(pathToFileURL(join(here, "lib", "devdocs-core.mjs")).href);

  pi.registerTool({
    name: "docs",
    label: "Docs (DevDocs)",
    description:
      "Look up official API documentation OFFLINE (DevDocs). Returns the real signature and a " +
      "short description for a symbol/function/method/CLI flag. Use it to CONFIRM a signature " +
      "before writing code instead of guessing. Docsets: python, bash, node, javascript, typescript, git.",
    promptSnippet: "Look up a real API signature offline (DevDocs) before guessing it",
    promptGuidelines: [
      "Before using an unfamiliar or uncertain stdlib/CLI signature, call docs to confirm it.",
      "Pass doc to scope the search (e.g. doc:'python'); omit doc to search all installed docsets.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Symbol / function / method / flag to look up, e.g. 'subprocess.run'." }),
      doc: Type.Optional(Type.String({ description: "Docset: python|bash|node|javascript|typescript|git. Omit to search all." })),
      limit: Type.Optional(Type.Number({ description: "Max entries to return (1-3, default 1)." })),
    }),
    async execute(_id, params, _signal, onUpdate, ctx) {
      const query = String(params.query ?? "").trim();
      if (!query) return { content: [{ type: "text", text: "docs: empty query." }] };
      const res = core.search(query, { doc: params.doc, limit: params.limit });
      onUpdate?.({ content: [{ type: "text", text: res.ok ? `✓ ${res.results[0].name}` : "✗ no match" }] });
      ctx.ui.setStatus("docs", res.ok ? `docs: ${res.results[0].docset}` : "docs: miss");
      return { content: [{ type: "text", text: core.render(res) }], details: { ok: res.ok } };
    },
  });

  // Active nudge: inject a docs-preference line into the system prompt for every model call, so a
  // weak model actually reaches for `docs` instead of guessing exact args/flags from memory. Chains
  // after other before_agent_start handlers (each sees the prior handler's systemPrompt). Only when
  // docsets are actually installed. Disable with PI_DOCS_NUDGE=0.
  if (process.env.PI_DOCS_NUDGE !== "0") {
    pi.on("before_agent_start", async (event) => {
      const installed = core.listInstalled();
      if (!installed.length) return;
      // Inject the procedure as a conversation MESSAGE (foreground), not system-prompt text
      // (background). On-device testing showed a 12B discounts the system prompt but acts on
      // recent conversation content — so this is the placement that actually drives the lookup.
      const content =
        `[docs tool — standing procedure for this task]\n` +
        `You have a \`docs\` tool with authoritative OFFLINE docs for: ${installed.join(", ")}. ` +
        `BEFORE you write any command or call that uses an exact flag, keyword-argument name, or ` +
        `format placeholder for one of those ecosystems (e.g. a git \`--pretty=format:\` specifier ` +
        `like %h/%an/%ar, a \`subprocess\`/\`argparse\` kwarg, a \`node:fs\` option), FIRST call \`docs\` ` +
        `to confirm the exact spelling — e.g. docs({doc:"git", query:"git log"}) — then write the code ` +
        `against what it returns. Do not write exact flag/kwarg/placeholder names from memory. ` +
        `(Plain prose, control flow, and obvious basics don't need a lookup.)`;
      return { message: { customType: "docs-nudge", content, display: false } };
    });
  }

  pi.on("session_start", async (_e, ctx) => {
    const n = core.listInstalled().length;
    ctx.ui.setStatus("docs", n ? `docs: ${n} docsets` : "docs: none (run devdocs-download.sh)");
  });
}
