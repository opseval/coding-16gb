#!/usr/bin/env bash
# coding-lib.sh — shared paths + PATH-block helpers for install.sh / uninstall.sh / coding.sh.
# SOURCE this file; do not execute it. Every path honors $HOME (and explicit overrides) so a
# sandbox HOME isolates the whole stack for tests.
# shellcheck disable=SC2034  # vars are consumed by the scripts that source this lib

CODING_BIN_DIR="${CODING_BIN_DIR:-$HOME/.local/bin}"
CODING_HOME="${CODING_HOME:-$HOME/.local/share/coding}"
CODING_CMD="$CODING_BIN_DIR/coding"
CODING_MANIFEST="$CODING_HOME/.manifest"
PI_DIR="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
CODING_ZPROFILE="${CODING_ZPROFILE:-$HOME/.zprofile}"
CODING_MODELS_DIR="${CODING_MODELS_DIR:-$HOME/models}"
CODING_DEVDOCS_DIR="${PI_DEVDOCS_DIR:-$HOME/.pi/devdocs}"

CODING_PATH_MARKER="# >>> coding install (PATH) >>>"
CODING_PATH_END="# <<< coding install (PATH) <<<"

# path_block_present <file> — 0 if our marked block is present.
path_block_present() { [ -f "$1" ] && grep -qF "$CODING_PATH_MARKER" "$1"; }

# path_block_add <file> — append the marked PATH block exactly once.
path_block_add() {
  local f="$1"
  path_block_present "$f" && return 0
  mkdir -p "$(dirname "$f")"
  # Ensure the file ends in a newline first, else our start marker glues onto the user's
  # last line (corrupting it AND making the block unremovable — the marker is no longer
  # on its own line for the exact-match remover).
  [ -s "$f" ] && [ -n "$(tail -c1 "$f")" ] && printf '\n' >> "$f"
  {
    printf '%s\n' "$CODING_PATH_MARKER"
    printf 'export PATH="%s:$PATH"\n' "$CODING_BIN_DIR"
    printf '%s\n' "$CODING_PATH_END"
  } >> "$f"
}

# path_block_remove <file> — delete the marked block (exact markers only). Fail-soft.
path_block_remove() {
  local f="$1"
  { [ -f "$f" ] && path_block_present "$f"; } || return 0
  local tmp; tmp="$(mktemp)"
  awk -v s="$CODING_PATH_MARKER" -v e="$CODING_PATH_END" '
    $0==s {skip=1} skip==0 {print} $0==e {skip=0}
  ' "$f" > "$tmp" && mv "$tmp" "$f"
}
