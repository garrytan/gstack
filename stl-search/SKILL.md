---
name: stl-search
version: 0.2.0
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
      "stl_url": "https://www.thingiverse.com/download:67890",
      "stl_path": "/tmp/stl-cache/12345.stl",
      "all_stl_urls": ["..."],
      "download_ok": true
    },
    ...
  ]
}
```

The server downloads each STL to `stl_path` on first query and caches it.
If `download_ok` is `false` for the top hit, fall back to the next result
whose `download_ok` is `true`. If none have a usable file, surface that to
the user.

If `results` is empty, tell the user no match was found and stop.

### 2. Render multi-angle previews of the top match

Pick the highest-scoring result with `download_ok: true`. Call its
`stl_path` the chosen STL.

```bash
python cad-coder/render.py "<stl_path>" --out /tmp/stl-search/renders --views iso front top right
```

If `render.py` errors because there's no OpenGL context (headless), retry:

```bash
PYOPENGL_PLATFORM=egl python cad-coder/render.py "<stl_path>" --out /tmp/stl-search/renders
PYOPENGL_PLATFORM=osmesa python cad-coder/render.py "<stl_path>" --out /tmp/stl-search/renders
```

The output filenames are `{stem}_{view}.png` where `{stem}` is the STL's
basename without extension (e.g. `12345_iso.png` for `/tmp/stl-cache/12345.stl`).

### 3. Read the rendered images yourself

**Load-bearing step.** Use the Read tool on each PNG. Reading the renders is
how you actually understand the model's geometry — Thingiverse names and
tags are often vague, and the embedding can pick a thing that *sounds* right
but doesn't *look* right.

```
Read /tmp/stl-search/renders/<stem>_iso.png
Read /tmp/stl-search/renders/<stem>_front.png
Read /tmp/stl-search/renders/<stem>_top.png
Read /tmp/stl-search/renders/<stem>_right.png
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
4. **The files** — local STL path (`stl_path`) and renders directory.

Don't loop through all 3 candidates unprompted. One render pass per
invocation unless the user asks for more.

## Notes and edge cases

- **API not running.** If `curl http://127.0.0.1:8000/healthz` returns a
  connection error, tell the user to run
  `cd cad-coder/zeroentropy && uvicorn server:app --port 8000` and stop.
- **Multi-part things.** `stl_path` is just the first STL in the thing.
  Other parts live at the URLs in `all_stl_urls`. If renders look like a
  small detached piece rather than the thing the user asked for, mention
  this and offer to download a different file.
- **Re-runs.** `/tmp/stl-search/renders/` is overwritten on each run, but
  `/tmp/stl-cache/` persists (keyed by `thing_id`).
- **Empty/blank renders.** Mesh might be degenerate. Inspect with
  `python -c "import trimesh; m=trimesh.load('<path>'); print(m.bounds, m.extents)"`.

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `curl` returns connection refused | Server not running | `cd cad-coder/zeroentropy && uvicorn server:app --port 8000` |
| API returns `{"results": []}` | Corpus not indexed | Run `python cad-coder/zeroentropy/scrape.py && python cad-coder/zeroentropy/index.py` |
| All results have `download_ok: false` | Thingiverse rate-limited the cache | Wait a minute and re-query, or retry with a different query |
| `render.py` crashes with OpenGL/GLFW error | Headless machine, no display | Set `PYOPENGL_PLATFORM=egl` or `osmesa` |
| Renders are blank/black | Degenerate mesh | Inspect bounds/extents; report to user |
