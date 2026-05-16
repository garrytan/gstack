"""Scrape ~N popular Thingiverse models into models.jsonl.

Each record: {id, name, description, tags, url, thumbnail, stl_files: [{name, url}]}

Requires a free Thingiverse API token. Register an app at
https://www.thingiverse.com/developers/my-apps and copy the App Token.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv

API = "https://api.thingiverse.com"


def headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "User-Agent": "zeroentropy-pipeline/0.1"}


def get(session: requests.Session, url: str, token: str, **kwargs) -> dict | list:
    for attempt in range(4):
        r = session.get(url, headers=headers(token), timeout=30, **kwargs)
        if r.status_code == 429:
            wait = 2 ** attempt
            print(f"  rate-limited, sleeping {wait}s", file=sys.stderr)
            time.sleep(wait)
            continue
        r.raise_for_status()
        return r.json()
    raise RuntimeError(f"Failed after retries: {url}")


def list_popular(session: requests.Session, token: str, count: int) -> list[dict]:
    """Walk the popular search until we have `count` things."""
    things: list[dict] = []
    page = 1
    per_page = 30
    while len(things) < count:
        data = get(
            session,
            f"{API}/search/",
            token,
            params={"type": "things", "sort": "popular", "per_page": per_page, "page": page},
        )
        hits = data.get("hits") if isinstance(data, dict) else data
        if not hits:
            break
        things.extend(hits)
        page += 1
    return things[:count]


def stl_files(session: requests.Session, token: str, thing_id: int) -> list[dict]:
    files = get(session, f"{API}/things/{thing_id}/files", token)
    out = []
    for f in files or []:
        name = f.get("name", "")
        if not name.lower().endswith(".stl"):
            continue
        out.append({
            "name": name,
            "url": f.get("public_url") or f.get("download_url") or f.get("url"),
        })
    return out


def thing_detail(session: requests.Session, token: str, thing_id: int) -> dict:
    return get(session, f"{API}/things/{thing_id}", token)


def main() -> int:
    load_dotenv()
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=100)
    ap.add_argument("--out", type=Path, default=Path(__file__).parent / "models.jsonl")
    args = ap.parse_args()

    token = os.environ.get("THINGIVERSE_TOKEN")
    if not token:
        print("error: set THINGIVERSE_TOKEN (see .env.example)", file=sys.stderr)
        return 1

    session = requests.Session()
    print(f"fetching {args.count} popular things...")
    listing = list_popular(session, token, args.count)
    print(f"got {len(listing)} listing entries")

    n_written = 0
    with args.out.open("w") as fh:
        for i, item in enumerate(listing, 1):
            tid = item.get("id")
            if not tid:
                continue
            try:
                detail = thing_detail(session, token, tid)
                stls = stl_files(session, token, tid)
            except requests.HTTPError as e:
                print(f"  [{i}/{len(listing)}] {tid}: skip ({e})", file=sys.stderr)
                continue
            if not stls:
                print(f"  [{i}/{len(listing)}] {tid}: no STL files, skip")
                continue
            record = {
                "id": tid,
                "name": detail.get("name", ""),
                "description": (detail.get("description") or "").strip(),
                "details": (detail.get("details") or "").strip(),
                "tags": [t.get("name") for t in detail.get("tags", []) if t.get("name")],
                "url": detail.get("public_url"),
                "thumbnail": detail.get("thumbnail"),
                "creator": (detail.get("creator") or {}).get("name"),
                "like_count": detail.get("like_count"),
                "stl_files": stls,
            }
            fh.write(json.dumps(record) + "\n")
            n_written += 1
            print(f"  [{i}/{len(listing)}] {tid}: {record['name'][:60]} ({len(stls)} STL)")
            time.sleep(0.1)

    print(f"\nwrote {n_written} records to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
