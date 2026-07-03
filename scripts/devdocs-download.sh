#!/usr/bin/env bash
# devdocs-download.sh — fetch DevDocs docsets (offline JSON) into ~/.pi/devdocs/docs.
#   scripts/devdocs-download.sh                    # the defaults (python bash node js ts git + web stack)
#   scripts/devdocs-download.sh python~3.13 rust   # specific slugs (see https://devdocs.io)
#   scripts/devdocs-download.sh --refresh          # re-download even if already present
#   scripts/devdocs-download.sh --list             # list installed docsets + versions
# Each docset is ~0.3-7MB compressed. Source: https://downloads.devdocs.io/<slug>.tar.gz
# (tarball contains index.json + db.json + meta.json — the only files the `docs` tool reads).
# More web-stack slugs available (add explicitly): flask click werkzeug express.
# NOTE: DevDocs has NO sqlalchemy or pytest docset — the `docs` tool can't help with those.
set -euo pipefail

DIR="${PI_DEVDOCS_DIR:-$HOME/.pi/devdocs/docs}"
BASE="https://downloads.devdocs.io"
# Universal basics + the common Python/JS web stack this box's model reaches for (fastapi/requests
# verified present on DevDocs 2026-07-03; all others confirmed downloadable).
DEFAULTS=(python~3.13 bash node javascript typescript git fastapi requests)
REFRESH=0; LIST=0; SLUGS=()
for a in "$@"; do
  case "$a" in
    --refresh) REFRESH=1 ;;
    --list) LIST=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    --*) echo "unknown flag: $a" >&2; exit 2 ;;
    *) SLUGS+=("$a") ;;
  esac
done

list_installed() {
  local found=0 d slug ver
  [ -d "$DIR" ] || { echo "(none — $DIR does not exist)"; return 0; }
  for d in "$DIR"/*/; do
    [ -f "${d}index.json" ] && [ -f "${d}db.json" ] || continue
    found=1; slug="$(basename "$d")"
    ver="$(sed -n 's/.*"release":"\([^"]*\)".*/\1/p' "${d}meta.json" 2>/dev/null | head -1)"
    printf '  %-16s %s\n' "$slug" "${ver:+v$ver}"
  done
  [ "$found" = 1 ] || echo "(none installed in $DIR)"
}

if [ "$LIST" = 1 ]; then list_installed; exit 0; fi

[ "${#SLUGS[@]}" -gt 0 ] || SLUGS=("${DEFAULTS[@]}")
command -v curl >/dev/null || { echo "curl required" >&2; exit 1; }
command -v tar  >/dev/null || { echo "tar required"  >&2; exit 1; }
mkdir -p "$DIR"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

for slug in "${SLUGS[@]}"; do
  dest="$DIR/$slug"
  if [ "$REFRESH" != 1 ] && [ -f "$dest/index.json" ] && [ -f "$dest/db.json" ]; then
    echo "==> $slug already present (use --refresh to update); skipping"; continue
  fi
  echo "==> downloading $slug  ($BASE/$slug.tar.gz)"
  if ! curl -fsSL --max-time 300 "$BASE/$slug.tar.gz" -o "$TMP/d.tgz"; then
    echo "    ERROR: download failed for '$slug' (bad slug? see https://devdocs.io). Existing copy left intact." >&2
    continue
  fi
  rm -rf "$TMP/x"; mkdir -p "$TMP/x"
  if ! tar -xzf "$TMP/d.tgz" -C "$TMP/x"; then
    echo "    ERROR: '$slug' tarball could not be extracted (corrupt/truncated); skipping." >&2; continue
  fi   # tarball has ./index.json ./db.json ./meta.json (+ html we drop)
  if [ ! -f "$TMP/x/index.json" ] || [ ! -f "$TMP/x/db.json" ]; then
    echo "    ERROR: '$slug' tarball missing index.json/db.json; not installing." >&2; continue
  fi
  mkdir -p "$dest"
  cp -f "$TMP/x/index.json" "$TMP/x/db.json" "$dest/"
  if [ -f "$TMP/x/meta.json" ]; then cp -f "$TMP/x/meta.json" "$dest/"; fi
  echo "    installed $slug ($(du -sh "$dest" | cut -f1)) -> $dest"
done

echo "Done. Installed docsets:"; list_installed
