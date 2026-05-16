from dataclasses import dataclass, field
import numpy as np
import trimesh


@dataclass
class MeshStats:
    bounds: np.ndarray          # shape (2, 3): [min, max]
    extents: np.ndarray         # shape (3,): [dx, dy, dz]
    center_mass: np.ndarray     # shape (3,)
    volume: float
    surface_area: float
    face_count: int
    vertex_count: int
    is_watertight: bool
    is_convex: bool
    principal_axes: np.ndarray  # shape (3, 3) — PCA eigenvectors
    principal_extents: np.ndarray  # shape (3,) — extents in principal frame
    symmetry_axes: list[str] = field(default_factory=list)


def analyze_mesh(mesh: trimesh.Trimesh) -> MeshStats:
    bounds = mesh.bounds
    extents = mesh.extents
    center_mass = np.array(mesh.center_mass)
    volume = float(mesh.volume) if mesh.is_watertight else float(mesh.convex_hull.volume)
    surface_area = float(mesh.area)

    axes, extents_pca = _pca_axes(mesh)
    symmetry = _detect_symmetry_axes(mesh)

    return MeshStats(
        bounds=bounds,
        extents=extents,
        center_mass=center_mass,
        volume=volume,
        surface_area=surface_area,
        face_count=len(mesh.faces),
        vertex_count=len(mesh.vertices),
        is_watertight=mesh.is_watertight,
        is_convex=mesh.is_convex,
        principal_axes=axes,
        principal_extents=extents_pca,
        symmetry_axes=symmetry,
    )


def _pca_axes(mesh: trimesh.Trimesh):
    verts = mesh.vertices
    centered = verts - verts.mean(axis=0)
    cov = np.cov(centered.T)
    eigenvalues, eigenvectors = np.linalg.eigh(cov)
    # Sort descending
    order = np.argsort(eigenvalues)[::-1]
    axes = eigenvectors[:, order].T  # rows are axes
    # Project to get extents in PCA frame
    projected = centered @ axes.T
    extents = projected.max(axis=0) - projected.min(axis=0)
    return axes, extents


def _detect_symmetry_axes(mesh: trimesh.Trimesh, threshold: float = 0.05) -> list[str]:
    """Heuristic: reflect vertices across each axis plane and measure ICP residual."""
    verts = mesh.vertices
    c = verts.mean(axis=0)
    centered = verts - c
    found = []
    for axis_name, axis_idx in [("x", 0), ("y", 1), ("z", 2)]:
        reflected = centered.copy()
        reflected[:, axis_idx] *= -1
        # Nearest-neighbour distance as symmetry score
        from scipy.spatial import cKDTree
        tree = cKDTree(centered)
        dists, _ = tree.query(reflected, k=1)
        score = dists.mean() / (mesh.extents.max() + 1e-9)
        if score < threshold:
            found.append(axis_name)
    return found
