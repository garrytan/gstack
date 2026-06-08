#!/usr/bin/env python3
"""gstack-question-log validator (Python fallback for bun on Windows).

Reads a JSON AskUserQuestion log entry from stdin, validates+normalizes
according to the schema, and prints the result to stdout. Mirrors the
inline bun validator in gstack-question-log line-for-line.

Fields:
- skill (required, kebab-case)
- question_id (required, kebab-case, <=64)
- question_summary (required, <=200, no newlines, no injection patterns)
- category (optional, allow-listed)
- door_type (optional, one-way|two-way)
- options_count (optional, integer 1-26)
- user_choice (required, <=64, single-line)
- recommended (optional, <=64)
- followed_recommendation (auto-computed)
- session_id (optional, <=64)
- ts (auto-filled)
"""
import sys
import json
import re
import math
from datetime import datetime, timezone

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def fail(msg: str) -> None:
    sys.stderr.write(f"gstack-question-log: {msg}\n")
    sys.exit(1)


raw = sys.stdin.read()
try:
    j = json.loads(raw)
except Exception:
    fail("invalid JSON")

KEBAB = re.compile(r"^[a-z0-9-]+$")

if not isinstance(j.get("skill"), str) or not j["skill"] or not KEBAB.match(j["skill"]):
    fail("invalid skill, must be kebab-case")

qid = j.get("question_id")
if not isinstance(qid, str) or not qid or not KEBAB.match(qid) or len(qid) > 64:
    fail("invalid question_id, must be kebab-case <=64 chars")

qs = j.get("question_summary")
if not isinstance(qs, str) or not qs:
    fail("question_summary required")
if len(qs) > 200:
    qs = qs[:200]
if "\n" in qs:
    qs = re.sub(r"\n+", " ", qs)
j["question_summary"] = qs

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
]
for pat in INJECTION_PATTERNS:
    if re.search(pat, qs, re.IGNORECASE):
        fail("question_summary contains suspicious instruction-like content, rejected")

ALLOWED_CATEGORIES = ["approval", "clarification", "routing", "cherry-pick", "feedback-loop"]
if "category" in j and j["category"] is not None:
    if j["category"] not in ALLOWED_CATEGORIES:
        fail("invalid category, must be one of: " + ", ".join(ALLOWED_CATEGORIES))

ALLOWED_DOORS = ["one-way", "two-way"]
if "door_type" in j and j["door_type"] is not None:
    if j["door_type"] not in ALLOWED_DOORS:
        fail("invalid door_type, must be one-way or two-way")

if "options_count" in j and j["options_count"] is not None:
    try:
        n_raw = float(j["options_count"])
    except (TypeError, ValueError):
        n_raw = float("nan")
    if math.isnan(n_raw) or not n_raw.is_integer() or n_raw < 1 or n_raw > 26:
        fail("options_count must be integer in [1, 26]")
    j["options_count"] = int(n_raw)

uc = j.get("user_choice")
if not isinstance(uc, str) or not uc:
    fail("user_choice required")
if len(uc) > 64:
    uc = uc[:64]
uc = re.sub(r"\n+", " ", uc)
j["user_choice"] = uc

if "recommended" in j and j["recommended"] is not None:
    if not isinstance(j["recommended"], str):
        fail("recommended must be string")
    if len(j["recommended"]) > 64:
        j["recommended"] = j["recommended"][:64]

if j.get("recommended") is not None and j.get("user_choice") is not None:
    j["followed_recommendation"] = j["user_choice"] == j["recommended"]

if "session_id" in j and j["session_id"] is not None:
    if not isinstance(j["session_id"], str):
        fail("session_id must be string")
    if len(j["session_id"]) > 64:
        j["session_id"] = j["session_id"][:64]

if not j.get("ts"):
    j["ts"] = (
        datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )

sys.stdout.write(json.dumps(j, separators=(",", ":")) + "\n")
