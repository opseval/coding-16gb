#!/usr/bin/env bash
# serve-gemma.sh — Gemma 4 12B (Google, QAT q4_0) on :8080.
# Highest-capability local model; comfortable, swap-safe fit (~7GB weights + q8 KV).
#
# NOTE on caching: Gemma 4 uses Shared-KV + sliding-window attention, so llama.cpp's cross-turn
# prefix reuse (--cache-reuse) is INERT for it (logs sim=0.000, full re-prefill every turn —
# llama.cpp #21468, open as of Jun 2026). That means a per-turn re-prefill tax on long multi-turn
# loops. Best for interactive / highest-quality bursts; for long *autonomous* loops consider Granite
# (serve-granite.sh) or gpt-oss (serve-gptoss.sh), whose prefix caches actually work.
#
# Only ONE local model fits in 16GB RAM at a time — run this OR serve-gptoss / serve-granite.
set -euo pipefail

# OOM-safety: only ONE local model server at a time. Two ~20GB --mlock'd models will hard-OOM a 36GB
# box (and can log you out). Free our model ports first; leaves other servers (e.g. bge-small) alone.
for _p in 8080 8081 8082; do _pid=$(/usr/sbin/lsof -ti tcp:$_p 2>/dev/null || true); [ -n "${_pid:-}" ] && { echo "OOM-guard: stopping model server on :$_p (pid $_pid)"; kill "$_pid" 2>/dev/null || true; }; done; sleep 1

LLAMA_SERVER="${LLAMA_SERVER:-$(command -v llama-server || echo /opt/homebrew/bin/llama-server)}"
[ -x "$LLAMA_SERVER" ] || { echo "llama-server not found (brew install llama.cpp)"; exit 1; }

DIR="${GEMMA_DIR:-$HOME/models/gemma-4-12b}"
MODEL="${GEMMA_GGUF:-$( (ls "$DIR"/*UD-Q4_K_XL*.gguf "$DIR"/*q4_0*.gguf "$DIR"/*.gguf 2>/dev/null | grep -v -i -e mmproj -e mtp | head -1) || true)}"
[ -n "${MODEL:-}" ] && [ -f "$MODEL" ] || { echo "No GGUF found in $DIR — run scripts/download-models.sh"; exit 1; }

echo "serve-gemma: $MODEL on :8080"
# Gemma 4 sampling is temp 1.0 / top-k 64 / top-p 0.95 (it degrades at low temp — do NOT lower for
# "determinism"; use GBNF/JSON-schema grammar for tool-call reproducibility instead).
# Reasoning is OFF by default in Gemma 4; models.json enables it via chat_template_kwargs.enable_thinking
# and --reasoning-format routes the thinking into reasoning_content. VERIFY the thought channel doesn't
# leak into content on your build (open bugs #21338/#21836); if it does, drop --reasoning-format and set
# reasoning:false in models.json.
exec "$LLAMA_SERVER" \
  -m "$MODEL" -a gemma-4-12b \
  --host 127.0.0.1 --port 8080 \
  -c 32768 -ngl 999 -fa on \
  --jinja --reasoning-format auto \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --cache-ram 0 --ctx-checkpoints 0 \
  --parallel 1 --mlock \
  --temp 1.0 --top-p 0.95 --top-k 64 --min-p 0.01
