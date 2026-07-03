#!/usr/bin/env python3
"""One-shot forced compaction of a Pi session — a between-iterations backstop for autonomous loops.

WHY THIS EXISTS
    Pi >= 0.80 runs threshold ("auto") compaction in AgentSession — checked before each
    prompt submission and again after each full agent run, in interactive, rpc AND print
    mode (pre-0.80 print mode had none; this helper was the only defense then). But the
    check NEVER runs between tool-call rounds inside one run: a single iteration can grow
    far past the threshold while Pi's per-request output budget (contextWindow -
    promptTokens - 4096) collapses toward zero, and past contextWindow - 4096 even the
    compaction summary request is clamped to ~nothing — an unrecoverable wedge (this
    helper starves there too; nothing client-side recovers). Forcing a compaction BETWEEN
    iterations bounds how large an iteration can START, keeping the loop away from that
    cliff.

    This helper drives ONE `pi --mode rpc` process, issues a manual `compact`
    command (the same AgentSession.compact() the interactive `/compact` uses — the
    clean path, not the auto-retry path), waits for `compaction_end`, and exits.
    pi-watch.sh calls it between iterations once the session crosses COMPACT_AT, so
    each iteration resumes from a compacted, low-token session with a healthy output
    budget.

USAGE
    pi-compact.py <session-path> [-- <extra pi flags…>]
        e.g. pi-compact.py ~/.pi/agent/sessions/foo.jsonl -- --thinking low

    Extra pi flags after `--` are passed through to the rpc process (provider/model
    come from ~/.pi/agent/settings.json defaults if not given).

ENV
    PI_COMPACT_STARTUP_S   startup grace before sending compact (default 5)
    PI_COMPACT_TIMEOUT_S   max seconds to wait for compaction_end (default 240)

EXIT
    0  compaction succeeded, OR nothing to compact (session already small enough)
    2  error / timeout / process died
"""
import json
import os
import queue
import subprocess
import sys
import threading
import time


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        print("usage: pi-compact.py <session> [-- <pi flags>]", file=sys.stderr)
        return 2
    session = argv[0]
    passthru = argv[1:]
    if passthru and passthru[0] == "--":
        passthru = passthru[1:]

    startup_s = float(os.environ.get("PI_COMPACT_STARTUP_S", "5"))
    timeout_s = float(os.environ.get("PI_COMPACT_TIMEOUT_S", "240"))

    cmd = ["pi", "--mode", "rpc", "--session", session] + passthru
    try:
        proc = subprocess.Popen(
            cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
    except FileNotFoundError:
        print("pi-compact: 'pi' not found on PATH", file=sys.stderr)
        return 2

    events: "queue.Queue[dict]" = queue.Queue()

    def read_stdout() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if line and line[0] == "{":
                try:
                    events.put(json.loads(line))
                except ValueError:
                    pass

    threading.Thread(target=read_stdout, daemon=True).start()

    time.sleep(startup_s)  # let the rpc session initialize

    def send(obj: dict) -> None:
        assert proc.stdin is not None
        obj = {**obj, "id": f"c{time.time_ns()}"}
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()

    started = False
    ok = False
    nothing = False
    try:
        send({"type": "compact"})
        deadline = time.time() + timeout_s
        while time.time() < deadline:
            try:
                ev = events.get(timeout=2)
            except queue.Empty:
                if proc.poll() is not None:
                    break
                continue
            etype = ev.get("type")
            if etype == "compaction_start":
                started = True
                print(f"pi-compact: compaction_start ({ev.get('reason')})")
            elif etype == "compaction_end":
                msg = ev.get("errorMessage")
                if msg:
                    # "Nothing to compact" is a benign no-op, not a failure.
                    if "othing to compact" in msg or "too small" in msg:
                        nothing = True
                        print("pi-compact: nothing to compact (session small enough)")
                    else:
                        print(f"pi-compact: compaction_end ERROR: {msg}", file=sys.stderr)
                else:
                    ok = True
                    print("pi-compact: compaction_end OK")
                break
    finally:
        try:
            send({"type": "shutdown"})
        except Exception:
            pass
        time.sleep(1)
        try:
            proc.terminate()
        except Exception:
            pass

    if ok or nothing:
        return 0
    if not started:
        print("pi-compact: no compaction event received (timeout or early exit)", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
