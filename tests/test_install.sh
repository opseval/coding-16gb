#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"

# --- default deploy copies payload, writes shim, edits PATH, writes manifest ---
sandbox
bash "$REPO/scripts/install.sh" >/dev/null
assert '[ -x "$HOME/.local/bin/coding" ]'                       "shim installed + executable"
assert 'grep -q "exec .*coding.sh" "$HOME/.local/bin/coding"'   "shim execs coding.sh"
assert '[ -f "$HOME/.local/share/coding/coding-lib.sh" ]'       "lib copied to share"
assert '[ -f "$HOME/.local/share/coding/serve-gemma.sh" ]'      "serve script copied to share"
assert '[ -f "$HOME/.local/share/coding/pi-config/models.json" ]' "pi-config copied to share"
assert '[ -f "$HOME/.pi/agent/models.json" ] && [ ! -L "$HOME/.pi/agent/models.json" ]' "config is a COPY, not a symlink"
assert '[ -f "$HOME/.pi/agent/settings.json" ]'                 "settings copied to pi dir"
assert 'grep -qF "# >>> coding install (PATH) >>>" "$HOME/.zprofile"' "PATH block written"
assert '[ -f "$HOME/.local/share/coding/.manifest" ]'          "manifest written"
assert 'grep -q ".local/bin/coding" "$HOME/.local/share/coding/.manifest"' "manifest lists the shim"

# --- idempotent: second run keeps one PATH block, exits 0 ---
bash "$REPO/scripts/install.sh" >/dev/null
n=$(grep -cF "# >>> coding install (PATH) >>>" "$HOME/.zprofile")
assert '[ "$n" = "1" ]'                                          "PATH block still single after 2nd deploy"

# --- dry-run makes no changes ---
sandbox
bash "$REPO/scripts/install.sh" --dry-run >/dev/null
assert '[ ! -e "$HOME/.local/bin/coding" ]'                     "dry-run created no shim"
assert '[ ! -e "$HOME/.zprofile" ]'                             "dry-run touched no zprofile"

# --- --link mode symlinks into pi dir (dev workflow preserved) ---
sandbox
bash "$REPO/scripts/install.sh" --link >/dev/null
assert '[ -L "$HOME/.pi/agent/models.json" ]'                   "--link makes config a symlink"

# --- regression: reinstalling must NOT destroy a pre-existing user config ---
sandbox
mkdir -p "$HOME/.pi/agent"; echo "USER-ORIGINAL" > "$HOME/.pi/agent/models.json"
bash "$REPO/scripts/install.sh" >/dev/null
bash "$REPO/scripts/install.sh" >/dev/null                      # second run — must not clobber the backup
bash "$HOME/.local/share/coding/uninstall.sh" >/dev/null
assert 'grep -qx "USER-ORIGINAL" "$HOME/.pi/agent/models.json"' "reinstall+uninstall restores the USER original"

finish
