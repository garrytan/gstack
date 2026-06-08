#!/usr/bin/env python3
"""gstack-learnings-search processor (Python fallback for bun on Windows).

Reads tab-tagged JSONL lines from stdin (each line is `<tag>\\t<json>` where
`<tag>` is `current` or `cross`), processes them, and prints the formatted
search result to stdout. Behavior must match the inline bun script in
gstack-learnings-search:
- Confidence decay: observed/inferred sources lose 1pt per 30 days from ts
- Trust gate: cross-project entries with trusted == false are dropped
- Dedup: latest ts wins per (key, type) tuple
- Filter by GSTACK_SEARCH_TYPE (env var) if set
- Filter by GSTACK_SEARCH_QUERY (env var, token-OR across key/insight/files)
- Sort by effective confidence desc, then by recency desc
- Limit to GSTACK_SEARCH_LIMIT entries
- Output: summary line + grouped-by-type sections

Exit 0 silently if no entries survive filtering.
"""
import sys
import os
import json
import math
import re
from datetime import datetime, timezone

# Force UTF-8 on stdout/stderr. Windows defaults to cp1252 which raises
# UnicodeEncodeError on non-ASCII (em-dashes, arrows, smart quotes).
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def parse_ts(ts_str):
    """Return seconds since epoch, or None if unparseable.

    Matches JS `new Date(ts).getTime()` for ISO 8601 strings ending in Z.
    """
    if not ts_str or not isinstance(ts_str, str):
        return None
    try:
        # Python 3.11+ accepts the Z suffix directly; replace for older.
        normalized = ts_str.replace("Z", "+00:00")
        return datetime.fromisoformat(normalized).timestamp()
    except Exception:
        return None


now = datetime.now(timezone.utc).timestamp()
type_filter = os.environ.get("GSTACK_SEARCH_TYPE", "")
query_raw = os.environ.get("GSTACK_SEARCH_QUERY", "").lower()
query_tokens = [t for t in re.split(r"\s+", query_raw) if t]
try:
    limit = int(os.environ.get("GSTACK_SEARCH_LIMIT", "10"))
except (TypeError, ValueError):
    limit = 10

entries = []
for tagged_line in sys.stdin.read().split("\n"):
    if not tagged_line:
        continue
    try:
        tab_idx = tagged_line.find("\t")
        if tab_idx == -1:
            source_tag = "current"
            line = tagged_line
        else:
            source_tag = tagged_line[:tab_idx]
            line = tagged_line[tab_idx + 1:]
        e = json.loads(line)
        if not e.get("key") or not e.get("type"):
            continue

        # Confidence decay for observed/inferred sources only.
        conf = e.get("confidence")
        if not isinstance(conf, (int, float)):
            conf = 5
        if e.get("source") in ("observed", "inferred"):
            ts_sec = parse_ts(e.get("ts"))
            if ts_sec is not None:
                days = math.floor((now - ts_sec) / 86400)
                conf = max(0, conf - math.floor(days / 30))
        e["_effectiveConfidence"] = conf

        is_cross_project = source_tag == "cross"
        e["_crossProject"] = is_cross_project

        # Trust gate: drop cross-project AI-generated learnings (prevents
        # silent prompt-injection-style influence across projects).
        if is_cross_project and e.get("trusted") is False:
            continue

        entries.append(e)
    except Exception:
        # Bun version silently swallows per-line parse errors; match that.
        continue


# Dedup: latest ts wins per (key, type).
seen = {}
for e in entries:
    dk = f"{e['key']}|{e['type']}"
    existing = seen.get(dk)
    if existing is None:
        seen[dk] = e
    else:
        e_ts = parse_ts(e.get("ts")) or 0
        ex_ts = parse_ts(existing.get("ts")) or 0
        if e_ts > ex_ts:
            seen[dk] = e

results = list(seen.values())

if type_filter:
    results = [e for e in results if e.get("type") == type_filter]

if query_tokens:
    def matches(e):
        haystacks = [
            (e.get("key") or "").lower(),
            (e.get("insight") or "").lower(),
        ]
        haystacks.extend((f or "").lower() for f in (e.get("files") or []))
        return any(tok in h for tok in query_tokens for h in haystacks)
    results = [e for e in results if matches(e)]

# Sort: effective confidence desc, then ts desc.
def sort_key(e):
    ts_sec = parse_ts(e.get("ts")) or 0
    return (-e.get("_effectiveConfidence", 0), -ts_sec)
results.sort(key=sort_key)

results = results[:limit]

if not results:
    sys.exit(0)

# Group by type for output.
by_type = {}
for e in results:
    t = e.get("type") or "unknown"
    by_type.setdefault(t, []).append(e)

# Summary line.
counts = []
for t, arr in by_type.items():
    label = t + ("s" if len(arr) > 1 else "")
    counts.append(f"{len(arr)} {label}")
print(f"LEARNINGS: {len(results)} loaded ({', '.join(counts)})")
print("")

for t, arr in by_type.items():
    header = t[0].upper() + t[1:] + "s"
    print(f"## {header}")
    for e in arr:
        cross = " [cross-project]" if e.get("_crossProject") else ""
        files_list = e.get("files") or []
        files = f" (files: {', '.join(files_list)})" if files_list else ""
        ts_date = (e.get("ts") or "").split("T")[0]
        print(
            f"- [{e['key']}] (confidence: {e['_effectiveConfidence']}/10, "
            f"{e.get('source', '')}, {ts_date}){cross}"
        )
        print(f"  {e.get('insight', '')}{files}")
    print("")
