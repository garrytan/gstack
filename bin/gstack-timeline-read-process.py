#!/usr/bin/env python3
"""gstack-timeline-read processor (Python fallback for bun on Windows).

Reads timeline.jsonl from stdin (one JSON event per line), filters by since/
branch, prints a summary line and the last N recent events. Mirrors the bun
script in gstack-timeline-read:
- Parse `since` like "7 days ago" (minute/hour/day/week/month, plural ok)
- Filter entries with ts < sinceMs if since was parsed
- Filter entries with branch != GSTACK_TIMELINE_BRANCH if set
- Skill counts use COMPLETED events only
- Take last `limit` entries (most recent end)
- Output summary, blank line, "## Recent Events", then formatted events

Exit 0 silently if no entries survive.
"""
import sys
import os
import re
import json
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def parse_ts_ms(ts_str):
    """Return ms since epoch, or None if unparseable. Matches new Date(ts).getTime()."""
    if not ts_str or not isinstance(ts_str, str):
        return None
    try:
        normalized = ts_str.replace("Z", "+00:00")
        return int(datetime.fromisoformat(normalized).timestamp() * 1000)
    except Exception:
        return None


since = os.environ.get("GSTACK_TIMELINE_SINCE", "")
branch = os.environ.get("GSTACK_TIMELINE_BRANCH", "")
limit_raw = os.environ.get("GSTACK_TIMELINE_LIMIT", "20")
try:
    parsed_limit = int(limit_raw)
    limit = parsed_limit if parsed_limit > 0 else 20
except (TypeError, ValueError):
    limit = 20

since_ms = 0
if since:
    m = re.match(r"(\d+)\s*(day|hour|minute|week|month)s?\s*ago", since, re.IGNORECASE)
    if m:
        n = int(m.group(1))
        unit = m.group(2).lower()
        unit_ms = {
            "minute": 60000,
            "hour": 3600000,
            "day": 86400000,
            "week": 604800000,
            "month": 2592000000,
        }
        now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
        since_ms = now_ms - n * unit_ms.get(unit, 86400000)

raw = sys.stdin.read().strip()
lines = [ln for ln in raw.split("\n") if ln]

entries = []
for line in lines:
    try:
        e = json.loads(line)
        if since_ms:
            ts_ms = parse_ts_ms(e.get("ts"))
            if ts_ms is None or ts_ms < since_ms:
                continue
        if branch and e.get("branch") != branch:
            continue
        entries.append(e)
    except Exception:
        continue

if not entries:
    sys.exit(0)

recent = entries[-limit:]

# Skill counts (completed events only).
counts = {}
branches = set()
for e in entries:
    if e.get("event") == "completed":
        skill = e.get("skill")
        if skill:
            counts[skill] = counts.get(skill, 0) + 1
    if e.get("branch"):
        branches.add(e["branch"])

# Output summary.
count_pairs = sorted(counts.items(), key=lambda kv: -kv[1])
count_str = ", ".join(f"{n} /{s}" for s, n in count_pairs)

if count_str:
    branch_count = len(branches)
    plural = "branch" if branch_count == 1 else "branches"
    print(f"TIMELINE: {count_str} across {branch_count} {plural}")

print("")
print("## Recent Events")
for e in recent:
    ts = (e.get("ts") or "").replace("T", " ")
    ts = re.sub(r"\.\d+Z$", "Z", ts)
    dur_s = e.get("duration_s")
    dur = f" ({dur_s}s)" if dur_s else ""
    outcome = f" [{e['outcome']}]" if e.get("outcome") else ""
    branch_str = f" on {e['branch']}" if e.get("branch") else ""
    print(f"- {ts} /{e.get('skill', '')} {e.get('event', '')}{outcome}{dur}{branch_str}")
