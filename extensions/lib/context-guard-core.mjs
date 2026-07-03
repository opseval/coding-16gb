// context-guard-core.mjs — pure mid-run context-bounding transforms (ZERO deps, strings + math only).
// Imported by extensions/context-guard.ts (Pi's "context" + "session_before_compact" hooks) and by
// the unit/replay tests.
//
// WHY THIS EXISTS
//   Pi (v0.80.x) checks compaction before prompt submission and after each full agent run — NEVER
//   between tool rounds inside one run. One user submit can therefore grow a single 47-round run
//   straight past the zero-cliff (contextWindow - 4096) where every request's output budget —
//   including the compaction summary's own — is clamped to ~1 token: an unrecoverable wedge
//   (observed on-device 2026-07-02: 6.4K -> 28.7K tokens, zero compaction opportunities, dead at
//   ~28.7K on a 32K window). The "context" event is the only thing that runs between rounds, so
//   the bounding lives there.
//
// V2 (M3/M4) — WHY MORE EXISTS
//   The guard bounds the OUTBOUND request only; Pi's auto-compaction reads the RAW persisted
//   branch. A live guarded 124-round run (2026-07-02) finished with ~55K raw tokens; Pi's
//   summarizer serialized the whole turn prefix into ONE request (~45K tok input on a 32K window)
//   -> llama.cpp 400 exceed_context_size, at every subsequent boundary, forever (Pi has no
//   fallback). M3 (compaction rescue) detects that overflow from the session_before_compact event
//   and replaces the LLM summary with a deterministic digest. M4 (floor-creep escape) fires Pi's
//   compaction mid-run when elision is exhausted and the guarded estimate still nears the cliff.
//
// THE TRANSFORM IS EPHEMERAL
//   It rewrites the outbound request only; live state and the session file keep FULL history (Pi
//   structuredClones messages before handlers run, and auto-compaction later works from persisted
//   entries — elision delays compaction and loses nothing). The handler sees the full untransformed
//   history on every request, so everything here is RE-DERIVED per call; the caller holds sticky
//   id-sets so a message transformed once stays transformed on later requests (a full->elided->full
//   oscillation would churn the llama.cpp KV prefix cache). Core stays pure: sticky sets are inputs,
//   additions are returned — never mutated here.
//
// TWO MECHANISMS (composed by guard()):
//   M1 capResults — age-gated result cap, ALWAYS active: toolResults older than the last keepRounds
//      tool rounds whose total text > cap chars (isError: 1.5x cap) keep head+tail around a marker.
//      Fresh rounds are never touched, so a just-read file is always intact.
//   M2 elide — threshold elision, fires only when estimateTokens() >= elideAt: oldest-first,
//      (pass 1) big string arguments of elideTools toolCalls — old write/edit bodies were 72% of the
//      real failed run's growth and their content is persisted on disk anyway — then (pass 2) stub
//      remaining old toolResult texts to their first 200 chars, until the projected estimate
//      <= elideAt - headroom. EMERGENCY VALVE: if still >= contextWindow - 4096 - 2048, also cap
//      FRESH oversized results (> 4x cap) — a live run beats a pristine fresh read.
//
// HARD RULES
//   Never drop/reorder messages (a toolResult without its paired toolCall is a provider reject —
//   we only rewrite text in place, copy-on-write). Never touch user messages, assistant
//   text/thinking blocks, custom/compactionSummary/bashExecution/branchSummary messages, or the
//   toolCallId/toolName/isError fields.
//
// SIZE MATH (mirrors Pi's own): context estimate = the last valid assistant's usage tokens
//   (usage.totalTokens || input+output+cacheRead+cacheWrite; skip stopReason "aborted"/"error" and
//   all-zero usage) + ceil(chars of everything after that assistant / 4). STALE-ANCHOR RULE: an
//   assistant whose timestamp predates the newest compactionSummary is NOT a valid anchor — its
//   usage reflects the old pre-compaction context (compaction keeps the message but cannot rewrite
//   its usage). Pi guards its own auto-compaction the same way (agent-session.js _checkCompaction).
//
// PROJECTION / STICKY CREDIT RULE: only NEW transforms are credited against the estimate. A sticky
//   re-application was already part of the previous outbound request, so it is already reflected in
//   the anchor usage — crediting it again would double-count savings and under-protect the run.
//
// STICKY ID CONVENTIONS: capResults tracks plain toolCallIds; elide tracks tagged ids —
//   "args:<toolCallId>" (toolCall arguments elided) and "result:<toolCallId>" (toolResult stubbed).

const STUB_KEEP = 200;   // chars kept by an M2 result stub
const MIN_SHRINK = 160;  // never rewrite unless it shrinks the text by at least the marker's size

