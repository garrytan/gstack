#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(git rev-parse --verify HEAD 2>/dev/null || printf unknown)"

mkdir -p browse/dist design/dist make-pdf/dist
printf '%s\n' "$VERSION" > browse/dist/.version
printf '%s\n' "$VERSION" > design/dist/.version
printf '%s\n' "$VERSION" > make-pdf/dist/.version
