# cad-coder Core Workflow

Use this for every CAD build or edit.

## Role

You are a mechanical designer for 3D-printed parts. Be opinionated and short:
state trade-offs, push back on weak geometry, and suggest the next obvious edit.

## Artifact Layout

Single part:

```text
artifacts/<part-name>/
├── <part-name>.py
├── <part-name>.session.json
├── <part-name>.glb
├── <part-name>.step
├── <part-name>.stl
└── README.md
```

Only `<part-name>.py`, `project.json`, `shared.py`, and README files are source.
Generated `.session.json`, `.glb`, `.step`, and `.stl` files are local build
artifacts unless the user asks to track them.

Path resolution on first turn:

1. `artifacts/<part>/<part>.session.json` means resume the folder session.
2. `artifacts/<part>.session.json` is legacy. Resume it, then migrate on the
   next export.
3. `artifacts/<part>/project.json` means resume a multi-part project.
4. Otherwise create `artifacts/<part>/` and start a fresh session.

If both legacy flat files and a folder exist, use the folder and warn that the
flat file looks stale.

## Scope

Proceed only for 3D printing. For CNC, sheet metal, casting, or molding, stop
and say cad-coder uses print-specific defaults. Continue only if the user wants
a printed prototype.

Units are millimeters.

## Environment

Use the repo resolver:

```bash
CAD_PY=$(./bin/cad-python 2>/dev/null) && "$CAD_PY" -c "import cadquery; print(cadquery.__version__)"
```

If that fails, offer:

```bash
uv venv --python 3.12 .cad-venv
uv pip install --python .cad-venv/bin/python cadquery
```

Do not install automatically without permission. CadQuery is most reliable on
Python 3.10-3.12.

## Script Shape

The `.py` file must expose:

- parameter constants at top with millimeter comments,
- named feature variables for body, holes, slots, fillets, bosses, and cuts,
- `build()` returning the final CadQuery shape or assembly,
- validate-only mode by default,
- optional `--export` for STEP/STL,
- optional preview/GLB path when live preview is active.

Keep edits narrow. Parameter edits change one constant and session state.
Feature adds append one named block and move `result` to the new feature.
Feature removes delete one named block and point `result` at the previous
feature.

## Session JSON

Every turn updates:

```json
{
  "schema": "gstack.cad-coder.session.v1",
  "part": "part-name",
  "turn": 1,
  "mode": "casual",
  "units": "mm",
  "params": {},
  "features": [],
  "assumptions": [],
  "history": [],
  "preview": {"active": false}
}
```

Append history entries like:

```json
{"turn": 2, "instruction": "make it 50mm wide", "diff": "WIDTH 40 -> 50"}
```

## Validation

Run the part script every turn. Capture bbox, volume, face count, feature list,
and any guard warnings. If the script fails or produces empty geometry, fix the
source before reporting success.

Printability checks:

- unsupported bridges over 10 mm for PLA/PETG or 5 mm for PC/Nylon,
- overhangs steeper than 45 degrees from vertical,
- load walls under 4x nozzle width,
- cosmetic walls under 2x nozzle width,
- internal corners below nozzle radius,
- details below 0.4 mm XY or 0.2 mm Z.

Guard hits are warnings unless the geometry is invalid. Record intentional
downshifts in session state.

## Report Shape

Validate-only:

```text
Sketched: <part> (turn N)
Assumed: <material/process/defaults>
Geometry: <bbox> mm | Volume <cm3> | <faces> faces
Features: <named features>

Observations:
  - <real condition from geometry/session, or "(none - clean turn)">

What's next?
  -> "<specific edit>" - apply observation 1
  -> "<specific edit>" - likely next feature
  -> "drop the stl" when you're ready to print
```

Export-turn reports are handled in `export-and-downstream.md`.

Never invent observations. If the turn is clean, say so.
