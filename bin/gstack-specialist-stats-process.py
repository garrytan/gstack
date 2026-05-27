#!/usr/bin/env python3
"""gstack-specialist-stats processor (Python fallback for bun on Windows).

Reads tab/newline-separated JSONL review records from stdin, aggregates
per-specialist dispatch + finding counts, and prints the stats summary.
Mirrors the inline bun script in gstack-specialist-stats.
"""
import sys
import json

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


NEVER_GATE = {"security", "data-migration"}

raw = sys.stdin.read().strip()
lines = [ln for ln in raw.split("\n") if ln]

stats = {}
reviewed = 0
for line in lines:
    try:
        e = json.loads(line)
    except Exception:
        continue
    if not e.get("specialists"):
        continue
    reviewed += 1
    for name, info in e["specialists"].items():
        if not isinstance(info, dict):
            continue
        if name not in stats:
            stats[name] = {"dispatched": 0, "findings": 0}
        if info.get("dispatched"):
            stats[name]["dispatched"] += 1
            stats[name]["findings"] += int(info.get("findings") or 0)

print(f"SPECIALIST_STATS: {reviewed} reviews analyzed")
for name, s in sorted(stats.items()):
    pct = round(100 * s["findings"] / s["dispatched"]) if s["dispatched"] > 0 else 0
    tag = ""
    if name in NEVER_GATE:
        tag = " [NEVER_GATE]"
    elif s["dispatched"] >= 10 and s["findings"] == 0:
        tag = " [GATE_CANDIDATE]"
    print(
        f"{name}: {s['dispatched']}/{reviewed} dispatched, "
        f"{s['findings']} findings ({pct}%){tag}"
    )
