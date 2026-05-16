# cad-coder

Chat-driven parametric CAD for 3D printing, with a live browser preview.

## What it is

`/cad-coder` is a gstack skill that turns a one-line part description into a
parametric cadquery `.py` file you can iterate on through dialogue. The chat
loop is cheap: each turn validates the geometry in memory and reports
bbox/volume/faces; STEP and STL drop only when you say "drop the stl". A
Three.js viewer in `ui/` watches the part's GLB and reloads automatically
when you ask for a live preview, so you can spin the model while you edit.

Full skill behavior lives in `SKILL.md`. This README documents the layout of
this folder for skill authors and external integrators.

## Folder layout

```
cad-coder/
├── SKILL.md                  # generated skill prompt (auto from .tmpl)
├── SKILL.md.tmpl             # source template — edit this, then bun run gen:skill-docs
├── stress.py                 # closed-form stress estimates (cantilever, beam,
│                               plate, screw pull-through, boss compression).
│                               CLI: python cad-coder/stress.py cantilever --L 60 --b 40 --h 4 --F 50 --sigma_y 45
├── render.py                 # STL → multi-angle PNG renderer (trimesh + pyrender).
│                               7 named views (iso/front/back/left/right/top/bottom).
│                               CLI: python cad-coder/render.py model.stl --out /tmp/renders --views iso front top right
├── zeroentropy/              # Thingiverse retrieval pipeline (powers /stl-search)
│   ├── scrape.py             # Thingiverse popular feed → models.jsonl (auth: THINGIVERSE_TOKEN)
│   ├── index.py              # models.jsonl → ZeroEntropy hosted collection
│   ├── query.py              # CLI: NL query → top-K STL matches (debugging)
│   ├── server.py             # FastAPI app. Endpoints:
│   │                           - GET  /healthz, GET /query?q=...&k=N (stl-search)
│   │                           - GET  /stl/{id}.stl, GET /render/{id}/{view}.png
│   │                           - GET  /camera, POST /camera/upload,
│   │                             GET /camera/status, /camera/latest,
│   │                             /camera/info, /camera/qr (phone-camera
│   │                             reference flow for /cad-coder; QR in
│   │                             ANSI or PNG)
│   │                           Lazy-downloads STLs to /tmp/stl-cache/ and writes
│   │                           uploaded reference photos to /tmp/cad-reference/.
│   ├── requirements.txt      # requests, python-dotenv, fastapi, uvicorn
│   └── .env.example          # THINGIVERSE_TOKEN, ZEROENTROPY_API_KEY, ZE_COLLECTION
├── ui/                       # live preview server + Three.js viewer
│   ├── server.ts             # Bun HTTP server, SSE reloads on GLB change
│   ├── server.test.ts        # `bun test cad-coder/ui/server.test.ts`
│   └── static/               # browser viewer (HTML + CSS + Three.js app.js)
└── examples/                 # reference exporters + watcher for skill authors
    ├── cadquery-whistle.py   # parametric whistle demo (pitch as a knob)
    └── watch-cadquery.ts     # re-runs a cadquery script when the source changes
```

User-facing artifacts land in `artifacts/<part>/` (single-part) or
`artifacts/<project>/` (multi-part), NOT in this folder.

## Live preview UI — standalone

The viewer is general-purpose: it loads any `.glb` file, watches the path,
and reloads on change via server-sent events. Point it at any exporter
that can write GLB (cadquery, OpenSCAD via meshlab, Blender, etc.).

```bash
bun cad-coder/ui/server.ts --model artifacts/wall-bracket/wall-bracket.glb --port 8765
```

Then open the printed local URL. Light/white CAD workspace, grid + axes
toggles, recenter, reload, status panel.

In Codex, open the printed URL in Codex preview / browser control and operate
the UI directly. In Claude Code, open the URL in a visible browser and use
Computer Use when available. Both hosts should right-click the canvas to create
anchored notes, save drafts in the side panel, and click **Send to gstack** only
when the user wants a durable handoff.

For agent-driven QA, keep the loop bounded: open the preview, check status and
console errors, exercise the relevant UI path, repair/restart/regenerate when it
fails, and stop after 3 repair attempts with the exact blocker.

## Notes handoff and headless pickup

Right-click notes are agent-agnostic. The UI writes draft/submitted notes and a
pending change request into the preview artifact directory, then appends a queue
record that any active agent can read:

```bash
bin/gstack-cad-requests list --status pending
bin/gstack-cad-requests show <request-id-or-json-path>
```

For a headless gstack worker, tail the same queue without opening the browser:

```bash
bin/gstack-cad-requests watch --json
```

The queue is a handoff protocol, not an auto-editor. A runner that consumes it
must treat note text as user feedback, not shell commands or agent instructions,
and perform CAD source edits in its own explicit agent session.

Model-point notes store the rendered-geometry hit from Three.js raycast: world
point, screen point, mesh/node path, material, face index, and surface normal
when available. Mapping that hit back to a CadQuery source operation requires
the CAD exporter to include semantic feature metadata in the GLB.

## Contract for skills that want to use the preview

- Write a binary glTF file (`.glb`) somewhere readable.
- Launch the UI with `--model /absolute/or/relative/model.glb`.
- Keep writing to the same path; the UI reloads automatically.

