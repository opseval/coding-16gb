#!/usr/bin/env bash
# install.sh — deploy the coding stack.
#
# Default (copy): install into ~/.local/share/coding + ~/.pi/agent, generate the `coding`
#   command on PATH, and record a manifest. The cloned repo is then deletable.
# --link (dev):   symlink pi-config/skills/extensions into ~/.pi/agent so repo edits are live.
#
# Usage:
#   scripts/install.sh                 # copy-deploy (default)
#   scripts/install.sh --link          # dev symlink mode
#   scripts/install.sh --with-docs     # also fetch offline docsets
#   scripts/install.sh --launchd       # also template+install the Gemma LaunchAgent
#   scripts/install.sh --dry-run       # print actions only
#   scripts/install.sh --status        # show what's installed
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO/scripts/coding-lib.sh"
STAMP="$(date +%Y%m%d-%H%M%S)"
MODE="copy"; DRY=0; LAUNCHD=0; WITH_DOCS=0
for a in "$@"; do case "$a" in
  --link) MODE="link" ;;
  --dry-run) DRY=1 ;;
  --launchd) LAUNCHD=1 ;;
  --with-docs) WITH_DOCS=1 ;;
  --status) MODE="status" ;;
  *) echo "unknown flag: $a"; exit 2 ;;
esac; done

say() { printf '%s\n' "$*"; }
run() { if [ "$DRY" -eq 1 ]; then say "  [dry-run] $*"; else eval "$*"; fi; }

# Ownership record: paths listed in the PRIOR manifest are files WE installed, so a reinstall
# must overwrite them without backing up (else the 2nd run backs up its own copy over the
# genuine user backup). Loaded before any deploy; the manifest is rewritten at the end.
OWNED_SET=""
[ -f "$CODING_MANIFEST" ] && OWNED_SET="$(cat "$CODING_MANIFEST")"
is_owned() { [ -n "$OWNED_SET" ] && printf '%s\n' "$OWNED_SET" | grep -qxF "$1"; }
# uniq_bak <dest> — a backup name that never collides (STAMP has 1-second resolution).
uniq_bak() { local b="$1.bak.$STAMP" i=0; while [ -e "$b" ]; do i=$((i+1)); b="$1.bak.$STAMP.$i"; done; printf '%s' "$b"; }

if [ "$MODE" = "status" ]; then
  say "coding stack status"
  say "  command:  $( [ -x "$CODING_CMD" ] && echo "$CODING_CMD" || echo '(not installed)')"
  say "  share:    $( [ -d "$CODING_HOME" ] && echo "$CODING_HOME" || echo '(absent)')"
  say "  pi dir:   $PI_DIR"
  for f in models.json settings.json; do
    if [ -L "$PI_DIR/$f" ]; then say "    $f -> $(readlink "$PI_DIR/$f") (symlink/dev)"
    elif [ -f "$PI_DIR/$f" ]; then say "    $f (copy)"
    else say "    $f (absent)"; fi
  done
  say "  PATH set: $(path_block_present "$CODING_ZPROFILE" && echo yes || echo no)"
  exit 0
fi

# Payload copied into the share dir (everything the runtime needs without the repo).
PAYLOAD=(coding.sh coding-lib.sh launch.sh uninstall.sh
         serve-gemma.sh serve-gptoss.sh serve-granite.sh
         pi-watch.sh pi-compact.py smoke-test.sh download-models.sh devdocs-download.sh)

