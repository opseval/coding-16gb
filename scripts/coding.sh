#!/usr/bin/env bash
# coding.sh — git-style dispatcher for the coding stack. Invoked via the `coding` shim
# (which sets CODING_HOME); also runnable directly from the repo's scripts/ dir.
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SELF_DIR/coding-lib.sh"

# Test/inspection seam: print the resolved target instead of running it.
_go() { # _go <script-basename> [args...]
  local target="$SELF_DIR/$1"; shift
  if [ "${CODING_DISPATCH_DRYRUN:-0}" = 1 ]; then echo "would exec: $target $*"; exit 0; fi
  [ -e "$target" ] || { echo "coding: missing component: $target" >&2; exit 1; }
  exec bash "$target" "$@"
}

usage() {
  cat <<'EOF'
coding — local agentic-coding stack

  coding                    launch: pick a model, serve it, open interactive Pi (in $PWD)
  coding "build X…"         launch, seeded with an initial task
  coding run [args…]        explicit form of the launcher
  coding watch <sess> "…"   autonomous pi-watch loop
  coding serve <model>      serve a model only (gemma|gptoss|granite)
  coding stop               stop any running model server
  coding smoke              smoke-test the served endpoint
  coding models [--alt]     (re)download models
  coding docs               (re)download offline docsets
  coding status             show what's installed / served
  coding uninstall [--purge] remove the stack (--purge also deletes models + docsets)
  coding help               this text
EOF
}

cmd="${1:-}"; [ $# -gt 0 ] && shift || true
case "$cmd" in
  ""|run)      _go launch.sh "$@" ;;
  watch)       _go pi-watch.sh "$@" ;;
  serve)
    case "${1:-gemma}" in
      gemma)   _go serve-gemma.sh ;;
      gptoss)  _go serve-gptoss.sh ;;
      granite) _go serve-granite.sh ;;
      *) echo "coding serve: unknown model '${1:-}' (gemma|gptoss|granite)" >&2; exit 2 ;;
    esac ;;
  stop)        _go launch.sh --stop ;;
  smoke)       _go smoke-test.sh "$@" ;;
  models)      _go download-models.sh "$@" ;;
  docs)        _go devdocs-download.sh "$@" ;;
  status)
    if [ -f "$SELF_DIR/../scripts/install.sh" ]; then bash "$SELF_DIR/../scripts/install.sh" --status
    else _go uninstall.sh --status; fi ;;
  uninstall)   _go uninstall.sh "$@" ;;
  help|-h|--help) usage ;;
  -*|*\ *)     _go launch.sh "$cmd" "$@" ;;   # a flag or a task-with-spaces → launcher
  *)           echo "coding: unknown subcommand '$cmd'" >&2; usage >&2; exit 2 ;;
esac
