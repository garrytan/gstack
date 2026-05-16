"""
stl_to_cadquery — main entry point.

Usage:
    python convert.py path/to/model.stl [--out output.py] [--validate]
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from mesh_loader import load_mesh
from mesh_analysis import analyze_mesh
from feature_detection import detect_features
from cadquery_codegen import generate_cadquery
from validation import validate_output


def convert(stl_path: str, validate: bool = False) -> str:
    mesh = load_mesh(stl_path)
    stats = analyze_mesh(mesh)
    model = detect_features(mesh, stats)
    code = generate_cadquery(model)

    if validate:
        result = validate_output(mesh, code)
        print(f"[validation] syntax_ok={result.syntax_ok}  score={result.score:.3f}")
        print(f"             volume_ratio={result.volume_ratio}  bbox_iou={result.bbox_iou}")
        for note in result.notes:
            print(f"             note: {note}")

    return code


def main():
    parser = argparse.ArgumentParser(description="Convert STL to CadQuery script")
    parser.add_argument("stl", help="Path to input STL file")
    parser.add_argument("--out", default=None, help="Output .py file (default: stdout)")
    parser.add_argument("--validate", action="store_true", help="Run validation after generation")
    args = parser.parse_args()

    code = convert(args.stl, validate=args.validate)

    if args.out:
        Path(args.out).write_text(code)
        print(f"Written to {args.out}")
    else:
        print(code)


if __name__ == "__main__":
    main()
