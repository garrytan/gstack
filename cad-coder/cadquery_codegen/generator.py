"""
Convert an IRModel into a clean, editable CadQuery Python script.
"""
from __future__ import annotations

import numpy as np
from intermediate_representation.ir import (
    IRModel, IRPrimitive, Box, Cylinder, Sphere, Extrusion,
    BooleanOp, Fillet, Chamfer,
)


def generate_cadquery(model: IRModel) -> str:
    lines = [
        "import cadquery as cq",
        "",
    ]

    # Emit named parameters
    if model.parameters:
        lines.append("# --- Parameters (edit these) ---")
        for k, v in model.parameters.items():
            lines.append(f"{k} = {v}")
        lines.append("")

    # Emit notes as comments
    for note in model.notes:
        lines.append(f"# {note}")
    if model.notes:
        lines.append("")

    expr = _emit_node(model.root, model.parameters)
    lines.append(f"result = {expr}")
    lines.append("")
    lines.append("# Show in CQ-editor")
    lines.append("show_object(result)")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Node emitters
# ---------------------------------------------------------------------------

def _emit_node(node, params: dict) -> str:
    if isinstance(node, BooleanOp):
        return _emit_boolean(node, params)
    if isinstance(node, Fillet):
        return _emit_fillet(node, params)
    if isinstance(node, Chamfer):
        return _emit_chamfer(node, params)
    if isinstance(node, Box):
        return _emit_box(node, params)
    if isinstance(node, Cylinder):
        return _emit_cylinder(node, params)
    if isinstance(node, Sphere):
        return _emit_sphere(node, params)
    if isinstance(node, Extrusion):
        return _emit_extrusion(node, params)
    raise ValueError(f"Unknown IR node: {type(node)}")


def _emit_boolean(node: BooleanOp, params: dict) -> str:
    base = _emit_node(node.base, params)
    tool = _emit_node(node.tool, params)
    op_map = {"union": "union", "cut": "cut", "intersect": "intersect"}
    cq_op = op_map[node.op]
    return f"(\n    {base}\n    .{cq_op}(\n        {tool}\n    )\n)"


def _emit_fillet(node: Fillet, params: dict) -> str:
    inner = _emit_node(node.target, params)
    sel = f'"{node.edge_selector}"' if node.edge_selector else ""
    if sel:
        return f"(\n    {inner}\n    .edges({sel})\n    .fillet({node.radius})\n)"
    return f"(\n    {inner}\n    .edges()\n    .fillet({node.radius})\n)"


def _emit_chamfer(node: Chamfer, params: dict) -> str:
    inner = _emit_node(node.target, params)
    sel = f'"{node.edge_selector}"' if node.edge_selector else ""
    if sel:
        return f"(\n    {inner}\n    .edges({sel})\n    .chamfer({node.length})\n)"
    return f"(\n    {inner}\n    .edges()\n    .chamfer({node.length})\n)"


def _emit_box(node: Box, params: dict) -> str:
    w, d, h = _param_or_val("width", node.width, params), \
               _param_or_val("depth", node.depth, params), \
               _param_or_val("height", node.height, params)
    tx, ty, tz = _fmt_translation(node.translation)
    base = f"cq.Workplane('XY').box({w}, {d}, {h})"
    if not _is_zero(node.translation):
        base += f".translate(({tx}, {ty}, {tz}))"
    return base


def _emit_cylinder(node: Cylinder, params: dict) -> str:
    r = node.radius
    h = node.height
    axis_map = {"x": "YZ", "y": "XZ", "z": "XY"}
    plane = axis_map[node.axis]
    tx, ty, tz = _fmt_translation(node.translation)
    base = f"cq.Workplane('{plane}').cylinder({h}, {r})"
    if not _is_zero(node.translation):
        base += f".translate(({tx}, {ty}, {tz}))"
    return base


def _emit_sphere(node: Sphere, params: dict) -> str:
    tx, ty, tz = _fmt_translation(node.translation)
    base = f"cq.Workplane('XY').sphere({node.radius})"
    if not _is_zero(node.translation):
        base += f".translate(({tx}, {ty}, {tz}))"
    return base


def _emit_extrusion(node: Extrusion, params: dict) -> str:
    axis_map = {"x": "YZ", "y": "XZ", "z": "XY"}
    plane = axis_map[node.axis]
    pts = ", ".join(f"({x}, {y})" for x, y in node.profile_points)
    return (
        f"cq.Workplane('{plane}')\n"
        f"    .polyline([{pts}])\n"
        f"    .close()\n"
        f"    .extrude({node.height})"
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _param_or_val(name: str, val: float, params: dict) -> str:
    if name in params and abs(params[name] - val) < 1e-6:
        return name
    return str(round(val, 4))


def _fmt_translation(t: np.ndarray) -> tuple[str, str, str]:
    return (str(round(float(t[0]), 4)),
            str(round(float(t[1]), 4)),
            str(round(float(t[2]), 4)))


def _is_zero(t: np.ndarray, tol: float = 1e-4) -> bool:
    return bool(np.all(np.abs(t) < tol))
