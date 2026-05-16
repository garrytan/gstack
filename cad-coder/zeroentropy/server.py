"""Tiny FastAPI server exposing /query → top-3 STL matches with local paths.

GET /query?q=<text>&k=3

Each result contains the model description and a *local filesystem path* to
an STL file. STLs are downloaded lazily on first request and cached under
$STL_CACHE_DIR (default: /tmp/stl-cache/).

Run:
    uvicorn server:app --reload --port 8000
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query

load_dotenv()

ZE_BASE = "https://api.zeroentropy.dev/v1"
ZE_KEY = os.environ.get("ZEROENTROPY_API_KEY")
ZE_COLLECTION = os.environ.get("ZE_COLLECTION", "thingiverse-popular")
CACHE_DIR = Path(os.environ.get("STL_CACHE_DIR", "/tmp/stl-cache"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)

MODELS_JSONL = Path(__file__).parent / "models.jsonl"
TAG_RE = re.compile(r"<[^>]+>")


def _load_descriptions() -> dict[str, str]:
    """thing_id -> plain-text description, loaded from models.jsonl."""
    out: dict[str, str] = {}
    if not MODELS_JSONL.exists():
        return out
    with MODELS_JSONL.open() as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            tid = str(rec.get("id", ""))
            if not tid:
                continue
            desc = TAG_RE.sub(" ", rec.get("description") or "").strip()
            details = TAG_RE.sub(" ", rec.get("details") or "").strip()
            out[tid] = (desc + ("\n\n" + details if details else "")).strip()
    return out


DESCRIPTIONS = _load_descriptions()

app = FastAPI(title="stl-search", version="0.2.0")


def _ze_top(query: str, k: int) -> list[dict]:
    if not ZE_KEY:
        raise HTTPException(500, "ZEROENTROPY_API_KEY not set on server")
    r = requests.post(
        f"{ZE_BASE}/queries/top-documents",
        headers={"Authorization": f"Bearer {ZE_KEY}", "Content-Type": "application/json"},
        json={
            "collection_name": ZE_COLLECTION,
            "query": query,
            "k": k,
            "include_metadata": True,
        },
        timeout=30,
    )
    if r.status_code >= 400:
        raise HTTPException(r.status_code, f"ZE error: {r.text[:300]}")
    return r.json().get("results") or []


def _download_stl(thing_id: str, url: str) -> Path | None:
    """Cache an STL locally. Returns path or None on failure."""
    if not thing_id or not url:
        return None
    dest = CACHE_DIR / f"{thing_id}.stl"
    if dest.exists() and dest.stat().st_size > 1024:
        return dest
    try:
        with requests.get(
            url,
            headers={"User-Agent": "Mozilla/5.0 (stl-search/0.1)"},
            stream=True,
            timeout=60,
            allow_redirects=True,
        ) as resp:
            if resp.status_code >= 400:
                return None
            with dest.open("wb") as fh:
                for chunk in resp.iter_content(chunk_size=64 * 1024):
                    if chunk:
                        fh.write(chunk)
        if dest.stat().st_size < 1024:
            # likely an HTML error page
            dest.unlink(missing_ok=True)
            return None
        return dest
    except requests.RequestException:
        return None


@app.get("/healthz")
def healthz() -> dict:
    return {"ok": True, "collection": ZE_COLLECTION, "cache_dir": str(CACHE_DIR)}


@app.get("/query")
def query(
    q: str = Query(..., description="natural-language model description"),
    k: int = Query(3, ge=1, le=10),
) -> dict:
    hits = _ze_top(q, k)
    out = []
    for hit in hits:
        meta = hit.get("metadata") or {}
        thing_id = str(meta.get("thing_id") or "")
        stl_url = meta.get("stl_url") or ""
        local = _download_stl(thing_id, stl_url)
        try:
            all_urls = json.loads(meta.get("all_stl_urls_json") or "[]")
        except json.JSONDecodeError:
            all_urls = []
        try:
            tags = json.loads(meta.get("tags_json") or "[]")
        except json.JSONDecodeError:
            tags = []
        out.append({
            "thing_id": thing_id,
            "name": meta.get("name") or "",
            "description": DESCRIPTIONS.get(thing_id, ""),
            "thing_url": meta.get("thing_url") or "",
            "tags": tags,
            "score": hit.get("score"),
            "stl_url": stl_url,
            "stl_path": str(local) if local else None,
            "all_stl_urls": all_urls,
            "download_ok": local is not None,
        })
    return {"query": q, "k": k, "results": out}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)