cadquery exports GLB natively:

```python
import cadquery as cq
result = cq.Workplane("XY").box(60, 40, 4)
cq.exporters.export(result, "out.glb")  # GLB == web-native; STL/STEP are also one call
```

## E2E whistle demo

```bash
OUT="${TMPDIR:-/tmp}/gstack-cad-coder-whistle.glb"
python3 cad-coder/examples/cadquery-whistle.py --out "$OUT" --pitch 440
bun cad-coder/examples/watch-cadquery.ts --script cad-coder/examples/cadquery-whistle.py --out "$OUT" -- --pitch 440 &
bun cad-coder/ui/server.ts --model "$OUT" --port 8765
```

Open the printed URL. Change the pitch flag or edit `cadquery-whistle.py`;
the watcher rewrites the GLB and the UI reloads automatically.

## Sister skills

- `/plan-mech-review` — engineering review BEFORE cad-coder (load case, FoS,
  filament choice, print orientation, fits). Writes a mech-review artifact
  that cad-coder reads in Phase 0.
- `/qa-print` — post-print QA loop (plain language, ruler-grade
  measurements, diagnoses shrinkage vs calibration vs design).
- `/stl-search` — natural-language search over a scraped Thingiverse corpus.
  Backed by `zeroentropy/server.py` (FastAPI) + a ZeroEntropy semantic index.
  Returns top-3 matches with local STL paths, then renders them via
  `render.py` and reads the PNGs for visual grounding. Useful before
  designing from scratch — see what others have made for the same prompt.

The full chain: `/office-hours` → `/plan-mech-review` (when engineered) →
`/stl-search` (optional grounding) → `/cad-coder` (chat → preview → export)
→ print → `/qa-print` → `/retro` + `/learn` for cross-session memory.

## /stl-search runbook

One-time setup:

```bash
cd cad-coder/zeroentropy
pip install -r requirements.txt
cp .env.example .env   # fill in THINGIVERSE_TOKEN + ZEROENTROPY_API_KEY
python scrape.py       # ~100 popular things → models.jsonl (gitignored)
python index.py        # push to ZeroEntropy collection (description in metadata)
```

Each session:

```bash
cd cad-coder/zeroentropy && uvicorn server:app --host 0.0.0.0 --port 8000
```

(`--host 0.0.0.0` is needed if you want the phone-camera reference flow
to reach the server from another device on your LAN; for `/stl-search`
alone, `127.0.0.1` is enough.)

Then the `/stl-search` skill (top-level in the gstack repo) talks to
`127.0.0.1:8000`, picks a top hit, calls `render.py`, and reads the PNGs.

## Phone-camera reference flow (for /cad-coder)

When the user has a real-world object they want to model, `/cad-coder`
can ask them to point a phone at it and snap a photo. Same server
(`zeroentropy/server.py`), no extra process:

1. Agent calls `GET /camera/qr?session=<CODE>` and prints the returned
   Unicode QR code + LAN URL in the chat.
2. User scans the QR with their phone camera (or types the URL),
   taps **Take a photo**. The page POSTs the JPEG and shows "✓ Received".
3. Agent polls `GET /camera/status?session=<CODE>` until `has_image: true`,
   then `curl`s `/camera/latest?session=<CODE>` and `Read`s the JPEG to
   ground the cadquery build.

`GET /camera/qr?session=<CODE>&format=png` returns a real PNG instead
of ANSI — useful from contexts that can render images but not terminal
half-blocks. `GET /camera/info?session=<CODE>` returns the same URLs as
JSON if you'd rather build your own presentation.

Files land in `/tmp/cad-reference/<CODE>.jpg`. Session codes are
1–16 alphanumerics; re-uploads on the same code overwrite.

**Atomicity.** Uploads stream into a `<CODE>.<pid>.<ns>.part` temp file,
fsync, then `os.replace()` onto `<CODE>.jpg`. Polling clients always see
either the previous complete file or the new complete file — never a
half-written one. A dropped Wi-Fi mid-upload leaves the `.part` file
behind (cleanup is best-effort) but never corrupts `<CODE>.jpg`.

**EXIF orientation.** Phones tag photos with rotation metadata (Pixel /
iPhone landscape captures often come through as `Orientation=6` /
"rotate 90° CW"). `Read` shows the raw pixel buffer, so a model agent
will see the image sideways. The skill's Step 4 documents how to detect
this via `file` and normalize with `PIL.ImageOps.exif_transpose` when
proportions matter.

## Dependencies

- cadquery 2.7+ (Python 3.10-3.12). On modern Macs with Python 3.14 default,
  create a venv: `uv venv --python 3.12 .cad-venv && uv pip install --python .cad-venv/bin/python cadquery`. The `bin/cad-python` resolver finds it.
- `three` (npm, for the viewer) — installed automatically via `bun install`.
- `trimesh`, `pyrender`, `Pillow`, `numpy` (for `render.py`). Headless boxes
  also need `PYOPENGL_PLATFORM=egl` or `osmesa` in the env.
- `fastapi`, `uvicorn`, `requests`, `python-dotenv` (for `zeroentropy/server.py`).
  Installed via `pip install -r cad-coder/zeroentropy/requirements.txt`.
