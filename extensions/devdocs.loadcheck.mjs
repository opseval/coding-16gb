// Proves (a) the realpath→core import that devdocs.ts uses resolves and runs, and
// (b) devdocs.ts is structurally a Pi extension registering the `docs` tool.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const here = dirname(realpathSync(fileURLToPath(import.meta.url)));

// (a) same resolution devdocs.ts performs at runtime
const core = await import(pathToFileURL(join(here, "lib", "devdocs-core.mjs")).href);
assert.equal(typeof core.search, "function", "core.search must be importable via realpath");
assert.equal(typeof core.render, "function");
assert.equal(typeof core.listInstalled, "function");

// (b) structural checks on the extension source
const src = readFileSync(join(here, "devdocs.ts"), "utf8");
assert.match(src, /export default async function/, "must have async default export");
assert.match(src, /registerTool\(/, "must register a tool");
assert.match(src, /name:\s*["']docs["']/, "tool must be named docs");
assert.match(src, /query:\s*Type\.String/, "must declare a string query param");
assert.match(src, /realpathSync\(fileURLToPath\(import\.meta\.url\)\)/, "must resolve core via realpath");
assert.match(src, /pi\.on\(["']before_agent_start["']/, "must inject the active docs nudge on before_agent_start");
assert.match(src, /PI_DOCS_NUDGE/, "docs nudge must be disable-able via PI_DOCS_NUDGE");
assert.match(src, /message:\s*\{[^}]*customType/, "docs nudge must inject a conversation MESSAGE (foreground), not just system prompt");

console.log("devdocs.ts loadcheck: OK");
