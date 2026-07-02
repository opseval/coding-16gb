#!/usr/bin/env bash
# serve-granite.sh — IBM Granite 4.0 H-Tiny on :8082.
# Hybrid Mamba-2 (~4GB, ~1B active) → ~30-50 tok/s, low heat, cheap long context, AND its prefix
# cache works across turns — the best thermal/latency profile for LONG AUTONOMOUS loops on a
# passively-cooled Mac. Mid-tier raw coder; lean on the scaffolding + cloud escape for hard subtasks.
# Stop other local servers first (one model fits in 16GB at a time).
set -euo pipefail

# OOM-safety: only ONE local model server at a time. Two ~20GB --mlock'd models will hard-OOM a 36GB
# box (and can log you out). Free our model ports first; leaves other servers (e.g. bge-small) alone.
for _p in 8080 8081 8082; do _pid=$(/usr/sbin/lsof -ti tcp:$_p 2>/dev/null || true); [ -n "${_pid:-}" ] && { echo "OOM-guard: stopping model server on :$_p (pid $_pid)"; kill "$_pid" 2>/dev/null || true; }; done; sleep 1

LLAMA_SERVER="${LLAMA_SERVER:-$(command -v llama-server || echo /opt/homebrew/bin/llama-server)}"
[ -x "$LLAMA_SERVER" ] || { echo "llama-server not found (brew install llama.cpp)"; exit 1; }

DIR="${GRANITE_DIR:-$HOME/models/granite-4-tiny}"
MODEL="${GRANITE_GGUF:-$( (ls "$DIR"/*Q6_K*.gguf "$DIR"/*Q8_0*.gguf "$DIR"/*.gguf 2>/dev/null | head -1) || true)}"
[ -n "${MODEL:-}" ] && [ -f "$MODEL" ] || { echo "No GGUF in $DIR — run: scripts/download-models.sh --alt"; exit 1; }

echo "serve-granite: $MODEL on :8082"
exec "$LLAMA_SERVER" \
  -m "$MODEL" -a granite-4-tiny \
  --host 127.0.0.1 --port 8082 \
  -c 32768 -ngl 999 -fa on \
  --jinja \
  --cache-reuse 256 \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --cache-ram 2048 \
  --parallel 1 --mlock \
  --temp 0.2 --top-p 0.9
