// context-guard-core.test.mjs — unit + replay suite for the mid-run context guard.
// Run: node --test extensions/lib/context-guard-core.test.mjs
//
// The replay tests drive the ANONYMIZED real failing sessions in __fixtures__/sessions/
// (regenerate with eval/make-ctxguard-fixture.py — strings are filled; lengths track the
// real run's within a few percent (JSON-escape overhead isn't reproduced) while every count,
// usage number and message shape is the real run's), proving the guard would have kept
// those exact runs below the observed death point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  estimateTokens, messageChars, resultTextChars, annotateRounds,
  capResults, elide, guard,
  serializedChars, estimateSummarizerInput, wouldOverflow, piMessageTokens, planRescue,
  harvestFiles, buildDigest, compactionSummaryKey, escapeDecision,
} from "./context-guard-core.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__", "sessions");

// ---------------------------------------------------------------- builders

let _id = 0;
const tid = () => `tc${++_id}`;
const usage = (total) => ({ input: total - 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost: 0 });
const user = (text) => ({ role: "user", content: text, timestamp: 1 });
const call = (name, args, id = tid()) => ({ type: "toolCall", id, name, arguments: args });
const asst = (calls, o = {}) => ({
  role: "assistant",
  content: [{ type: "text", text: o.text ?? "ok" }, ...calls],
  usage: o.usage ?? usage(o.total ?? 1000),
  stopReason: o.stopReason ?? (calls.length ? "toolUse" : "stop"),
  timestamp: 1,
});
const result = (id, text, o = {}) => ({
  role: "toolResult", toolCallId: id, toolName: o.toolName ?? "bash",
  content: [{ type: "text", text }], isError: o.isError ?? false, timestamp: 1,
});

// conv(rounds): [user, (assistant+toolResult)*] — one toolCall per round.
// round spec: { tool, args, resText, isError, total (assistant usage.totalTokens) }
function conv(rounds) {
  const msgs = [user("do the thing")];
  for (const r of rounds) {
    const c = call(r.tool ?? "bash", r.args ?? { command: "ls -la" });
    msgs.push(asst([c], { total: r.total ?? 1000 }));
    msgs.push(result(c.id, r.resText ?? "ok", { toolName: r.tool ?? "bash", isError: r.isError }));
  }
  return msgs;
}
const emptySticky = () => ({ capIds: new Set(), elideIds: new Set() });
const mergeSticky = (s, actions) => {
  for (const id of actions.capped) s.capIds.add(id);
  for (const t of actions.elided) s.elideIds.add(t);
};
const totalChars = (msgs) => msgs.reduce((n, m) => n + messageChars(m), 0);
const OPTS = { contextWindow: 32768, elideAt: 16384, headroom: 6144 }; // the shipped defaults

// ---------------------------------------------------------------- estimate math

test("estimateTokens: no valid assistant -> ceil(chars/4)", () => {
  assert.equal(estimateTokens([user("a".repeat(101))]), Math.ceil(101 / 4));
});

test("estimateTokens: anchors on last valid assistant usage + ceil(tail chars/4)", () => {
  const c = call("bash", { command: "ls" });
  const msgs = [user("a".repeat(100)), asst([c], { total: 5000 }), result(c.id, "b".repeat(333))];
  assert.equal(estimateTokens(msgs), 5000 + Math.ceil(messageChars(msgs[2]) / 4));
  assert.equal(messageChars(msgs[2]), 333);
});

test("estimateTokens: skips error/aborted/zero-usage assistants (their chars count as tail)", () => {
  const c = call("bash", { command: "ls" });
  const base = [user("u"), asst([c], { total: 5000 }), result(c.id, "b".repeat(333))];
  const errA = { ...asst([], { total: 9000, text: "c".repeat(40) }), stopReason: "error" };
  assert.equal(estimateTokens([...base, errA]), 5000 + Math.ceil((333 + 40) / 4));
  const abortA = { ...asst([], { total: 9000, text: "c".repeat(40) }), stopReason: "aborted" };
  assert.equal(estimateTokens([...base, abortA]), 5000 + Math.ceil((333 + 40) / 4));
  const zeroA = asst([], { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 }, text: "c".repeat(40) });
  assert.equal(estimateTokens([...base, zeroA]), 5000 + Math.ceil((333 + 40) / 4));
});

test("estimateTokens: falls back to input+output+cacheRead+cacheWrite when totalTokens is 0", () => {
  const a = asst([], { usage: { input: 100, output: 50, cacheRead: 25, cacheWrite: 0, totalTokens: 0, cost: 0 } });
  assert.equal(estimateTokens([user("u"), a]), 175);
});

// ---------------------------------------------------------------- rounds

test("annotateRounds: assistant-with-toolCalls starts a round; its results join it", () => {
  const msgs = conv([{}, {}, {}]);
  const { roundOf, totalRounds } = annotateRounds(msgs);
  assert.equal(totalRounds, 3);
  assert.deepEqual(roundOf, [-1, 0, 0, 1, 1, 2, 2]);
});

// ---------------------------------------------------------------- M1: age-gated result cap

