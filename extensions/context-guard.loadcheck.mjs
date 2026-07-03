// Proves (a) the realpath→core import that context-guard.ts uses resolves and runs, and
// (b) context-guard.ts is structurally a Pi extension registering the context and
// session_before_compact handlers (v2: compaction rescue + floor-creep escape).
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(realpathSync(fileURLToPath(import.meta.url)));

// (a) same resolution context-guard.ts performs at runtime
const core = await import(pathToFileURL(join(here, "lib", "context-guard-core.mjs")).href);
assert.equal(typeof core.guard, "function", "core.guard must be importable via realpath");
assert.equal(typeof core.estimateTokens, "function");
assert.equal(typeof core.capResults, "function");
assert.equal(typeof core.elide, "function");
// v2 core surface (M3 rescue + M4 escape)
assert.equal(typeof core.estimateSummarizerInput, "function");
assert.equal(typeof core.wouldOverflow, "function");
assert.equal(typeof core.planRescue, "function");
assert.equal(typeof core.buildDigest, "function");
assert.equal(typeof core.harvestFiles, "function");
assert.equal(typeof core.compactionSummaryKey, "function");
assert.equal(typeof core.escapeDecision, "function");

// …and the core actually transforms: a minimal old-oversized-result conversation gets capped.
const c = { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } };
const msgs = [
  { role: "user", content: "go", timestamp: 1 },
  { role: "assistant", content: [c], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 }, stopReason: "toolUse", timestamp: 1 },
  { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "y".repeat(9000) }], isError: false, timestamp: 1 },
];
const res = core.guard(msgs, { keepRounds: 0 }, { capIds: new Set(), elideIds: new Set() });
assert.equal(res.changed, true, "guard must cap an old oversized result");
assert.match(res.messages[2].content[0].text, /context-guard/, "capped text must carry the marker");

// …and the v2 rescue path actually plans + digests: a mini entry list yields a real cut id and a
// bounded deterministic digest carrying the standing instruction.
const entries = [
  { type: "message", id: "e1", parentId: null, timestamp: "t", message: { role: "user", content: "build the thing", timestamp: 1 } },
  { type: "message", id: "e2", parentId: "e1", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "w".repeat(4000) }, { type: "toolCall", id: "c1", name: "write", arguments: { path: "a.py", content: "W".repeat(4000) } }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 }, stopReason: "toolUse", timestamp: 1 } },
  { type: "message", id: "e3", parentId: "e2", timestamp: "t", message: { role: "toolResult", toolCallId: "c1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false, timestamp: 1 } },
  { type: "message", id: "e4", parentId: "e3", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: 0 }, stopReason: "stop", timestamp: 1 } },
];
const plan = core.planRescue(entries, { keepRecentTokens: 10 });
assert.ok(plan && entries.some((e) => e.id === plan.firstKeptEntryId), "planRescue must pick a real entry id");
const digest = core.buildDigest(plan.elidedMessages, {});
assert.ok(digest.length < 8192, "digest must stay under 8K chars");
assert.match(digest, /Re-read PLAN\.md and NOTES\.md/, "digest must carry the standing instruction");
assert.equal(digest, core.buildDigest(plan.elidedMessages, {}), "digest must be deterministic");
// …and the escape latch fires exactly once per cycle.
const d1 = core.escapeDecision(undefined, { projected: 30000, threshold: 24576, summaryKey: "" });
const d2 = core.escapeDecision(d1.state, { projected: 30000, threshold: 24576, summaryKey: "" });
assert.ok(d1.fire && !d2.fire, "escape latch must fire once per cycle");

// (b) structural checks on the extension source
const src = readFileSync(join(here, "context-guard.ts"), "utf8");
assert.match(src, /export default async function/, "must have async default export");
assert.match(src, /pi\.on\(["']context["']/, "must register a context handler");
assert.match(src, /pi\.on\(["']session_before_compact["']/, "must register a session_before_compact handler (M3)");
assert.match(src, /realpathSync\(fileURLToPath\(import\.meta\.url\)\)/, "must resolve core via realpath");
assert.match(src, /PI_CTXGUARD\b/, "must be disable-able via PI_CTXGUARD=0");
assert.match(src, /PI_CTXGUARD_CAP/, "cap knob");
assert.match(src, /PI_CTXGUARD_KEEP/, "keep-rounds knob");
assert.match(src, /PI_CTXGUARD_AT/, "threshold knob");
assert.match(src, /PI_CTXGUARD_HEADROOM/, "headroom knob");
assert.match(src, /PI_CTXGUARD_ELIDE_TOOLS/, "elide-tools knob");
assert.match(src, /PI_CTXGUARD_COMPACT/, "escape-disable knob (M4)");
assert.match(src, /PI_CTXGUARD_ESCAPE/, "escape-threshold knob (M4)");
assert.match(src, /PI_CTXGUARD_QUIET/, "quiet knob");
assert.match(src, /reserveTokens/, "must read compaction.reserveTokens from settings.json");
assert.match(src, /keepRecentTokens/, "must read compaction.keepRecentTokens from settings.json");
assert.match(src, /ctx\.compact\(/, "M4 must fire Pi's compaction via ctx.compact");
assert.match(src, /pi\.sendUserMessage\(/, "M4 must re-drive the run via pi.sendUserMessage");
assert.match(src, /catch\s*\{\s*\n?\s*return undefined/, "handler body must fail-soft to undefined");
assert.match(src, /contextWindow\s*\|\|\s*32768/, "must fall back to a 32768 context window");

console.log("context-guard.ts loadcheck: OK");
