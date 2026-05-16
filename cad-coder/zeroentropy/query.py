"""Query the ZE collection with natural language; return the top STL URL.

Usage:
    python query.py "a low-poly fox figurine"
    python query.py --k 5 "phone stand that holds a tablet"
"""
from __future__ import annotations

import argparse
import json
import os
import sys

import requests
from dotenv import load_dotenv

ZE_BASE = "https://api.zeroentropy.dev/v1"


def main() -> int:
    load_dotenv()
    ap = argparse.ArgumentParser()
    ap.add_argument("query", help="natural language description of the model")
    ap.add_argument("--k", type=int, default=5)
    ap.add_argument("--collection", default=os.environ.get("ZE_COLLECTION", "thingiverse-popular"))
    ap.add_argument("--json", action="store_true", help="emit full JSON response")
    args = ap.parse_args()

    key = os.environ.get("ZEROENTROPY_API_KEY")
    if not key:
        print("error: set ZEROENTROPY_API_KEY", file=sys.stderr)
        return 1

    r = requests.post(
        f"{ZE_BASE}/queries/top-documents",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json={
            "collection_name": args.collection,
            "query": args.query,
            "k": args.k,
            "include_metadata": True,
        },
        timeout=30,
    )
    if r.status_code >= 400:
        print(f"ZE error {r.status_code}: {r.text}", file=sys.stderr)
        return 1
    data = r.json()

    if args.json:
        print(json.dumps(data, indent=2))
        return 0

    results = data.get("results") or []
    if not results:
        print("no results")
        return 0

    print(f"\nquery: {args.query!r}\n")
    for i, hit in enumerate(results, 1):
        meta = hit.get("metadata") or {}
        score = hit.get("score")
        score_s = f"{score:.3f}" if isinstance(score, (int, float)) else "?"
        try:
            tags = json.loads(meta.get("tags_json") or "[]")
        except json.JSONDecodeError:
            tags = []
        print(f"[{i}] score={score_s}  {meta.get('name', '(unnamed)')}")
        print(f"    thing:    {meta.get('thing_url', '')}")
        print(f"    stl_url:  {meta.get('stl_url', '')}")
        if tags:
            print(f"    tags:     {', '.join(tags[:8])}")
        print()

    top = results[0].get("metadata") or {}
    print(f"TOP MATCH STL: {top.get('stl_url', '(none)')}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
