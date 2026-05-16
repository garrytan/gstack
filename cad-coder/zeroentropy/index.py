"""Index models.jsonl into a ZeroEntropy hosted collection.

Each Thingiverse record becomes one ZE document whose `content` is the
natural-language description (name + description + tags) and whose metadata
carries the thing URL and first STL file URL so retrieval can return a path.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

ZE_BASE = "https://api.zeroentropy.dev/v1"
MAX_CONTENT_BYTES = 60_000  # leave headroom under ZE's metadata-size cap
TAG = re.compile(r"<[^>]+>")


def strip_html(s: str) -> str:
    return TAG.sub(" ", s or "").strip()


def build_text(record: dict) -> str:
    parts = [
        f"Name: {record.get('name', '')}",
        f"Tags: {', '.join(record.get('tags') or [])}",
        f"Description: {strip_html(record.get('description', ''))}",
    ]
    details = strip_html(record.get("details", ""))
    if details:
        parts.append(f"Details: {details}")
    text = "\n".join(p for p in parts if p.strip())
    return text[:MAX_CONTENT_BYTES]


def ze_post(session: requests.Session, key: str, path: str, body: dict) -> dict:
    r = session.post(
        f"{ZE_BASE}{path}",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        json=body,
        timeout=60,
    )
    if r.status_code >= 400:
        # surface ZE error details
        raise RuntimeError(f"ZE {path} -> {r.status_code}: {r.text[:500]}")
    return r.json()


def ensure_collection(session: requests.Session, key: str, name: str) -> None:
    try:
        ze_post(session, key, "/collections/add-collection", {"collection_name": name})
        print(f"created collection {name!r}")
    except RuntimeError as e:
        msg = str(e)
        if "409" in msg or "already" in msg.lower() or "exists" in msg.lower():
            print(f"collection {name!r} already exists")
        else:
            raise


def main() -> int:
    load_dotenv()
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", type=Path, default=Path(__file__).parent / "models.jsonl")
    ap.add_argument("--collection", default=os.environ.get("ZE_COLLECTION", "thingiverse-popular"))
    args = ap.parse_args()

    key = os.environ.get("ZEROENTROPY_API_KEY")
    if not key:
        print("error: set ZEROENTROPY_API_KEY (see .env.example)", file=sys.stderr)
        return 1
    if not args.input.exists():
        print(f"error: {args.input} not found — run scrape.py first", file=sys.stderr)
        return 1

    session = requests.Session()
    ensure_collection(session, key, args.collection)

    n = 0
    with args.input.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            rec = json.loads(line)
            text = build_text(rec)
            if not text.strip():
                continue
            stls = rec.get("stl_files") or []
            primary = stls[0] if stls else {}
            desc_plain = strip_html(rec.get("description", ""))
            details_plain = strip_html(rec.get("details", ""))
            meta = {
                "thing_id": str(rec.get("id", "")),
                "name": (rec.get("name") or "")[:500],
                # Description carried in metadata so retrieval callers don't
                # need the source jsonl. Truncated to stay under ZE's 65536-byte
                # metadata-value cap with headroom.
                "description": (desc_plain + ("\n\n" + details_plain if details_plain else ""))[:8000],
                "thing_url": rec.get("url") or "",
                "stl_name": primary.get("name", ""),
                "stl_url": primary.get("url", ""),
                # ZE metadata requires scalar strings — JSON-encode lists so
                # callers can json.loads() them on retrieval.
                "all_stl_urls_json": json.dumps(
                    [s.get("url", "") for s in stls if s.get("url")][:20]
                ),
                "tags_json": json.dumps((rec.get("tags") or [])[:30]),
            }
            try:
                ze_post(
                    session,
                    key,
                    "/documents/add-document",
                    {
                        "collection_name": args.collection,
                        "path": f"thing-{rec['id']}",
                        "content": {"type": "text", "text": text},
                        "metadata": meta,
                    },
                )
            except RuntimeError as e:
                msg = str(e)
                if "409" in msg or "already" in msg.lower() or "exists" in msg.lower():
                    print(f"  exists {rec.get('id')}, skipping")
                else:
                    print(f"  skip {rec.get('id')}: {e}", file=sys.stderr)
                continue
            n += 1
            if n % 10 == 0:
                print(f"  indexed {n}")
            time.sleep(0.05)

    print(f"\nindexed {n} documents into collection {args.collection!r}")
    print("note: ZE indexes documents asynchronously — wait a bit before querying.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