// The M4 resume message (single source of truth — the .ts sends it, buildDigest must NOT mistake
// it for the user's task when it is the first user message of a post-compaction span).
export const RESUME_MESSAGE = "Context was compacted mid-task. Re-read PLAN.md and NOTES.md, "
  + "then continue the current step exactly where you left off.";

export function normOpts(opts = {}) {
  const cap = opts.cap ?? 8192;
  const contextWindow = opts.contextWindow ?? 32768;
  return {
    cap,
    keepRounds: opts.keepRounds ?? 4,
    headKeep: opts.headKeep ?? Math.floor(cap * 0.75),     // 6144 at the default cap
    tailKeep: opts.tailKeep ?? Math.floor(cap * 0.1875),   // 1536 at the default cap
    argStubMin: opts.argStubMin ?? 512,
    elideTools: new Set(opts.elideTools ?? ["write", "edit"]),
    contextWindow,
    elideAt: opts.elideAt ?? contextWindow - 16384,
    headroom: opts.headroom ?? 6144,
    estimate: opts.estimate, // optional precomputed estimate (guard threads M1 savings through)
  };
}

// ---------------------------------------------------------------- size estimation

function safeJsonLen(v) {
  try { return JSON.stringify(v ?? null).length; } catch { return 0; }
}

export function usageTokens(m) {
  const u = m?.usage || {};
  return u.totalTokens || ((u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0));
}

function isValidAnchor(m) {
  if (!m || m.role !== "assistant") return false;
  if (m.stopReason === "aborted" || m.stopReason === "error") return false;
  return usageTokens(m) > 0;
}

// Payload chars of one message, for the chars/4 tail estimate. Unknown block types fall back to
// their JSON length (an image's base64 IS in the payload — overestimating is the safe direction).
export function messageChars(m) {
  if (!m) return 0;
  let n = 0;
  const c = m.content;
  if (typeof c === "string") n += c.length;
  else if (Array.isArray(c)) {
    for (const b of c) {
      if (!b) continue;
      if (b.type === "text" || b.type === "thinking") {
        if (typeof b.text === "string") n += b.text.length;
        if (typeof b.thinking === "string") n += b.thinking.length;
      } else if (b.type === "toolCall") {
        n += String(b.name || "").length + safeJsonLen(b.arguments);
      } else {
        n += safeJsonLen(b);
      }
    }
  }
  if (typeof m.summary === "string") n += m.summary.length; // compactionSummary-shaped entries
  return n;
}

// Pi-style context estimate: anchor on the last valid assistant's server-reported usage, then add
// ceil(chars/4) for everything the provider hasn't priced yet (the tail after that assistant).
//
// STALE-ANCHOR RULE: right after a compaction lands, the rebuilt history is [compactionSummary,
// ...kept messages] — and the kept assistant's usage still prices the OLD (pre-compaction) context.
// Anchoring on it would hold the estimate at pre-compaction levels for the whole resume run: M2
// would elide pointlessly and M4 would refire ctx.compact into its own resume (abort, then
// 'Nothing to compact' -> stranded session). So an assistant whose timestamp predates the newest
// compactionSummary's is skipped — the same check Pi's own auto-compaction makes (agent-session.js
// _checkCompaction: `usageMsg.timestamp <= new Date(compactionEntry.timestamp).getTime()`). With no
// anchor left, the estimate degrades to ceil(chars/4) of the whole (compacted) history — small and
// honest. Messages without numeric timestamps keep the old behavior (never treated as stale).
export function estimateTokens(messages) {
  let compactedAt = -Infinity;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "compactionSummary") {
      if (typeof m.timestamp === "number") compactedAt = m.timestamp;
      break;
    }
  }
  let anchor = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isValidAnchor(m)) continue;
    // stale pre-compaction usage — and every earlier anchor is staler still, so stop looking.
    if (typeof m.timestamp === "number" && m.timestamp <= compactedAt) break;
    anchor = i;
    break;
  }
  let chars = 0;
  for (let i = anchor + 1; i < messages.length; i++) chars += messageChars(messages[i]);
  return (anchor >= 0 ? usageTokens(messages[anchor]) : 0) + Math.ceil(chars / 4);
}

// ---------------------------------------------------------------- rounds

// A tool "round" = one assistant message containing toolCall(s) + the toolResults that follow it.
// roundOf[i] = -1 for anything before the first tool round (initial user msg, orphan toolResults
// left by earlier transforms/compaction — treated as old, which is the conservative choice).
export function annotateRounds(messages) {
  const roundOf = new Array(messages.length);
  let r = -1;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && m.role === "assistant" && Array.isArray(m.content)
        && m.content.some((b) => b && b.type === "toolCall")) r += 1;
    roundOf[i] = r;
  }
  return { roundOf, totalRounds: r + 1 };
}

// ---------------------------------------------------------------- rewriters (all copy-on-write)

