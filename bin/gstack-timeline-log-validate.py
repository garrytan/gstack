#!/usr/bin/env python3
"""gstack-timeline-log validator (Python fallback for bun on Windows).

Reads a JSON timeline event from stdin, validates required fields, auto-fills
`ts` if missing, and prints normalized JSON to stdout. Matches the three
inline bun blocks in gstack-timeline-log:
- Require `skill` and `event` (exit 1 silently if missing — the bash wrapper
  treats this as a non-blocking skip)
- Auto-fill `ts` with current ISO-UTC-with-Z if not present
- Preserve all other fields in insertion order

Exit 0 on success (with normalized JSON on stdout), 1 on any failure
(silent — matches bun behavior).
"""
import sys
import json
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


try:
    j = json.loads(sys.stdin.read())
except Exception:
    sys.exit(1)

if not j.get("skill") or not j.get("event"):
    sys.exit(1)

if not j.get("ts"):
    j["ts"] = (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )

sys.stdout.write(json.dumps(j, separators=(",", ":")) + "\n")
