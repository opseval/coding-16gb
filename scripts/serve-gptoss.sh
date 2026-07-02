#!/usr/bin/env bash
# serve-gptoss.sh — OpenAI gpt-oss-20b (MXFP4) on :8081.
# Full-attention MoE → cross-turn prefix cache WORKS (unlike Gemma), so good for multi-turn loops;
# but MARGINAL memory fit (~12GB weights) — needs the 14336 wired cap, context kept modest, other
# apps closed. Stop the Gemma/Granite server first (only one model fits in 16GB at a time).
set -euo pipefail

# OOM-safety: only ONE local model server at a time. Two ~20GB --mlock'd models will hard-OOM a 36GB
# box (and can log you out). Free our model ports first; leaves other servers (e.g. bge-small) alone.
for _p in 8080 8081 8082; do _pid=$(/usr/sbin/lsof -ti tcp:$_p 2>/dev/null || true); [ -n "${_pid:-}" ] && { echo "OOM-guard: stopping model server on :$_p (pid $_pid)"; kill "$_pid" 2>/dev/null || true; }; done; sleep 1

LLAMA_SERVER="${LLAMA_SERVER:-$(command -v llama-server || echo /opt/homebrew/bin/llama-server)}"
[ -x "$LLAMA_SERVER" ] || { echo "llama-server not found (brew install llama.cpp)"; exit 1; }

DIR="${GPTOSS_DIR:-$HOME/models/gpt-oss-20b}"
MODEL="${GPTOSS_GGUF:-$( (ls "$DIR"/*mxfp4*.gguf "$DIR"/*.gguf 2>/dev/null | head -1) || true)}"
[ -n "${MODEL:-}" ] && [ -f "$MODEL" ] || { echo "No GGUF in $DIR — run: scripts/download-models.sh --alt"; exit 1; }

echo "serve-gptoss: $MODEL on :8081 (marginal fit — keep ctx <=16K, other apps closed)"
# gpt-oss reasoning effort is honored by llama.cpp ONLY via chat_template_kwargs (the top-level
# reasoning_effort field is ignored); set it here. "medium" = harmony default, so only high/low matter.
exec "$LLAMA_SERVER" \
  -m "$MODEL" -a gpt-oss-20b \
  --host 127.0.0.1 --port 8081 \
  -c 16384 -ngl 999 -fa on \
  --jinja --reasoning-format auto \
  --chat-template-kwargs '{"reasoning_effort":"high"}' \
  --cache-reuse 256 \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --cache-ram 0 \
  --parallel 1 --mlock \
  --temp 1.0 --top-p 1.0
