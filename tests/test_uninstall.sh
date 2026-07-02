#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"

# install, drop a fake model + docset, then uninstall (default keeps data)
sandbox
bash "$REPO/scripts/install.sh" >/dev/null
mkdir -p "$HOME/models/gemma-4-12b" "$HOME/.pi/devdocs/docs/python~3.13"
touch "$HOME/models/gemma-4-12b/model.gguf"
bash "$HOME/.local/share/coding/uninstall.sh" >/dev/null

assert '[ ! -e "$HOME/.local/bin/coding" ]'                 "shim removed"
assert '[ ! -e "$HOME/.local/share/coding" ]'               "share dir removed"
assert '[ ! -e "$HOME/.pi/agent/models.json" ]'             "pi config removed"
assert '! grep -qF "# >>> coding install (PATH) >>>" "$HOME/.zprofile"' "PATH block removed"
assert '[ -f "$HOME/models/gemma-4-12b/model.gguf" ]'       "models KEPT by default"
assert '[ -d "$HOME/.pi/devdocs/docs/python~3.13" ]'        "docsets KEPT by default"

# fail-soft: lost manifest still clears the shim
sandbox
bash "$REPO/scripts/install.sh" >/dev/null
rm -f "$HOME/.local/share/coding/.manifest"
bash "$HOME/.local/share/coding/uninstall.sh" >/dev/null 2>&1
assert '[ ! -e "$HOME/.local/bin/coding" ]'                 "fail-soft removal without manifest still clears shim"

# --purge deletes models + docsets
sandbox
bash "$REPO/scripts/install.sh" >/dev/null
mkdir -p "$HOME/models/gemma-4-12b" "$HOME/.pi/devdocs/docs"
touch "$HOME/models/gemma-4-12b/model.gguf"
bash "$HOME/.local/share/coding/uninstall.sh" --purge >/dev/null
assert '[ ! -e "$HOME/models/gemma-4-12b/model.gguf" ]'     "--purge deletes models"
assert '[ ! -e "$HOME/.pi/devdocs" ]'                       "--purge deletes docsets"

# regression: a SECOND uninstall (manifest gone) must not delete the restored user original
sandbox
mkdir -p "$HOME/.pi/agent"; echo "USER-ORIGINAL" > "$HOME/.pi/agent/models.json"
bash "$REPO/scripts/install.sh" >/dev/null
bash "$HOME/.local/share/coding/uninstall.sh" >/dev/null    # restores USER-ORIGINAL, removes share+manifest
bash "$REPO/scripts/uninstall.sh" >/dev/null 2>&1 || true   # manifest-less fallback must be safe
assert 'grep -qx "USER-ORIGINAL" "$HOME/.pi/agent/models.json"' "double uninstall keeps the USER original"

finish