# --- backup helper: back up a real (non-owned) file/dir before replacing it ---
backup_if_real() { # <dest>
  local dest="$1"
  if [ -L "$dest" ]; then
    case "$(readlink "$dest")" in "$REPO"/*|"$CODING_HOME"/*) run "rm -f '$dest'"; return ;; esac
    run "mv '$dest' '$(uniq_bak "$dest")'"
  elif [ -e "$dest" ]; then
    # A file we installed on a prior run (in the manifest) is ours — replace it, don't back it up.
    if is_owned "$dest"; then run "rm -rf '$dest'"; return; fi
    run "mv '$dest' '$(uniq_bak "$dest")'"
  fi
}

deploy_pi_files() { # copy or link based on $MODE
  run "mkdir -p '$PI_DIR' '$PI_DIR/skills' '$PI_DIR/extensions' '$CODING_DEVDOCS_DIR/docs'"
  for f in models.json settings.json; do
    backup_if_real "$PI_DIR/$f"
    if [ "$MODE" = link ]; then run "ln -s '$REPO/pi-config/$f' '$PI_DIR/$f'"
    else run "cp '$REPO/pi-config/$f' '$PI_DIR/$f'"; fi
  done
  for d in "$REPO"/skills/*/; do
    [ -e "${d}SKILL.md" ] || continue
    local name; name="$(basename "$d")"; backup_if_real "$PI_DIR/skills/$name"
    if [ "$MODE" = link ]; then run "ln -s '${d%/}' '$PI_DIR/skills/$name'"
    else run "cp -R '${d%/}' '$PI_DIR/skills/$name'"; fi
  done
  for e in "$REPO"/extensions/*.ts; do
    [ -e "$e" ] || continue
    local name; name="$(basename "$e")"; backup_if_real "$PI_DIR/extensions/$name"
    if [ "$MODE" = link ]; then run "ln -s '$e' '$PI_DIR/extensions/$name'"
    else run "cp '$e' '$PI_DIR/extensions/$name'"; fi
  done
}

say "Deploying coding stack ($MODE) from: $REPO"
deploy_pi_files

if [ "$MODE" = "copy" ]; then
  run "mkdir -p '$CODING_HOME' '$CODING_BIN_DIR'"
  for f in "${PAYLOAD[@]}"; do
    [ -e "$REPO/scripts/$f" ] && run "cp '$REPO/scripts/$f' '$CODING_HOME/$f'"
  done
  run "cp -R '$REPO/pi-config' '$CODING_HOME/pi-config'"
  run "chmod +x '$CODING_HOME'/*.sh '$CODING_HOME'/*.py 2>/dev/null || true"
  # generate the shim
  if [ "$DRY" -eq 1 ]; then
    say "  [dry-run] write shim $CODING_CMD"
  else
    cat > "$CODING_CMD" <<EOF
#!/usr/bin/env bash
export CODING_HOME="\${CODING_HOME:-$CODING_HOME}"
exec "\$CODING_HOME/coding.sh" "\$@"
EOF
    chmod +x "$CODING_CMD"
  fi
  say "  wrote command: $CODING_CMD"
  # PATH block
  if [ "$DRY" -eq 1 ]; then say "  [dry-run] ensure PATH block in $CODING_ZPROFILE"
  else path_block_add "$CODING_ZPROFILE"; fi
  # manifest (created top-level paths uninstall should remove)
  if [ "$DRY" -eq 0 ]; then
    { echo "$CODING_CMD"; echo "$CODING_HOME"
      for f in models.json settings.json; do echo "$PI_DIR/$f"; done
      for d in "$REPO"/skills/*/; do [ -e "${d}SKILL.md" ] && echo "$PI_DIR/skills/$(basename "$d")"; done
      for e in "$REPO"/extensions/*.ts; do [ -e "$e" ] && echo "$PI_DIR/extensions/$(basename "$e")"; done
    } > "$CODING_MANIFEST"
  fi
fi

# Optional: LaunchAgent (unchanged behavior)
if [ "$LAUNCHD" -eq 1 ]; then
  src="$REPO/scripts/local.llm.gemma.plist"; dest="$HOME/Library/LaunchAgents/local.llm.gemma.plist"
  say "LaunchAgent -> $dest"
  if [ "$DRY" -eq 1 ]; then say "  [dry-run] template $src -> $dest"
  else mkdir -p "$HOME/Library/LaunchAgents"
    [ -e "$dest" ] && mv "$dest" "$(uniq_bak "$dest")"
    sed "s#REPLACE_WITH_ABSOLUTE_PATH#$CODING_HOME#" "$src" > "$dest"
    [ "$MODE" = "copy" ] && echo "$dest" >> "$CODING_MANIFEST"
    say "  wrote $dest — load: launchctl load -w '$dest'"; fi
fi

# Optional: docsets
if [ "$WITH_DOCS" -eq 1 ]; then
  if [ "$DRY" -eq 1 ]; then say "  [dry-run] $REPO/scripts/devdocs-download.sh"
  else say "Fetching offline docsets ..."; "$REPO/scripts/devdocs-download.sh" || say "  (devdocs-download.sh failed — rerun manually)"; fi
fi

say ""
if [ "$MODE" = "copy" ]; then
  say "Done. Open a new shell (or: source $CODING_ZPROFILE), then run:  coding"
  say "The repo is no longer referenced — you may delete this clone."
else
  say "Done (dev/--link). Repo stays authoritative; edits to pi-config/skills/extensions are live."
fi