export function resultTextChars(m) {
  if (!Array.isArray(m?.content)) return 0;
  let n = 0;
  for (const b of m.content) if (b && b.type === "text" && typeof b.text === "string") n += b.text.length;
  return n;
}

// Surrogate-safe slice boundaries: a cut that lands inside a UTF-16 pair would ship a lone
// surrogate (mojibake for the model; a strict server may reject the body). Back the head cut
// off a leading high surrogate; push a tail start past a leading low surrogate.
function safeEnd(s, i) {
  const c = s.charCodeAt(i - 1);
  return c >= 0xd800 && c <= 0xdbff ? i - 1 : i;
}
function safeStart(s, i) {
  const c = s.charCodeAt(i);
  return c >= 0xdc00 && c <= 0xdfff ? i + 1 : i;
}

// head+tail cap of one text block; null = no change. The <= headKeep+tailKeep+MIN_SHRINK guard makes
// re-capping an already-capped block a no-op — that's what makes sticky re-application idempotent.
function capText(t, headKeep, tailKeep) {
  if (typeof t !== "string" || t.length <= headKeep + tailKeep + MIN_SHRINK) return null;
  const h = safeEnd(t, headKeep);
  const ts = safeStart(t, t.length - tailKeep);
  const removed = ts - h;
  return t.slice(0, h)
    + `\n[context-guard: ${removed} chars truncated — re-run the tool (narrower) if you need the full output]\n`
    + t.slice(ts);
}

function capToolResult(m, headKeep, tailKeep) {
  if (!Array.isArray(m.content)) return null;
  let changed = false;
  const content = m.content.map((b) => {
    if (!b || b.type !== "text") return b;
    const t = capText(b.text, headKeep, tailKeep);
    if (t == null) return b;
    changed = true;
    return { ...b, text: t };
  });
  return changed ? { ...m, content } : null;
}

// one-line stub of a toolResult's text blocks (first STUB_KEEP chars); null = no change.
function stubToolResult(m) {
  if (!Array.isArray(m.content)) return null;
  let changed = false;
  const content = m.content.map((b) => {
    if (!b || b.type !== "text" || typeof b.text !== "string") return b;
    if (b.text.length <= STUB_KEEP + MIN_SHRINK) return b;
    changed = true;
    const keep = safeEnd(b.text, STUB_KEEP);
    const removed = b.text.length - keep;
    return { ...b, text: b.text.slice(0, keep)
      + `\n[context-guard: ${removed} chars elided — re-run the tool if you need the full output]` };
  });
  return changed ? { ...m, content } : null;
}

// Replace long string values inside toolCall arguments (recursively; keys and short values — paths,
// flags — stay verbatim). The stub is ~80 chars < argStubMin, so re-eliding is a no-op.
function elideStringsDeep(v, minLen) {
  if (typeof v === "string") {
    if (v.length <= minLen) return v;
    return `[context-guard: ${v.length} chars elided — content persisted on disk at time of call]`;
  }
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => { const y = elideStringsDeep(x, minLen); if (y !== x) changed = true; return y; });
    return changed ? out : v;
  }
  if (v && typeof v === "object") {
    let changed = false;
    const out = {};
    for (const [k, x] of Object.entries(v)) { const y = elideStringsDeep(x, minLen); if (y !== x) changed = true; out[k] = y; }
    return changed ? out : v;
  }
  return v;
}

function elideCallArgs(block, argStubMin) {
  const args = elideStringsDeep(block.arguments, argStubMin);
  return args === block.arguments ? null : { ...block, arguments: args };
}

// ---------------------------------------------------------------- M1: age-gated result cap

// Always active. Sticky ids are re-applied unconditionally (age/threshold no longer matter — the
// transform must be byte-stable across rounds for the KV prefix cache); NEW caps require the result
// to be old AND oversized, and only they are credited in savedChars (see the sticky credit rule).
export function capResults(messages, opts, stickyCapIds) {
  const o = normOpts(opts);
  const { roundOf, totalRounds } = annotateRounds(messages);
  const cutoff = totalRounds - o.keepRounds;
  const sticky = stickyCapIds ?? new Set();
  let out = null;
  const newlyCapped = [];
  let savedChars = 0;
  messages.forEach((m, i) => {
    if (!m || m.role !== "toolResult") return;
    const isSticky = sticky.has(m.toolCallId);
    if (!isSticky) {
      if (roundOf[i] >= cutoff) return; // fresh round — never touched by M1
      const limit = m.isError ? o.cap * 1.5 : o.cap;
      if (resultTextChars(m) <= limit) return;
    }
    // Fallback: a result spread over many small blocks (aggregate > cap, no block individually
    // cappable) is stubbed instead, so M1 honors its aggregate-size contract for every shape.
    const capped = capToolResult(m, o.headKeep, o.tailKeep) ?? stubToolResult(m);
    if (!capped) return;
    if (!out) out = messages.slice();
    out[i] = capped;
    if (!isSticky) {
      newlyCapped.push(m.toolCallId);
      savedChars += resultTextChars(m) - resultTextChars(capped);
    }
  });
  return { messages: out ?? messages, newlyCapped, savedChars };
}

