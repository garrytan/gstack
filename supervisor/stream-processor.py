#!/usr/bin/env python3
"""
stream-processor.py — real-time activity extractor for cstack agent sessions.

Reads `claude --output-format stream-json --verbose` NDJSON from stdin.
Writes:
  $LOG_DIR/live.json         current session state (task, tool, duration) — atomic
  $LOG_DIR/live-events.jsonl append-only event log one JSON line per tool call

Outputs to stdout at session end: metrics-compatible JSON summary so the
existing Python metrics extractor in run-agent.sh continues to work unchanged.

Event format in live-events.jsonl:
  {"ts":"...","agent":"...","type":"tool_call","tool":"Bash","summary":"git status"}
  {"ts":"...","agent":"...","type":"task_claimed","task":"FEAT-001"}
  {"ts":"...","agent":"...","type":"session_end","task":"...","duration_s":300}
"""

import json, sys, re, os, time
from datetime import datetime, timezone

# --- Args ---
if len(sys.argv) < 4:
    sys.exit("Usage: stream-processor.py <log-dir> <agent-name> <control-dir>")

LOG_DIR     = sys.argv[1]
AGENT_NAME  = sys.argv[2]
CONTROL_DIR = sys.argv[3]

LIVE_FILE     = os.path.join(LOG_DIR, "live.json")
EVENTS_FILE   = os.path.join(LOG_DIR, "live-events.jsonl")
PRESENCE_FILE = os.path.join(CONTROL_DIR, "mailboxes", "presence", f"{AGENT_NAME}.json")

# --- Helpers ---

def now_iso() -> str:
    return datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')

def atomic_write(path: str, data: dict) -> None:
    tmp = path + ".tmp"
    try:
        with open(tmp, "w") as f:
            json.dump(data, f)
        os.replace(tmp, path)
    except OSError:
        pass

def append_event(event: dict) -> None:
    try:
        with open(EVENTS_FILE, "a") as f:
            f.write(json.dumps(event) + "\n")
    except OSError:
        pass

def update_presence(state: dict) -> None:
    existing = {}
    try:
        with open(PRESENCE_FILE) as f:
            existing = json.load(f)
    except (OSError, json.JSONDecodeError):
        pass
    existing.update(state)
    existing["ts"] = now_iso()
    atomic_write(PRESENCE_FILE, existing)

def tool_summary(name: str, inp: dict) -> str:
    """One-line summary of a tool call for display."""
    if name == "Bash":
        cmd = (inp.get("command") or "").strip()
        return cmd[:80] + ("…" if len(cmd) > 80 else "")
    if name in ("Read", "Edit", "Write", "NotebookEdit"):
        return inp.get("file_path", "")[:80]
    if name == "Agent":
        return (inp.get("description") or inp.get("prompt", "")[:60])[:80]
    if name in ("WebFetch", "WebSearch"):
        return (inp.get("url") or inp.get("query", ""))[:80]
    return str(inp)[:80]

def detect_task(text: str, current):  # current: Optional[str]
    """Scan Bash command or text output for a kernel/task claim."""
    if current:
        return current
    # Bash: ./kernel/task claim FEAT-001 --agent ...
    m = re.search(r'task\s+claim\s+([A-Z][A-Z0-9-]+)', text)
    if m:
        return m.group(1)
    # Text output: claim(FEAT-001)
    m = re.search(r'claim\(([A-Z][A-Z0-9-]+)\)', text)
    if m:
        return m.group(1)
    return None

# --- State ---

session_start_iso = now_iso()
session_start_ts  = time.time()

def _ledger_claimed_task() -> "str | None":
    """Return the task ID this agent has in_progress in the ledger, if any."""
    ledger_dir = os.path.join(CONTROL_DIR, "ledger")
    if not os.path.isdir(ledger_dir):
        return None
    try:
        for fn in os.listdir(ledger_dir):
            if not fn.endswith(".task"):
                continue
            fields: dict = {}
            with open(os.path.join(ledger_dir, fn)) as f:
                for line in f:
                    m = re.match(r'^([a-z_]+):\s?(.*)$', line.rstrip("\n"))
                    if m:
                        fields[m.group(1)] = m.group(2).strip()
            if fields.get("claimed_by") == AGENT_NAME and fields.get("status") == "in_progress":
                return fields.get("id") or fn[:-5]
    except OSError:
        pass
    return None

