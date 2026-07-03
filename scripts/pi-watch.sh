#!/usr/bin/env bash
# pi-watch.sh — watchdog for long autonomous Pi sessions on a 16 GB Apple-silicon Mac.
#
# Loops `pi --session <file> -p "<msg>"` so the session auto-resumes from its last git checkpoint
# after a crash/OOM, with hard caps and a cooldown gap for thermal recovery. Completion is gated on
# the agent writing a `<<DONE>>` sentinel into NOTES.md — NOT on exit 0 (print mode returns 0 even
# when it did nothing).
#
# Usage:
#   scripts/pi-watch.sh <session-id-or-path> "<task prompt>"
#
# Env (with defaults):
#   PI_MAX_WALL=14400     wall-clock budget, seconds (4h)
#   PI_MAX_ITERS=40       max resume iterations
#   PI_COOLDOWN=45        seconds idle between iterations (thermal recovery)
#   PI_TOOLS=read,bash,edit,write,grep,find,ls,verify,docs
#   PI_THINKING=off
#   PI_SKILLS="plan verify tdd autonomy docs"   # loaded from <agent-dir>/skills
#   PI_WATCH_WORKDIR=$PWD  # where PLAN.md / NOTES.md live (the repo being worked)
#   PI_LOG=~/pi-session.log
set -euo pipefail

SESSION="${1:?usage: pi-watch.sh <session-id-or-path> \"<task prompt>\"}"
TASK="${2:-}"
MAX_WALL="${PI_MAX_WALL:-14400}"
MAX_ITERS="${PI_MAX_ITERS:-40}"
COOLDOWN="${PI_COOLDOWN:-45}"
TOOLS="${PI_TOOLS:-read,bash,edit,write,grep,find,ls,verify,docs}"
# off by default — matches launch.sh + the on-device A/B (thinking-on regresses the loop);
# inert for non-reasoning primaries; opt in with PI_THINKING=medium for a deep autonomous run.
THINKING="${PI_THINKING:-off}"
WORKDIR="${PI_WATCH_WORKDIR:-$PWD}"
LOG="${PI_LOG:-$HOME/pi-session.log}"
# Force compaction between iterations once the session context reaches this many tokens.
# Pi >= 0.80 print mode auto-compacts (pre-prompt + after each agent run) from settings.json,
# but never MID-run — this backstop still bounds how big an iteration can start. Keep it
# coupled to the client config: contextWindow (32768) - settings.json reserveTokens (12288).
COMPACT_AT="${PI_COMPACT_AT:-20480}"
PI_AGENT="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPACT_HELPER="$SCRIPT_DIR/pi-compact.py"
SKILLS_DIR="$PI_AGENT/skills"
EXT_FILE="$PI_AGENT/extensions/frontier-scaffold.ts"

# Fail closed: the `verify` tool AND the bash guardrail both come from frontier-scaffold. If it isn't
# deployed, an autonomous run would silently lose its done-gate AND its destructive-command protection.
case ",$TOOLS," in
  *,verify,*) [ -f "$EXT_FILE" ] || { echo "FATAL: \$TOOLS includes 'verify' but $EXT_FILE is missing. Run scripts/install.sh."; exit 1; } ;;
esac
# Fail soft: `docs` (offline API lookup) is a helper, not a safety gate — if its extension isn't
# deployed, drop it from the allowlist with a warning instead of aborting the run.
DEVDOCS_EXT="$PI_AGENT/extensions/devdocs.ts"
case ",$TOOLS," in
  *,docs,*) [ -f "$DEVDOCS_EXT" ] || { echo "pi-watch: WARN 'docs' in \$TOOLS but $DEVDOCS_EXT missing → dropping it (run scripts/install.sh)."
              # comma-pad so 'docs' strips even as the first (or only) entry of a user-supplied $TOOLS
              TOOLS=",$TOOLS,"; TOOLS="${TOOLS//,docs,/,}"; TOOLS="${TOOLS#,}"; TOOLS="${TOOLS%,}"; } ;;
esac
ext_args=(); [ -f "$EXT_FILE" ] && ext_args=(--extension "$EXT_FILE")
# devdocs.ts is loaded explicitly (like frontier-scaffold) so the `docs` tool is registered in this
# run path; only when it survived the fail-soft check above.
case ",$TOOLS," in *,docs,*) ext_args+=(--extension "$DEVDOCS_EXT") ;; esac
# context-guard.ts bounds context MID-run (Pi + maybe_compact only act BETWEEN iterations; a single
# 47-round iteration can still wedge at the zero-cliff without it). Fail-soft: a missing guard must
# not stop an autonomous run — it just runs unguarded, warn and continue.
CTXGUARD_EXT="$PI_AGENT/extensions/context-guard.ts"
if [ -f "$CTXGUARD_EXT" ]; then ext_args+=(--extension "$CTXGUARD_EXT")
else echo "pi-watch: WARN $CTXGUARD_EXT missing → no mid-run context guard (run scripts/install.sh)."; fi