test("capResults: old oversized result gets head+tail cap with the truncation marker", () => {
  const rounds = [{ resText: "R".repeat(9000) }, {}, {}, {}, {}, {}]; // round 0 old (keep 4 of 6)
  const msgs = conv(rounds);
  const { messages: out, newlyCapped } = capResults(msgs, OPTS, new Set());
  const t = out[2].content[0].text;
  assert.equal(newlyCapped.length, 1);
  assert.ok(t.startsWith("R".repeat(100)));
  assert.ok(t.endsWith("R".repeat(100)));
  assert.match(t, /\[context-guard: 1320 chars truncated — re-run the tool \(narrower\) if you need the full output\]/);
  assert.ok(t.length < 9000 && t.length < 8192);
  assert.notEqual(out, msgs);          // copy-on-write: new array…
  assert.equal(out[1], msgs[1]);       // …untouched entries keep identity
});

test("capResults: fresh oversized / old small / old error-below-1.5x results untouched", () => {
  const msgs = conv([
    { resText: "s".repeat(500) },                          // old, small
    { resText: "E".repeat(10000), isError: true },         // old, error, 10000 <= 12288
    {}, {}, {}, {},
  ]);
  msgs.push(...conv([{ resText: "F".repeat(9000) }]).slice(1)); // extra fresh round, oversized
  const r = capResults(msgs, OPTS, new Set());
  assert.equal(r.messages, msgs); // same array reference: nothing changed at all
  assert.deepEqual(r.newlyCapped, []);
});

test("capResults: old isError result above 1.5x cap IS capped", () => {
  const msgs = conv([{ resText: "E".repeat(13000), isError: true }, {}, {}, {}, {}, {}]);
  const r = capResults(msgs, OPTS, new Set());
  assert.deepEqual(r.newlyCapped, [msgs[2].toolCallId]);
  assert.equal(r.messages[2].isError, true); // isError never touched
});

test("capResults: sticky ids re-applied regardless of age, without re-reporting", () => {
  const msgs = conv([{}, { resText: "R".repeat(9000) }]); // 2 rounds — ALL fresh (keep 4)
  const sticky = new Set([msgs[4].toolCallId]);
  const r = capResults(msgs, OPTS, sticky);
  assert.match(r.messages[4].content[0].text, /chars truncated/);
  assert.deepEqual(r.newlyCapped, []); // sticky re-application is not a new action
  assert.equal(r.savedChars, 0);       // …and is never credited (already in the anchor usage)
});

// ---------------------------------------------------------------- M2: threshold elision

test("elide: below elideAt does nothing new (sticky still re-applied)", () => {
  const msgs = conv([
    { tool: "write", args: { path: "a.py", content: "W".repeat(3000) } },
    {}, {}, {}, {}, { total: 8000 },
  ]);
  const r = elide(msgs, OPTS, new Set());
  assert.equal(r.messages, msgs);
  assert.deepEqual(r.newlyElided, []);
  const sticky = new Set([`args:${msgs[1].content[1].id}`]);
  const r2 = elide(msgs, OPTS, sticky);
  assert.match(r2.messages[1].content[1].arguments.content, /3000 chars elided — content persisted on disk/);
  assert.deepEqual(r2.newlyElided, []);
});

test("elide pass 1: old write/edit bodies elided oldest-first; short props + fresh calls verbatim", () => {
  const msgs = conv([
    { tool: "write", args: { path: "a.py", content: "W".repeat(3000) } },
    { tool: "edit", args: { path: "b.py", oldText: "O".repeat(2000), newText: "N".repeat(2000) } },
    { tool: "read", args: { path: "c".repeat(1000) } },   // old but NOT in elideTools
    {}, {},
    { tool: "write", args: { path: "d.py", content: "F".repeat(3000) } }, // fresh
    { total: 20000 },
  ]);
  const r = elide(msgs, OPTS, new Set());
  const w = r.messages[1].content[1].arguments;
  assert.equal(w.path, "a.py"); // short prop verbatim
  assert.match(w.content, /^\[context-guard: 3000 chars elided — content persisted on disk at time of call\]$/);
  const e = r.messages[3].content[1].arguments;
  assert.match(e.oldText, /2000 chars elided/);
  assert.match(e.newText, /2000 chars elided/);
  assert.equal(r.messages[5], msgs[5]);                          // read call untouched (not in elideTools)
  assert.deepEqual(r.messages[11], msgs[11]);                    // fresh write untouched
  assert.deepEqual(r.newlyElided.filter((t) => t.startsWith("args:")).length, 2);
});

test("elide: stops oldest-first once projected <= elideAt - headroom", () => {
  // savings per write ≈ (5000+"" quotes) − stub ≈ ~4900 chars ≈ ~1230 tok; need 1016 -> ONE suffices
  const msgs = conv([
    { tool: "write", args: { path: "a.py", content: "W".repeat(5000) } },
    { tool: "write", args: { path: "b.py", content: "W".repeat(5000) } },
    {}, {}, {}, {},
    { total: 17000 },
  ]);
  const r = elide(msgs, { ...OPTS, headroom: 400 }, new Set()); // target = 15984, need (17000-15984)*4
  assert.equal(r.newlyElided.length, 1);
  assert.match(r.messages[1].content[1].arguments.content, /chars elided/);
  assert.equal(r.messages[3], msgs[3]); // second old write untouched — target already reached
  assert.ok(r.projected <= 15984, `projected ${r.projected}`);
});

