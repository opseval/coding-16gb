#!/usr/bin/env bash
# uninstall.sh — reverse a copy-install. Manifest-driven; fail-soft without one.
#   uninstall.sh            remove the stack; keep models + docsets
#   uninstall.sh --purge    also delete ~/models/*.gguf and the docsets
#   uninstall.sh --status   print install status (used by `coding status` in the shipped layout)
set -uo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SELF_DIR/coding-lib.sh"
PURGE=0
for a in "$@"; do case "$a" in
  --purge) PURGE=1 ;;
  --status)
    echo "coding stack status"
    echo "  command:  $( [ -x "$CODING_CMD" ] && echo "$CODING_CMD" || echo '(absent)')"
    echo "  share:    $( [ -d "$CODING_HOME" ] && echo "$CODING_HOME" || echo '(absent)')"
    echo "  pi dir:   $PI_DIR"
    echo "  PATH set: $(path_block_present "$CODING_ZPROFILE" && echo yes || echo no)"
    exit 0 ;;
  *) echo "unknown flag: $a"; exit 2 ;;
esac; done

# 1. Remove manifested paths (fall back to known defaults if the manifest is gone).
if [ -f "$CODING_MANIFEST" ]; then
  while IFS= read -r p; do [ -n "$p" ] && rm -rf "$p"; done < "$CODING_MANIFEST"
else
  # No manifest → we cannot prove we own the config. Remove the shim (unambiguously ours by
  # path), but only remove a config file if a backup exists to restore (step 2); otherwise
  # leave it — it may be the user's own file (e.g. a second uninstall after the first restored it).
  rm -f "$CODING_CMD"
  for f in models.json settings.json; do
    ls "$PI_DIR/$f".bak.* >/dev/null 2>&1 && rm -f "$PI_DIR/$f"
  done
fi

# Remove stack-owned symlinks left by a --link (dev) install — safe: only symlinks, and only
# those whose target points into a coding-* repo or the share dir (never a user's own file).
for l in "$PI_DIR/models.json" "$PI_DIR/settings.json" "$PI_DIR"/skills/* "$PI_DIR"/extensions/*.ts; do
  [ -L "$l" ] || continue
  case "$(readlink "$l" 2>/dev/null)" in */coding-*/*|"$CODING_HOME"/*) rm -f "$l" ;; esac
done

# 2. Restore most-recent backups the installer made for real files it replaced.
for f in models.json settings.json; do
  bak="$(ls -t "$PI_DIR/$f".bak.* 2>/dev/null | head -1 || true)"
  [ -n "${bak:-}" ] && mv "$bak" "$PI_DIR/$f"
done

# 3. Remove the PATH block.
path_block_remove "$CODING_ZPROFILE"

# 4. Optional data purge.
if [ "$PURGE" = 1 ]; then
  rm -f "$CODING_MODELS_DIR"/*/*.gguf "$CODING_MODELS_DIR"/*.gguf 2>/dev/null || true
  rm -rf "$CODING_DEVDOCS_DIR"
  echo "Purged models under $CODING_MODELS_DIR and docsets at $CODING_DEVDOCS_DIR."
fi

# 5. Remove the share dir LAST (this script lives inside it).
rm -rf "$CODING_HOME"

cat <<EOF
Removed the coding stack.
$( [ "$PURGE" = 1 ] && echo "Also deleted models + docsets (--purge)." || echo "Kept: models ($CODING_MODELS_DIR) and docsets ($CODING_DEVDOCS_DIR) — rerun with --purge to delete them." )
Not managed by this uninstaller (remove separately if you want them gone):
  pi   (npm -g @earendil-works/pi-coding-agent)
  llama.cpp, node   (brew)
  huggingface_hub / ruff / pytest   (pip --user)
Open a new shell so the removed PATH entry takes effect.
EOF
