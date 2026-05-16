# Multi-Part and Engineered CAD

Load this when the request mentions assemblies, multiple parts, load, force,
torque, vibration, tight fits, safety, regulated use, engineering filaments,
non-FDM print processes, or quantity greater than 10.

## Engineered Mode Triggers

Use engineered mode if any signal appears:

- load, force, torque, weight, vibration,
- press-fit, slip-fit, locating fit, interference fit,
- SLA/MSLA, SLS, MJF, nylon, PC, PEEK, PEI, Ultem, carbon-fiber PA,
- safety, medical-adjacent, load-rated, production-grade,
- quantity greater than 10.

Ask one requirements round before sketching:

- load case and direction,
- mating parts and tolerances,
- process/material/nozzle/layer height,
- safety factor target,
- quantity and expected use.

Then sketch immediately.

## Engineered Session Fields

Add:

```json
{
  "mode": "engineered",
  "requirements": {},
  "engineered_constraints": {
    "wall_min_mm": null,
    "fillet_min_mm": null,
    "fit_class": null,
    "print_z_axis": null,
    "fos_spec": null
  }
}
```

## Parameter Guard

Before applying engineered parameter edits, check:

- wall stays above computed load requirement and nozzle minimum,
- holes/bosses preserve recorded fit class,
- load-bearing fillets stay at least max(0.5x wall, nozzle width),
- orientation does not move the primary load cross-layer without warning.

If the edit violates a recorded constraint, do not silently apply it. Explain
the effect and ask for confirmation or a different value.

## Engineered Report Additions

Add these lines to validate reports:

```text
Requirements: <short recorded constraints>
Engineering: FoS <n> | material <sigma_y> | fit/orientation notes
Print: <orientation> | est. print time | est. mass
```

Mass is volume times filament density when known. Print time is an estimate.

## Multi-Part Layout

```text
artifacts/<project>/
├── shared.py
├── project.json
├── <part-a>.py
├── <part-a>.session.json
├── <part-b>.py
├── <part-b>.session.json
├── assembly.step
├── assembly.stl
└── README.md
```

`shared.py` owns shared dimensions and interfaces. Each part imports shared
params. `project.json` tracks parts, interfaces, focused part, and last geometry.

## Multi-Part Bootstrap

Create:

- `shared.py` with common envelope, screw patterns, fits, and interface params,
- one script per part,
- one session per part,
- `project.json` with part list and interfaces.

Keep the focused part in `project.json["focused_part"]`.

## Shared Param Edits

When a shared parameter changes:

1. Edit `shared.py`.
2. Revalidate every part.
3. Diff bbox and volume against `project.json["parts"][].last_geometry`.
4. Surface every affected part.
5. If any part breaks, report it and offer to revert.

Part-specific edits should touch only that part's script.

## Interface Changes

For dovetails, seams, fastener patterns, bosses, or mating holes, update both
sides of the interface or shared params. Revalidate both sides and report the
clearance change.
