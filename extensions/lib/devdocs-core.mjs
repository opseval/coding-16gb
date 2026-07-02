// devdocs-core.mjs — pure DevDocs lookup (node:fs + node:path + strings only; ZERO Pi deps).
// Imported by extensions/devdocs.ts (the `docs` tool) and by the unit tests / smoke script.
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export function docsDir() {
  return process.env.PI_DEVDOCS_DIR || join(process.env.HOME || "", ".pi", "devdocs", "docs");
}

const ALIASES = {
  python: "python", py: "python",
  javascript: "javascript", js: "javascript",
  typescript: "typescript", ts: "typescript",
  node: "node", nodejs: "node",
  bash: "bash", sh: "bash", shell: "bash",
  git: "git",
};

export function listInstalled(dir = docsDir()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => {
    try {
      const p = join(dir, d);
      return statSync(p).isDirectory()
        && existsSync(join(p, "index.json")) && existsSync(join(p, "db.json"));
    } catch { return false; }
  }).sort();
}

export function resolveDocset(doc, dir = docsDir()) {
  if (!doc) return null;
  const installed = listInstalled(dir);
  if (installed.includes(doc)) return doc;
  const d = doc.toLowerCase();
  const canon = ALIASES[d] || d;
  const hit = installed.find((s) => s === canon || s.startsWith(canon + "~"));
  if (hit) return hit;
  return installed.find((s) => s.startsWith(d)) || null;
}

const _index = new Map(); // dir/slug -> entries[]
const _db = new Map();    // dir/slug -> object
const _meta = new Map();  // dir/slug -> object

