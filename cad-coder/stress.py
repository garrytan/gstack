"""Closed-form stress estimates for common 3D-printed part geometries.

NOT FEA — rule-of-thumb closed-form formulas. ±30% accuracy. Catches
order-of-magnitude mistakes (e.g. specced 1mm wall to hold 5kg);
does NOT replace physical testing or real FEA for production-grade
parts.

Used by /cad-coder engineered-mode validation and /qa-print Phase 0.5
pre-print check via subprocess CLI:

    python cad-coder/stress.py cantilever --L 60 --b 40 --h 4 --F 50 --sigma_y 45 --layer_factor 1.0

Units: mm for length, N for force, MPa for stress (= N/mm²).
σ_y reference (in-plane, FDM):
    PLA 50, PETG 45, ABS 40, ASA 45, PC 65, Nylon 50, PA-CF 95, PEEK 95.
Cross-layer multiply by ~0.5 for FDM.
"""
from dataclasses import dataclass, asdict
import math


@dataclass
class StressResult:
    geometry: str             # name of the formula used
    max_stress_mpa: float     # peak stress in MPa
    location: str             # human-readable location of peak
    inputs: dict              # echo of the dimensions + load for transparency

    def fos(self, sigma_y_mpa: float, layer_factor: float = 1.0) -> float:
        """Factor of safety against the given material yield, accounting for
        FDM layer-direction strength reduction (use 0.5 for cross-layer loads
        on FDM, 1.0 for in-plane loads or isotropic processes like SLA/SLS)."""
        if self.max_stress_mpa <= 0:
            return float("inf")
        return (sigma_y_mpa * layer_factor) / self.max_stress_mpa


# ── Beams ─────────────────────────────────────────────────────────────

def cantilever_max_stress(length_mm, width_mm, thickness_mm, load_n):
    """Max bending stress at the root of a cantilever beam loaded at the tip.

    σ_max = M·c/I = (F·L)·(h/2) / (b·h³/12) = 6·F·L / (b·h²)
    """
    if width_mm <= 0 or thickness_mm <= 0:
        raise ValueError("width and thickness must be > 0")
    stress = 6.0 * load_n * length_mm / (width_mm * thickness_mm * thickness_mm)
    return StressResult(
        geometry="cantilever_beam_tip_load",
        max_stress_mpa=stress,
        location="root of cantilever (top/bottom fibre at fixed end)",
        inputs={"length_mm": length_mm, "width_mm": width_mm,
                "thickness_mm": thickness_mm, "load_n": load_n},
    )


def simply_supported_beam_max_stress(span_mm, width_mm, thickness_mm, load_n):
    """Max bending stress in a simply-supported beam under a center point load.

    σ_max = M·c/I = (F·L/4)·(h/2) / (b·h³/12) = (3/2)·F·L / (b·h²)
    """
    if width_mm <= 0 or thickness_mm <= 0:
        raise ValueError("width and thickness must be > 0")
    stress = 1.5 * load_n * span_mm / (width_mm * thickness_mm * thickness_mm)
    return StressResult(
        geometry="simply_supported_beam_center_load",
        max_stress_mpa=stress,
        location="bottom fibre at midspan",
        inputs={"span_mm": span_mm, "width_mm": width_mm,
                "thickness_mm": thickness_mm, "load_n": load_n},
    )


# ── Plates ────────────────────────────────────────────────────────────

# Roark Table 11.4 case 1a: simply-supported rectangular plate, center point load.
# β coefficient for σ_max = β·F / t²  (load in N, t in mm → σ in MPa)
_PLATE_BETA = [
    (1.0, 0.435), (1.2, 0.494), (1.5, 0.534),
    (2.0, 0.576), (4.0, 0.704), (10.0, 0.750),
]


def plate_center_load_max_stress(length_mm, width_mm, thickness_mm, load_n):
    """Simply-supported rectangular plate with center point load (Roark 11.4 1a).

    σ_max ≈ β·F / t², β from a/b lookup table.
    """
    if min(length_mm, width_mm, thickness_mm) <= 0:
        raise ValueError("all dimensions must be > 0")
    a, b = max(length_mm, width_mm), min(length_mm, width_mm)
    ratio = a / b
    if ratio >= _PLATE_BETA[-1][0]:
        beta = _PLATE_BETA[-1][1]
    elif ratio <= _PLATE_BETA[0][0]:
        beta = _PLATE_BETA[0][1]
    else:
        beta = _PLATE_BETA[0][1]
        for (r1, b1), (r2, b2) in zip(_PLATE_BETA, _PLATE_BETA[1:]):
            if r1 <= ratio <= r2:
                beta = b1 + (b2 - b1) * (ratio - r1) / (r2 - r1)
                break
    stress = beta * load_n / (thickness_mm * thickness_mm)
    return StressResult(
        geometry="plate_center_load_simply_supported",
        max_stress_mpa=stress,
        location=f"centre of plate (a/b={ratio:.2f}, β={beta:.3f})",
        inputs={"length_mm": length_mm, "width_mm": width_mm,
                "thickness_mm": thickness_mm, "load_n": load_n,
                "aspect_ratio": round(ratio, 3)},
    )


# ── Fastener interfaces ───────────────────────────────────────────────