test("elide pass 2: old toolResults stubbed to first 200 chars when args aren't enough", () => {
  const msgs = conv([
    { resText: "A".repeat(3000) },  // old, below cap -> M1 skips, M2 stubs
    { resText: "B".repeat(3000) },
    {}, {}, {}, {},
    { total: 25000 },
  ]);
  const r = elide(msgs, OPTS, new Set());
  const t = r.messages[2].content[0].text;
  assert.ok(t.startsWith("A".repeat(200)));
  assert.match(t, /\[context-guard: 2800 chars elided — re-run the tool if you need the full output\]/);
  assert.ok(t.length < 400);
  assert.deepEqual(r.newlyElided, [`result:${msgs[2].toolCallId}`, `result:${msgs[4].toolCallId}`]);
  assert.equal(r.messages[8], msgs[8]); // fresh results untouched
});

// ---------------------------------------------------------------- guard: composition + invariants

function bigConv() {
  // 8 rounds: 0-3 old, 4-7 fresh; anchor high enough that M2 fires (but below the valve cliff).
  return conv([
    { tool: "write", args: { path: "a.py", content: "W".repeat(6000) }, resText: "r".repeat(9000) },
    { tool: "edit", args: { path: "b.py", oldText: "O".repeat(4000), newText: "N".repeat(4000) }, resText: "r".repeat(3000) },
    { resText: "x".repeat(12000) },
    { resText: "y".repeat(700) },
    { tool: "write", args: { path: "f.py", content: "F".repeat(6000) }, resText: "fresh".repeat(400) },
    {}, {},
    { resText: "z".repeat(9000), total: 24000 },
  ]);
}

test("guard: pairing/count/order preserved; protected roles+fields byte-identical", () => {
  const msgs = bigConv();
  msgs.splice(1, 0, { role: "custom", customType: "docs-nudge", content: "n".repeat(5000), timestamp: 1 });
  const res = guard(msgs, OPTS, emptySticky());
  assert.equal(res.messages.length, msgs.length);
  msgs.forEach((m, i) => {
    const o = res.messages[i];
    assert.equal(o.role, m.role);
    if (m.role === "toolResult") {
      assert.equal(o.toolCallId, m.toolCallId);
      assert.equal(o.toolName, m.toolName);
      assert.equal(o.isError, m.isError);
    }
    if (m.role === "assistant") {
      assert.deepEqual(
        o.content.filter((b) => b.type === "toolCall").map((b) => [b.id, b.name]),
        m.content.filter((b) => b.type === "toolCall").map((b) => [b.id, b.name]));
      assert.equal(o.content[0].text, m.content[0].text); // assistant text blocks untouched
      assert.deepEqual(o.usage, m.usage);
    }
    if (m.role === "user" || m.role === "custom") assert.deepEqual(o, m);
  });
  // every toolResult still pairs with a toolCall on the assistant side
  const callIds = new Set(res.messages.flatMap((m) =>
    m.role === "assistant" ? m.content.filter((b) => b.type === "toolCall").map((b) => b.id) : []));
  for (const m of res.messages) if (m.role === "toolResult") assert.ok(callIds.has(m.toolCallId));
});

test("guard: the last keepRounds rounds are never touched (no emergency)", () => {
  const msgs = bigConv();
  const res = guard(msgs, OPTS, emptySticky());
  const { roundOf, totalRounds } = annotateRounds(msgs);
  msgs.forEach((m, i) => {
    if (roundOf[i] >= totalRounds - 4) assert.deepEqual(res.messages[i], m, `fresh msg ${i} touched`);
  });
  assert.ok(res.changed);
  assert.ok(res.projectedAfter < res.projectedBefore);
});

test("guard: idempotent — output is a fixed point given the merged sticky sets", () => {
  const msgs = bigConv(); // anchor 24000 -> target 10240 unreachable: everything old gets processed
  const sticky = emptySticky();
  const r1 = guard(msgs, OPTS, sticky);
  mergeSticky(sticky, r1.actions);
  // (a) re-run on the ORIGINAL full history + sticky (the live-run shape every round)
  const r2 = guard(msgs, OPTS, sticky);
  assert.deepEqual(r2.messages, r1.messages);
  assert.deepEqual(r2.actions, { capped: [], elided: [] });
  // (b) re-run on the transformed OUTPUT + sticky (guard(guard(x)) === guard(x))
  const r3 = guard(r1.messages, OPTS, sticky);
  assert.deepEqual(r3.messages, r1.messages);
  assert.deepEqual(r3.actions, { capped: [], elided: [] });
});

test("guard: sticky monotonicity — once elided, stays elided even when usage drops below elideAt", () => {
  const msgs = bigConv();
  const sticky = emptySticky();
  mergeSticky(sticky, guard(msgs, OPTS, sticky).actions);
  assert.ok(sticky.elideIds.size > 0 && sticky.capIds.size > 0);
  // simulate post-recovery: same history, low anchor (e.g. after a cheap round)
  const low = msgs.map((m) => (m.role === "assistant" ? { ...m, usage: usage(6000) } : m));
  const res = guard(low, OPTS, sticky);
  assert.deepEqual(res.actions, { capped: [], elided: [] }); // nothing NEW…
  const oldWriteArgs = res.messages[1].content[1].arguments;
  assert.match(oldWriteArgs.content, /chars elided/);        // …but sticky transforms still applied
  assert.match(res.messages[2].content[0].text, /context-guard/);
});

