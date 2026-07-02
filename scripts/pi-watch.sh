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
#   PI_THINKING=medium
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
THINKING="${PI_THINKING:-medium}"
WORKDIR="${PI_WATCH_WORKDIR:-$PWD}"
LOG="${PI_LOG:-$HOME/pi-session.log}"
PI_AGENT="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
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
  *,docs,*) [ -f "$DEVDOCS_EXT" ] || { echo "pi-watch: WARN 'docs' in \$TOOLS but $DEVDOCS_EXT missing → dropping it (run scripts/install.sh)."; TOOLS="${TOOLS//,docs/}"; } ;;
esac
ext_args=(); [ -f "$EXT_FILE" ] && ext_args=(--extension "$EXT_FILE")
# devdocs.ts is loaded explicitly (like frontier-scaffold) so the `docs` tool is registered in this
# run path; only when it survived the fail-soft check above.
case ",$TOOLS," in *,docs,*) ext_args+=(--extension "$DEVDOCS_EXT") ;; esac

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
  echo "pi-watch: not done, cooling ${COOLDOWN}s then resuming" | tee -a "$LOG"
  sleep "$COOLDOWN"
done
echo "pi-watch: stopped after $iter iterations." | tee -a "$LOG"
