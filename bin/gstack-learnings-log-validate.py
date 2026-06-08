#!/usr/bin/env python3
"""gstack-learnings-log validator (Python fallback for bun on Windows).

Reads a JSON learning entry from stdin, validates and normalizes it, and
prints the result to stdout. Behavior must match the inline bun validator
in gstack-learnings-log:
- Same allowed `type` list
- Same `key` regex (alphanumeric + hyphens + underscores)
- Same `confidence` integer 1-10 rule
- Same allowed `source` list
- Same prompt-injection pattern blocklist on `insight`
- Same `ts` ISO-with-Z auto-fill
- Same `trusted = (source == "user-stated")` rule
- All other fields pass through unchanged, in insertion order

Exit 0 on success, 1 on validation failure (with a message on stderr that
matches the bun version's wording).
"""
import sys
import json
import re
import math
from datetime import datetime, timezone

# Force UTF-8 on stdout/stderr. Windows defaults to cp1252 which raises
# UnicodeEncodeError on non-ASCII (em-dashes, arrows, smart quotes).
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def fail(msg: str) -> None:
    sys.stderr.write(f"gstack-learnings-log: {msg}\n")
    sys.exit(1)


raw = sys.stdin.read()
try:
    j = json.loads(raw)
except Exception:
    fail("invalid JSON, skipping")

ALLOWED_TYPES = [
    "pattern", "pitfall", "preference", "architecture",
    "tool", "operational", "investigation",
]
if not j.get("type") or j["type"] not in ALLOWED_TYPES:
    fail(
        f'invalid type "{j.get("type") or ""}", must be one of: '
        + ", ".join(ALLOWED_TYPES)
    )

if not j.get("key") or not re.match(r"^[a-zA-Z0-9_-]+$", j["key"]):
    fail("invalid key, must be alphanumeric with hyphens/underscores only")

conf_raw = j.get("confidence")
try:
    conf_num = float(conf_raw) if conf_raw is not None else float("nan")
except (TypeError, ValueError):
    conf_num = float("nan")
if math.isnan(conf_num) or not conf_num.is_integer() or conf_num < 1 or conf_num > 10:
    fail("confidence must be integer 1-10")
j["confidence"] = int(conf_num)

ALLOWED_SOURCES = ["observed", "user-stated", "inferred", "cross-model"]
if j.get("source") and j["source"] not in ALLOWED_SOURCES:
    fail("invalid source, must be one of: " + ", ".join(ALLOWED_SOURCES))

if j.get("insight"):
    INJECTION_PATTERNS = [
        r"ignore\s+(all\s+)?previous\s+(instructions|context|rules)",
        r"you\s+are\s+now\s+",
        r"always\s+output\s+no\s+findings",
        r"skip\s+(all\s+)?(security|review|checks)",
        r"override[:\s]",
        r"\bsystem\s*:",
        r"\bassistant\s*:",
        r"\buser\s*:",
        r"do\s+not\s+(report|flag|mention)",
        r"approve\s+(all|every|this)",
    ]
    for pat in INJECTION_PATTERNS:
        if re.search(pat, j["insight"], re.IGNORECASE):
            fail("insight contains suspicious instruction-like content, rejected")

if not j.get("ts"):
    j["ts"] = (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )

j["trusted"] = j.get("source") == "user-stated"

# Compact separators to match JS JSON.stringify output (existing entries
# in learnings.jsonl have no whitespace after `:` or `,`).
sys.stdout.write(json.dumps(j, separators=(",", ":")) + "\n")
