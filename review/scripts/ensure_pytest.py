#!/usr/bin/env python3
"""Ensure pytest exists in a project-local environment for review-time test runs."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


REPO_ROOT = Path.cwd()
LOCAL_VENV_NAMES = (".venv", "venv")


def _run(command: list[str], check: bool = False) -> subprocess.CompletedProcess[str]:
    return subprocess.run(command, check=check, text=True, capture_output=True)


def _relative(path: Path) -> str:
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def _current_python_is_virtualenv() -> bool:
    base_prefix = getattr(sys, "base_prefix", sys.prefix)
    return sys.prefix != base_prefix or bool(os.environ.get("VIRTUAL_ENV"))


def find_python() -> tuple[Path, bool]:
    for name in LOCAL_VENV_NAMES:
        candidate = REPO_ROOT / name / "bin" / "python"
        if candidate.exists():
            return candidate, False

    current = Path(sys.executable).resolve()
    if _current_python_is_virtualenv():
        return current, False

    return REPO_ROOT / ".venv" / "bin" / "python", True


def pytest_available(python_path: Path) -> bool:
    if not python_path.exists():
        return False
    result = _run([str(python_path), "-m", "pytest", "--version"])
    return result.returncode == 0


def create_local_venv() -> Path:
    bootstrap_python = shutil.which("python3") or shutil.which("python")
    if not bootstrap_python:
        raise RuntimeError("Could not find python3 or python to create .venv")

    _run([bootstrap_python, "-m", "venv", str(REPO_ROOT / ".venv")], check=True)
    return REPO_ROOT / ".venv" / "bin" / "python"


def install_pytest(python_path: Path) -> None:
    _run([str(python_path), "-m", "pip", "install", "--upgrade", "pip"], check=True)
    _run([str(python_path), "-m", "pip", "install", "pytest"], check=True)


def build_plan() -> dict[str, object]:
    python_path, needs_local_venv = find_python()
    available = pytest_available(python_path)
    action = "already-installed"
    if not available:
        action = "create-venv-and-install" if needs_local_venv else "install-into-existing-python"

    return {
        "python": _relative(python_path),
        "needs_local_venv": needs_local_venv,
        "pytest_available": available,
        "action": action,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Ensure pytest exists for review-time test runs."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would happen without creating or installing anything.",
    )
    args = parser.parse_args()

    try:
        plan = build_plan()
        if args.dry_run:
            print(json.dumps({"status": "planned", **plan}, indent=2))
            return 0

        if plan["pytest_available"]:
            print(json.dumps({"status": "ok", **plan, "installed": False}, indent=2))
            return 0

        created_venv = False
        python_path = Path(str(plan["python"]))
        if plan["needs_local_venv"]:
            python_path = create_local_venv()
            created_venv = True

        install_pytest(python_path)

        if not pytest_available(python_path):
            raise RuntimeError("pytest install reported success but pytest is still unavailable")

        print(
            json.dumps(
                {
                    "status": "ok",
                    "python": _relative(python_path),
                    "action": "installed",
                    "created_venv": created_venv,
                    "installed": True,
                },
                indent=2,
            )
        )
        return 0
    except subprocess.CalledProcessError as exc:
        print(
            json.dumps(
                {
                    "status": "error",
                    "action": "install-failed",
                    "returncode": exc.returncode,
                    "command": exc.cmd,
                    "stdout": exc.stdout,
                    "stderr": exc.stderr,
                },
                indent=2,
            )
        )
        return 1
    except Exception as exc:  # pragma: no cover - defensive CLI guard
        print(json.dumps({"status": "error", "message": str(exc)}, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