// ---------------------------------------------------------------- M2: threshold elision

// stickyElideIds: Set of tagged ids ("args:<id>" | "result:<id>") — always re-applied. New elisions
// run oldest-first only when the estimate crosses elideAt, and stop once the projected estimate
// reaches elideAt - headroom. Note: the projection credits NEW savings only, so within one call the
// running estimate is exact; across calls the anchor usage picks the savings up naturally.
export function elide(messages, opts, stickyElideIds) {
  const o = normOpts(opts);
  const { roundOf, totalRounds } = annotateRounds(messages);
  const cutoff = totalRounds - o.keepRounds;
  const sticky = stickyElideIds ?? new Set();
  const estimate = o.estimate ?? estimateTokens(messages);
  let out = null;
  const newlyElided = [];
  let savedChars = 0;
  const setMsg = (i, m) => { if (!out) out = messages.slice(); out[i] = m; };
  const cur = (i) => (out ? out[i] : messages[i]);

  // sticky re-application first (uncredited), regardless of age or estimate — monotonic elision.
  messages.forEach((m, i) => {
    if (!m) return;
    if (m.role === "assistant" && Array.isArray(m.content)) {
      let content = null;
      m.content.forEach((b, j) => {
        if (!b || b.type !== "toolCall" || !sticky.has(`args:${b.id}`)) return;
        const nb = elideCallArgs(b, o.argStubMin);
        if (!nb) return;
        if (!content) content = m.content.slice();
        content[j] = nb;
      });
      if (content) setMsg(i, { ...m, content });
    } else if (m.role === "toolResult" && sticky.has(`result:${m.toolCallId}`)) {
      const stubbed = stubToolResult(cur(i)); // over the (possibly M1-capped) current version
      if (stubbed) setMsg(i, stubbed);
    }
  });

  let running = estimate;
  if (running >= o.elideAt) {
    const target = o.elideAt - o.headroom;

    // pass 1 — oldest-first: big string args of elideTools calls (content persisted on disk).
    for (let i = 0; i < messages.length && running > target; i++) {
      const m = messages[i];
      if (!m || m.role !== "assistant" || roundOf[i] >= cutoff || !Array.isArray(m.content)) continue;
      for (let j = 0; j < m.content.length && running > target; j++) {
        const b = m.content[j];
        if (!b || b.type !== "toolCall" || !o.elideTools.has(b.name) || sticky.has(`args:${b.id}`)) continue;
        const nb = elideCallArgs(b, o.argStubMin);
        if (!nb) continue;
        const base = cur(i);
        const content = base.content.slice();
        content[j] = nb;
        setMsg(i, { ...base, content });
        savedChars += safeJsonLen(b.arguments) - safeJsonLen(nb.arguments);
        newlyElided.push(`args:${b.id}`);
        running = estimate - Math.ceil(savedChars / 4);
      }
    }

    // pass 2 — oldest-first: stub remaining old toolResult texts beyond what M1 already capped.
    for (let i = 0; i < messages.length && running > target; i++) {
      const m = messages[i];
      if (!m || m.role !== "toolResult" || roundOf[i] >= cutoff) continue;
      if (sticky.has(`result:${m.toolCallId}`)) continue;
      const base = cur(i);
      const stubbed = stubToolResult(base);
      if (!stubbed) continue;
      setMsg(i, stubbed);
      savedChars += resultTextChars(base) - resultTextChars(stubbed);
      newlyElided.push(`result:${m.toolCallId}`);
      running = estimate - Math.ceil(savedChars / 4);
    }
  }

  return { messages: out ?? messages, newlyElided, projected: running, savedChars };
}

// ---------------------------------------------------------------- composition

