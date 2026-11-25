#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"

BUN_CMD="${BUN_CMD:-bun}"
BUN_CMD_WAS_COPIED=0
BUILD_STAMP="$ROOT/browse/dist/.build-complete"
BUILD_STAMP_TMP="$BUILD_STAMP.tmp.$$"

# Setup trusts this stamp as proof that the selected multi-binary build completed.
# Invalidate before touching output so an interrupted build cannot hide staleness.
rm -f "$BUILD_STAMP" "$BUILD_STAMP_TMP"

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

# A project's .env or bunfig.toml must never reach the shipped binaries: they run
# inside untrusted repos, and dotenv could set security switches such as
# GSTACK_CHROMIUM_NO_SANDBOX while a bunfig preload runs arbitrary code (D0).
"$BUN_CMD" run vendor:xterm
# Inside an install, render only the hosts setup installed from this checkout
# (#1694): every host's render under ~/.claude/skills/gstack is scanned by
# Claude Code and Cursor. bin/gstack-host-renders.sh owns the record.
. "$ROOT/bin/gstack-host-renders.sh"
gstack_render_hosts_select "$ROOT"
if [ "$GSTACK_RENDER_HOST_LIST" = all ]; then
  echo "Rendering skills for every host: $GSTACK_RENDER_HOST_REASON"
  "$BUN_CMD" run gen:skill-docs --host all
else
  echo "Rendering skills for: $GSTACK_RENDER_HOST_LIST ($GSTACK_RENDER_HOST_REASON)"
  for render_host in $GSTACK_RENDER_HOST_LIST; do
    "$BUN_CMD" run gen:skill-docs --host "$render_host"
  done
fi
"$BUN_CMD" build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig browse/src/cli.ts --outfile browse/dist/browse
"$BUN_CMD" build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig browse/src/find-browse.ts --outfile browse/dist/find-browse
"$BUN_CMD" build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig design/src/cli.ts --outfile design/dist/design
"$BUN_CMD" build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig make-pdf/src/cli.ts --outfile make-pdf/dist/pdf
"$BUN_CMD" build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig bin/gstack-global-discover.ts --outfile bin/gstack-global-discover
bash browse/scripts/build-node-server.sh
bash scripts/write-version-files.sh browse/dist/.version design/dist/.version make-pdf/dist/.version
chmod +x browse/dist/browse browse/dist/find-browse design/dist/design make-pdf/dist/pdf bin/gstack-global-discover
rm -f .*.bun-build
if [ "$BUN_CMD_WAS_COPIED" -eq 1 ]; then
  rm -rf "$ROOT/.tmp-bun-bin"
fi

# Publish last and on the same filesystem. A failure or interruption before the
# rename leaves the canonical stamp absent, which makes setup rebuild everything.
printf 'complete\n' > "$BUILD_STAMP_TMP"
mv -f "$BUILD_STAMP_TMP" "$BUILD_STAMP"