test("guard: emergency valve caps FRESH oversized results near the zero-cliff", () => {
  // est = anchor 20000 + 40000/4 tail = 30000 >= cliff (32768-4096-2048 = 26624)
  const msgs = conv([{ resText: "H".repeat(40000), total: 20000 }]); // 1 round: fresh by definition
  const res = guard(msgs, OPTS, emptySticky());
  const t = res.messages[2].content[0].text;
  assert.match(t, /chars truncated/);
  assert.ok(t.length < 8192);
  assert.deepEqual(res.actions.capped, [msgs[2].toolCallId]);
  assert.ok(res.projectedAfter < 26624, `projectedAfter ${res.projectedAfter}`);
  // same shape but comfortably below the cliff (10000 + 10000 tail): fresh read stays pristine
  const calm = conv([{ resText: "H".repeat(40000), total: 10000 }]);
  const res2 = guard(calm, OPTS, emptySticky());
  assert.equal(res2.messages, calm);
});

test("guard: valve ignores fresh results at/below 4x cap", () => {
  const msgs = conv([{ resText: "H".repeat(30000), total: 27000 }]); // 30000 <= 32768
  const res = guard(msgs, OPTS, emptySticky());
  assert.equal(res.messages, msgs);
});

// ---------------------------------------------------------------- replay of the REAL failing runs

const DEATH = 28672; // window 32768 - 4096: every request (incl. compaction's) clamps to ~1 token

// Session records -> AgentMessage array, stopping at the first compaction record (after it Pi
// rebuilds the request from the summary — the mid-run growth we replay all happens before it).
function loadFixtureMessages(name) {
  const msgs = [];
  for (const line of readFileSync(join(FIX, name), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.type === "compaction") break;
    if (r.type === "message") msgs.push(r.message);
    else if (r.type === "custom_message") {
      msgs.push({ role: "custom", customType: r.customType, content: r.content, timestamp: r.timestamp });
    }
  }
  return msgs;
}

// Provider-request points: before every assistant message, plus the request that would follow the
// final message (the one the real run died on).
function requestPoints(msgs) {
  const pts = [];
  msgs.forEach((m, i) => { if (m.role === "assistant") pts.push(i); });
  pts.push(msgs.length);
  return pts;
}

for (const name of ["run1.jsonl", "run2.jsonl"]) {
  test(`replay ${name}: untransformed run exceeds the death point (fixture reproduces the failure)`, () => {
    const msgs = loadFixtureMessages(name);
    const worst = Math.max(...requestPoints(msgs).map((i) => estimateTokens(msgs.slice(0, i))));
    assert.ok(worst >= DEATH, `untransformed peak ${worst} should reach the observed death point`);
  });

  test(`replay ${name}: guarded, every request point stays below the death point`, () => {
    const msgs = loadFixtureMessages(name);
    const sticky = emptySticky();
    const seen = new Set(); // oscillation check: an id may be acted on at most once per action kind
    let worstGuarded = 0;
    for (const i of requestPoints(msgs)) {
      const prefix = msgs.slice(0, i);
      const res = guard(prefix, OPTS, sticky);
      mergeSticky(sticky, res.actions);
      for (const id of [...res.actions.capped.map((x) => `cap:${x}`), ...res.actions.elided]) {
        assert.ok(!seen.has(id), `id ${id} re-actioned — sticky oscillation`);
        seen.add(id);
      }
      // Fixture anchors are the UNTRANSFORMED run's usage, so simulate the guarded context as
      // (untransformed estimate) - (all chars the guard removed)/4 — what the provider would price.
      const saved = totalChars(prefix) - totalChars(res.messages);
      assert.ok(saved >= 0);
      const simulated = estimateTokens(prefix) - Math.ceil(saved / 4);
      worstGuarded = Math.max(worstGuarded, simulated);
      assert.ok(simulated < DEATH, `request @${i}: simulated ${simulated} >= ${DEATH}`);
    }
    // and the guard must have actually mattered at the peak, not squeaked by on rounding
    const worstRaw = Math.max(...requestPoints(msgs).map((i) => estimateTokens(msgs.slice(0, i))));
    assert.ok(worstGuarded <= worstRaw - 2000,
      `guarded peak ${worstGuarded} not meaningfully below raw peak ${worstRaw}`);
  });
}

// ---------------------------------------------------------------- v2 M3: compaction rescue

// Full branch-entry loader (rescue tests need SessionEntry shape, ids included — unlike
// loadFixtureMessages, which flattens to AgentMessages and stops at the first compaction).
function loadFixtureEntries(name) {
  const entries = [];
  for (const line of readFileSync(join(FIX, name), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line);
    if (r.type === "session") continue; // header is not a branch entry
    entries.push(r);
  }
  return entries;
}
const firstUserText = (msgs) => {
  for (const m of msgs) {
    if (m?.role !== "user") continue;
    const c = m.content;
    return typeof c === "string" ? c
      : c.filter((b) => b?.type === "text").map((b) => b.text).join("");
  }
  return "";
};

