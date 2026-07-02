#!/usr/bin/env bash
# download-models.sh — fetch GGUF weights into ~/models.
#   scripts/download-models.sh                 # Gemma 4 12B — the daily driver (default)
#   scripts/download-models.sh --with-granite  # also Granite 4.0 H-Tiny Q6_K (fast/cool; SIMPLE tasks only)
#   scripts/download-models.sh --alt           # also gpt-oss-20b (~12GB, marginal-fit reasoning fallback)
# (flags combine, e.g. --with-granite --alt)
#
# Quant choices set by the model-layer evaluation (Jun 2026):
#  - Gemma 4 12B -> Unsloth UD-Q4_K_XL of the QAT line (same QAT checkpoint, ~260MB smaller than Google's
#    QAT q4_0, with chat-template/tool-call fixes). The interactive + autonomous workhorse. Provenance:
#    pure re-quant of Google's QAT weights (clean provenance, no added training lineage).
#  - Granite 4.0 H-Tiny -> Q6_K. OPT-IN (--with-granite): the model-layer eval DEMOTED it from the
#    autonomous default — it cannot complete complex multi-file builds. Its
#    only niche is fast/cool SIMPLE tasks + a working cross-turn prefix cache. Most users won't need it.
#  - gpt-oss-20b -> native MXFP4 (every GGUF is ~12GB regardless of label; no quality reason to pay more).
# Source quants ONLY from google/unsloth/ggml-org/bartowski (pure re-quants, no added training lineage).
set -euo pipefail

WITH_GRANITE=0; WITH_ALT=0
for a in "$@"; do
  case "$a" in
    --with-granite) WITH_GRANITE=1 ;;
    --alt) WITH_ALT=1 ;;
    *) echo "unknown flag: $a  (use --with-granite and/or --alt)"; exit 2 ;;
  esac
done

command -v hf >/dev/null 2>&1 || { echo "Install the HF CLI first:  pip3 install --user -U huggingface_hub  (and put \$(python3 -m site --user-base)/bin on PATH — see README)"; exit 1; }
req(){ ls "$1"/*.gguf >/dev/null 2>&1 || { echo "ERROR: no .gguf in $1 — hf --include matched no file (check the repo's actual filenames). Nothing downloaded." >&2; exit 1; }; }
mkdir -p "$HOME/models"

echo "==> Daily driver: Gemma 4 12B (Unsloth UD-Q4_K_XL of the QAT line, ~6.7GB)"
# Equally defensible vendor-official alternative: google/gemma-4-12B-it-qat-q4_0-gguf (q4_0, ~7GB).
hf download unsloth/gemma-4-12B-it-qat-GGUF --include "*UD-Q4_K_XL*.gguf" --local-dir "$HOME/models/gemma-4-12b"
req "$HOME/models/gemma-4-12b"

if [ "$WITH_GRANITE" = 1 ]; then
  echo "==> Opt-in: Granite 4.0 H-Tiny (Q6_K, ~5.7GB) — fast/cool, SIMPLE tasks only (fails complex builds)"
  # If this repo id 404s, try: bartowski/granite-4.0-h-tiny-GGUF
  hf download unsloth/granite-4.0-h-tiny-GGUF --include "*Q6_K*.gguf" --local-dir "$HOME/models/granite-4-tiny"
  req "$HOME/models/granite-4-tiny"
fi

if [ "$WITH_ALT" = 1 ]; then
  echo "==> Fallback: gpt-oss-20b (MXFP4, ~12GB — marginal fit, full-attention reasoning)"
  hf download ggml-org/gpt-oss-20b-GGUF --include "*mxfp4*.gguf" --local-dir "$HOME/models/gpt-oss-20b"
  req "$HOME/models/gpt-oss-20b"
fi

echo "Done. Models under ~/models. Interactive + autonomous: scripts/serve-gemma.sh"
