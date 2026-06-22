#!/usr/bin/env python3
"""Runnable demo for the Northstar Pantry hypothetical business."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data" / "business-state.json"
MEMORY = ROOT / "gbrain" / "memory.jsonl"


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def load_jsonl(path: Path):
    rows = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        raw = raw.strip()
        if not raw:
            continue
        rows.append(json.loads(raw))
    return rows


def score_issue(issue: dict) -> float:
    impact = issue.get("impact", 0)
    urgency = issue.get("urgency", 0)
    confidence = issue.get("confidence", 0.0)
    return (impact * 2.0) + urgency + confidence


def memory_matches(entries, query: str):
    terms = [t.lower() for t in re.findall(r"[\w-]+", query) if t.strip()]
    if not terms:
        return entries
    hits = []
    for entry in entries:
        haystack = " ".join(
            [
                entry.get("id", ""),
                entry.get("type", ""),
                entry.get("title", ""),
                entry.get("content", ""),
                " ".join(entry.get("tags", [])),
            ]
        ).lower()
        if all(term in haystack for term in terms):
            hits.append(entry)
    return hits


def print_summary(state: dict, memory: list[dict]):
    print(f"Business: {state['business_name']}")
    print(f"Type: {state['business_type']}")
    print(f"North star: {state['north_star']}")
    print()

    metrics = state["metrics"]
    print("Current metrics")
    print(f"  Active subscribers: {metrics['active_subscribers']}")
    print(f"  Monthly revenue:    ${metrics['monthly_revenue_usd']:,.0f}")
    print(f"  Gross margin:       {metrics['gross_margin_pct']}%")
    print(f"  Late shipments:     {metrics['late_shipments_pct']}%")
    print(f"  CAC:                ${metrics['blended_cac_usd']:.2f}")
    print(f"  Refund rate:        {metrics['refund_rate_pct']}%")
    print()

    ranked = sorted(state["issues"], key=score_issue, reverse=True)
    print("Top risks")
    for idx, issue in enumerate(ranked[:3], start=1):
        print(f"  {idx}. {issue['name']} (score {score_issue(issue):.1f})")
        print(f"     {issue['note']}")
    print()

    print("Recommended next actions")
    action_map = {
        "Late shipments": "Audit picking and packing today, then shorten the route with the highest delay rate.",
        "Oat bar supplier delay": "Switch the next purchase order to the backup supplier before the weekend promo.",
        "Packing accuracy complaints": "Add a packing checklist and spot-check the top 20 orders from the last 48 hours.",
        "Rising CAC": "Pause the weakest paid social campaign and move budget to referral/email until CAC drops.",
        "Enterprise sample request": "Ship the sample box on Thursday and book the follow-up while the package is in transit.",
    }
    for issue in ranked[:3]:
        print(f"  - {action_map.get(issue['name'], 'Investigate and reduce the blocker.')}")
    print()

    print("gbrain memory clues")
    for key in ["supplier", "enterprise", "cac"]:
        hits = memory_matches(memory, key)
        if not hits:
            continue
        top = hits[0]
        print(f"  Query '{key}': {top['title']} — {top['content']}")
    print()

    print("Operator questions to resolve")
    for q in state["open_questions"]:
        print(f"  - {q}")


def print_search(memory: list[dict], query: str):
    hits = memory_matches(memory, query)
    print(f"Search: {query}")
    if not hits:
        print("No matches found.")
        return
    for entry in hits:
        print(f"- [{entry['type']}] {entry['title']}")
        print(f"  {entry['content']}")


def main(argv: list[str]) -> int:
    state = load_json(DATA)
    memory = load_jsonl(MEMORY)
    if len(argv) >= 2 and argv[1] == "search":
        query = " ".join(argv[2:]).strip()
        if not query:
            print("Usage: run_demo.py search <query>")
            return 2
        print_search(memory, query)
        return 0
    print_summary(state, memory)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
