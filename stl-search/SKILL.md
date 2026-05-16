---
name: stl-search
version: 0.3.0
description: |
  Find a Thingiverse STL file matching a natural-language description via the
  local stl-search HTTP API, render multi-angle previews, and visually inspect
  the renders before reporting to the user. Backed by a self-hosted FastAPI
  server (cad-coder/zeroentropy/server.py) that wraps a ZeroEntropy semantic
  index of scraped Thingiverse models and serves STL files from a local cache.
  Use when asked to "find an STL of X", "search for a 3D model of X", "show me
  a Thingiverse model that looks like X", "fetch and preview an STL by
  description". Use even when asked to design any CAD model, because this
  gives you extra context and grounding on what others have made. (gstack)
triggers:
  - find an STL of
  - search thingiverse for
  - find a 3D model of
  - show me a model that looks like
  - fetch and preview an STL
  - build a CAD model of
allowed-tools:
  - Bash
  - Read
  - AskUserQuestion
---
<!-- AUTO-GENERATED from SKILL.md.tmpl — do not edit directly -->
<!-- Regenerate: bun run gen:skill-docs -->

# /stl-search — Search Thingiverse by description and visually verify

Given a natural-language description of a 3D model, hit the local stl-search
API to get the top 3 candidate STL files (already downloaded to a local
cache), render preview images from multiple angles, and **read those images
yourself** so you actually understand the geometry before reporting back.

All paths in this skill are relative to the **gstack repo root** (the
directory containing `cad-coder/`). If your cwd is elsewhere, `cd` there
first.

The pipeline lives in `cad-coder/`:

- `cad-coder/zeroentropy/server.py` — FastAPI server exposing `GET /query`,
  backed by ZeroEntropy + a local STL cache
- `cad-coder/render.py` — STL → multi-angle PNG renderer

The API is expected to be running at `http://127.0.0.1:8000`.

### Precondition: API must be up

Always check first:

```bash
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/healthz
```

If this is anything other than `200`, tell the user to start the server and
stop. Do **not** fabricate results.

```bash
cd cad-coder/zeroentropy && uvicorn server:app --port 8000
```

## When to use

Invoke when the user wants to **find and see** an STL by description:

- "find me an STL of a low-poly fox"
- "is there a Thingiverse model for a phone stand that holds a tablet?"
- "show me what the best match for 'articulated dragon' looks like"

Also invoke for "design a CAD model of X" prompts — use the top match as
grounding for what similar things look like before you propose your own.

## Steps

### 1. Query the API

Use `curl -G --data-urlencode` so spaces, punctuation, and quotes in the
query are encoded safely:

```bash
curl -sS -G http://127.0.0.1:8000/query \
  --data-urlencode "q=<the user's description>" \
  --data-urlencode "k=3" \
  > /tmp/stl-search.json
```

Read `/tmp/stl-search.json`. It looks like:

```json
{
  "query": "...",
  "k": 3,
  "results": [
    {
      "thing_id": "12345",
      "name": "Low-poly fox",
      "description": "A simple low-poly fox figurine designed for FDM printing without supports...",
      "thing_url": "https://www.thingiverse.com/thing:12345",
      "tags": ["fox", "animal"],
      "score": 0.81,
      "download_ok": true,
      "stl_url":     "http://127.0.0.1:8000/stl/12345.stl",
      "render_urls": {
        "iso":   "http://127.0.0.1:8000/render/12345/iso.png",
        "front": "http://127.0.0.1:8000/render/12345/front.png",
        "top":   "http://127.0.0.1:8000/render/12345/top.png",
        "right": "http://127.0.0.1:8000/render/12345/right.png"
      },
      "stl_path": "/tmp/stl-cache/12345.stl",
      "thingiverse_stl_url": "https://www.thingiverse.com/download:67890",
      "all_stl_urls": ["..."]
    },
    ...
  ]
}
```

The server downloads each STL to its cache on first query. `stl_url` and
`render_urls` are HTTP URLs served by this server — use these (not the
filesystem paths) so the flow works from any client. `stl_path` is also
returned for same-machine convenience.

