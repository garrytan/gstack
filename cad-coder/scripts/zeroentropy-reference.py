#!/usr/bin/env python3
"""Fetch ZeroEntropy STL references into a cad-coder artifact folder.

This helper talks to the local cad-coder/zeroentropy FastAPI service. It does
not require ZeroEntropy credentials itself; the server owns that setup.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_SERVER = "http://127.0.0.1:8000"
DEFAULT_VIEWS = ("iso", "front", "top", "right")


def get_json(url: str, timeout: int = 30) -> dict[str, Any]:
    with urllib.request.urlopen(url, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def download(url: str, path: Path, timeout: int = 90) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=timeout) as response:
        path.write_bytes(response.read())


def write_summary(
    path: Path,
    *,
    query: str,
    server: str,
    status: str,
    message: str,
    results: list[dict[str, Any]],
    selected: dict[str, Any] | None,
    renders: list[str],
) -> None:
    lines = [
        "# ZeroEntropy STL References",
        "",
        f"- Query: `{query}`",
        f"- Server: `{server}`",
        f"- Status: `{status}`",
        f"- Message: {message}",
        "",
        "## Results",
        "",
    ]
    if not results:
        lines.append("No results returned.")
    for index, result in enumerate(results, start=1):
        ok = "yes" if result.get("download_ok") else "no"
        score = result.get("score")
        lines.extend(
            [
                f"{index}. {result.get('name') or '(untitled)'}",
                f"   - thing_id: `{result.get('thing_id') or ''}`",
                f"   - score: `{score}`",
                f"   - download_ok: `{ok}`",
                f"   - thing_url: {result.get('thing_url') or ''}",
                f"   - stl_path: `{result.get('stl_path') or ''}`",
            ]
        )
    lines.extend(["", "## Selected", ""])
    if selected:
        lines.extend(
            [
                f"- Name: {selected.get('name') or '(untitled)'}",
                f"- thing_id: `{selected.get('thing_id') or ''}`",
                f"- thing_url: {selected.get('thing_url') or ''}",
                f"- stl_path: `{selected.get('stl_path') or ''}`",
            ]
        )
    else:
        lines.append("No renderable result selected.")
    lines.extend(["", "## Renders", ""])
    if renders:
        lines.extend(f"- `{render}`" for render in renders)
    else:
        lines.append("No renders downloaded.")
    lines.extend(
        [
            "",
            "## Agent Notes",
            "",
            "Read the render PNGs before writing CAD. Record visual takeaways in",
            "`session.json[\"zeroentropy_reference\"]`.",
        ]
    )
    path.write_text("\n".join(lines) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="Fetch ZeroEntropy STL reference renders")
    parser.add_argument("--query", required=True, help="CAD brief to search for")
    parser.add_argument("--artifact-dir", required=True, help="Part artifact directory")
    parser.add_argument("--server", default=DEFAULT_SERVER, help="Local zeroentropy server URL")
    parser.add_argument("--k", type=int, default=3, help="Number of search results")
    parser.add_argument("--render", action="store_true", help="Download rendered PNG views")
    args = parser.parse_args()

    server = args.server.rstrip("/")
    ref_dir = Path(args.artifact_dir).expanduser().resolve() / "references" / "zeroentropy"
    render_dir = ref_dir / "renders"
    ref_dir.mkdir(parents=True, exist_ok=True)

    try:
        get_json(f"{server}/healthz", timeout=5)
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        message = (
            f"ZeroEntropy server unavailable: {exc}. Start it with "
            "`cd cad-coder/zeroentropy && uvicorn server:app --host 0.0.0.0 --port 8000`."
        )
        write_summary(
            ref_dir / "summary.md",
            query=args.query,
            server=server,
            status="unavailable",
            message=message,
            results=[],
            selected=None,
            renders=[],
        )
        print(f"ZEROENTROPY_REFERENCE_UNAVAILABLE {ref_dir / 'summary.md'}")
        return 2

    query_url = (
        f"{server}/query?"
        + urllib.parse.urlencode({"q": args.query, "k": max(1, min(args.k, 10))})
    )
    try:
        payload = get_json(query_url, timeout=60)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")[:500]
        message = f"ZeroEntropy query failed: HTTP {exc.code}: {body}"
        write_summary(
            ref_dir / "summary.md",
            query=args.query,
            server=server,
            status="query-error",
            message=message,
            results=[],
            selected=None,
            renders=[],
        )
        print(f"ZEROENTROPY_REFERENCE_UNAVAILABLE {ref_dir / 'summary.md'}")
        return 2
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        message = f"ZeroEntropy query failed: {exc}"
        write_summary(
            ref_dir / "summary.md",
            query=args.query,
            server=server,
            status="query-error",
            message=message,
            results=[],
            selected=None,
            renders=[],
        )
        print(f"ZEROENTROPY_REFERENCE_UNAVAILABLE {ref_dir / 'summary.md'}")
        return 2

    (ref_dir / "query.json").write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n")
    results = payload.get("results") or []
    selected = next((result for result in results if result.get("download_ok")), None)
    renders: list[str] = []
    render_errors: list[str] = []

    if selected and args.render:
        thing_id = str(selected.get("thing_id") or "")
        render_urls = selected.get("render_urls") or {}
        for view in DEFAULT_VIEWS:
            url = render_urls.get(view)
            if not url:
                continue
            dest = render_dir / f"{thing_id}_{view}.png"
            try:
                download(url, dest)
                renders.append(str(dest))
            except (urllib.error.URLError, TimeoutError) as exc:
                render_errors.append(f"{view}: {exc}")

    status = "ok" if selected else "no-renderable-result"
    message = "Selected top downloadable STL reference." if selected else "No result had download_ok=true."
    if render_errors:
        message += " Render errors: " + "; ".join(render_errors)

    write_summary(
        ref_dir / "summary.md",
        query=args.query,
        server=server,
        status=status,
        message=message,
        results=results,
        selected=selected,
        renders=renders,
    )

    if selected:
        print(f"ZEROENTROPY_REFERENCE_OK {ref_dir / 'summary.md'}")
        return 0

    print(f"ZEROENTROPY_REFERENCE_UNAVAILABLE {ref_dir / 'summary.md'}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