test("serializedChars: honors Pi's 2000-char per-tool-result serializer cap", () => {
  const big = result("t1", "R".repeat(100000));
  const atCap = result("t2", "R".repeat(2000));
  // the 100K result serializes as 2000 chars + truncation marker, NOT 100K
  assert.ok(serializedChars(big) < serializedChars(atCap) + 100,
    `capped ${serializedChars(big)} vs at-cap ${serializedChars(atCap)}`);
  assert.ok(serializedChars(big) >= serializedChars(atCap));
  // and the cap flows through the input estimate: same history, ±98K result chars ≈ same tokens
  const mk = (n) => conv([{ resText: "R".repeat(n) }]);
  const eBig = estimateSummarizerInput({ messagesToSummarize: mk(100000) });
  const eCap = estimateSummarizerInput({ messagesToSummarize: mk(2000) });
  assert.ok(eBig.maxRequestTokens - eCap.maxRequestTokens < 30,
    `estimate must not grow past the serializer cap (${eBig.maxRequestTokens} vs ${eCap.maxRequestTokens})`);
});

test("wouldOverflow: true at run3 scale on a 32K window, false for a small history", () => {
  const entries = loadFixtureEntries("run3.jsonl");
  const plan = planRescue(entries, { keepRecentTokens: 3000 });
  assert.ok(plan, "run3 must yield a rescue plan");
  const est = estimateSummarizerInput({ messagesToSummarize: plan.elidedMessages });
  assert.ok(est.maxRequestTokens > 32768, // the live 400: ~45K tok of input on a 32K window
    `run3 summarizer input ~${est.maxRequestTokens} tok should not even fit the whole window`);
  assert.equal(wouldOverflow(est.maxRequestTokens, 32768), true);
  assert.equal(wouldOverflow(est.maxRequestTokens, 131072), false); // fine on a 128K window
  const small = estimateSummarizerInput({ messagesToSummarize: conv([{}, {}, {}]) });
  assert.equal(wouldOverflow(small.maxRequestTokens, 32768), false);
  // split turn = TWO parallel requests; the binding number is the max, not the sum
  const both = estimateSummarizerInput({
    messagesToSummarize: conv([{ resText: "a".repeat(4000) }]),
    turnPrefixMessages: conv([{ resText: "b".repeat(8000) }]),
  });
  assert.equal(both.maxRequestTokens, Math.max(both.historyTokens, both.turnPrefixTokens));
});

test("planRescue: mirrors the keepRecent walk exactly on uniform synthetic entries", () => {
  // user + 10 rounds; every message is 400 chars = 100 Pi-tokens. keepRecent 1000 -> the walk
  // stops on the 10th message from the end (assistant of round 5), a valid cut point itself.
  const entries = [{ type: "message", id: "u", parentId: null, timestamp: "t",
    message: user("U".repeat(400)) }];
  for (let r = 0; r < 10; r++) {
    // exact 400-char accounting per assistant: name(4) + JSON({"command":"x"*382}) (396) = 400
    const a = {
      role: "assistant",
      content: [{ type: "toolCall", id: `c${r}`, name: "bash", arguments: { command: "x".repeat(382) } }],
      usage: usage(1000), stopReason: "toolUse", timestamp: 1,
    };
    entries.push({ type: "message", id: `a${r}`, parentId: "p", timestamp: "t", message: a });
    entries.push({ type: "message", id: `t${r}`, parentId: "p", timestamp: "t",
      message: result(`c${r}`, "R".repeat(400)) });
  }
  for (const e of entries) {
    assert.equal(piMessageTokens(e.message), 100, `uniform sizing broke for ${e.id}`);
  }
  const plan = planRescue(entries, { keepRecentTokens: 1000 });
  // backward walk: t9,a9,...,t5 = 900 tok; a5 makes 1000 -> stop at a5; a5 IS a cut point.
  assert.equal(plan.firstKeptEntryId, "a5");
  assert.equal(plan.keptTokens, 1000); // a5..t9 = 10 messages x 100 tok
  assert.equal(plan.elidedMessages.length, 11); // user + rounds 0-4
});

test("planRescue on run3: real entry id, never a toolResult cut, ~keepRecentTokens of tail", () => {
  const entries = loadFixtureEntries("run3.jsonl");
  const plan = planRescue(entries, { keepRecentTokens: 3000 });
  assert.ok(plan);
  const cutEntry = entries.find((e) => e.id === plan.firstKeptEntryId);
  assert.ok(cutEntry, "firstKeptEntryId must exist in the entries");
  assert.equal(entries[plan.cutIndex], cutEntry);
  if (cutEntry.type === "message") {
    assert.notEqual(cutEntry.message.role, "toolResult", "must never cut at a toolResult");
  }
  // the kept tail is ~keepRecentTokens: at least the budget minus one message either side of the
  // stop index, at most the budget plus the message the walk stopped on.
  const msgTokens = entries.filter((e) => e.type === "message").map((e) => piMessageTokens(e.message));
  const biggest = Math.max(...msgTokens);
  assert.ok(plan.keptTokens <= 3000 + biggest, `kept ${plan.keptTokens} tok overshoots the budget`);
  assert.ok(plan.keptTokens >= 3000 - biggest, `kept ${plan.keptTokens} tok undershoots the budget`);
  // and everything before the cut is in the digest span (one user + 100+ rounds of it)
  assert.ok(plan.elidedMessages.length > 200, `elided span ${plan.elidedMessages.length} msgs`);
});