function loadIndex(dir, slug) {
  const k = join(dir, slug);
  if (!_index.has(k)) {
    const j = JSON.parse(readFileSync(join(dir, slug, "index.json"), "utf8"));
    _index.set(k, Array.isArray(j.entries) ? j.entries : []);
  }
  return _index.get(k);
}
function loadDb(dir, slug) {
  const k = join(dir, slug);
  if (!_db.has(k)) _db.set(k, JSON.parse(readFileSync(join(dir, slug, "db.json"), "utf8")));
  return _db.get(k);
}
function loadMeta(dir, slug) {
  const k = join(dir, slug);
  if (!_meta.has(k)) {
    try { _meta.set(k, JSON.parse(readFileSync(join(dir, slug, "meta.json"), "utf8"))); }
    catch { _meta.set(k, {}); }
  }
  return _meta.get(k);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Split a query/name into significant tokens, separator-agnostic: a model may write
// `Array.prototype.reduce`, `git-rebase`, or `os path join` for `Array.reduce`/`git rebase`/`os.path.join`.
const TOKENIZE = /[.\-\s/_:()]+/;

// 0 exact, 1 prefix, 2 word-boundary, 3 substring, 4 all-tokens-present, 5 last-token; null = no match.
// Tiers 4-5 rank BELOW the literal matches, so exact/prefix always win; they only rescue queries
// whose separator style or canonical form differs from the docset's entry name.
export function rankName(name, query) {
  const n = name.toLowerCase(), q = query.toLowerCase();
  if (n === q) return 0;
  if (n.startsWith(q)) return 1;
  if (new RegExp("\\b" + esc(q)).test(n)) return 2;
  if (n.includes(q)) return 3;
  const toks = q.split(TOKENIZE).filter((t) => t.length >= 2);
  if (toks.length > 1) {
    if (toks.every((t) => n.includes(t))) return 4;              // e.g. git-rebase -> "git rebase"
    const last = toks[toks.length - 1];
    if (last.length >= 3 && new RegExp("\\b" + esc(last)).test(n)) return 5; // Array.prototype.reduce -> "Array.reduce"
  }
  return null;
}

export function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<\/(pre|p|div|dt|dd|li|tr|h[1-6])>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
       .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
       .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
       .replace(/&amp;/g, "&");
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

// Extract the section for a #fragment from a page's HTML. Falls back to whole page (capped).
export function extractSection(html, fragment, cap = 3000) {
  if (!fragment) return htmlToText(html).slice(0, cap);
  const idRe = new RegExp("(id|name)=[\"']" + esc(fragment) + "[\"']", "i");
  const m = idRe.exec(html);
  if (!m) return htmlToText(html).slice(0, cap);
  let start = html.lastIndexOf("<", m.index);
  if (start < 0) start = m.index;
  const rest = html.slice(start + 1);
  const nextId = rest.search(/<[^>]*\s(id|name)=["'][^"']+["']/i);
  const nextH = rest.search(/<h[1-6]\b/i);
  let end = rest.length;
  for (const e of [nextId, nextH]) if (e > 0 && e < end) end = e;
  return htmlToText(html.slice(start, start + 1 + end)).slice(0, cap);
}

function nearest(dir, slugs, query) {
  // Suggest on any query token (not just the first 4 chars), so a hyphen/dot mismatch still offers help.
  const toks = query.toLowerCase().split(TOKENIZE).filter((t) => t.length >= 3);
  const probe = toks.length ? toks : [query.toLowerCase().slice(0, 4)].filter((t) => t.length >= 2);
  const out = [];
  for (const slug of slugs) {
    let entries; try { entries = loadIndex(dir, slug); } catch { continue; }
    for (const e of entries) {
      const nl = e.name.toLowerCase();
      if (probe.some((t) => nl.includes(t))) out.push(`${e.name} (${slug})`);
      if (out.length >= 8) return out;
    }
  }
  return out;
}

export function search(query, opts = {}) {
  const dir = opts.dir || docsDir();
  const installed = listInstalled(dir);
  if (installed.length === 0) {
    return { ok: false, error: `No docsets installed in ${dir}. Run scripts/devdocs-download.sh` };
  }
  let slugs;
  if (opts.doc) {
    const r = resolveDocset(opts.doc, dir);
    if (!r) {
      return { ok: false, error: `Docset "${opts.doc}" not installed. Installed: ${installed.join(", ")}. Add it: scripts/devdocs-download.sh ${opts.doc}` };
    }
    slugs = [r];
  } else {
    slugs = installed;
  }
  const limN = Math.max(1, Math.min(opts.limit || 1, 3));
  const scored = [];
  for (const slug of slugs) {
    let entries; try { entries = loadIndex(dir, slug); } catch { continue; }
    for (const e of entries) {
      const rk = rankName(e.name, query);
      if (rk !== null) scored.push({ rk, slug, entry: e });
    }
  }
  if (scored.length === 0) {
    return { ok: false, suggestions: nearest(dir, slugs, query), error: `No entry matching "${query}"${opts.doc ? " in " + opts.doc : ""}.` };
  }
  scored.sort((a, b) => a.rk - b.rk || a.entry.name.length - b.entry.name.length
    || a.entry.name.localeCompare(b.entry.name));
  const results = scored.slice(0, limN).map(({ slug, entry }) => {
    const [page, frag] = String(entry.path).split("#");
    let text = "";
    try {
      const db = loadDb(dir, slug);
      const html = db[page] ?? db[entry.path] ?? "";
      text = html ? extractSection(html, frag) : "(no page content found)";
    } catch (err) { text = `(error reading db.json: ${err.message})`; }
    const meta = loadMeta(dir, slug);
    return { name: entry.name, docset: slug, version: meta.release || meta.version || "", path: entry.path, text };
  });
  const alternatives = scored.slice(limN, limN + 5).map((s) => `${s.entry.name} (${s.slug})`);
  // Invariant: ok:true implies results.length >= 1 (scored is non-empty here and limN >= 1).
  return { ok: true, results, alternatives };
}

export function render(res) {
  if (!res.ok) {
    let t = res.error || "No result.";
    if (res.suggestions && res.suggestions.length) t += `\nDid you mean: ${res.suggestions.join(", ")}`;
    return t;
  }
  const parts = res.results.map((r) =>
    `# ${r.name} — ${r.docset}${r.version ? "@" + r.version : ""}\n${r.text}`);
  if (res.alternatives && res.alternatives.length) parts.push(`\nOther matches: ${res.alternatives.join(", ")}`);
  return parts.join("\n\n");
}
