"""
stl_to_images — render an STL from multiple angles.

Usage:
    python render.py path/to/model.stl --out /tmp/out/
    python render.py path/to/model.stl --out /tmp/out/ --size 800x600 --views iso front top right
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path

import numpy as np
import trimesh
import pyrender
from pyrender import PerspectiveCamera, DirectionalLight, OffscreenRenderer
from PIL import Image

# Named camera angles: (azimuth_deg, elevation_deg)
VIEWS: dict[str, tuple[float, float]] = {
    "iso":    (45,  35),
    "front":  (0,   5),
    "back":   (180, 5),
    "right":  (270, 5),
    "left":   (90,  5),
    "top":    (45,  88),
    "bottom": (45, -88),
}


def render_stl(
    stl_path: str | Path,
    out_dir: str | Path,
    views: list[str] | None = None,
    width: int = 800,
    height: int = 600,
    bg_color: tuple[float, float, float] = (0.15, 0.15, 0.15),
) -> list[Path]:
    """
    Render an STL from one or more named camera angles.
    Returns list of saved image paths.
    """
    if views is None:
        views = ["iso", "front", "top", "right"]

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    mesh = _load(stl_path)
    renderer = OffscreenRenderer(width, height)
    saved: list[Path] = []

    for view_name in views:
        if view_name not in VIEWS:
            raise ValueError(f"Unknown view '{view_name}'. Choose from: {list(VIEWS)}")
        az, el = VIEWS[view_name]
        color = _render_view(mesh, renderer, az, el, bg_color)
        out_path = out_dir / f"{Path(stl_path).stem}_{view_name}.png"
        Image.fromarray(color).save(out_path)
        saved.append(out_path)
        print(f"  saved {out_path}")

    renderer.delete()
    return saved


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _load(path: str | Path) -> trimesh.Trimesh:
    mesh = trimesh.load(str(path), force="mesh")
    if isinstance(mesh, trimesh.Scene):
        mesh = trimesh.util.concatenate(list(mesh.geometry.values()))
    mesh.apply_translation(-mesh.centroid)
    return mesh


def _lookat(eye: np.ndarray) -> np.ndarray:
    """Build a camera pose matrix looking from `eye` toward the origin."""
    forward = -eye / (np.linalg.norm(eye) + 1e-12)
    world_up = np.array([0.0, 0.0, 1.0])
    # Avoid gimbal lock near the poles
    if abs(np.dot(forward, world_up)) > 0.99:
        world_up = np.array([0.0, 1.0, 0.0])
    right = np.cross(forward, world_up)
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    pose = np.eye(4)
    pose[:3, 0] = right
    pose[:3, 1] = up
    pose[:3, 2] = -forward
    pose[:3, 3] = eye
    return pose


def _render_view(
    mesh: trimesh.Trimesh,
    renderer: OffscreenRenderer,
    azimuth_deg: float,
    elevation_deg: float,
    bg_color: tuple[float, float, float],
) -> np.ndarray:
    scene = pyrender.Scene(
        ambient_light=[0.35, 0.35, 0.35],
        bg_color=[*bg_color, 1.0],
    )

    # Mesh with flat shading so edges are visible
    py_mesh = pyrender.Mesh.from_trimesh(mesh, smooth=False)
    scene.add(py_mesh)

    # Camera distance: 2.8× bounding sphere radius
    r_sphere = float(np.linalg.norm(mesh.extents)) / 2.0
    dist = r_sphere * 2.8

    az = np.radians(azimuth_deg)
    el = np.radians(elevation_deg)
    eye = np.array([
        dist * np.cos(el) * np.cos(az),
        dist * np.cos(el) * np.sin(az),
        dist * np.sin(el),
    ])

    pose = _lookat(eye)
    cam = PerspectiveCamera(yfov=np.pi / 4.0)
    scene.add(cam, pose=pose)

    # Key light from camera direction + fill light from opposite side
    scene.add(DirectionalLight(color=[1, 1, 1], intensity=5.0), pose=pose)
    fill_eye = np.array([-eye[0], -eye[1], eye[2] * 0.5])
    fill_pose = _lookat(fill_eye / (np.linalg.norm(fill_eye) + 1e-12) * dist)
    scene.add(DirectionalLight(color=[0.8, 0.8, 1.0], intensity=2.0), pose=fill_pose)

    color, _ = renderer.render(scene)
    return color


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Render STL to images from multiple angles")
    parser.add_argument("stl", help="Path to input STL file")
    parser.add_argument("--out", default="/tmp/cad-renders", help="Output directory")
    parser.add_argument(
        "--views", nargs="+",
        default=["iso", "front", "top", "right"],
        choices=list(VIEWS),
        help="Camera angles to render",
    )
    parser.add_argument("--size", default="800x600", help="Image size, e.g. 800x600")
    args = parser.parse_args()

    w, h = map(int, args.size.split("x"))
    print(f"Rendering {args.stl} → {args.out}")
    paths = render_stl(args.stl, args.out, views=args.views, width=w, height=h)
    print(f"Done. {len(paths)} image(s) saved.")


if __name__ == "__main__":
    main()
