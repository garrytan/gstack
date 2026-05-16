"""FastAPI server: /query → top-K STL matches with HTTP download/render URLs.

Endpoints:
    GET /healthz                         — liveness
    GET /query?q=<text>&k=3              — top-K matches with download + render URLs
    GET /stl/{thing_id}.stl              — cached STL binary
    GET /render/{thing_id}/{view}.png    — lazy-rendered PNG (cached)

Run:
    uvicorn server:app --port 8000
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse

# render.py lives one dir up — make its render_stl() importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from render import VIEWS, render_stl  # noqa: E402

load_dotenv()

ZE_BASE = "https://api.zeroentropy.dev/v1"
ZE_KEY = os.environ.get("ZEROENTROPY_API_KEY")
ZE_COLLECTION = os.environ.get("ZE_COLLECTION", "thingiverse-popular")
CACHE_DIR = Path(os.environ.get("STL_CACHE_DIR", "/tmp/stl-cache"))
RENDER_DIR = Path(os.environ.get("STL_RENDER_DIR", "/tmp/stl-renders"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
RENDER_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_VIEWS = ("iso", "front", "top", "right")

app = FastAPI(title="stl-search", version="0.4.0")


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
        # Cloudflare in front of Thingiverse fingerprints UA + Accept-* +
        # Sec-Fetch-*. A bare browser UA still gets 403; the full browser-like
        # header set passes.
        browser_hdrs = {
            "User-Agent": (
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.5",
            "Accept-Encoding": "gzip, deflate, br",
            "Referer": "https://www.thingiverse.com/",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "same-origin",
            "Upgrade-Insecure-Requests": "1",
        }
        with requests.get(
            url,
            headers=browser_hdrs,
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
            dest.unlink(missing_ok=True)
            return None
        return dest
    except requests.RequestException:
        return None


def _render_view(thing_id: str, view: str) -> Path | None:
    """Lazy-render a single view PNG, cached on disk."""
    if view not in VIEWS:
        return None
    stl_path = CACHE_DIR / f"{thing_id}.stl"
    if not stl_path.exists():
        return None
    out_dir = RENDER_DIR / thing_id
    out_path = out_dir / f"{thing_id}_{view}.png"
    if out_path.exists() and out_path.stat().st_size > 0:
        return out_path
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        render_stl(stl_path, out_dir, views=[view])
    except Exception:
        return None
    return out_path if out_path.exists() else None


def _result_urls(request: Request, thing_id: str) -> tuple[str, dict[str, str]]:
    """Build absolute URLs for the cached STL and each default render view."""
    base = str(request.base_url).rstrip("/")
    stl_url = f"{base}/stl/{thing_id}.stl"
    render_urls = {v: f"{base}/render/{thing_id}/{v}.png" for v in DEFAULT_VIEWS}
    return stl_url, render_urls


@app.get("/healthz")
def healthz() -> dict:
    return {
        "ok": True,
        "collection": ZE_COLLECTION,
        "cache_dir": str(CACHE_DIR),
        "render_dir": str(RENDER_DIR),
    }


@app.get("/query")
def query(
    request: Request,
    q: str = Query(..., description="natural-language model description"),
    k: int = Query(3, ge=1, le=10),
) -> dict:
    hits = _ze_top(q, k)
    out = []
    for hit in hits:
        meta = hit.get("metadata") or {}
        thing_id = str(meta.get("thing_id") or "")
        thingiverse_stl_url = meta.get("stl_url") or ""
        local = _download_stl(thing_id, thingiverse_stl_url)
        try:
            all_urls = json.loads(meta.get("all_stl_urls_json") or "[]")
        except json.JSONDecodeError:
            all_urls = []
        try:
            tags = json.loads(meta.get("tags_json") or "[]")
        except json.JSONDecodeError:
            tags = []
        stl_local_url, render_urls = _result_urls(request, thing_id) if local else ("", {})
        out.append({
            "thing_id": thing_id,
            "name": meta.get("name") or "",
            "description": meta.get("description") or "",
            "thing_url": meta.get("thing_url") or "",
            "tags": tags,
            "score": hit.get("score"),
            "download_ok": local is not None,
            # HTTP URLs served by this server — downstream clients use these.
            "stl_url": stl_local_url,
            "render_urls": render_urls,
            # Original Thingiverse references, for citation.
            "thingiverse_stl_url": thingiverse_stl_url,
            "all_stl_urls": all_urls,
            # Local filesystem path (same-machine clients only).
            "stl_path": str(local) if local else None,
        })
    return {"query": q, "k": k, "results": out}


@app.get("/stl/{filename}")
def get_stl(filename: str):
    # Strip .stl suffix if present, then resolve safely against CACHE_DIR.
    stem = filename[:-4] if filename.endswith(".stl") else filename
    if "/" in stem or ".." in stem or not stem:
        raise HTTPException(400, "invalid filename")
    path = CACHE_DIR / f"{stem}.stl"
    if not path.exists():
        raise HTTPException(404, f"STL not cached for thing_id={stem}")
    return FileResponse(path, media_type="model/stl", filename=path.name)


@app.get("/render/{thing_id}/{view_file}")
def get_render(thing_id: str, view_file: str):
    if "/" in thing_id or ".." in thing_id or "/" in view_file or ".." in view_file:
        raise HTTPException(400, "invalid path")
    view = view_file[:-4] if view_file.endswith(".png") else view_file
    if view not in VIEWS:
        raise HTTPException(400, f"unknown view {view!r}; choose from {list(VIEWS)}")
    path = _render_view(thing_id, view)
    if not path:
        raise HTTPException(404, "STL not cached or render failed")
    return FileResponse(path, media_type="image/png", filename=path.name)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("server:app", host="127.0.0.1", port=8000, reload=False)
