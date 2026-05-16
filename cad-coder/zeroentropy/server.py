"""FastAPI server: /query → top-K STL matches with HTTP download/render URLs.

Endpoints:
    GET  /healthz                         — liveness
    GET  /query?q=<text>&k=3              — top-K matches with download + render URLs
    GET  /stl/{thing_id}.stl              — cached STL binary
    GET  /render/{thing_id}/{view}.png    — lazy-rendered PNG (cached)
    GET  /camera                          — mobile-friendly page: snap + upload a photo
    POST /camera/upload?session=ABCD      — receive JPEG from phone (multipart 'file')
    GET  /camera/status?session=ABCD      — {has_image, received_at, size_bytes}
    GET  /camera/latest?session=ABCD      — last uploaded JPEG bytes
    GET  /camera/qr?session=ABCD          — QR code (format=ansi|png) for the phone URL

Run:
    uvicorn server:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import json
import os
import socket
import struct
import subprocess
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from fastapi import FastAPI, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, PlainTextResponse, Response

# render.py lives one dir up — make its render_stl() importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from render import VIEWS  # noqa: E402

load_dotenv()

RENDER_SCRIPT = Path(__file__).resolve().parent.parent / "render.py"
ZE_BASE = "https://api.zeroentropy.dev/v1"
ZE_KEY = os.environ.get("ZEROENTROPY_API_KEY")
ZE_COLLECTION = os.environ.get("ZE_COLLECTION", "thingiverse-popular")
CACHE_DIR = Path(os.environ.get("STL_CACHE_DIR", "/tmp/stl-cache"))
RENDER_DIR = Path(os.environ.get("STL_RENDER_DIR", "/tmp/stl-renders"))
CAMERA_DIR = Path(os.environ.get("CAD_CAMERA_DIR", "/tmp/cad-reference"))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
RENDER_DIR.mkdir(parents=True, exist_ok=True)
CAMERA_DIR.mkdir(parents=True, exist_ok=True)

DEFAULT_VIEWS = ("iso", "front", "top", "right")
MAX_UPLOAD_BYTES = 15 * 1024 * 1024  # 15 MB — phone JPEGs are typically 1–5 MB

app = FastAPI(title="stl-search", version="0.6.0")

# In-memory session table: { code -> {"path": Path, "received_at": float, "size": int} }
_camera_sessions: dict[str, dict] = {}


def _safe_session(code: str) -> str:
    """Session codes are 1–16 chars, alphanumerics only (used in filenames + URLs)."""
    code = (code or "").strip()
    if not code or len(code) > 16 or not code.isalnum():
        raise HTTPException(400, "invalid session code (use 1–16 alphanumerics)")
    return code.upper()


def _lan_ip() -> str:
    """Best-effort: the IP the phone should connect to. Falls back to 127.0.0.1."""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


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


def _looks_like_stl(path: Path) -> bool:
    """Cheap validation so cached HTML/errors do not masquerade as STL files."""
    try:
        size = path.stat().st_size
        if size < 84:
            return False
        with path.open("rb") as fh:
            header = fh.read(512)
        if len(header) < 84:
            return False

        tri_count = struct.unpack("<I", header[80:84])[0]
        if tri_count > 0 and 84 + tri_count * 50 == size:
            return True

        stripped = header.lstrip().lower()
        return stripped.startswith(b"solid") and (
            b"facet normal" in stripped or b"endsolid" in stripped
        )
    except OSError:
        return False


def _download_stl(thing_id: str, url: str) -> Path | None:
    """Cache an STL locally. Returns path or None on failure."""
    if not thing_id or not url:
        return None
    dest = CACHE_DIR / f"{thing_id}.stl"
    if dest.exists() and _looks_like_stl(dest):
        return dest
    dest.unlink(missing_ok=True)
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
        if not _looks_like_stl(dest):
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
    result = subprocess.run(
        [
            sys.executable,
            str(RENDER_SCRIPT),
            str(stl_path),
            "--out",
            str(out_dir),
            "--views",
            view,
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=90,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    if result.returncode != 0:
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


# ─── Camera reference flow ────────────────────────────────────────────────
# Lets the user point a phone browser at this server, snap a photo of the
# real-world object they want to model, and POST it as the agent's grounding
# reference. No WebSocket — phone POSTs once, agent polls /camera/status.

_CAMERA_PAGE = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
  <title>cad-coder camera</title>
  <style>
    :root { color-scheme: light; }
    body { font: 16px/1.4 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
           margin: 0; padding: 24px; background: #f7f7f8; color: #111; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .session { font: 700 28px/1 ui-monospace, Menlo, monospace;
               letter-spacing: 4px; color: #0a7; margin: 8px 0 20px; }
    label.btn { display: block; padding: 18px; background: #111; color: #fff;
                text-align: center; border-radius: 12px; font-weight: 600;
                cursor: pointer; }
    label.btn input { display: none; }
    #status { margin-top: 20px; padding: 16px; border-radius: 12px;
              background: #fff; border: 1px solid #ddd; min-height: 48px; }
    #status.ok    { background: #e6fbef; border-color: #0a7; color: #064; }
    #status.err   { background: #fdecec; border-color: #c33; color: #802; }
    #preview { display: block; max-width: 100%; margin-top: 16px; border-radius: 8px; }
    .meta { color: #666; font-size: 13px; margin-top: 4px; }
  </style>
</head>
<body>
  <h1>cad-coder reference photo</h1>
  <div class="meta">Session</div>
  <div class="session" id="session">—</div>

  <label class="btn">
    Take a photo
    <input id="file" type="file" accept="image/*" capture="environment">
  </label>

  <div id="status">Take a photo of the object. It uploads automatically.</div>
  <img id="preview" alt="">

  <script>
    const params = new URLSearchParams(location.search);
    const session = (params.get('session') || 'DEFAULT').toUpperCase();
    document.getElementById('session').textContent = session;

    const file = document.getElementById('file');
    const status = document.getElementById('status');
    const preview = document.getElementById('preview');

    file.addEventListener('change', async () => {
      if (!file.files || !file.files[0]) return;
      const f = file.files[0];
      preview.src = URL.createObjectURL(f);
      status.className = '';
      status.textContent = 'Uploading ' + (f.size / 1024).toFixed(0) + ' KB…';
      const fd = new FormData();
      fd.append('file', f, f.name || 'photo.jpg');
      try {
        const r = await fetch('/camera/upload?session=' + encodeURIComponent(session), {
          method: 'POST', body: fd
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        status.className = 'ok';
        status.textContent = '✓ Received (' + (j.size_bytes / 1024).toFixed(0) +
                             ' KB). You can close this page.';
      } catch (e) {
        status.className = 'err';
        status.textContent = '✗ Upload failed: ' + e.message;
      }
    });
  </script>
</body>
</html>
"""


