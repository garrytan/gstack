import trimesh
import numpy as np
from pathlib import Path


def load_mesh(path: str | Path) -> trimesh.Trimesh:
    """Load an STL file (binary or ASCII) and attempt repair if needed."""
    mesh = trimesh.load(str(path), force="mesh")

    if not isinstance(mesh, trimesh.Trimesh):
        # Scene with multiple geometries — concatenate into one
        if isinstance(mesh, trimesh.Scene):
            geometries = list(mesh.geometry.values())
            mesh = trimesh.util.concatenate(geometries)
        else:
            raise ValueError(f"Unsupported mesh type: {type(mesh)}")

    mesh = _repair(mesh)
    return mesh


def _repair(mesh: trimesh.Trimesh) -> trimesh.Trimesh:
    trimesh.repair.fix_winding(mesh)
    trimesh.repair.fix_normals(mesh)
    trimesh.repair.fix_inversion(mesh)

    if not mesh.is_watertight:
        trimesh.repair.fill_holes(mesh)

    trimesh.repair.broken_faces(mesh, color=None)
    mesh.update_faces(mesh.unique_faces())
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()

    return mesh