skill_args=()
for s in ${PI_SKILLS:-plan verify tdd autonomy docs}; do
  [ -d "$SKILLS_DIR/$s" ] && skill_args+=(--skill "$SKILLS_DIR/$s")
done

# Normalize a bare session id to a real path (Pi treats an arg as a path only if it has /, \, or .jsonl).
case "$SESSION" in
  */*|*\\*|*.jsonl) : ;;
  *) SESSION="$PI_AGENT/sessions/${SESSION}.jsonl" ;;
esac
mkdir -p "$(dirname "$SESSION")"

RESUME_MSG="Resume autonomous work: read PLAN.md and NOTES.md, continue the next unchecked step, call verify after each step. Use the docs tool to confirm any unfamiliar stdlib/CLI signature before writing it instead of guessing. Append the exact line '<<DONE>>' to NOTES.md ONLY when the entire task is complete and verify passes."

notify() { osascript -e "display notification \"$1\" with title \"pi-watch\"" >/dev/null 2>&1 || true; }
is_done() { [ -f "$WORKDIR/NOTES.md" ] && grep -q '<<DONE>>' "$WORKDIR/NOTES.md"; }

# Current session context size = the last assistant message's server-reported total tokens.
session_tokens() {
  [ -f "$SESSION" ] || { echo 0; return; }
  python3 - "$SESSION" <<'PY' 2>/dev/null || echo 0
import json, sys
tot = 0
for line in open(sys.argv[1]):
    line = line.strip()
    if not line:
        continue
    try:
        r = json.loads(line)
    except ValueError:
        continue
    m = r.get("message", r)
    if m.get("role") == "assistant":
        t = (m.get("usage") or {}).get("totalTokens")
        if isinstance(t, int):
            tot = t
print(tot)
PY
}

# Force a compaction when the session has grown past COMPACT_AT — a between-iterations
# backstop for Pi >= 0.80's native checks (pre-submit/agent_end, even in print mode),
# which never run MID-run: bounding iteration START size keeps the run away from the
# zero-cliff (window - 4096) where even the compaction summary starves. Fail-soft:
# a missing helper/python must not stop the run — compaction is a health measure,
# not a correctness gate.
maybe_compact() {
  [ "$COMPACT_AT" -gt 0 ] 2>/dev/null || return 0
  local ctx; ctx="$(session_tokens)"
  [ "$ctx" -ge "$COMPACT_AT" ] 2>/dev/null || return 0
  if ! command -v python3 >/dev/null 2>&1 || [ ! -f "$COMPACT_HELPER" ]; then
    echo "pi-watch: WARN session ~${ctx} tok >= ${COMPACT_AT} but pi-compact.py/python3 unavailable — skipping compaction" | tee -a "$LOG"
    return 0
  fi
  echo "pi-watch: session ~${ctx} tok >= ${COMPACT_AT} — forcing compaction" | tee -a "$LOG"
  python3 "$COMPACT_HELPER" "$SESSION" -- --thinking "$THINKING" >>"$LOG" 2>&1 \
    || echo "pi-watch: WARN compaction helper exited non-zero (continuing)" | tee -a "$LOG"
}

start="$(date +%s)"
iter=0
echo "pi-watch: session=$SESSION workdir=$WORKDIR wall=${MAX_WALL}s iters=$MAX_ITERS" | tee -a "$LOG"

while :; do
  iter=$((iter + 1))
  now="$(date +%s)"; elapsed=$((now - start))
  if [ "$elapsed" -ge "$MAX_WALL" ]; then echo "pi-watch: wall-clock cap hit" | tee -a "$LOG"; notify "wall-clock cap hit"; break; fi
  if [ "$iter" -gt "$MAX_ITERS" ]; then echo "pi-watch: iteration cap hit" | tee -a "$LOG"; notify "iteration cap hit"; break; fi

  if [ "$iter" -eq 1 ] && [ -n "$TASK" ]; then MSG="$TASK"; else MSG="$RESUME_MSG"; fi
  echo "--- pi-watch iter $iter (elapsed ${elapsed}s) ---" | tee -a "$LOG"
  pi --session "$SESSION" -p --thinking "$THINKING" --tools "$TOOLS" \
     "${skill_args[@]}" "${ext_args[@]}" "$MSG" >>"$LOG" 2>&1 || echo "pi-watch: agent exited non-zero (crash/OOM?)" | tee -a "$LOG"

  if is_done; then echo "pi-watch: <<DONE>> found — task complete" | tee -a "$LOG"; notify "session complete"; break; fi
  # Compact before the next iteration if the session has grown too large (bounds iteration START size).
  maybe_compact
  echo "pi-watch: not done, cooling ${COOLDOWN}s then resuming" | tee -a "$LOG"
  sleep "$COOLDOWN"
done
echo "pi-watch: stopped after $iter iterations." | tee -a "$LOG"