// guard(messages, opts, sticky) — the one call the extension makes per context event.
//   sticky: { capIds: Set<toolCallId>, elideIds: Set<"args:..."|"result:..."> } (never mutated).
//   returns { messages, changed, actions: { capped: [], elided: [] }, projectedBefore, projectedAfter }
//   — actions hold ONLY the additions from this call; the caller merges them into its sticky sets.
export function guard(messages, opts, sticky) {
  const o = normOpts(opts);
  const capIds = sticky?.capIds ?? new Set();
  const elideIds = sticky?.elideIds ?? new Set();

  const projectedBefore = estimateTokens(messages);

  // M1 (always) — then thread the post-M1 estimate into M2 so its threshold sees M1's new savings.
  const r1 = capResults(messages, o, capIds);
  let savedChars = r1.savedChars;
  const r2 = elide(r1.messages, { ...o, estimate: projectedBefore - Math.ceil(savedChars / 4) }, elideIds);
  savedChars += r2.savedChars;
  let out = r2.messages;
  let running = projectedBefore - Math.ceil(savedChars / 4);

  // EMERGENCY VALVE — old-message elision wasn't enough and the next round could hit the zero-cliff
  // (window - 4096, minus a 2048 safety band): cap even FRESH oversized results (> 4x cap).
  const emergencyCapped = [];
  if (running >= o.contextWindow - 4096 - 2048) {
    const { roundOf, totalRounds } = annotateRounds(out);
    const cutoff = totalRounds - o.keepRounds;
    let arr = null;
    out.forEach((m, i) => {
      if (!m || m.role !== "toolResult" || roundOf[i] < cutoff) return; // old ones were handled above
      if (capIds.has(m.toolCallId) || elideIds.has(`result:${m.toolCallId}`)) return;
      if (resultTextChars(m) <= o.cap * 4) return;
      const capped = capToolResult(m, o.headKeep, o.tailKeep);
      if (!capped) return;
      if (!arr) arr = out.slice();
      savedChars += resultTextChars(m) - resultTextChars(capped);
      arr[i] = capped;
      emergencyCapped.push(m.toolCallId);
    });
    if (arr) out = arr;
    running = projectedBefore - Math.ceil(savedChars / 4);
  }

  return {
    messages: out,
    changed: out !== messages,
    actions: { capped: [...r1.newlyCapped, ...emergencyCapped], elided: r2.newlyElided },
    projectedBefore,
    projectedAfter: running,
  };
}

// ================================================================ v2 — M3: compaction rescue
//
// Pi's auto-compaction (dist/core/compaction/compaction.js) serializes the ENTIRE span it wants
// to summarize verbatim into ONE user message (serializeConversation, utils.js — assistant
// text/thinking verbatim, toolCall args as JSON, tool results capped at 2000 chars each) with no
// chunking and no input-size cap; clampMaxTokensToContext clamps OUTPUT only, so an input bigger
// than the window is a llama.cpp 400 at every boundary, forever. The rescue path: estimate that
// input from the session_before_compact event; when it cannot fit, hand Pi a deterministic digest
// (CompactionResult) instead — Pi then makes NO LLM call.

const SERIALIZE_RESULT_CAP = 2000;      // Pi's TOOL_RESULT_MAX_CHARS (compaction/utils.js)
const SERIALIZE_JOINER = 2;             // serializeConversation joins parts with "\n\n"
const SERIALIZE_PROMPT_OVERHEAD = 2600; // summarization prompt (879) + system (~320) + <conversation>
                                        // wrapper + update-prompt margin, in chars
const SUMMARIZER_ZERO_CLIFF = 4096;     // Pi's clamp: output budget = window - input - 4096
const SUMMARIZER_MIN_OUTPUT = 2048;     // below this the "summary" is too starved to be useful

// Chars Pi's serializeConversation would emit for ONE message (slight overestimates are the safe
// direction — they only push us toward the digest, never toward a 400).
export function serializedChars(m) {
  if (!m) return 0;
  const textOf = (c) => (typeof c === "string" ? c
    : Array.isArray(c)
      ? c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("")
      : "");
  switch (m.role) {
    case "user":
    case "custom": { // convertToLlm turns custom messages into plain user messages
      const t = textOf(m.content);
      return t ? t.length + 8 : 0; // "[User]: "
    }
    case "branchSummary":
    case "compactionSummary": { // convertToLlm wraps the summary in a user-message banner
      const t = typeof m.summary === "string" ? m.summary : "";
      return t ? t.length + 120 : 0;
    }
    case "assistant": {
      let text = 0, thinking = 0, calls = 0, nCalls = 0;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b) continue;
        if (b.type === "text" && typeof b.text === "string") text += b.text.length;
        else if (b.type === "thinking" && typeof b.thinking === "string") thinking += b.thinking.length;
        else if (b.type === "toolCall") {
          nCalls += 1;
          calls += String(b.name || "").length + 4; // "name(...)" + "; " separator
          const args = b.arguments;
          if (args && typeof args === "object" && !Array.isArray(args)) {
            for (const [k, v] of Object.entries(args)) calls += k.length + 1 + safeJsonLen(v) + 2;
          } else calls += safeJsonLen(args);
        }
      }
      let n = 0;
      if (thinking) n += thinking + 24; // "[Assistant thinking]: "
      if (text) n += text + 13;         // "[Assistant]: "
      if (nCalls) n += calls + 25;      // "[Assistant tool calls]: "
      return n;
    }
    case "toolResult": {
      const t = textOf(m.content);
      if (!t) return 0;
      const capped = t.length > SERIALIZE_RESULT_CAP ? SERIALIZE_RESULT_CAP + 45 : t.length; // + marker
      return capped + 15; // "[Tool result]: "
    }
    case "bashExecution":
      return String(m.command || "").length + String(m.output || "").length + 20;
    default:
      return safeJsonLen(m.content);
  }
}

