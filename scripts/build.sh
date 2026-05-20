#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"

BUN_CMD="${BUN_CMD:-bun}"
BUN_CMD_WAS_COPIED=0

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    bun_path="$(command -v "$BUN_CMD" 2>/dev/null || true)"
    case "$bun_path" in
      *[![:ascii:]]*)
        bun_copy_dir="$ROOT/.tmp-bun-bin"
        mkdir -p "$bun_copy_dir"
        cp -f "$bun_path" "$bun_copy_dir/bun.exe"
        BUN_CMD="$bun_copy_dir/bun.exe"
        BUN_CMD_WAS_COPIED=1
        ;;
    esac
    ;;
esac

"$BUN_CMD" run vendor:xterm
"$BUN_CMD" run gen:skill-docs --host all
"$BUN_CMD" build --compile browse/src/cli.ts --outfile browse/dist/browse
"$BUN_CMD" build --compile browse/src/find-browse.ts --outfile browse/dist/find-browse
"$BUN_CMD" build --compile design/src/cli.ts --outfile design/dist/design
"$BUN_CMD" build --compile make-pdf/src/cli.ts --outfile make-pdf/dist/pdf
"$BUN_CMD" build --compile bin/gstack-global-discover.ts --outfile bin/gstack-global-discover
bash browse/scripts/build-node-server.sh
bash scripts/write-version-files.sh browse/dist/.version design/dist/.version make-pdf/dist/.version
chmod +x browse/dist/browse browse/dist/find-browse design/dist/design make-pdf/dist/pdf bin/gstack-global-discover
rm -f .*.bun-build
if [ "$BUN_CMD_WAS_COPIED" -eq 1 ]; then
  rm -rf "$ROOT/.tmp-bun-bin"
fi
