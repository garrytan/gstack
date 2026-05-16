"""
Detect semantic CAD features from a mesh and mesh stats.

Strategy:
  1. Try to fit a sphere
  2. Try to fit a cylinder
  3. Fit a box from OBB
  4. Detect hole cylinders (negative features) from boundary loops
  5. Detect through-holes and bosses
"""
from __future__ import annotations

import numpy as np
import trimesh
from scipy.optimize import least_squares

from mesh_analysis.analyzer import MeshStats
from intermediate_representation.ir import (
    IRModel, Box, Cylinder, Sphere, BooleanOp, Fillet,
)


def detect_features(mesh: trimesh.Trimesh, stats: MeshStats) -> IRModel:
    model = IRModel()
    model.parameters = {
        "width": round(float(stats.extents[0]), 4),
        "depth": round(float(stats.extents[1]), 4),
        "height": round(float(stats.extents[2]), 4),
    }

    # Try sphere first (most constrained)
    sphere = _try_fit_sphere(mesh, stats)
    if sphere is not None:
        model.root = sphere
        model.notes.append("Detected as sphere")
        return model

    # Try cylinder
    cyl = _try_fit_cylinder(mesh, stats)
    if cyl is not None:
        base = cyl
        # Look for through-holes to subtract
        holes = _detect_holes(mesh, stats)
        for hole in holes:
            base = BooleanOp(op="cut", base=base, tool=hole)
        model.root = base
        model.notes.append(f"Detected as cylinder with {len(holes)} hole(s)")
        return model

    # Fall back to box
    box = _fit_box(stats)
    base: object = box
    holes = _detect_holes(mesh, stats)
    for hole in holes:
        base = BooleanOp(op="cut", base=base, tool=hole)

    # Optionally suggest a fillet if roundness is high
    if _has_rounded_edges(mesh, stats):
        fillet_r = round(min(stats.extents[:2]) * 0.05, 4)
        base = Fillet(target=base, radius=fillet_r, edge_selector="|Z")
        model.notes.append("Added fillet on vertical edges (rounded corners detected)")

    model.root = base
    model.notes.append(f"Detected as box with {len(holes)} hole(s)")
    return model


# ---------------------------------------------------------------------------
# Sphere fitting
# ---------------------------------------------------------------------------

def _try_fit_sphere(mesh: trimesh.Trimesh, stats: MeshStats) -> Sphere | None:
    e = stats.extents
    aspect = max(e) / (min(e) + 1e-9)
    if aspect > 1.15:
        return None

    verts = mesh.vertices
    c0 = stats.center_mass
    r0 = np.linalg.norm(verts - c0, axis=1).mean()

    def residuals(params):
        cx, cy, cz, r = params
        return np.linalg.norm(verts - [cx, cy, cz], axis=1) - r

    result = least_squares(residuals, [*c0, r0])
    cx, cy, cz, r = result.x
    res_rms = np.sqrt((result.fun ** 2).mean())
    if res_rms / r >= 0.02:
        return None
    # Check that face normals are isotropically distributed (not cylinder-like)
    normals = mesh.face_normals
    frac_horizontal = float(np.mean(np.abs(normals[:, 2]) < 0.2))
    if frac_horizontal > 0.35:
        return None  # Too many horizontal normals — likely a cylinder
    s = Sphere(radius=round(float(r), 4))
    s.translation = np.array([cx, cy, cz])
    return s


# ---------------------------------------------------------------------------
# Cylinder fitting
# ---------------------------------------------------------------------------

