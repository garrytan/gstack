# Export and Downstream Artifacts

Use this when the user asks to print, export, drop files, save a variant, or
ship a CAD version.

## Export Signals

Treat these as export intent:

- "drop the stl", "give me the file", "export it", "save the files",
- "ready to print", "print it", "ready for the printer",
- "lock it in", "ship this version", "this is the one".

If the user only sounds done, confirm once: "Exporting STEP + STL now?"

## Single-Part Export

1. Run the part script with `--export`.
2. Write or update:
   - `artifacts/<part>/<part>.step`
   - `artifacts/<part>/<part>.stl`
   - `artifacts/<part>/<part>.glb` if preview is active
   - `artifacts/<part>/README.md`
3. Update `session.json["last_exported_at"]` and
   `session.json["last_exported_turn"]`.
4. Write the downstream cad-built artifact.

Validate-only turns do not write downstream build artifacts.

## Multi-Part Export

For "export everything" or "drop the assembly":

1. Run every part script with `--export`.
2. Export one STEP/STL per part.
3. Export `assembly.step` and `assembly.stl` for combined preview.
4. Update `project.json["last_exported_all_at"]` and part sessions.
5. Write one cad-built artifact per part and one project-built artifact.
6. Update the project README with parts, print order, fasteners, assembly, and
   interface notes.

For "drop just <part>", export only that part.

## Export Report

Single part:

```text
Built: artifacts/<part>/<part>.step + .stl (exported on turn N)
Geometry: <bbox> mm | Volume <cm3> | <faces> faces
Features: <named features>

After you print it: run /qa-print to check the fit. A ruler is fine.
```

Engineered exports preserve Engineering and Print lines above `Built:`.

## README

Single-part README should include:

- what it is,
- print material/process assumptions,
- recommended orientation,
- slicer basics,
- key parameters,
- regenerate command,
- post-print checks.

Multi-part README should include:

- parts list,
- print order,
- per-part settings,
- fastener BOM,
- assembly steps,
- interface summary,
- regenerate commands.

## Variants

For "save this as a variant", copy the whole artifact folder to
`artifacts/<part>-<tag>/`, update the copied session with `parent`, then export
that variant so it is self-contained.
