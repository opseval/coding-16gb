import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  listInstalled, resolveDocset, htmlToText, extractSection, search, render,
} from "./devdocs-core.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "__fixtures__");

test("listInstalled finds fixture docsets", () => {
  const got = listInstalled(FIX);
  assert.ok(got.includes("python~3.13"), got.join(","));
  assert.ok(got.includes("bash"));
});

test("resolveDocset alias + prefix", () => {
  assert.equal(resolveDocset("python", FIX), "python~3.13");
  assert.equal(resolveDocset("py", FIX), "python~3.13");
  assert.equal(resolveDocset("bash", FIX), "bash");
  assert.equal(resolveDocset("rust", FIX), null);
});

test("htmlToText strips tags, keeps code text, decodes entities", () => {
  assert.equal(htmlToText("<code>x &lt; 1</code>"), "x < 1");
});

test("extractSection isolates the fragment's entry", () => {
  const db = JSON.parse(readFileSync(join(FIX, "python~3.13", "db.json"), "utf8"));
  const txt = extractSection(db["library/subprocess"], "subprocess.run");
  assert.match(txt, /timeout/i);
  assert.doesNotMatch(txt, /child program/i);
});

test("search exact match returns signature text", () => {
  const r = search("subprocess.run", { doc: "python", dir: FIX });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].name, "subprocess.run");
  assert.equal(r.results[0].docset, "python~3.13");
  assert.match(r.results[0].text, /timeout/i);
});

test("search prefix ranks shorter name first, honours limit", () => {
  const r = search("subprocess", { doc: "python", dir: FIX, limit: 3 });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].name, "subprocess.run"); // shorter than subprocess.Popen
  assert.ok(r.results.length <= 3);
});

test("search across all docsets when doc omitted", () => {
  const r = search("printf", { dir: FIX });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].docset, "bash");
});

test("search not-installed docset returns friendly miss", () => {
  const r = search("subprocess.run", { doc: "rust", dir: FIX });
  assert.equal(r.ok, false);
  assert.match(r.error, /not installed/i);
});

test("search no-match returns ok:false with suggestions field", () => {
  const r = search("zzzznotathing", { doc: "python", dir: FIX });
  assert.equal(r.ok, false);
  assert.ok("suggestions" in r);
});

test("render produces model-facing text", () => {
  const r = search("subprocess.run", { doc: "python", dir: FIX });
  const t = render(r);
  assert.match(t, /subprocess\.run/);
  assert.match(t, /python~3\.13/);
});

test("search matches across separator styles (all query tokens present)", () => {
  // a model may query `subprocess-run` when the entry is `subprocess.run`
  const r = search("subprocess-run", { doc: "python", dir: FIX });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].name, "subprocess.run");
});

test("search falls back to the last query token (canonical-name mismatch)", () => {
  // a model may query `builtins.print` when the entry is just `print`
  const r = search("builtins.print", { doc: "python", dir: FIX });
  assert.equal(r.ok, true);
  assert.equal(r.results[0].name, "print");
});

test("extractSection is not truncated by a data-id/data-name attribute inside the section", () => {
  const html =
    '<dl><dt id="foo.bar"><code>foo.bar(x, y)</code></dt>' +
    '<dd><p>Does a thing. <a data-id="ref1" href="#z">see also</a> and more description continues here.</p></dd>' +
    '<dt id="foo.baz"><code>foo.baz()</code></dt><dd><p>Another entry.</p></dd></dl>';
  const txt = extractSection(html, "foo.bar");
  assert.match(txt, /more description continues here/); // not cut at the data-id link
  assert.doesNotMatch(txt, /Another entry/);            // still stops before the real next entry
});