live: dict = {
    "agent":         AGENT_NAME,
    "session_start": session_start_iso,
    "task":          _ledger_claimed_task(),
    "last_tool":     None,
    "last_summary":  None,
    "last_ts":       session_start_iso,
    "turn":          0,
    "input_tokens":  None,
    "output_tokens": None,
    "cost_usd":      None,
    "ended":         False,
}
atomic_write(LIVE_FILE, live)
update_presence({"state": "working", "task": live["task"], "last_tool": None})

# Accumulators for final metrics JSON
result_event: dict = {}
all_text_parts: list[str] = []

# --- Parse NDJSON stream ---

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    try:
        ev = json.loads(raw)
    except json.JSONDecodeError:
        continue

    ev_type = ev.get("type", "")

    # assistant event: contains text + tool_use content blocks
    if ev_type == "assistant":
        live["turn"] += 1
        content = ev.get("message", {}).get("content") or []
        for item in content:
            item_type = item.get("type", "")

            if item_type == "text":
                text = item.get("text", "")
                all_text_parts.append(text)
                task = detect_task(text, live["task"])
                if task and not live["task"]:
                    live["task"] = task
                    append_event({"ts": now_iso(), "agent": AGENT_NAME,
                                  "type": "task_claimed", "task": task})
                    update_presence({"state": "working", "task": task})

            elif item_type == "tool_use":
                name = item.get("name", "unknown")
                inp  = item.get("input") or {}
                summ = tool_summary(name, inp)

                # Detect task from Bash commands
                if name == "Bash":
                    cmd = inp.get("command", "")
                    all_text_parts.append(f"[tool:{name}] {cmd}")
                    task = detect_task(cmd, live["task"])
                    if task and not live["task"]:
                        live["task"] = task
                        append_event({"ts": now_iso(), "agent": AGENT_NAME,
                                      "type": "task_claimed", "task": task})

                live["last_tool"]    = name
                live["last_summary"] = summ
                live["last_ts"]      = now_iso()
                atomic_write(LIVE_FILE, live)

                append_event({"ts": now_iso(), "agent": AGENT_NAME,
                              "type": "tool_call", "tool": name, "summary": summ})
                update_presence({"state": "working", "task": live["task"],
                                 "last_tool": name, "last_summary": summ})

    # user event: tool results (verbose mode) — scan result text for task clues
    elif ev_type == "user":
        content = ev.get("message", {}).get("content") or []
        for item in content:
            if item.get("type") == "tool_result":
                result_text = ""
                c = item.get("content", "")
                if isinstance(c, str):
                    result_text = c
                elif isinstance(c, list):
                    result_text = " ".join(
                        x.get("text", "") for x in c if x.get("type") == "text"
                    )
                task = detect_task(result_text, live["task"])
                if task and not live["task"]:
                    live["task"] = task
                    append_event({"ts": now_iso(), "agent": AGENT_NAME,
                                  "type": "task_claimed", "task": task})
                    update_presence({"state": "working", "task": task})

    # result: final event with cost, usage, and summary text
    elif ev_type == "result":
        result_event = ev
        live["cost_usd"]      = ev.get("cost_usd") or ev.get("total_cost_usd")
        usage = ev.get("usage") or {}
        live["input_tokens"]  = usage.get("input_tokens")
        live["output_tokens"] = usage.get("output_tokens")

# --- Session ended ---

duration_s = int(time.time() - session_start_ts)
live["ended"] = True
atomic_write(LIVE_FILE, live)

append_event({"ts": now_iso(), "agent": AGENT_NAME, "type": "session_end",
              "task": live["task"], "duration_s": duration_s})
update_presence({"state": "idle", "task": None, "last_tool": None, "last_summary": None})

# --- Output metrics-compatible JSON to stdout ---
# This goes to $JSONFILE and is read by the existing metrics Python in run-agent.sh.

result_text = result_event.get("result", "") or " ".join(all_text_parts)
usage       = result_event.get("usage") or {}
print(json.dumps({
    "result":        result_text,
    "is_error":      result_event.get("is_error", False),
    "total_cost_usd": live["cost_usd"],
    "num_turns":     live["turn"],
    "usage": {
        "input_tokens":            usage.get("input_tokens",  live["input_tokens"]),
        "output_tokens":           usage.get("output_tokens", live["output_tokens"]),
        "cache_read_input_tokens": usage.get("cache_read_input_tokens"),
    },
}))