If `download_ok` is `false` for the top hit, fall back to the next result
whose `download_ok` is `true`. If none have a usable file, surface that to
the user. If `results` is empty, tell the user no match was found and stop.

### 2. Download the render PNGs

Pick the highest-scoring result with `download_ok: true`. Pull each of its
four render URLs to local files. Rendering happens lazily on the server on
first hit (~5-15s for the first view, instant after that — the server
caches PNGs).

```bash
mkdir -p /tmp/stl-search/renders
TID="<thing_id from top result>"
for VIEW in iso front top right; do
  curl -sS -o "/tmp/stl-search/renders/${TID}_${VIEW}.png" \
    "http://127.0.0.1:8000/render/${TID}/${VIEW}.png"
done
ls -lh /tmp/stl-search/renders/
```

Each PNG should be more than a few KB. If `curl` returns a JSON error body
instead, the server failed to render — surface that to the user.

### 3. Read the rendered images yourself

**Load-bearing step.** Use the Read tool on each PNG. Reading the renders is
how you actually understand the model's geometry — Thingiverse names and
tags are often vague, and the embedding can pick a thing that *sounds* right
but doesn't *look* right.

```
Read /tmp/stl-search/renders/<thing_id>_iso.png
Read /tmp/stl-search/renders/<thing_id>_front.png
Read /tmp/stl-search/renders/<thing_id>_top.png
Read /tmp/stl-search/renders/<thing_id>_right.png
```

For each view, note the shape, proportions, whether it's one piece or many,
and any notable features (articulation, hollow vs solid, supports baked in).

### 4. Report back

Tell the user, in this order:

1. **What you found** — model name + Thingiverse URL.
2. **What it actually looks like** — 2-4 sentences grounded in the rendered
   images, not the Thingiverse blurb.
3. **Whether it matches** — direct verdict on fit. If the geometry doesn't
   match the user's request, say so plainly and mention the next 1-2
   candidates from `/tmp/stl-search.json`; offer to render one of them.
4. **The files** — STL download URL (`stl_url`) and renders directory.

Don't loop through all 3 candidates unprompted. One render pass per
invocation unless the user asks for more.

## Adjacent: phone-camera reference flow

The same `cad-coder/zeroentropy/server.py` that powers this skill also
hosts a phone-camera upload page (`GET /camera`) for `/cad-coder`. If
the user has a real-world reference object they want to model, point
them to `/cad-coder` — its Phase 0 covers the camera flow. From this
skill, only mention it if the user is clearly trying to *design* rather
than *search*.

## Notes and edge cases

- **API not running.** If `curl http://127.0.0.1:8000/healthz` returns a
  connection error, tell the user to run
  `cd cad-coder/zeroentropy && uvicorn server:app --port 8000` and stop.
- **Multi-part things.** `stl_url` serves only the first STL in the thing.
  Other parts live at the Thingiverse URLs in `all_stl_urls`. If renders
  look like a small detached piece rather than the thing the user asked
  for, mention this and offer to download a different file directly from
  Thingiverse.
- **Re-runs.** `/tmp/stl-search/renders/` is overwritten on each run, but
  server-side caches (`/tmp/stl-cache/`, `/tmp/stl-renders/`) persist
  (keyed by `thing_id`).
- **First-view latency.** The server renders lazily. The first PNG GET for
  a given STL takes ~5-15s; subsequent views are nearly instant because
  pyrender reuses cached mesh state and the resulting PNGs are on disk.
- **Empty/blank renders.** Mesh might be degenerate.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `curl` returns connection refused | Server not running | `cd cad-coder/zeroentropy && uvicorn server:app --port 8000` |
| API returns `{"results": []}` | Corpus not indexed | Run `python cad-coder/zeroentropy/scrape.py && python cad-coder/zeroentropy/index.py` |
| All results have `download_ok: false` | Thingiverse rate-limited the cache | Wait a minute and re-query, or retry with a different query |
| `/render/...` returns 404 | STL never downloaded or render failed | Re-query first, then retry the render URL |
| `/render/...` hangs on first hit | Lazy render in progress | Wait up to ~30s; subsequent views are instant |
| Renders are blank/black | Degenerate mesh | Try the next-ranked candidate |