def _try_fit_cylinder(mesh: trimesh.Trimesh, stats: MeshStats) -> Cylinder | None:
    # Determine cylinder axis from face normals: the axis with most cap-pointing normals
    normals = mesh.face_normals
    axis_idx = int(np.argmax([
        np.mean(np.abs(normals[:, i]) > 0.8) for i in range(3)
    ]))
    axis_name = ["x", "y", "z"][axis_idx]
    plane_axes = [i for i in range(3) if i != axis_idx]

    # Cross-section extents must be roughly equal (round cross-section)
    cross_extents = stats.extents[plane_axes]
    if abs(cross_extents[0] - cross_extents[1]) / (cross_extents.max() + 1e-9) > 0.12:
        return None

    height = float(stats.extents[axis_idx])
    radius_guess = float(cross_extents.mean()) / 2.0

    verts = mesh.vertices
    c = stats.center_mass
    pts2d = verts[:, plane_axes]
    c2d = c[plane_axes]

    # Exclude cap-center vertices (near the axis projection) before circle fit
    dists_from_center = np.linalg.norm(pts2d - c2d, axis=1)
    mask = dists_from_center > radius_guess * 0.3
    pts2d_rim = pts2d[mask]
    if len(pts2d_rim) < 16:
        pts2d_rim = pts2d  # fallback

    def residuals(params):
        cx, cy, r = params
        return np.linalg.norm(pts2d_rim - [cx, cy], axis=1) - r

    result = least_squares(residuals, [*c2d, radius_guess])
    cx, cy, r = result.x
    res_rms = np.sqrt((result.fun ** 2).mean())
    if res_rms / r > 0.08:
        return None

    center = np.array(c)
    center[plane_axes[0]] = cx
    center[plane_axes[1]] = cy

    cyl = Cylinder(
        radius=round(float(r), 4),
        height=round(float(height), 4),
        axis=axis_name,
    )
    cyl.translation = np.round(center, 4)
    return cyl


# ---------------------------------------------------------------------------
# Box fitting
# ---------------------------------------------------------------------------

def _fit_box(stats: MeshStats) -> Box:
    e = stats.extents
    box = Box(
        width=round(float(e[0]), 4),
        depth=round(float(e[1]), 4),
        height=round(float(e[2]), 4),
    )
    box.translation = np.round(stats.center_mass, 4)
    return box


# ---------------------------------------------------------------------------
# Hole / boss detection via boundary loops
# ---------------------------------------------------------------------------

def _detect_holes(mesh: trimesh.Trimesh, stats: MeshStats) -> list[Cylinder]:
    """Find circular boundary loops and treat them as through-holes."""
    holes = []
    try:
        outline = mesh.outline()
    except Exception:
        return holes

    min_hole_r = min(stats.extents[:2]) * 0.03
    max_hole_r = min(stats.extents[:2]) * 0.45

    for entity in outline.entities:
        pts = outline.vertices[entity.points]
        if len(pts) < 8:
            continue
        # Determine dominant plane
        normal = np.cross(pts[1] - pts[0], pts[2] - pts[0])
        if np.linalg.norm(normal) < 1e-9:
            continue
        normal /= np.linalg.norm(normal)
        dominant = int(np.argmax(np.abs(normal)))
        plane_axes = [i for i in range(3) if i != dominant]
        pts2d = pts[:, plane_axes]
        c2d = pts2d.mean(axis=0)
        dists = np.linalg.norm(pts2d - c2d, axis=1)
        r = dists.mean()
        if not (min_hole_r < r < max_hole_r):
            continue
        circularity = dists.std() / (r + 1e-9)
        if circularity > 0.12:
            continue
        axis_name = ["x", "y", "z"][dominant]
        cyl = Cylinder(
            radius=round(float(r), 4),
            height=round(float(stats.extents[dominant]) * 1.1, 4),
            axis=axis_name,
        )
        center = np.array(stats.center_mass)
        center[plane_axes[0]] = c2d[0]
        center[plane_axes[1]] = c2d[1]
        cyl.translation = np.round(center, 4)
        holes.append(cyl)
    return holes


# ---------------------------------------------------------------------------
# Rounded edge heuristic
# ---------------------------------------------------------------------------

def _has_rounded_edges(mesh: trimesh.Trimesh, stats: MeshStats) -> bool:
    """Return True if the mesh appears to have significantly rounded vertical edges."""
    face_normals = mesh.face_normals
    horizontal = np.abs(face_normals[:, 2]) < 0.1
    if horizontal.sum() < 10:
        return False
    h_normals = face_normals[horizontal]
    angles = np.arctan2(h_normals[:, 1], h_normals[:, 0])
    hist, _ = np.histogram(angles, bins=36, range=(-np.pi, np.pi))
    uniformity = hist.std() / (hist.mean() + 1e-9)
    return bool(uniformity < 0.6)
