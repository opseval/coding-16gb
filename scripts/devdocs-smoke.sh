#!/usr/bin/env bash
# devdocs-smoke.sh — verify the DevDocs integration.
#   1) unit tests (pure core, hermetic fixtures)
#   2) live query against installed docsets in ~/.pi/devdocs/docs (skipped if none present)
# Run after scripts/devdocs-download.sh for the full check.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO"

echo "== unit: devdocs-core (node --test) =="
node --test 'extensions/lib/*.test.mjs'

DIR="${PI_DEVDOCS_DIR:-$HOME/.pi/devdocs/docs}"
if ls "$DIR"/*/db.json >/dev/null 2>&1; then
  echo "== live: query installed docsets in $DIR =="
  node --input-type=module -e '
    import { search, render, listInstalled, docsDir } from "./extensions/lib/devdocs-core.mjs";
    import { readFileSync } from "node:fs";
    import { join } from "node:path";
    const dir = docsDir();
    const inst = listInstalled(dir);
    if (!inst.length) { console.error("no docsets after ls matched?"); process.exit(1); }
    // generic round-trip: first entry of the first installed docset must resolve
    const idx = JSON.parse(readFileSync(join(dir, inst[0], "index.json"), "utf8"));
    const name = idx.entries[0].name;
    const r = search(name, { doc: inst[0] });
    if (!r.ok || r.results[0].name !== name) { console.error("FAIL round-trip on " + inst[0] + "/" + name + "\n" + render(r)); process.exit(1); }
    console.log("PASS round-trip:", inst[0], "->", name);
    // stronger check when python is installed
    if (resolveInstalled(inst, "python")) {
      const p = search("subprocess.run", { doc: "python" });
      if (!p.ok || !/timeout/i.test(render(p))) { console.error("FAIL python subprocess.run/timeout\n" + render(p)); process.exit(1); }
      console.log("PASS python subprocess.run mentions timeout");
    }
    // not-installed docset must miss gracefully
    const nf = search("anything", { doc: "zzz-not-a-docset" });
    if (nf.ok) { console.error("FAIL expected not-installed miss"); process.exit(1); }
    console.log("PASS not-installed docset returns friendly miss");
    function resolveInstalled(list, prefix){ return list.find(s => s === prefix || s.startsWith(prefix + "~")); }
  '
else
  echo "== live: SKIP (no docsets in $DIR — run scripts/devdocs-download.sh) =="
fi
echo "devdocs-smoke: OK"
