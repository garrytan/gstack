from __future__ import annotations
from dataclasses import dataclass, field
from typing import Literal
import numpy as np


@dataclass
class IRPrimitive:
    """Base class for all IR geometry nodes."""
    name: str = ""
    translation: np.ndarray = field(default_factory=lambda: np.zeros(3))
    rotation_axis: np.ndarray = field(default_factory=lambda: np.array([0, 0, 1]))
    rotation_angle: float = 0.0  # degrees


@dataclass
class Box(IRPrimitive):
    width: float = 1.0   # x
    depth: float = 1.0   # y
    height: float = 1.0  # z


@dataclass
class Cylinder(IRPrimitive):
    radius: float = 1.0
    height: float = 1.0
    axis: Literal["x", "y", "z"] = "z"


@dataclass
class Sphere(IRPrimitive):
    radius: float = 1.0


@dataclass
class Extrusion(IRPrimitive):
    """2D profile extruded along an axis."""
    profile_points: list[tuple[float, float]] = field(default_factory=list)
    height: float = 1.0
    axis: Literal["x", "y", "z"] = "z"


@dataclass
class BooleanOp:
    """Boolean combination of two IR nodes."""
    op: Literal["union", "cut", "intersect"]
    base: IRPrimitive | BooleanOp | None = None
    tool: IRPrimitive | BooleanOp | None = None


@dataclass
class Fillet:
    target: IRPrimitive | BooleanOp | None = None
    radius: float = 0.5
    edge_selector: str = ""  # CadQuery selector string, e.g. ">Z"


@dataclass
class Chamfer:
    target: IRPrimitive | BooleanOp | None = None
    length: float = 0.5
    edge_selector: str = ""


# Top-level container
@dataclass
class IRModel:
    root: IRPrimitive | BooleanOp | Fillet | Chamfer | None = None
    parameters: dict[str, float] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)
