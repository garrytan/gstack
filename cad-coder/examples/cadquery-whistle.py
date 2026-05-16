#!/usr/bin/env python3
"""CadQuery whistle demo for the cad-coder live UI."""

from __future__ import annotations

import argparse
from pathlib import Path


def build_whistle(pitch: float = 440.0):
    import cadquery as cq

    scale = max(0.75, min(1.35, 440.0 / max(pitch, 1.0)))
    length = 68.0 * scale
    width = 18.0
    height = 16.0
    wall = 2.0

    body = (
        cq.Workplane("XY")
        .box(length, width, height)
        .edges("|Z")
        .fillet(3.0)
        .edges(">Z")
        .fillet(1.4)
    )

    chamber = (
        cq.Workplane("XY")
        .box(length - 16.0, width - wall * 2, height - wall * 2)
        .translate((3.0, 0, 1.0))
    )
    body = body.cut(chamber)

    mouth_slot = (
        cq.Workplane("XY")
        .box(20.0, width + 1.0, 3.2)
        .translate((-length / 2 + 13.0, 0, height / 2 - 1.5))
    )
    body = body.cut(mouth_slot)

    windway = (
        cq.Workplane("XY")
        .box(28.0, width - 5.0, 2.2)
        .translate((-length / 2 + 15.0, 0, height / 2 - 4.2))
    )
    body = body.cut(windway)

    bevel = (
        cq.Workplane("XZ")
        .polyline([(0, 0), (8, 0), (0, 5)])
        .close()
        .extrude(width + 2)
        .translate((-length / 2 + 25.0, -width / 2 - 1.0, height / 2 - 6.0))
    )
    body = body.cut(bevel)

    loop = (
        cq.Workplane("YZ")
        .circle(5.5)
        .circle(3.1)
        .extrude(3.0)
        .translate((length / 2 + 1.5, 0, 0))
    )

    tone_label = (
        cq.Workplane("XY")
        .text(f"{int(pitch)} Hz", 6.0, 0.8)
        .translate((length / 2 - 21.0, 0, height / 2 + 0.15))
    )

    assy = cq.Assembly(name="live-whistle")
    assy.add(body, name="body", color=cq.Color(0.88, 0.68, 0.25))
    assy.add(loop, name="lanyard-loop", color=cq.Color(0.95, 0.82, 0.35))
    assy.add(tone_label, name="pitch-label", color=cq.Color(0.12, 0.12, 0.12))
    return assy


def main() -> int:
    parser = argparse.ArgumentParser(description="Export a CadQuery whistle as GLB")
    parser.add_argument("--out", required=True, help="Output .glb file")
    parser.add_argument("--pitch", type=float, default=440.0, help="Demo pitch value that changes whistle length")
    args = parser.parse_args()

    try:
        assy = build_whistle(args.pitch)
    except ModuleNotFoundError as exc:
        if exc.name == "cadquery":
            print("CadQuery is not installed. Run: python3 -m pip install cadquery", flush=True)
            return 2
        raise

    out = Path(args.out).expanduser().resolve()
    out.parent.mkdir(parents=True, exist_ok=True)
    assy.export(str(out))
    print(f"wrote {out}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
