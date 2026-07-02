#!/usr/bin/env bash
# install.sh — deploy this repo into ~/.pi/agent as the source of truth.
#
# Symlinks pi-config/* (models.json, settings.json), skills/*, and extensions/*.ts into ~/.pi/agent/
# so the repo stays authoritative and every change is tracked in git. Existing real files are backed
# up (timestamped) before being replaced. Idempotent.
#
# Usage:
#   scripts/install.sh             # deploy config/skills/extensions (incl. the docs tool + auto-nudge)
#   scripts/install.sh --with-docs # also fetch the offline docsets so the docs tool works immediately
#   scripts/install.sh --launchd   # also template + install the model-server LaunchAgent
#   scripts/install.sh --dry-run   # show what would happen
#   scripts/install.sh --status    # show current links
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PI="${PI_CODING_AGENT_DIR:-${PI_AGENT_DIR:-$HOME/.pi/agent}}"
STAMP="$(date +%Y%m%d-%H%M%S)"
DRY=0; LAUNCHD=0; WITH_DOCS=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --launchd) LAUNCHD=1 ;;
    --with-docs) WITH_DOCS=1 ;;
    --uninstall)
      echo "Uninstalling from $PI (remove repo symlinks, restore most-recent backups)"
      for f in models.json settings.json; do
        if [ -L "$PI/$f" ]; then
          case "$(readlink "$PI/$f")" in "$REPO"/*) rm -f "$PI/$f"; echo "  removed symlink $f" ;; esac
        fi
        bak="$(ls -t "$PI/$f".bak.* 2>/dev/null | head -1 || true)"
        [ -n "${bak:-}" ] && { mv "$bak" "$PI/$f"; echo "  restored $f from $(basename "$bak")"; }
      done
      for d in "$PI"/skills/*; do
        [ -L "$d" ] && case "$(readlink "$d")" in "$REPO"/*) rm -f "$d"; echo "  removed skill $(basename "$d")" ;; esac
      done
      for e in "$PI"/extensions/*.ts; do
        [ -L "$e" ] && case "$(readlink "$e")" in "$REPO"/*) rm -f "$e"; echo "  removed extension $(basename "$e")" ;; esac
      done
      echo "Done. (Server processes + ~/models are separate — stop/remove those manually if desired.)"
      exit 0 ;;
    --status)
      echo "Pi agent dir: $PI"
      for f in models.json settings.json; do
        printf '  %-14s -> %s\n' "$f" "$(readlink "$PI/$f" 2>/dev/null || echo '(not a symlink / absent)')"
      done
      echo "  skills/:     $(ls -1 "$PI/skills" 2>/dev/null | tr '\n' ' ')"
      echo "  extensions/: $(ls -1 "$PI/extensions" 2>/dev/null | tr '\n' ' ')"
      _dd="${PI_DEVDOCS_DIR:-$HOME/.pi/devdocs/docs}"
      echo "  devdocs:     $(ls -1d "$_dd"/*/ 2>/dev/null | wc -l | tr -d ' ') docset(s) in $_dd"
      exit 0 ;;
  esac
done

say() { printf '%s\n' "$*"; }
do_or_show() { if [ "$DRY" -eq 1 ]; then say "  [dry-run] $*"; else eval "$*"; fi; }

