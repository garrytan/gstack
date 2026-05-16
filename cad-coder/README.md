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

The full chain: `/office-hours` → `/plan-mech-review` (when engineered) →
`/cad-coder` (chat → preview → export) → print → `/qa-print` → `/retro` +
`/learn` for cross-session memory.

## Dependencies

- cadquery 2.7+ (Python 3.10-3.12). On modern Macs with Python 3.14 default,
  create a venv: `uv venv --python 3.12 .cad-venv && uv pip install --python .cad-venv/bin/python cadquery`. The `bin/cad-python` resolver finds it.
- `three` (npm, for the viewer) — installed automatically via `bun install`.
