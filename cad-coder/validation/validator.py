"""
Validate generated CadQuery script against the original mesh.

Metrics:
  - volume ratio
  - bounding box overlap (IoU in 3D)
  - surface area ratio
  - syntax check (compile the script)
"""
from __future__ import annotations

import ast
import sys
from dataclasses import dataclass

import numpy as np
import trimesh


@dataclass
class ValidationResult:
    syntax_ok: bool
    volume_ratio: float        # generated / original (ideal = 1.0)
    bbox_iou: float            # 3D bounding box IoU (ideal = 1.0)
    surface_area_ratio: float  # generated / original (ideal = 1.0)
    notes: list[str]

    @property
    def score(self) -> float:
        """0-1 composite score."""
        if not self.syntax_ok:
            return 0.0
        vol_err = abs(1.0 - self.volume_ratio)
        sa_err = abs(1.0 - self.surface_area_ratio)
        return float(np.clip(1.0 - (vol_err + sa_err * 0.5 + (1.0 - self.bbox_iou) * 0.5) / 2.0, 0, 1))


def validate_output(
    original_mesh: trimesh.Trimesh,
    generated_code: str,
) -> ValidationResult:
    notes = []

    # Syntax check
    try:
        ast.parse(generated_code)
        syntax_ok = True
    except SyntaxError as e:
        notes.append(f"SyntaxError: {e}")
        return ValidationResult(False, 0, 0, 0, notes)

    # Try to execute and get CadQuery result
    gen_mesh = _execute_cq(generated_code, notes)
    if gen_mesh is None:
        return ValidationResult(True, 0, 0, 0, notes)

    vol_orig = float(original_mesh.volume) if original_mesh.is_watertight else float(original_mesh.convex_hull.volume)
    vol_gen = float(gen_mesh.volume) if gen_mesh.is_watertight else float(gen_mesh.convex_hull.volume)
    vol_ratio = vol_gen / (vol_orig + 1e-9)

    sa_orig = float(original_mesh.area)
    sa_gen = float(gen_mesh.area)
    sa_ratio = sa_gen / (sa_orig + 1e-9)

    iou = _bbox_iou(original_mesh.bounds, gen_mesh.bounds)

    return ValidationResult(
        syntax_ok=True,
        volume_ratio=round(vol_ratio, 4),
        bbox_iou=round(iou, 4),
        surface_area_ratio=round(sa_ratio, 4),
        notes=notes,
    )


def _execute_cq(code: str, notes: list[str]) -> trimesh.Trimesh | None:
    try:
        import cadquery as cq
    except ImportError:
        notes.append("cadquery not installed — skipping mesh execution check")
        return None

    namespace = {"cq": cq, "show_object": lambda *a, **kw: None}
    try:
        exec(compile(code, "<generated>", "exec"), namespace)
    except Exception as e:
        notes.append(f"Execution error: {e}")
        return None

    result = namespace.get("result")
    if result is None:
        notes.append("No 'result' variable found in generated code")
        return None

    try:
        shell = result.val()
        vertices, triangles = [], []
        import OCC.Core.BRep as BRep  # noqa: F401 — presence check
        # Use CadQuery's built-in tessellation
        tess = result.tessellate(0.01)
        verts = np.array([[v.x, v.y, v.z] for v in tess[0]])
        faces = np.array(tess[1])
        mesh = trimesh.Trimesh(vertices=verts, faces=faces)
        return mesh
    except Exception as e:
        notes.append(f"Tessellation error: {e}")
        return None


def _bbox_iou(bounds_a: np.ndarray, bounds_b: np.ndarray) -> float:
    inter_min = np.maximum(bounds_a[0], bounds_b[0])
    inter_max = np.minimum(bounds_a[1], bounds_b[1])
    inter_dims = np.maximum(inter_max - inter_min, 0)
    inter_vol = float(np.prod(inter_dims))
    vol_a = float(np.prod(bounds_a[1] - bounds_a[0]))
    vol_b = float(np.prod(bounds_b[1] - bounds_b[0]))
    union_vol = vol_a + vol_b - inter_vol
    if union_vol < 1e-12:
        return 1.0
    return inter_vol / union_vol