def screw_pull_through_max_stress(head_diameter_mm, hole_diameter_mm,
                                  wall_thickness_mm, load_n):
    """Shear stress on the annular ring of wall material around a screw under
    tensile load. Failure mode: screw head pulls THROUGH the wall,
    extracting a cone of plastic.

    Approximation: τ = F / (π·D_hole·t), the cylindrical shear surface
    around the hole. (A real cone is shallower but this is conservative.)
    """
    if wall_thickness_mm <= 0 or hole_diameter_mm <= 0:
        raise ValueError("wall thickness and hole diameter must be > 0")
    if head_diameter_mm <= hole_diameter_mm:
        raise ValueError("screw head must be larger than hole")
    shear_area = math.pi * hole_diameter_mm * wall_thickness_mm
    stress = load_n / shear_area
    return StressResult(
        geometry="screw_pull_through_shear",
        max_stress_mpa=stress,
        location=f"shear cone around Ø{hole_diameter_mm}mm hole in {wall_thickness_mm}mm wall",
        inputs={"head_diameter_mm": head_diameter_mm,
                "hole_diameter_mm": hole_diameter_mm,
                "wall_thickness_mm": wall_thickness_mm, "load_n": load_n},
    )


def boss_compression_max_stress(boss_diameter_mm, hole_diameter_mm, load_n):
    """Compressive stress on a screw boss under axial load.

    σ_c = F / A, where A is the annular cross-section between hole and
    boss OD. Used for clamping force or external compression on bosses.
    """
    if boss_diameter_mm <= hole_diameter_mm:
        raise ValueError("boss OD must exceed hole ID")
    area = math.pi * (boss_diameter_mm * boss_diameter_mm
                      - hole_diameter_mm * hole_diameter_mm) / 4
    stress = load_n / area
    return StressResult(
        geometry="boss_axial_compression",
        max_stress_mpa=stress,
        location=f"annular ring of boss (Ø{boss_diameter_mm}/Ø{hole_diameter_mm}mm)",
        inputs={"boss_diameter_mm": boss_diameter_mm,
                "hole_diameter_mm": hole_diameter_mm, "load_n": load_n},
    )


# ── CLI ───────────────────────────────────────────────────────────────

GEOMETRIES = {
    "cantilever":   ("cantilever_max_stress", ["L", "b", "h", "F"]),
    "beam":         ("simply_supported_beam_max_stress", ["L", "b", "h", "F"]),
    "plate":        ("plate_center_load_max_stress", ["L", "b", "h", "F"]),
    "pull_through": ("screw_pull_through_max_stress", ["D_head", "D_hole", "h", "F"]),
    "boss":         ("boss_compression_max_stress", ["D_boss", "D_hole", "F"]),
}


def _verdict(fos):
    if fos == float("inf"):
        return "no load"
    if fos >= 5.0: return "comfortable margin"
    if fos >= 3.0: return "acceptable for functional parts"
    if fos >= 2.0: return "tight — consider thicker wall or stiffer filament"
    if fos >= 1.0: return "marginal — likely to deform under load, may not break"
    return "FAILS — peak stress exceeds yield; redesign required"


def main():
    import argparse, json, sys
    p = argparse.ArgumentParser(
        description="Closed-form stress estimates for 3D-printed parts.")
    p.add_argument("geometry", choices=list(GEOMETRIES.keys()),
                   help="part class")
    p.add_argument("--L", type=float, help="length or span (mm)")
    p.add_argument("--b", type=float, help="width (mm)")
    p.add_argument("--h", type=float, help="thickness / wall thickness (mm)")
    p.add_argument("--F", type=float, required=True, help="load (N)")
    p.add_argument("--D_head", type=float, help="screw head diameter (mm)")
    p.add_argument("--D_hole", type=float, help="hole diameter (mm)")
    p.add_argument("--D_boss", type=float, help="boss outer diameter (mm)")
    p.add_argument("--sigma_y", type=float,
                   help="material yield strength MPa — output FoS if given")
    p.add_argument("--layer_factor", type=float, default=1.0,
                   help="0.5 for cross-layer FDM load, 1.0 in-plane or isotropic")
    args = p.parse_args()

    fn_name, needs = GEOMETRIES[args.geometry]
    fn = globals()[fn_name]
    kwargs_map = {
        "L": ("length_mm" if args.geometry != "beam" else "span_mm"),
        "b": "width_mm", "h": ("thickness_mm" if args.geometry in {"cantilever", "beam", "plate"} else "wall_thickness_mm"),
        "F": "load_n", "D_head": "head_diameter_mm",
        "D_hole": "hole_diameter_mm", "D_boss": "boss_diameter_mm",
    }
    kwargs = {}
    for key in needs:
        val = getattr(args, key)
        if val is None:
            sys.stderr.write(f"missing --{key} for geometry '{args.geometry}'\n")
            sys.exit(2)
        kwargs[kwargs_map[key]] = val

    r = fn(**kwargs)
    out = asdict(r)
    out["max_stress_mpa"] = round(out["max_stress_mpa"], 2)
    if args.sigma_y is not None:
        fos = r.fos(args.sigma_y, args.layer_factor)
        out["sigma_y_mpa"] = args.sigma_y
        out["layer_factor"] = args.layer_factor
        out["fos"] = round(fos, 2) if fos != float("inf") else None
        out["verdict"] = _verdict(fos)
    print(json.dumps(out, indent=None))


if __name__ == "__main__":
    main()