// Per-request input estimates for the summarizer calls Pi is about to make. A split turn fires TWO
// parallel requests (history summary + turn-prefix summary) — each must fit on its own, so the
// binding number is the max, not the sum. previousSummary rides along in the history request.
export function estimateSummarizerInput({ messagesToSummarize = [], turnPrefixMessages = [], previousSummary = "" } = {}) {
  const spanChars = (msgs) => msgs.reduce((n, m) => n + serializedChars(m) + SERIALIZE_JOINER, 0);
  const prevChars = typeof previousSummary === "string" && previousSummary ? previousSummary.length + 44 : 0;
  const historyChars = messagesToSummarize.length
    ? spanChars(messagesToSummarize) + prevChars + SERIALIZE_PROMPT_OVERHEAD : 0;
  const turnChars = turnPrefixMessages.length
    ? spanChars(turnPrefixMessages) + SERIALIZE_PROMPT_OVERHEAD : 0;
  const historyTokens = Math.ceil(historyChars / 4);
  const turnPrefixTokens = Math.ceil(turnChars / 4);
  return { historyTokens, turnPrefixTokens, maxRequestTokens: Math.max(historyTokens, turnPrefixTokens) };
}

// Pi's own summarizer only works when input + the 4096 clamp floor + a real output budget fit the
// window. Anything else is a guaranteed 400 (input > n_ctx) or a starved 1-token "summary".
export function wouldOverflow(inputTokens, contextWindow) {
  return !(inputTokens + SUMMARIZER_ZERO_CLIFF + SUMMARIZER_MIN_OUTPUT < contextWindow);
}

// ---------------------------------------------------------------- Pi cut-point mirror

// Mirror of Pi's per-message estimateTokens (compaction.js): role-dependent chars/4, images 4800.
const PI_IMAGE_CHARS = 4800;
function piContentChars(c) {
  if (typeof c === "string") return c.length;
  let n = 0;
  for (const b of Array.isArray(c) ? c : []) {
    if (!b) continue;
    if (b.type === "text" && typeof b.text === "string") n += b.text.length;
    else if (b.type === "image") n += PI_IMAGE_CHARS;
  }
  return n;
}
export function piMessageTokens(m) {
  if (!m) return 0;
  let chars = 0;
  switch (m.role) {
    case "user":
    case "custom":
    case "toolResult":
      chars = piContentChars(m.content); break;
    case "assistant":
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b) continue;
        if (b.type === "text" && typeof b.text === "string") chars += b.text.length;
        else if (b.type === "thinking" && typeof b.thinking === "string") chars += b.thinking.length;
        else if (b.type === "toolCall") chars += String(b.name || "").length + safeJsonLen(b.arguments);
      }
      break;
    case "bashExecution":
      chars = String(m.command || "").length + String(m.output || "").length; break;
    case "branchSummary":
    case "compactionSummary":
      chars = String(m.summary || "").length; break;
    default:
      return 0;
  }
  return Math.ceil(chars / 4);
}

// SessionEntry -> the AgentMessage it contributes to context (compaction entries excluded — Pi's
// getMessageFromEntryForCompaction does the same; their content lives on in previousSummary).
function entryMessage(entry) {
  if (!entry) return null;
  if (entry.type === "message") return entry.message ?? null;
  if (entry.type === "custom_message") return { role: "custom", customType: entry.customType, content: entry.content };
  if (entry.type === "branch_summary") return { role: "branchSummary", summary: entry.summary, fromId: entry.fromId };
  return null;
}

// Entry roles Pi's findValidCutPoints accepts (never a toolResult — it must follow its toolCall).
const CUT_ROLES = new Set(["user", "assistant", "custom", "branchSummary", "compactionSummary", "bashExecution"]);

