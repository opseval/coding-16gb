# helpers.sh — sandbox $HOME + assertions for the install/uninstall suite.
# Source this; it computes REPO before any $HOME change.
set -uo pipefail
FAIL=0
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

sandbox() {                       # fresh isolated HOME; clear Pi-dir overrides so defaults land in it
  SANDBOX="$(mktemp -d)"
  export HOME="$SANDBOX"
  unset PI_CODING_AGENT_DIR PI_AGENT_DIR CODING_HOME CODING_BIN_DIR CODING_ZPROFILE CODING_MODELS_DIR PI_DEVDOCS_DIR
}
assert() {                        # assert '<test-cmd>' '<description>'
  if eval "$1"; then echo "  ok: $2"; else echo "  FAIL: $2   [$1]"; FAIL=1; fi
}
finish() {
  [ -n "${SANDBOX:-}" ] && rm -rf "$SANDBOX"
  if [ "$FAIL" = 0 ]; then echo "PASS: $(basename "$0")"; else echo "FAIL: $(basename "$0")"; exit 1; fi
}
