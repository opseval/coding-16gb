#!/usr/bin/env bash
# smoke-test.sh — confirm the local OpenAI endpoint + tool-calls + prefill cost before a long run.
# Auto-discovers the served model id, so it's model-agnostic.
#
# Usage: scripts/smoke-test.sh [port] [api-key]
# Env: SMOKE_MAX_PREFILL=30   fail if a ~6K-token prefill takes longer than this many seconds
set -euo pipefail

PORT="${1:-${PI_LLM_PORT:-8080}}"
KEY="${2:-${PI_LLM_KEY:-pi-local-key}}"
MAX_PREFILL="${SMOKE_MAX_PREFILL:-30}"
BASE="http://127.0.0.1:${PORT}/v1"
AUTH=(-H "Authorization: Bearer $KEY" -H 'Content-Type: application/json')
fail=0

echo "1) endpoint up on :$PORT ?"
curl -fsS "$BASE/models" "${AUTH[@]}" -o /tmp/sm_models.json 2>/dev/null \
  || { echo "   FAIL: no response at $BASE/models — is llama-server running?"; exit 1; }
MODEL="$(python3 -c 'import json,sys;d=json.load(open("/tmp/sm_models.json"));print(d["data"][0]["id"])' 2>/dev/null || true)"
echo "   OK — served model id: ${MODEL:-<none>}"
[ -n "$MODEL" ] || { echo "   FAIL: could not parse a model id"; exit 1; }

echo "2) chat completion returns content?"
# max_tokens must budget for the model's reasoning preamble — the shipped serve config runs Gemma 4 with
# reasoning ON, so a tiny budget (e.g. 8) is entirely consumed by thinking and content comes back empty
# (finish_reason=length). 64 leaves room for the reasoning + a short answer.
RESP="$(curl -fsS "$BASE/chat/completions" "${AUTH[@]}" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word OK.\"}],\"max_tokens\":64,\"temperature\":0}")"
CONTENT="$(printf '%s' "$RESP" | python3 -c 'import json,sys;print((json.load(sys.stdin)["choices"][0]["message"].get("content") or "").strip())' 2>/dev/null || true)"
if printf '%s' "$CONTENT" | grep -qi 'ok'; then echo "   OK — content: $CONTENT"; else echo "   FAIL: unexpected content: ${CONTENT:-<empty>}"; fail=1; fi

echo "3) emits a structured tool_call?"
RESP2="$(curl -fsS "$BASE/chat/completions" "${AUTH[@]}" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"List files in the current directory.\"}],\"max_tokens\":128,\"temperature\":0,\"tools\":[{\"type\":\"function\",\"function\":{\"name\":\"ls\",\"description\":\"list directory\",\"parameters\":{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}}}}}],\"tool_choice\":\"auto\"}")"
HASTOOL="$(printf '%s' "$RESP2" | python3 -c 'import json,sys;m=json.load(sys.stdin)["choices"][0]["message"];print("yes" if m.get("tool_calls") else "no")' 2>/dev/null || echo no)"
if [ "$HASTOOL" = yes ]; then echo "   OK — emitted tool_calls"; else echo "   NOTE: no tool_calls — check --jinja / the model template if Pi tool use misbehaves"; fi

echo "4) prefill cost on a ~6K-token prompt (exposes re-prefill / no-cache behavior)?"
BIG="$(python3 -c 'print(("The quick brown fox jumps over the lazy dog. "*900))')"
PAYLOAD="$(python3 -c 'import json,sys;print(json.dumps({"model":sys.argv[1],"messages":[{"role":"user","content":sys.argv[2]}],"max_tokens":1,"temperature":0}))' "$MODEL" "$BIG")"
# warm, then measure (a working prefix cache makes the 2nd call cheap; Gemma SWA will not)
curl -fsS "$BASE/chat/completions" "${AUTH[@]}" -d "$PAYLOAD" -o /dev/null 2>/dev/null || true
SECS="$(curl -fsS "$BASE/chat/completions" "${AUTH[@]}" -d "$PAYLOAD" -o /dev/null -w '%{time_total}' 2>/dev/null || echo 999)"
echo "   prefill ~${SECS}s (threshold ${MAX_PREFILL}s)"
awk -v s="$SECS" -v m="$MAX_PREFILL" 'BEGIN{exit !(s+0>m+0)}' \
  && { echo "   FAIL: prefill exceeds ${MAX_PREFILL}s — re-prefill cost is too high for multi-turn agent loops on this model/build"; fail=1; } \
  || echo "   OK — prefill within budget"

[ "$fail" -eq 0 ] && echo "smoke-test: PASS" || { echo "smoke-test: FAIL"; exit 1; }