// Mirror of Pi's prepareCompaction cut selection (compaction.js findCutPoint + boundary logic):
// walk branch entries backward accumulating piMessageTokens until keepRecentTokens, cut at the
// first valid cut point at/after the stop index, then back-scan over non-message entries. Returns
// the digest plan: the REAL entry id Pi accepts as firstKeptEntryId + the span being elided.
export function planRescue(entries, opts = {}) {
  const keepRecentTokens = opts.keepRecentTokens > 0 ? opts.keepRecentTokens : 3000;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  if (entries[entries.length - 1]?.type === "compaction") return null; // Pi: nothing to compact

  // Everything before the previous compaction's first kept entry is already out of context.
  let boundaryStart = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "compaction") {
      const kept = entries.findIndex((e) => e?.id === entries[i].firstKeptEntryId);
      boundaryStart = kept >= 0 ? kept : i + 1;
      break;
    }
  }

  const cutPoints = [];
  for (let i = boundaryStart; i < entries.length; i++) {
    const e = entries[i];
    if (!e) continue;
    if (e.type === "message" && e.message && CUT_ROLES.has(e.message.role)) cutPoints.push(i);
    else if (e.type === "branch_summary" || e.type === "custom_message") cutPoints.push(i);
  }
  if (cutPoints.length === 0) return null;

  let cutIndex = cutPoints[0]; // Pi's default: keep from the first message
  let acc = 0;
  for (let i = entries.length - 1; i >= boundaryStart; i--) {
    const e = entries[i];
    if (!e || e.type !== "message") continue;
    acc += piMessageTokens(e.message);
    if (acc >= keepRecentTokens) {
      for (const c of cutPoints) { if (c >= i) { cutIndex = c; break; } }
      break;
    }
  }
  // include immediately-preceding non-message entries (model_change etc.), as Pi does
  while (cutIndex > boundaryStart) {
    const prev = entries[cutIndex - 1];
    if (!prev || prev.type === "compaction" || prev.type === "message") break;
    cutIndex--;
  }

  const firstKeptEntryId = entries[cutIndex]?.id;
  if (!firstKeptEntryId) return null;

  const elidedMessages = [];
  for (let i = boundaryStart; i < cutIndex; i++) {
    const m = entryMessage(entries[i]);
    if (m) elidedMessages.push(m);
  }
  if (elidedMessages.length === 0) return null; // Pi's prepareCompaction would bail too

  let keptTokens = 0;
  for (let i = cutIndex; i < entries.length; i++) {
    if (entries[i]?.type === "message") keptTokens += piMessageTokens(entries[i].message);
  }
  return { firstKeptEntryId, cutIndex, boundaryStart, elidedMessages, keptTokens };
}

// ---------------------------------------------------------------- deterministic digest

// Unique file paths touched by write/edit toolCalls across a span (insertion order, with counts),
// plus paths only read — the shape Pi's own CompactionDetails wants ({ readFiles, modifiedFiles }).
export function harvestFiles(messages, opts = {}) {
  const fileTools = new Set(opts.fileTools ?? ["write", "edit"]);
  const readTools = new Set(opts.readTools ?? ["read"]);
  const pathOf = (args) => {
    if (!args || typeof args !== "object" || Array.isArray(args)) return null;
    for (const k of ["path", "file_path", "filePath", "filename", "file"]) {
      if (typeof args[k] === "string" && args[k]) return args[k];
    }
    return null;
  };
  const modified = new Map();
  const read = new Set();
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (!b || b.type !== "toolCall") continue;
      const p = pathOf(b.arguments);
      if (!p) continue;
      if (fileTools.has(b.name)) modified.set(p, (modified.get(p) ?? 0) + 1);
      else if (readTools.has(b.name)) read.add(p);
    }
  }
  return {
    modified: [...modified.entries()].map(([path, count]) => ({ path, count })),
    read: [...read],
  };
}

const DIGEST_INSTRUCTION =
  "Full history is in the session file. Re-read PLAN.md and NOTES.md in the workdir before "
  + "continuing; re-read any file you need — do not trust this digest for exact code.";

