// bash-guard-core.mjs — pure command-classification for the frontier-scaffold bash guardrail
// (ZERO deps, regex + string only). Imported by extensions/frontier-scaffold.ts and the unit tests.
//
// WHY THIS EXISTS
//   The guardrail owns the shell commands a small local model can't be trusted with. Three classes:
//     HARD  — data-loss / outward-effect commands: always blocked (sudo, rm -rf /, curl|sh, git push).
//     STALL — foreground servers/watchers that never return (uvicorn, npm run dev, tail -f, tsc
//             --watch …). Pi's `bash` tool BLOCKS until the command exits, so these hang the whole
//             agent loop forever — observed on-device: `uvicorn api.main:app --reload` wedged an
//             interactive session until the user aborted. Blocked in BOTH modes (a hang is a hang),
//             UNLESS the model already made it non-blocking (backgrounded with `&`, wrapped in
//             `timeout`, or `--help`/`--version`). The block ships actionable guidance, not a flat no.
//     SOFT  — network/irreversible-ish ops (package installs, npx, destructive git): confirm in
//             interactive mode, block in autonomous (-p) mode.
//   Extracting the rules here (they used to be inline in the .ts) makes every rule unit-testable —
//   including the pre-existing HARD/SOFT ones, which had no tests.

// HARD_DENY: always blocked (no override). All rules match across newlines/positions.
export const HARD_DENY = [
  { re: /(^|[;&|\n])\s*sudo\b/, why: "sudo is denied" },
  { re: /--no-preserve-root\b/, why: "rm --no-preserve-root (root-wipe override)" },
  // recursive + force rm targeting an absolute (non-tmp), home, or parent path — any flag order/form
  { re: /\brm\b(?=[^\n]*(?:-[a-z]*r|--recursive))(?=[^\n]*(?:-[a-z]*f|--force))(?=[^\n]*(?:\s|=|["'])(?:\/(?!(?:private\/)?tmp\/)|~|\$HOME|\.\.))/, why: "recursive+force rm on absolute/home/parent path" },
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(bash|sh|zsh|python3?)\b/, why: "remote pipe-to-shell (curl|sh)" },
  { re: />\s*\/dev\/(r?disk|sd|nvme)/, why: "raw block-device write" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//, why: "dd to a device" },
  { re: /\b(mkfs|diskutil\s+erase|fdisk)\b/, why: "disk-format command" },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:/, why: "fork bomb" },
  { re: /(^|[;&|\n])\s*git\s+push\b/, why: "git push is outward — denied in autonomous mode" },
];

// SOFT_DENY: confirm in interactive (UI) mode, block in autonomous (print) mode.
export const SOFT_DENY = [
  { re: /\b(pip3?|uv|npm|pnpm|yarn|brew|cargo|gem|go|poetry|pipx)\s+(install|add|i|sync|ci|tool)\b/, why: "network package install" },
  { re: /(^|[;&|\n]|\s)npx\b/, why: "npx (fetches and runs a package)" },
  // recursive rm of the project cwd itself (.  ./…  *) — destroys .git checkpoints too
  { re: /\brm\b(?=[^\n]*(?:-[a-z]*r|--recursive))[^\n]*(?:\s|=|["'])(?:\.(?:\/|\s|$)|\*)/, why: "recursive rm of the project cwd / glob" },
  { re: /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f)/, why: "destructive git op" },
];

// Command-position prefix: start of string, or right after a separator (newline ; & | ( && ||),
// optionally after `cd <dir> &&`. Used to anchor SHORT/ambiguous tool names so they match only when
// actually invoked as a command — not when they appear as a filename/argument (`cat vite.config.js`,
// `mkdir serve`, `vim next.config.mjs`).
const SEP = "(?:^|[\\n;&|(]|&&|\\|\\||\\bcd\\s+\\S+\\s*&&)\\s*";
// Optional leading prefixes that sit between the anchor and the real binary and must be skipped, or
// `PORT=3000 uvicorn` / `poetry run uvicorn` / `time uvicorn` defeat the anchor (adversarial review):
//   VAR=val… (with optional `env`), `poetry|uv|pdm|hatch|rye run`, `time`, `nice [-n N]`.
const PFX = "(?:(?:env\\s+)?(?:[A-Za-z_]\\w*=\\S*\\s+)+|(?:poetry|uv|pdm|hatch|rye)\\s+run\\s+|(?:time|nice(?:\\s+-n\\s+\\d+)?)\\s+)*";
const AT_CMD = SEP + PFX;
// A bare-binary server name counts only when actually invoked: at command position (after the anchor
// + optional prefixes), or as `python -m <name>` / `exec <name>` / `nohup <name>`. This keeps
// `pkill -f uvicorn`, `ps aux | grep uvicorn`, `cat uvicorn.log` (name as an ARGUMENT) from blocking.
const AT_EXEC = "(?:" + AT_CMD + "|-m\\s+|\\b(?:exec|nohup)\\s+)";
const execServer = (alt, why) => ({ re: new RegExp(AT_EXEC + "(?:" + alt + ")\\b", "m"), why });

// STALL_DENY: foreground servers + watchers that block the agent loop. Matched against the command;
// suppressed when isNonBlocking() says the model already made it safe. Distinctive tokens are matched
// loosely (\b); short/ambiguous ones (vite/next/serve…) are anchored to command position via AT_CMD.
export const STALL_DENY = [
  // Python / ASGI-WSGI servers — bare binaries, anchored to command/exec position (see AT_EXEC)
  execServer("uvicorn|gunicorn|hypercorn|daphne|waitress-serve", "a foreground ASGI/WSGI server (uvicorn/gunicorn/…)"),
  { re: /\bflask\s+run\b/, why: "`flask run` (dev server)" },
  { re: /\bfastapi\s+(dev|run)\b/, why: "`fastapi dev/run` (dev server)" },
  { re: /\brunserver\b/, why: "Django `runserver`" },
  { re: /\bhttp\.server\b/, why: "`python -m http.server`" },
  { re: /\bstreamlit\s+run\b|\bpanel\s+serve\b|\bbokeh\s+serve\b/, why: "a data-app server (streamlit/panel/…)" },
  execServer("gradio", "a Gradio app server"),
  // Docs / static-site servers
  { re: /\b(mkdocs\s+serve|sphinx-autobuild|jekyll\s+serve|hugo\s+serve(r)?)\b/, why: "a docs/static-site dev server" },
  // JS / Node package-script dev servers (npm/yarn/pnpm run dev|start|serve|preview — build/test excluded)
  { re: /\b(npm|yarn|pnpm|bun)\s+(run\s+)?(dev|start|serve|preview)\b/, why: "an npm/yarn/pnpm dev-server script (dev/start/serve)" },
  // Framework CLIs: server when bare or with dev/serve/start/preview; NOT a one-shot subcommand.
  { re: new RegExp(AT_CMD + "(vite|next|nuxt|astro|remix)\\b(?!\\s+(?:build|lint|generate|check|info|typecheck|export|telemetry|analyze))", "m"), why: "a JS framework dev server (vite/next/nuxt/…)" },
  // Always-server bare tools (command position)
  { re: new RegExp(AT_CMD + "(webpack-dev-server|browser-sync|live-server|http-server)\\b", "m"), why: "a static/dev web server (http-server/live-server/…)" },
  { re: /\b(ng|webpack)\s+serve\b/, why: "an Angular/webpack dev server" },
  execServer("nodemon", "`nodemon` (restart-on-change runner)"),
  // Other language servers
  { re: /\brails\s+(server|s)\b/, why: "`rails server`" },
  { re: /\bphp\s+-S\b/, why: "`php -S` (built-in server)" },
  // TUIs / notebooks (also block a headless run)
  { re: /\btextual\s+run\b/, why: "`textual run` (a TUI app — blocks headlessly)" },
  { re: /\bjupyter\s+(notebook|lab|console)\b/, why: "a Jupyter server" },
  // Watchers — run until killed
  { re: new RegExp(AT_CMD + "watch\\s", "m"), why: "`watch` (re-runs forever)" },
  { re: /\btail\b[^\n]*(\s-f\b|--follow\b)/, why: "`tail -f` (follows forever)" },
  { re: /--watch(All)?\b/, why: "a `--watch` build/test loop" },
  { re: /\b(pytest-watch|ptw|watchexec|watchmedo|entr)\b/, why: "a file-watch runner" },
  { re: /\bcargo\s+watch\b/, why: "`cargo watch`" },
  { re: /\btsc\b[^\n]*(\s-w\b|--watch\b)/, why: "`tsc --watch`" },
  { re: /\b(docker\s+compose|docker-compose)\s+up\b/, why: "`docker compose up` (foreground)" },
  // Task-queue workers — long-running, hang the loop like a server (worker/beat/flower only; the
  // one-shot celery subcommands inspect/status/purge/control stay ok)
  { re: /\bcelery\b[^\n]*\b(worker|beat|flower)\b/, why: "a Celery worker/beat (long-running)" },
  execServer("rq|dramatiq|huey_consumer", "a task-queue worker (rq/dramatiq/huey)"),
  // Non-npm framework / cloud dev servers + Procfile runners (distinctive tokens)
  { re: /\b(vercel|netlify|wrangler|expo)\s+dev\b/, why: "a cloud framework dev server (vercel/netlify/…)" },
  { re: /\b(serverless|sls)\s+offline\b|\bsam\s+local\s+start-(api|lambda)\b|\bheroku\s+local\b/, why: "a local cloud-emulator server (serverless/sam/heroku)" },
  { re: /\bdeno\s+task\s+(dev|start|serve)\b/, why: "a Deno dev task" },
  { re: /\bspring-boot:run\b|\bbootRun\b/, why: "a Spring Boot dev server" },
  { re: /\b(honcho|foreman|overmind|hivemind)\s+(start|s)\b/, why: "a Procfile process runner (honcho/foreman)" },
  // Known blind spot (left OK to avoid false positives — undecidable from the command string):
  //   `make run/serve/dev`, `just dev`, `task dev`, `python bot.py`. A model may still stall on these.
];

export function matchDeny(cmd, list) {
  for (const { re, why } of list) if (re.test(cmd)) return why;
  return null;
}

// True when a would-be STALL command has already been made non-blocking, so the guard must NOT fire:
//   - backgrounded with a control `&` (not `&&`, not a redirect like 2>&1 / &> / >&)
//   - wrapped in a timeout/timelimit
//   - a help/version/dry probe that exits immediately
//   - docker compose up -d / --detach
export function isNonBlocking(cmd) {
  const s = String(cmd);
  // background control operator: a lone `&` not part of `&&` and not a redirect operator
  if (/(?<![<>&\d])&(?![&>])/.test(s)) return true;
  if (/\b(timeout|gtimeout|timelimit)\b/.test(s)) return true;
  if (/(?:^|\s)(--help|--version|--dry-run)\b/.test(s) || /(?:^|\s)-h(?=\s|$)/.test(s)) return true;
  // detached docker compose. NB: `\b-d` never matches (space→dash is not a word boundary) — anchor on space.
  if (/(?:^|\s)(-d|--detach)(?=\s|$)/.test(s) && /\b(docker\s+compose|docker-compose)\s+up\b/.test(s)) return true;
  return false;
}

// The SOFT reason for a command, independent of stall/hard precedence — so the guard can still
// enforce SOFT on a command that is BOTH stall and soft when the stall block is disabled.
export function softReason(cmd) {
  return matchDeny(cmd, SOFT_DENY);
}

// classifyBash(cmd) -> { verdict: "hard"|"stall"|"soft"|"ok", why: string|null }
// Precedence: HARD (always) > STALL (unless made non-blocking) > SOFT. The .ts maps the verdict to
// mode behavior (hard/stall block in both modes; soft confirms interactively, blocks autonomously).
export function classifyBash(cmd) {
  const hard = matchDeny(cmd, HARD_DENY);
  if (hard) return { verdict: "hard", why: hard };
  const stall = matchDeny(cmd, STALL_DENY);
  if (stall && !isNonBlocking(cmd)) return { verdict: "stall", why: stall };
  const soft = matchDeny(cmd, SOFT_DENY);
  if (soft) return { verdict: "soft", why: soft };
  return { verdict: "ok", why: null };
}

// The guidance a STALL block hands back to the model (kept here so tests can assert its shape).
export function stallGuidance(why, cmd) {
  return `Blocked: ${why} would hang the session — Pi's bash tool waits for the command to exit and `
    + `a server/watcher never does (this is what stalls the agent). Run it NON-BLOCKING instead:\n`
    + `  • background it and poll, e.g.  <cmd> > /tmp/srv.log 2>&1 &  then  sleep 3; curl -s localhost:PORT/…; kill %1\n`
    + `  • or bound a one-shot check with a timeout:  timeout 8 <cmd>\n`
    + `  • to check correctness, prefer the test suite (call verify / run pytest) over a live server.\n`
    + `If you truly need it foreground, set PI_SCAFFOLD_STALLGUARD=0 for a supervised run.`;
}