test("digest from run3: <8K chars, deterministic, task prefix + files section + instruction", () => {
  const entries = loadFixtureEntries("run3.jsonl");
  const plan = planRescue(entries, { keepRecentTokens: 3000 });
  const d1 = buildDigest(plan.elidedMessages, {});
  const d2 = buildDigest(plan.elidedMessages, {});
  assert.equal(d1, d2, "digest must be deterministic");
  assert.ok(d1.length < 8192, `digest ${d1.length} chars must stay under 8K`);
  const task = firstUserText(plan.elidedMessages);
  assert.ok(task.length > 0 && d1.includes(task.slice(0, 300)), "digest must carry the task prefix");
  assert.match(d1, /## Files created\/modified/, "digest must carry a files-touched section");
  assert.match(d1, /Re-read PLAN\.md and NOTES\.md/, "digest must carry the standing instruction");
  assert.match(d1, /## Standing instruction\n[^]*$/, "instruction must close the digest");
  // the files section reflects the span's write/edit calls (run3 has 63 writes + 12 edits)
  const files = harvestFiles(plan.elidedMessages);
  assert.ok(files.modified.length > 0);
});

test("digest is bounded <8K even for a monster synthetic history", () => {
  const rounds = Array.from({ length: 300 }, (_, i) => ({
    tool: "write",
    args: { path: `/deep/dir/${i}/${"n".repeat(60)}/file${i}.py`, content: "W".repeat(5000) },
    resText: i % 7 === 0 ? "E".repeat(3000) : "ok",
    isError: i % 7 === 0,
  }));
  const msgs = conv(rounds);
  msgs[0] = user("T".repeat(100000)); // 100K-char task prompt
  const d = buildDigest(msgs, {});
  assert.ok(d.length < 8192, `digest ${d.length} chars must stay under 8K`);
  assert.match(d, /…and \d+ more/, "overflowing file list must be elided with a count");
  assert.match(d, /Re-read PLAN\.md and NOTES\.md[^]*$/m, "instruction survives the trim");
  assert.equal(d, buildDigest(msgs, {}));
});

test("digest key outcomes: last verify result and last error result, capped", () => {
  const msgs = conv([
    { tool: "write", args: { path: "app.py", content: "W".repeat(500) } },
    { tool: "verify", args: { command: "pytest" }, resText: "3 passed, 1 failed: test_x" },
    { resText: "Traceback: " + "e".repeat(2000), isError: true },
    { tool: "verify", args: { command: "pytest" }, resText: "ALL 4 TESTS PASSED" },
    {},
  ]);
  const d = buildDigest(msgs, {});
  assert.match(d, /## Key outcomes/);
  assert.ok(d.includes("ALL 4 TESTS PASSED"), "must carry the LAST verify result");
  assert.ok(!d.includes("3 passed, 1 failed"), "earlier verify results are not the outcome");
  assert.ok(d.includes("Traceback: "), "must carry the last error result");
  assert.ok(!d.includes("e".repeat(600)), "error text must be capped (500)");
  assert.ok(d.includes("app.py"), "files section lists the write path");
});

// ---------------------------------------------------------------- v2 M4: floor-creep escape

test("escapeDecision: fires only at/over threshold, once per latch cycle", () => {
  const T = 24576;
  // below threshold: never fires, latch stays released
  let d = escapeDecision(undefined, { projected: T - 1, threshold: T, summaryKey: "" });
  assert.equal(d.fire, false);
  d = escapeDecision(d.state, { projected: T, threshold: T, summaryKey: "" });
  assert.equal(d.fire, true, "must fire at the threshold");
  // armed: same cycle, still over threshold -> silent (no ctx.compact retry-loop)
  d = escapeDecision(d.state, { projected: T + 5000, threshold: T, summaryKey: "" });
  assert.equal(d.fire, false, "must fire only once per cycle");
  d = escapeDecision(d.state, { projected: T + 5000, threshold: T, summaryKey: "" });
  assert.equal(d.fire, false);
});

test("escapeDecision: latch resets when a NEW compactionSummary lands (and only then)", () => {
  const T = 24576;
  const key0 = compactionSummaryKey([user("u")]); // no summary yet
  assert.equal(key0, "");
  let d = escapeDecision(undefined, { projected: T + 1, threshold: T, summaryKey: key0 });
  assert.equal(d.fire, true);
  // compaction lands -> history now carries a compactionSummary -> new cycle
  const compacted = [{ role: "compactionSummary", summary: "s".repeat(400), tokensBefore: 30000, timestamp: 99 }, user("resume")];
  const key1 = compactionSummaryKey(compacted);
  assert.notEqual(key1, key0);
  d = escapeDecision(d.state, { projected: T - 1000, threshold: T, summaryKey: key1 });
  assert.equal(d.fire, false, "released but below threshold");
  d = escapeDecision(d.state, { projected: T + 1, threshold: T, summaryKey: key1 });
  assert.equal(d.fire, true, "new cycle may fire again");
  // the SAME old summary key does NOT release the latch (an onError must not retry-loop)
  d = escapeDecision(d.state, { projected: T + 1, threshold: T, summaryKey: key1 });
  assert.equal(d.fire, false);
});

// ---------------------------------------------------------------- replay of the run3 live run

// run3 differs from run1/run2: the guard v1 WAS live during it (its usage anchors are the guarded
// run's), so the raw estimate is itself the guarded trajectory — the replay proves it stays below
// the death point at every request point and that re-guarding only ever lowers it, sticky-stable.
test("replay run3.jsonl: guarded trajectory stays below the death point at every request point", () => {
  const msgs = loadFixtureMessages("run3.jsonl");
  assert.ok(msgs.length > 240, "run3 must be the 124-round session");
  const sticky = emptySticky();
  const seen = new Set();
  for (const i of requestPoints(msgs)) {
    const prefix = msgs.slice(0, i);
    const res = guard(prefix, OPTS, sticky);
    mergeSticky(sticky, res.actions);
    for (const id of [...res.actions.capped.map((x) => `cap:${x}`), ...res.actions.elided]) {
      assert.ok(!seen.has(id), `id ${id} re-actioned — sticky oscillation`);
      seen.add(id);
    }
    const saved = totalChars(prefix) - totalChars(res.messages);
    assert.ok(saved >= 0);
    const live = estimateTokens(prefix); // anchors are the live guarded run's usage
    assert.ok(live < DEATH, `request @${i}: live guarded estimate ${live} >= ${DEATH}`);
    const replayed = live - Math.ceil(saved / 4);
    assert.ok(replayed < DEATH, `request @${i}: replayed ${replayed} >= ${DEATH}`);
  }
});

// ---------------------------------------------------------------- post-review regressions

const wellFormed = (s) =>
  typeof s.isWellFormed === "function"
    ? s.isWellFormed()
    : !/[\ud800-\udbff](?![\udc00-\udfff])|(?:^|[^\ud800-\udbff])[\udc00-\udfff]/.test(s);

test("cap never splits a surrogate pair (odd-aligned astral text)", () => {
  const id = tid();
  const msgs = [
    user("go"),
    asst([call("bash", { cmd: "x" }, id)], { total: 1000 }),
    { role: "toolResult", toolCallId: id, toolName: "bash", isError: false, timestamp: 2,
      content: [{ type: "text", text: "a" + "\u{1F600}".repeat(6000) }] },
    // 5 fresh rounds so the big result is old
    ...Array.from({ length: 5 }, () => {
      const i = tid();
      return [asst([call("ls", { p: "." }, i)], { total: 1200 }),
        { role: "toolResult", toolCallId: i, toolName: "ls", isError: false, timestamp: 3,
          content: [{ type: "text", text: "ok" }] }];
    }).flat(),
  ];
  const r = capResults(msgs, {}, new Set());
  assert.ok(r.newlyCapped.length === 1, "oversized astral result must be capped");
  for (const m of r.messages) {
    if (m.role !== "toolResult") continue;
    for (const b of m.content) if (b.type === "text") assert.ok(wellFormed(b.text), "capped text must be well-formed UTF-16");
  }
});

test("M2 stub never splits a surrogate pair", () => {
  const id = tid();
  const msgs = [
    user("go"),
    asst([call("bash", { cmd: "x" }, id)], { total: 1000 }),
    { role: "toolResult", toolCallId: id, toolName: "bash", isError: false, timestamp: 2,
      content: [{ type: "text", text: "a" + "\u{1F600}".repeat(3000) }] },
    ...Array.from({ length: 5 }, () => {
      const i = tid();
      return [asst([call("ls", { p: "." }, i)], { total: 1500 }),
        { role: "toolResult", toolCallId: i, toolName: "ls", isError: false, timestamp: 3,
          content: [{ type: "text", text: "ok" }] }];
    }).flat(),
    asst([], { total: 30000, text: "over threshold" }),
  ];
  const r = elide(msgs, {}, new Set());
  for (const m of r.messages) {
    if (m.role !== "toolResult") continue;
    for (const b of m.content) if (b.type === "text") assert.ok(wellFormed(b.text), "stubbed text must be well-formed UTF-16");
  }
});

// ------------------------------------------- M4 machine-gun regression (stale post-compaction anchor)
//
// Verified failure: M4 fires -> compaction lands -> the resume run's FIRST context event still
// projects >= threshold because the kept assistant's usage prices the OLD pre-compaction context,
// while the new compactionSummary changes the latch key and releases it -> ctx.compact refires,
// aborts the guard's own resume, throws 'Nothing to compact', and the session strands idle.
// Two independent fixes, both pinned here: estimateTokens skips stale pre-compaction anchors
// (Pi's own rule), and escapeDecision releases only when the projection is really back under
// the threshold (hysteresis).

test("estimateTokens: skips stale pre-compaction usage anchors (kept assistant after a landed compaction)", () => {
  const c = call("bash", { command: "ls" });
  const keptAsst = { ...asst([c], { total: 24800 }), timestamp: 1000 }; // usage prices the OLD context
  const keptRes = { ...result(c.id, "r".repeat(400)), timestamp: 1001 };
  const summaryMsg = { role: "compactionSummary", summary: "s".repeat(4000), tokensBefore: 24950, timestamp: 2000 };
  const resume = { ...user("Context was compacted mid-task. Re-read PLAN.md and NOTES.md."), timestamp: 2001 };
  const compacted = [summaryMsg, keptAsst, keptRes, resume];
  // no usable anchor -> honest chars/4 of the compacted history, nowhere near 24800
  const charsOnly = Math.ceil(compacted.reduce((n, m) => n + messageChars(m), 0) / 4);
  assert.equal(estimateTokens(compacted), charsOnly, "stale anchor must be skipped");
  assert.ok(charsOnly < 5000, `post-compaction estimate ${charsOnly} must reflect the compacted context`);
  // an assistant that answered AFTER the compaction anchors normally again
  const fresh = { ...asst([], { total: 4200 }), timestamp: 2100 };
  assert.equal(estimateTokens([...compacted, fresh]), 4200);
  // and with no compactionSummary in history the pre-v2 behavior is untouched
  assert.equal(estimateTokens([user("u"), keptAsst, keptRes]),
    24800 + Math.ceil(messageChars(keptRes) / 4));
});

test("escapeDecision: key change with a still-high projection must NOT release (no resume machine-gun)", () => {
  const T = 24576;
  // fire #1 mid-run (the finding's numbers)
  let d = escapeDecision(undefined, { projected: 24950, threshold: T, summaryKey: "" });
  assert.equal(d.fire, true);
  // compaction lands -> key changes, but a stale anchor keeps the projection at 24969: a release
  // here would refire ctx.compact into the guard's own resume and strand on 'Nothing to compact'
  d = escapeDecision(d.state, { projected: 24969, threshold: T, summaryKey: "2000:4000" });
  assert.equal(d.fire, false, "must not refire on the resume run's first request");
  d = escapeDecision(d.state, { projected: 24969, threshold: T, summaryKey: "2000:4000" });
  assert.equal(d.fire, false, "…or on any later stale-high request");
  // the resume assistant reports REAL post-compaction usage -> projection drops -> latch releases
  d = escapeDecision(d.state, { projected: 4200, threshold: T, summaryKey: "2000:4000" });
  assert.equal(d.fire, false, "the release itself must not fire");
  // …and a genuine later re-cross starts a real new cycle
  d = escapeDecision(d.state, { projected: T + 100, threshold: T, summaryKey: "2000:4000" });
  assert.equal(d.fire, true, "a genuine re-cross after release fires again");
});

test("M4 pipeline: fire -> landed compaction -> resume does not refire; later creep fires a new cycle", () => {
  const THRESHOLD = Math.max(4096, 32768 - 4096 - 4096); // the ts default: 24576
  const step = (state, msgs) => {
    // exactly the wiring in context-guard.ts: guard() -> escapeDecision(projectedAfter, key)
    const res = guard(msgs, OPTS, emptySticky());
    return escapeDecision(state, {
      projected: res.projectedAfter, threshold: THRESHOLD, summaryKey: compactionSummaryKey(msgs),
    });
  };
  // request 1: the run has crept past the escape threshold -> fire
  const before = conv([{ total: 25000 }]);
  let d = step(undefined, before);
  assert.equal(d.fire, true, "creep past the threshold must fire");
  // compaction lands; resume request sees [summary, kept msgs (STALE usage), resume user msg]
  const c = call("bash", { command: "ls" });
  const compacted = [
    { role: "compactionSummary", summary: "s".repeat(4000), tokensBefore: 25000, timestamp: 2000 },
    { ...asst([c], { total: 24800 }), timestamp: 1000 },
    { ...result(c.id, "r".repeat(400)), timestamp: 1001 },
    { ...user("Context was compacted mid-task. Re-read PLAN.md and NOTES.md."), timestamp: 2001 },
  ];
  d = step(d.state, compacted);
  assert.equal(d.fire, false, "resume request must not refire ctx.compact");
  // the resume run creeps up again for real (fresh post-compaction usage) -> a new cycle fires
  const crept = [...compacted, { ...asst([], { total: 25000, text: "grinding on" }), timestamp: 2100 }];
  d = step(d.state, crept);
  assert.equal(d.fire, true, "a genuine post-compaction re-cross is a new cycle");
});

test("M1 caps a multi-block oversized result (aggregate > cap, small blocks)", () => {
  const id = tid();
  const blocks = Array.from({ length: 12 }, (_, i) => ({ type: "text", text: String(i % 10).repeat(1000) }));
  const msgs = [
    user("go"),
    asst([call("bash", { cmd: "x" }, id)], { total: 1000 }),
    { role: "toolResult", toolCallId: id, toolName: "bash", isError: false, timestamp: 2, content: blocks },
    ...Array.from({ length: 5 }, () => {
      const i = tid();
      return [asst([call("ls", { p: "." }, i)], { total: 1200 }),
        { role: "toolResult", toolCallId: i, toolName: "ls", isError: false, timestamp: 3,
          content: [{ type: "text", text: "ok" }] }];
    }).flat(),
  ];
  const r = capResults(msgs, {}, new Set());
  assert.ok(r.newlyCapped.includes(id), "multi-block oversized result must be capped");
  const out = r.messages.find((m) => m.role === "toolResult" && m.toolCallId === id);
  assert.ok(resultTextChars(out) < 12000, "aggregate must actually shrink");
});

test("digest task-pick skips the guard's own M4 resume message", async () => {
  const { buildDigest, RESUME_MESSAGE } = await import("./context-guard-core.mjs");
  const msgs = [
    { role: "user", content: [{ type: "text", text: RESUME_MESSAGE }], timestamp: 1 },
    { role: "user", content: [{ type: "text", text: "Build the real thing: a CSV parser" }], timestamp: 2 },
    asst([], { total: 1000, text: "working" }),
  ];
  const d = buildDigest(msgs, {});
  assert.ok(d.includes("Build the real thing"), "digest must anchor on the real task");
  assert.ok(!d.includes("exactly where you left off"), "digest must not quote the resume message as the task");
});
