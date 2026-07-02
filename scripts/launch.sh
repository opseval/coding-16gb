#!/usr/bin/env bash
# launch.sh — pick a local model, serve it, and start Pi against it (the `coding` launcher).
# Run from the directory you want to code in — Pi opens in $PWD. Serve scripts are its siblings.
# (all three models below are open-weight: Gemma/Google, gpt-oss/OpenAI, Granite/IBM.)
#
#   coding                 # menu -> serve -> interactive Pi
#   coding "build X ..."   # same, but seed Pi with an initial task
#   coding stop            # stop whichever model server is running
#
# Env: PI_THINKING=medium  PI_PLAIN=1 (skip skills/extension/verify)
set -euo pipefail

# ============================ project config ============================
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"   # serve scripts are our siblings (repo or ~/.local/share/coding)

WIRED_REC=14336   # recommended iogpu.wired_limit_mb for a 16 GB Apple-silicon Mac

# model registry (parallel arrays):  label | serve-script | provider | model-id | port | note
LABEL=( "Gemma 4 12B          QAT-Q4_K_XL — PRIMARY · interactive + autonomous"
        "gpt-oss-20b          MXFP4       — alternate · full-attention MoE"
        "Granite 4.0 H-Tiny   Q6_K        — fast & cool · simple tasks" )
SERVE=( "serve-gemma.sh"        "serve-gptoss.sh"   "serve-granite.sh"  )
PROV=(  "gemma-local"           "gptoss-local"      "granite-local"     )
MODEL=( "gemma-4-12b"           "gpt-oss-20b"       "granite-4-tiny"    )
PORT=(  8080                    8081                8082                )
NOTE=(  "SWA model: re-prefills on compaction — keep effective context small."
        "MARGINAL RAM fit — close other apps; context stays <=16K."
        "fast/cool but weak on complex builds — lean on the cloud escape (Ctrl+P) for hard subtasks." )
# =======================================================================

# ------------------------------- engine --------------------------------
PI_AGENT="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
THINKING="${PI_THINKING:-medium}"
LOGDIR="$HOME/.cache/pi-launch"; mkdir -p "$LOGDIR"

stop_servers(){
  local any=0 pid
  for p in "${PORT[@]}"; do
    pid=$(/usr/sbin/lsof -ti tcp:"$p" 2>/dev/null || true)
    [ -n "${pid:-}" ] && { echo "stopping model server on :$p (pid $pid)"; kill "$pid" 2>/dev/null || true; any=1; }
  done
  [ "$any" = 0 ] && echo "no model server running on ports: ${PORT[*]}"
}

case "${1:-}" in
  --stop)      stop_servers; exit 0 ;;
  --help|-h)   sed -n '2,10p' "$0"; exit 0 ;;
esac

command -v pi >/dev/null 2>&1 || { echo "pi not found (npm i -g @earendil-works/pi-coding-agent)"; exit 1; }

# ---- menu ----
n=${#LABEL[@]}
echo "coding-16gb — which model?"
for i in $(seq 0 $((n-1))); do printf "  %d) %s\n" "$((i+1))" "${LABEL[$i]}"; done
printf "Select [1-%d] (default 1): " "$n"
read -r choice </dev/tty 2>/dev/null || choice=1
choice="${choice:-1}"
case "$choice" in ""|*[!0-9]*) echo "invalid selection"; exit 1 ;; esac
{ [ "$choice" -ge 1 ] && [ "$choice" -le "$n" ]; } || { echo "out of range"; exit 1; }
idx=$((choice-1))
serve="${SERVE[$idx]}"; prov="${PROV[$idx]}"; model="${MODEL[$idx]}"; port="${PORT[$idx]}"
echo "→ ${LABEL[$idx]}"
[ -n "${NOTE[$idx]}" ] && echo "  note: ${NOTE[$idx]}"

# ---- soft wired-memory check (non-fatal) ----
cur_wired=$(sysctl -n iogpu.wired_limit_mb 2>/dev/null || echo 0)
if [ "${cur_wired:-0}" -lt "$WIRED_REC" ]; then
  echo "  note: iogpu.wired_limit_mb=$cur_wired < recommended $WIRED_REC."
  echo "        If you hit a Metal alloc / OOM, run:  sudo sysctl iogpu.wired_limit_mb=$WIRED_REC"
fi

# ---- serve (reuse if the chosen model is already warm; else start it; OOM-guard in the serve script stops others) ----
if curl -fsS "http://127.0.0.1:$port/v1/models" 2>/dev/null | grep -q "\"$model\""; then
  echo "✓ $model already serving on :$port — reusing (warm)."
else
  log="$LOGDIR/serve-$model.log"
  echo "starting $serve on :$port  (log: $log)"
  nohup bash "$SELF_DIR/$serve" >"$log" 2>&1 &
  srv_pid=$!
  printf "loading model"
  ready=0
  for _ in $(seq 1 120); do
    if curl -fsS "http://127.0.0.1:$port/health" >/dev/null 2>&1; then ready=1; break; fi
    kill -0 "$srv_pid" 2>/dev/null || { echo; echo "✗ server exited early — last log lines:"; tail -n 25 "$log"; exit 1; }
    printf "."; sleep 2
  done
  echo
  [ "$ready" = 1 ] || { echo "✗ not ready after ~4 min — last log lines:"; tail -n 25 "$log"; exit 1; }
  echo "✓ $model ready on :$port."
fi

# ---- Pi capability args: skills + frontier-scaffold extension (the stack's structure layer) ----
tools="read,bash,edit,write,grep,find,ls,verify,docs"
ext="$PI_AGENT/extensions/frontier-scaffold.ts"; devdocs_ext="$PI_AGENT/extensions/devdocs.ts"
ext_args=(); skill_args=()
if [ -n "${PI_PLAIN:-}" ]; then
  tools="read,bash,edit,write,grep,find,ls"
elif [ -f "$ext" ]; then
  ext_args=(--extension "$ext")
  for s in plan verify tdd autonomy docs; do [ -d "$PI_AGENT/skills/$s" ] && skill_args+=(--skill "$PI_AGENT/skills/$s"); done
  # the `docs` tool comes from devdocs.ts — load it explicitly too, or drop 'docs' from the allowlist if absent
  if [ -f "$devdocs_ext" ]; then ext_args+=(--extension "$devdocs_ext")
  else tools="${tools//,docs/}"; echo "note: $devdocs_ext missing → dropping 'docs' tool (reinstall to enable it)."; fi
else
  echo "note: $ext missing → dropping 'verify'+'docs' tools (reinstall to enable them)."
  tools="read,bash,edit,write,grep,find,ls"
fi

echo "starting Pi → provider=$prov  model=$model  (cwd: $PWD)"
echo
pi --provider "$prov" --model "$model" --tools "$tools" --thinking "$THINKING" \
   "${skill_args[@]}" "${ext_args[@]}" "$@"

echo
echo "Pi exited. The $model server is still warm on :$port (instant restart)."
echo "Stop it with:  $(basename "$0") --stop"
