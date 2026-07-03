// Proves (a) the bash-guard core frontier-scaffold.ts imports is loadable + classifies correctly, and
// (b) frontier-scaffold.ts is structurally intact (guardrail wired to the core, verify tool, plan anchor).
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(realpathSync(fileURLToPath(import.meta.url)));

// (a) the sibling core the .ts imports (`./lib/bash-guard-core.mjs`) resolves and classifies
const core = await import(pathToFileURL(join(here, "lib", "bash-guard-core.mjs")).href);
assert.equal(typeof core.classifyBash, "function", "core.classifyBash must be importable");
assert.equal(typeof core.stallGuidance, "function", "core.stallGuidance must be importable");
assert.equal(core.classifyBash("uvicorn api.main:app --reload").verdict, "stall", "uvicorn must classify STALL");
assert.equal(core.classifyBash("uvicorn app:app &").verdict, "ok", "backgrounded server must be OK");
assert.equal(core.classifyBash("sudo rm x").verdict, "hard", "sudo must classify HARD");
assert.equal(core.classifyBash("pip install x").verdict, "soft", "pip install must classify SOFT");
assert.equal(core.classifyBash("pytest -q").verdict, "ok", "plain pytest must be OK");

// (b) structural checks on the extension source
const src = readFileSync(join(here, "frontier-scaffold.ts"), "utf8");
assert.match(src, /from\s+["']\.\/lib\/bash-guard-core\.mjs["']/, "must import the guard core");
assert.match(src, /classifyBash\(cmd\)/, "guardrail must classify via the core");
assert.match(src, /verdict === "stall"/, "must handle the STALL verdict");
assert.match(src, /PI_SCAFFOLD_STALLGUARD/, "stall block must be disable-able via PI_SCAFFOLD_STALLGUARD");
assert.match(src, /stallGuidance\(/, "STALL block must hand back the non-blocking recipe");
assert.match(src, /registerTool\(/, "must register the verify tool");
assert.match(src, /pi\.on\(["']tool_call["']/, "must register the bash guardrail on tool_call");

console.log("frontier-scaffold.ts loadcheck: OK");