// buildDigest(messages, opts) -> string. Deterministic (no LLM, no clock, no randomness), ALWAYS
// under maxChars regardless of input size, standing instruction always intact at the end.
export function buildDigest(messages, opts = {}) {
  const o = {
    maxChars: opts.maxChars ?? 7680,
    taskCap: opts.taskCap ?? 2000,
    verifyCap: opts.verifyCap ?? 1200,
    errorCap: opts.errorCap ?? 500,
    tailCount: opts.tailCount ?? 5,
    tailCap: opts.tailCap ?? 200,
    maxFileLines: opts.maxFileLines ?? 20,
    verifyTools: new Set(opts.verifyTools ?? ["verify"]),
  };
  const msgs = Array.isArray(messages) ? messages : [];
  const textOf = (c) => (typeof c === "string" ? c
    : Array.isArray(c)
      ? c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("")
      : "");
  const clip = (s, n) => (s.length <= n ? s : s.slice(0, safeEnd(s, n)) + "…");

  // (1) the original task — skipping the guard's own M4 resume message, which after a prior
  // compaction can be the span's first user message and would otherwise masquerade as the task
  let task = "";
  for (const m of msgs) {
    if (m?.role !== "user") continue;
    const t = textOf(m.content).trim();
    if (t === RESUME_MESSAGE) continue;
    task = t; break;
  }

  // (2) files created/modified across the elided span
  const files = harvestFiles(msgs, opts);

  // (3) key outcomes: the last verify-tool result + the last error result
  let lastVerify = "", lastError = "";
  for (const m of msgs) {
    if (m?.role !== "toolResult") continue;
    const t = textOf(m.content).trim();
    if (!t) continue;
    if (o.verifyTools.has(m.toolName)) lastVerify = t;
    if (m.isError) lastError = t;
  }

  // (4) trajectory tail: the last few assistant text snippets, oldest first
  const tail = [];
  for (let i = msgs.length - 1; i >= 0 && tail.length < o.tailCount; i--) {
    const m = msgs[i];
    if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
    const t = m.content.filter((b) => b && b.type === "text" && typeof b.text === "string")
      .map((b) => b.text).join(" ").trim();
    if (t) tail.unshift(clip(t, o.tailCap));
  }

  const fileLine = (f) =>
    `- ${f.path.length > 160 ? "…" + f.path.slice(-159) : f.path} (${f.count} write/edit${f.count === 1 ? "" : "s"})`;
  const assemble = (fileLines) => {
    const parts = ["[context-guard digest — deterministic compaction rescue; the LLM summary would not fit the context window]"];
    if (task) parts.push(`## Original task\n${clip(task, o.taskCap)}`);
    if (files.modified.length) {
      const omitted = files.modified.length - fileLines.length;
      parts.push("## Files created/modified in the elided span\n" + fileLines.join("\n")
        + (omitted > 0 ? `\n…and ${omitted} more` : ""));
    }
    const outcomes = [];
    if (lastVerify) outcomes.push(`Last verify result:\n${clip(lastVerify, o.verifyCap)}`);
    if (lastError) outcomes.push(`Last error result:\n${clip(lastError, o.errorCap)}`);
    if (outcomes.length) parts.push("## Key outcomes\n" + outcomes.join("\n\n"));
    if (tail.length) parts.push("## Trajectory tail (most recent last)\n" + tail.map((t) => `- ${t}`).join("\n"));
    parts.push(`## Standing instruction\n${DIGEST_INSTRUCTION}`);
    return parts.join("\n\n");
  };

  let fileLines = files.modified.slice(0, o.maxFileLines).map(fileLine);
  let out = assemble(fileLines);
  while (out.length > o.maxChars && fileLines.length > 0) { // shed file lines first — least dense
    fileLines = fileLines.slice(0, -1);
    out = assemble(fileLines);
  }
  if (out.length > o.maxChars) { // pathological inputs: hard-trim the head, keep the instruction
    const instr = `\n\n## Standing instruction\n${DIGEST_INSTRUCTION}`;
    out = out.slice(0, Math.max(0, safeEnd(out, o.maxChars - instr.length - 1))) + "…" + instr;
  }
  return out;
}

// ================================================================ v2 — M4: floor-creep escape
//
// When M1+M2 elision is exhausted and the guarded estimate still creeps toward the cliff, the only
// remaining move is Pi's own compaction, fired mid-run (ctx.compact aborts the active run, compacts
// the persisted branch, and the extension re-drives the run). One shot per latch cycle; the latch
// releases only when a NEW compactionSummary shows up in the incoming history (compaction landed)
// AND the projection is back under the threshold — the key change alone is not enough, because the
// kept assistant right after a landed compaction still carries stale pre-compaction usage
// (estimateTokens refuses that anchor, but the hysteresis keeps the latch safe even if a stale
// projection reaches it some other way: refiring would abort the guard's own resume run and strand
// the session on ctx.compact's 'Nothing to compact').

// Identity of the newest compactionSummary in a message array ("" when none) — a changed key means
// a compaction landed since the latch armed.
export function compactionSummaryKey(messages) {
  for (let i = (Array.isArray(messages) ? messages.length : 0) - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "compactionSummary") return `${m.timestamp ?? 0}:${String(m.summary ?? "").length}`;
  }
  return "";
}

// Pure latch state machine. state: { armed, keyAtArm } (pass undefined to start). Fires when the
// projected estimate crosses the threshold and the latch is released; arming records the current
// summary key so an onError never retry-loops (same key -> stays armed). Release takes BOTH a new
// compaction (key change) AND projected < threshold (hysteresis): a landed compaction changes the
// key on the very request whose projection can still read pre-compaction-high off a stale usage
// anchor, and releasing on the key alone would machine-gun ctx.compact into the guard's own resume.
export function escapeDecision(state, { projected, threshold, summaryKey }) {
  let armed = !!(state && state.armed);
  const keyAtArm = state?.keyAtArm ?? "";
  if (armed && summaryKey !== keyAtArm
      && Number.isFinite(projected) && Number.isFinite(threshold) && projected < threshold) {
    armed = false; // a new compaction landed AND the estimate really came down — new cycle
  }
  const fire = !armed && Number.isFinite(projected) && Number.isFinite(threshold) && projected >= threshold;
  return { fire, state: { armed: armed || fire, keyAtArm: fire ? summaryKey : keyAtArm } };
}