link() { # link <src> <dest>
  local src="$1" dest="$2"
  [ -e "$src" ] || { say "  skip (absent in repo): ${src#"$REPO"/}"; return; }
  if [ -L "$dest" ]; then
    # Only auto-remove a symlink we own (points inside $REPO); preserve a user's foreign symlink.
    local tgt; tgt="$(readlink "$dest")"
    case "$tgt" in
      "$REPO"/*) do_or_show "rm -f '$dest'" ;;
      *) do_or_show "mv '$dest' '$dest.bak.$STAMP'"; say "  preserved foreign symlink $(basename "$dest") -> .bak.$STAMP" ;;
    esac
  elif [ -e "$dest" ]; then
    do_or_show "mv '$dest' '$dest.bak.$STAMP'"
    say "  backed up existing $(basename "$dest") -> $(basename "$dest").bak.$STAMP"
  fi
  do_or_show "ln -s '$src' '$dest'"
  say "  linked $(basename "$dest")"
}

say "Deploying coding-16gb from: $REPO"
say "Into: $PI"
do_or_show "mkdir -p '$PI' '$PI/skills' '$PI/extensions'"
# DevDocs data dir (peer to the harness) so the `docs` tool has a stable path before first download.
do_or_show "mkdir -p '${PI_DEVDOCS_DIR:-$HOME/.pi/devdocs/docs}'"

# 1. Pi config files (config.json is NOT read by Pi 0.75.5 — settings.json carries defaults)
for f in models.json settings.json; do
  link "$REPO/pi-config/$f" "$PI/$f"
done

# 2. Skills (each subdirectory containing SKILL.md)
if [ -d "$REPO/skills" ]; then
  for d in "$REPO"/skills/*/; do
    [ -e "${d}SKILL.md" ] || continue
    link "${d%/}" "$PI/skills/$(basename "$d")"
  done
fi

# 3. Extensions (*.ts)
if [ -d "$REPO/extensions" ]; then
  for e in "$REPO"/extensions/*.ts; do
    [ -e "$e" ] || continue
    link "$e" "$PI/extensions/$(basename "$e")"
  done
fi

# 4. Optional: template + install the model-server LaunchAgent
if [ "$LAUNCHD" -eq 1 ]; then
  src="$REPO/scripts/local.llm.gemma.plist"
  dest="$HOME/Library/LaunchAgents/local.llm.gemma.plist"
  say ""
  say "LaunchAgent: templating $src -> $dest"
  if [ "$DRY" -eq 1 ]; then
    say "  [dry-run] sed 's#REPLACE_WITH_ABSOLUTE_PATH#$REPO#' '$src' > '$dest'"
    say "  [dry-run] launchctl load -w '$dest'"
  else
    mkdir -p "$HOME/Library/LaunchAgents"
    [ -e "$dest" ] && { mv "$dest" "$dest.bak.$STAMP"; say "  backed up existing plist"; }
    sed "s#REPLACE_WITH_ABSOLUTE_PATH#$REPO#" "$src" > "$dest"
    say "  wrote $dest (serve-gemma.sh path filled in)"
    say "  load it with:  launchctl load -w '$dest'"
  fi
fi

# 5. Optional: fetch the offline docsets so the `docs` tool + its auto-nudge work immediately.
#    (Docsets are data, like models — deployed separately by default; --with-docs pulls them here.)
if [ "$WITH_DOCS" -eq 1 ]; then
  say ""
  if [ "$DRY" -eq 1 ]; then
    say "  [dry-run] $REPO/scripts/devdocs-download.sh"
  else
    say "Fetching offline docsets for the docs tool ..."
    "$REPO/scripts/devdocs-download.sh" || say "  (devdocs-download.sh failed — rerun it manually)"
  fi
fi

# Report whether the docs tool is fully live (extension deployed AND docsets present).
_dd="${PI_DEVDOCS_DIR:-$HOME/.pi/devdocs/docs}"
_ndoc="$(ls -1d "$_dd"/*/ 2>/dev/null | wc -l | tr -d ' ')"

say ""
say "Done. Verify with: scripts/install.sh --status"
say "Deployed: frontier-scaffold + devdocs extensions, skills (plan/verify/tdd/autonomy/docs), settings.json."
if [ "$_ndoc" -gt 0 ]; then
  say "The docs tool is LIVE ($_ndoc docset(s)) — the harness auto-nudges the model to confirm APIs via \`docs\`."
else
  say "The docs tool is deployed but has NO docsets yet — run: scripts/devdocs-download.sh   (or reinstall with --with-docs)."
fi
say "Model serving + the wired-memory LaunchDaemon are separate — see scripts/local.iogpu.wired.plist."
