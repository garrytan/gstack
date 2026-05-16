import sys
from pathlib import Path
import numpy as np
import trimesh
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from mesh_loader import load_mesh
from mesh_analysis import analyze_mesh
from feature_detection import detect_features
from cadquery_codegen import generate_cadquery
from intermediate_representation.ir import Box, Cylinder, Sphere, BooleanOp


def _box_mesh() -> trimesh.Trimesh:
    return trimesh.creation.box(extents=[10, 5, 3])


def _cylinder_mesh() -> trimesh.Trimesh:
    return trimesh.creation.cylinder(radius=4, height=8, sections=64)


def _sphere_mesh() -> trimesh.Trimesh:
    return trimesh.creation.icosphere(radius=5)


def test_analyze_box():
    mesh = _box_mesh()
    stats = analyze_mesh(mesh)
    assert stats.extents == pytest.approx([10, 5, 3], abs=0.1)
    assert stats.is_watertight


def test_detect_box():
    mesh = _box_mesh()
    stats = analyze_mesh(mesh)
    model = detect_features(mesh, stats)
    assert isinstance(model.root, Box)
    assert model.root.width == pytest.approx(10, abs=0.2)


def test_detect_cylinder():
    mesh = _cylinder_mesh()
    stats = analyze_mesh(mesh)
    model = detect_features(mesh, stats)
    assert isinstance(model.root, Cylinder)
    assert model.root.radius == pytest.approx(4, abs=0.3)
    assert model.root.height == pytest.approx(8, abs=0.3)


def test_detect_sphere():
    mesh = _sphere_mesh()
    stats = analyze_mesh(mesh)
    model = detect_features(mesh, stats)
    assert isinstance(model.root, Sphere)
    assert model.root.radius == pytest.approx(5, abs=0.3)


def test_generate_box_code():
    mesh = _box_mesh()
    stats = analyze_mesh(mesh)
    model = detect_features(mesh, stats)
    code = generate_cadquery(model)
    assert "import cadquery" in code
    assert "box(" in code
    assert "show_object" in code


def test_generate_cylinder_code():
    mesh = _cylinder_mesh()
    stats = analyze_mesh(mesh)
    model = detect_features(mesh, stats)
    code = generate_cadquery(model)
    assert "cylinder(" in code


def test_generate_sphere_code():
    mesh = _sphere_mesh()
    stats = analyze_mesh(mesh)
    model = detect_features(mesh, stats)
    code = generate_cadquery(model)
    assert "sphere(" in code


def test_code_is_valid_python():
    import ast
    for mesh_fn in [_box_mesh, _cylinder_mesh, _sphere_mesh]:
        mesh = mesh_fn()
        stats = analyze_mesh(mesh)
        model = detect_features(mesh, stats)
        code = generate_cadquery(model)
        ast.parse(code)  # should not raise
