/**
 * context-guard — deterministic mid-run context bounding for Pi.
 *
 * Pi checks compaction pre-submit and post-run, NEVER between tool rounds inside one run: a single
 * user submit spawned a 47-round agent run that grew 6.4K -> 28.7K tokens with zero compaction
 * opportunities and died at the zero-cliff (contextWindow - 4096), where every request's output
 * budget — including the compaction summary's own — clamps to ~1 token (on-device, 2026-07-02).
 * The `context` event fires on EVERY provider request (first one and after every tool round), so
 * it is the only place a mid-run bound can live. Two mechanisms, both in the zero-dependency
 * sibling `lib/context-guard-core.mjs` (located via the realpath of THIS file — install.sh copies
 * the extension into ~/.pi/agent/extensions/ together with lib/):
 *
 *   M1 (always): toolResults older than the last KEEP rounds and bigger than CAP chars keep
 *      head+tail around a truncation marker. Fresh rounds are never touched.
 *   M2 (when the estimate crosses ELIDE_AT): oldest-first, elide big write/edit toolCall bodies
 *      (72% of the real failed run's growth — their content is on disk anyway), then stub old
 *      results, until the projection reaches ELIDE_AT - HEADROOM. Emergency valve near the cliff
 *      caps even fresh oversized results.
 *
 * v2 adds two mechanisms for the NEXT failure a live guarded run exposed (124 rounds, 2026-07-02):
 * Pi's auto-compaction reads the RAW persisted branch and serializes the whole span to summarize
 * into ONE unchunked LLM request — ~45K tok of input on a 32K window is a llama.cpp 400
 * exceed_context_size at every boundary, forever (Pi has no fallback):
 *
 *   M3 (compaction rescue, session_before_compact): estimate the summarizer's input from the
 *      event's preparation; when it fits with a healthy output budget, stand aside (Pi's LLM
 *      summary is higher quality). When it cannot fit, return a deterministic digest
 *      (CompactionResult) built from the elided span — task prompt, files touched, key outcomes,
 *      trajectory tail, standing re-read instruction — and Pi makes no LLM call at all.
 *   M4 (floor-creep escape, context event): when even after M1/M2 the guarded estimate crosses
 *      ESCAPE (default window - 8192), elision is exhausted and the floor has crept near the
 *      cliff — fire ctx.compact() mid-run (once per latch cycle; the latch re-releases only when
 *      a new compactionSummary appears in history AND the estimate is back under the threshold —
 *      kept messages carry stale pre-compaction usage, and a key-change-only release would refire
 *      into the guard's own resume) and, on completion, re-drive the run with pi.sendUserMessage.
 *      The abort races the in-flight request harmlessly; Pi drops the partial. estimateTokens
 *      itself also refuses anchors older than the newest compactionSummary (Pi's own stale-usage
 *      rule), so the post-compaction estimate reflects the compacted context, not the old one.
 *
 * The M1/M2 transform is EPHEMERAL — outbound request only. Live state and the session file keep
 * full history; Pi's auto-compaction keys off the real usage of the last response (which reflects
 * the transformed prompt) and compacts from persisted entries, so elision delays compaction and
 * loses nothing. Module-closure sticky sets keep every transformed id transformed on later
 * requests — a full->elided->full oscillation would churn the llama.cpp KV prefix cache.
 *
 * Failure stance: every handler is try/caught to `return undefined` (run continues untransformed;
 * compaction falls back to Pi's own path) — a guard must never be the thing that kills the run.
 *
 * Env:
 *   PI_CTXGUARD=0             disable entirely.
 *   PI_CTXGUARD_CAP           M1 result cap in chars (default 8192; isError results get 1.5x).
 *   PI_CTXGUARD_KEEP          fresh tool rounds never touched (default 4).
 *   PI_CTXGUARD_AT            elision threshold in tokens (default: active model contextWindow -
 *                             compaction.reserveTokens from ~/.pi/agent/settings.json, fallback 16384).
 *   PI_CTXGUARD_HEADROOM      elide down to AT - HEADROOM (default 6144).
 *   PI_CTXGUARD_ELIDE_TOOLS   comma list of toolCall names whose big args elide (default "write,edit").
 *   PI_CTXGUARD_COMPACT=0     disable M4 (the mid-run ctx.compact escape). M3 stays — it is pure
 *                             rescue of a compaction Pi already decided to run.
 *   PI_CTXGUARD_ESCAPE        M4 threshold in tokens (default: contextWindow - 4096 - 4096).
 *   PI_CTXGUARD_QUIET=1       silence the one-line action logs (stderr).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { realpathSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export default async function (pi: ExtensionAPI) {
  if (process.env.PI_CTXGUARD === "0") return;

  // Double-load stand-down: an installed copy + a --extension flag copy would register every
  // handler twice (observed to race/hang Pi's startup nondeterministically). First one wins.
  const LOADED = Symbol.for("pi.context-guard.loaded");
  if ((globalThis as any)[LOADED]) {
    console.error("context-guard: another instance is already active — this copy stands down");
    return;
  }
  (globalThis as any)[LOADED] = true;

  const here = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const core = await import(pathToFileURL(join(here, "lib", "context-guard-core.mjs")).href);

  const num = (v: string | undefined, dflt: number) => {
    const n = v == null || v === "" ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : dflt;
  };
  const CAP = num(process.env.PI_CTXGUARD_CAP, 8192);
  const KEEP = num(process.env.PI_CTXGUARD_KEEP, 4);
  const HEADROOM = num(process.env.PI_CTXGUARD_HEADROOM, 6144);
  const AT_OVERRIDE = num(process.env.PI_CTXGUARD_AT, 0); // 0 = derive from window - reserve
  const ELIDE_TOOLS = (process.env.PI_CTXGUARD_ELIDE_TOOLS || "write,edit")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const QUIET = process.env.PI_CTXGUARD_QUIET === "1";
  const COMPACT_ESCAPE = process.env.PI_CTXGUARD_COMPACT !== "0"; // M4 on by default
  const ESCAPE_OVERRIDE = num(process.env.PI_CTXGUARD_ESCAPE, 0); // 0 = derive from window

  // Settings are not exposed on ctx — read compaction.{reserveTokens,keepRecentTokens} ourselves,
  // once. keepRecentTokens falls back to 3000 (this stack's settings value, NOT Pi's 20000 default).
  let reserveTokens = 16384;
  let keepRecentTokens = 3000;
  try {
    const s = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8"));
    const r = s?.compaction?.reserveTokens;
    if (typeof r === "number" && r > 0) reserveTokens = r;
    const k = s?.compaction?.keepRecentTokens;
    if (typeof k === "number" && k > 0) keepRecentTokens = k;
  } catch { /* keep the fallbacks */ }

  // Sticky transform ids for THIS session process: once elided, always elided on later rounds
  // (core stays pure — it takes these as input and returns only the additions).
  const sticky = { capIds: new Set<string>(), elideIds: new Set<string>() };

  // M4 latch (module closure): one ctx.compact per cycle; re-released only when a NEW
  // compactionSummary shows up in the incoming history AND the guarded estimate is back under the
  // threshold — hysteresis against refiring into our own resume (core.escapeDecision is the brain).
  let escapeState: { armed: boolean; keyAtArm: string } | undefined;

  pi.on("context", (event: any, ctx: any) => {
    try {
      const contextWindow = ctx?.model?.contextWindow || 32768;
      const elideAt = AT_OVERRIDE || Math.max(4096, contextWindow - reserveTokens);
      const res = core.guard(event.messages, {
        cap: CAP, keepRounds: KEEP, elideAt, headroom: HEADROOM,
        elideTools: ELIDE_TOOLS, contextWindow,
      }, sticky);

      for (const id of res.actions.capped) sticky.capIds.add(id);
      for (const t of res.actions.elided) sticky.elideIds.add(t);

      // One line when (and only when) something NEW was transformed this round; silent when idle.
      const nResults = res.actions.capped.length
        + res.actions.elided.filter((t: string) => t.startsWith("result:")).length;
      const nArgs = res.actions.elided.filter((t: string) => t.startsWith("args:")).length;
      if (!QUIET && (nResults > 0 || nArgs > 0)) {
        console.error(`context-guard: est ~${res.projectedBefore} tok -> ~${res.projectedAfter} tok `
          + `(capped ${nResults} results, elided ${nArgs} tool bodies)`);
      }

      // M4 — floor-creep escape: elision is exhausted and the GUARDED estimate still crossed the
      // escape threshold; fire Pi's compaction mid-run (once per latch cycle) and re-drive the run
      // when it lands. The transformed messages still go out below — the abort races that request
      // harmlessly (Pi drops the partial assistant).
      if (COMPACT_ESCAPE) {
        try {
          const threshold = ESCAPE_OVERRIDE || Math.max(4096, contextWindow - 4096 - 4096);
          const d = core.escapeDecision(escapeState, {
            projected: res.projectedAfter,
            threshold,
            summaryKey: core.compactionSummaryKey(event.messages),
          });
          escapeState = d.state;
          if (d.fire) {
            if (!QUIET) {
              console.error(`context-guard: escape — guarded estimate ~${res.projectedAfter} tok >= `
                + `${threshold}; compacting mid-run`);
            }
            ctx.compact({
              onComplete: () => {
                try {
                  pi.sendUserMessage(core.RESUME_MESSAGE);
                } catch { /* resume is best-effort; the session is intact either way */ }
              },
              onError: (err: any) => {
                if (!QUIET) {
                  console.error(`context-guard: mid-run compaction failed (${err?.message ?? err}) — `
                    + `not retrying until the next compaction lands`);
                }
                // latch stays armed on purpose: no retry loop; a landed compaction re-releases it
              },
            });
          }
        } catch { /* the escape must never break the transform below */ }
      }

      return res.changed ? { messages: res.messages } : undefined;
    } catch {
      return undefined; // never let the guard be what kills the run
    }
  });

  // M3 — compaction rescue. Pi already decided to compact; its summarizer serializes the whole
  // span into ONE unchunked request (transformContext is NOT applied to it), so on a small window
  // a big raw branch is a llama.cpp 400 at every boundary, forever. When the input fits with a
  // healthy output budget we stand aside (Pi's LLM summary is better); when it cannot, we hand Pi
  // a deterministic digest and it makes no LLM call at all. Active even when PI_CTXGUARD_COMPACT=0
  // — this is pure rescue, it never initiates compaction.
  pi.on("session_before_compact", (event: any, ctx: any) => {
    try {
      const prep = event?.preparation;
      if (!prep) return undefined;
      const contextWindow = ctx?.model?.contextWindow || 32768;
      const est = core.estimateSummarizerInput({
        messagesToSummarize: prep.messagesToSummarize ?? [],
        turnPrefixMessages: prep.turnPrefixMessages ?? [],
        previousSummary: prep.previousSummary ?? "",
      });
      if (!core.wouldOverflow(est.maxRequestTokens, contextWindow)) return undefined;

      // Prefer the keepRecentTokens Pi actually used for this preparation; fall back to ours.
      const keepRecent = (typeof prep?.settings?.keepRecentTokens === "number"
        && prep.settings.keepRecentTokens > 0) ? prep.settings.keepRecentTokens : keepRecentTokens;
      const plan = core.planRescue(event.branchEntries ?? [], { keepRecentTokens: keepRecent });
      const firstKeptEntryId = plan?.firstKeptEntryId ?? prep.firstKeptEntryId;
      if (!firstKeptEntryId) return undefined;
      const span = plan?.elidedMessages?.length
        ? plan.elidedMessages
        : [...(prep.messagesToSummarize ?? []), ...(prep.turnPrefixMessages ?? [])];

      const summary = core.buildDigest(span, {});
      const files = core.harvestFiles(span, {});
      if (!QUIET) {
        console.error(`context-guard: compaction rescue (digest) — Pi summarizer would need `
          + `~${est.maxRequestTokens} tok input on a ${contextWindow} window`);
      }
      return {
        compaction: {
          summary,
          firstKeptEntryId,
          tokensBefore: typeof prep.tokensBefore === "number" ? prep.tokensBefore : 0,
          details: { readFiles: files.read, modifiedFiles: files.modified.map((f: any) => f.path) },
        },
      };
    } catch {
      return undefined; // fail-soft: Pi's own summarizer path runs (and may fail as before)
    }
  });
}