@app.get("/camera", response_class=HTMLResponse)
def camera_page() -> HTMLResponse:
    return HTMLResponse(_CAMERA_PAGE)


@app.post("/camera/upload")
async def camera_upload(
    session: str = Query("DEFAULT"),
    file: UploadFile = File(...),
) -> JSONResponse:
    code = _safe_session(session)
    dest = CAMERA_DIR / f"{code}.jpg"
    # Stream to a temp file then atomic-rename. This way a partial upload
    # (phone Wi-Fi blip, user re-tapping the picker mid-transfer) never
    # leaves a half-written file at `dest`, and session state only
    # updates after a complete write.
    tmp = CAMERA_DIR / f"{code}.{os.getpid()}.{time.time_ns()}.part"
    total = 0
    try:
        with tmp.open("wb") as fh:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_UPLOAD_BYTES:
                    raise HTTPException(413, f"upload too large (>{MAX_UPLOAD_BYTES} bytes)")
                fh.write(chunk)
            fh.flush()
            os.fsync(fh.fileno())
        if total == 0:
            raise HTTPException(400, "empty upload")
        os.replace(tmp, dest)  # atomic on POSIX
    except HTTPException:
        tmp.unlink(missing_ok=True)
        raise
    except Exception as e:
        tmp.unlink(missing_ok=True)
        raise HTTPException(500, f"upload write failed: {e}") from e
    _camera_sessions[code] = {
        "path": dest,
        "received_at": time.time(),
        "size": total,
        "content_type": file.content_type or "image/jpeg",
    }
    return JSONResponse({"ok": True, "session": code, "size_bytes": total})


@app.get("/camera/status")
def camera_status(session: str = Query("DEFAULT")) -> dict:
    code = _safe_session(session)
    entry = _camera_sessions.get(code)
    # If the server restarted, in-memory state is gone but the file may still be there.
    if entry is None:
        path = CAMERA_DIR / f"{code}.jpg"
        if path.exists():
            st = path.stat()
            return {
                "has_image": True,
                "session": code,
                "received_at": st.st_mtime,
                "size_bytes": st.st_size,
                "image_url": f"/camera/latest?session={code}",
            }
        return {"has_image": False, "session": code}
    return {
        "has_image": True,
        "session": code,
        "received_at": entry["received_at"],
        "size_bytes": entry["size"],
        "image_url": f"/camera/latest?session={code}",
    }


@app.get("/camera/latest")
def camera_latest(session: str = Query("DEFAULT")):
    code = _safe_session(session)
    path = CAMERA_DIR / f"{code}.jpg"
    if not path.exists():
        raise HTTPException(404, f"no image for session {code}")
    return FileResponse(path, media_type="image/jpeg", filename=f"{code}.jpg")


@app.get("/camera/qr")
def camera_qr(
    request: Request,
    session: str = Query("DEFAULT"),
    format: str = Query("ansi", pattern="^(ansi|png)$"),
):
    """QR code for the phone URL. format=ansi (terminal) or png (image)."""
    code = _safe_session(session)
    ip = _lan_ip()
    port = request.url.port or 8000
    phone_url = f"http://{ip}:{port}/camera?session={code}"
    import qrcode  # local import — keeps cold-start fast for stl-search-only users
    qr = qrcode.QRCode(border=1, box_size=8)
    qr.add_data(phone_url)
    qr.make(fit=True)
    if format == "png":
        import io
        img = qr.make_image(fill_color="black", back_color="white")
        buf = io.BytesIO()
        img.save(buf, "PNG")
        return Response(content=buf.getvalue(), media_type="image/png")
    import io as _io
    buf = _io.StringIO()
    qr.print_ascii(out=buf, invert=True)  # invert=True → scannable on dark terminals
    return PlainTextResponse(
        f"Scan from your phone:\n{buf.getvalue()}\n{phone_url}\n",
        media_type="text/plain; charset=utf-8",
    )


@app.get("/camera/info")
def camera_info(request: Request, session: str = Query("DEFAULT")) -> dict:
    code = _safe_session(session)
    ip = _lan_ip()
    port = request.url.port or 8000
    return {
        "session": code,
        "lan_ip": ip,
        "phone_url": f"http://{ip}:{port}/camera?session={code}",
        "status_url": f"http://{ip}:{port}/camera/status?session={code}",
        "image_url":  f"http://{ip}:{port}/camera/latest?session={code}",
    }


if __name__ == "__main__":
    import uvicorn
    # bind 0.0.0.0 so phones on the same LAN can reach /camera
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
