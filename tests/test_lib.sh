#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
sandbox
source "$REPO/scripts/coding-lib.sh"

# paths derive off the sandbox HOME
assert '[ "$CODING_HOME" = "$HOME/.local/share/coding" ]' "CODING_HOME under HOME"
assert '[ "$CODING_CMD" = "$HOME/.local/bin/coding" ]'     "CODING_CMD under HOME"
assert '[ "$PI_DIR" = "$HOME/.pi/agent" ]'                 "PI_DIR under HOME"

f="$HOME/.zprofile"
path_block_add "$f"
path_block_add "$f"                                        # idempotent
n=$(grep -cF "$CODING_PATH_MARKER" "$f")
assert '[ "$n" = "1" ]'                                    "PATH block added exactly once"
assert 'grep -qF "$HOME/.local/bin" "$f"'                  "PATH block references bin dir"
assert 'path_block_present "$f"'                           "path_block_present detects it"

path_block_remove "$f"
assert '! path_block_present "$f"'                         "PATH block removed"
path_block_remove "$f"                                     # fail-soft on already-removed
assert '[ $? = 0 ]'                                        "remove is fail-soft"

# regression: a profile with NO trailing newline must not be corrupted, and the block
# must remain removable (marker stays on its own line).
f2="$HOME/.zprofile_nonl"
printf 'export FOO=bar' > "$f2"                            # deliberately no trailing newline
path_block_add "$f2"
assert 'grep -qx "export FOO=bar" "$f2"'                   "existing last line stays on its own line"
assert 'path_block_present "$f2"'                          "block present after add to no-newline file"
path_block_remove "$f2"
assert '! path_block_present "$f2"'                        "block removable from formerly-no-newline file"
assert 'grep -qx "export FOO=bar" "$f2"'                   "user line intact after remove"

finish
