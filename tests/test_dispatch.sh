#!/usr/bin/env bash
source "$(dirname "$0")/helpers.sh"
D="$REPO/scripts/coding.sh"
export CODING_DISPATCH_DRYRUN=1

out() { bash "$D" "$@" 2>&1; }

assert 'out help | grep -q "coding"'                    "help prints usage"
assert 'out bogusxyz >/dev/null 2>&1; [ $? = 2 ]'       "unknown subcommand exits 2"
assert 'out watch s "t" | grep -q "pi-watch.sh"'        "watch routes to pi-watch.sh"
assert 'out smoke | grep -q "smoke-test.sh"'            "smoke routes to smoke-test.sh"
assert 'out models --alt | grep -q "download-models.sh"' "models routes to download-models.sh"
assert 'out docs | grep -q "devdocs-download.sh"'       "docs routes to devdocs-download.sh"
assert 'out serve gemma | grep -q "serve-gemma.sh"'     "serve gemma routes to serve-gemma.sh"
assert 'out stop | grep -q "launch.sh"'                 "stop routes to launch.sh"
assert 'out | grep -q "launch.sh"'                      "no-arg routes to launch.sh"
assert 'out "build a thing" | grep -q "launch.sh"'      "task string routes to launch.sh"
assert 'out uninstall | grep -q "uninstall.sh"'         "uninstall routes to uninstall.sh"

finish
