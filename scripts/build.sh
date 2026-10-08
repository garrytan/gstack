#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$ROOT"

BUN_CMD="${BUN_CMD:-bun}"
BUN_CMD_WAS_COPIED=0
BUILD_STAMP="$ROOT/browse/dist/.build-complete"
BUILD_STAMP_TMP="$BUILD_STAMP.tmp.$$"

# Setup trusts this stamp as proof that the selected multi-binary build completed.
# CSO is optional: a failed CSO build or publish is reported and recorded in
# bin/.gstack-cso-build-result, and the rest of the build still completes (#3071).
# GSTACK_STRICT_BUILD=1 (CI) makes a CSO failure fatal. Setup may explicitly omit
# CSO after its host capability probe, while still publishing the general build.
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
"$BUN_CMD" run gen:skill-docs --host all
"$BUN_CMD" build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig browse/src/cli.ts --outfile browse/dist/browse
"$BUN_CMD" build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig browse/src/find-browse.ts --outfile browse/dist/find-browse
"$BUN_CMD" build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig design/src/cli.ts --outfile design/dist/design
"$BUN_CMD" build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig make-pdf/src/cli.ts --outfile make-pdf/dist/pdf
"$BUN_CMD" build --compile --no-compile-autoload-dotenv --no-compile-autoload-bunfig bin/gstack-global-discover.ts --outfile bin/gstack-global-discover
if [ "${GSTACK_SETUP_RUNNING:-0}" = "1" ] && [ "${GSTACK_SETUP_SKIP_CSO_BUILD:-0}" = "1" ]; then
  # Setup removes these before invoking us too. Repeat here so the setup-private
  # escape hatch can never publish a completion stamp beside stale trusted code.
  rm -f bin/gstack-cso-launcher bin/gstack-cso-launcher.exe \
    bin/gstack-cso-core bin/gstack-cso-core.exe bin/gstack-cso-watchdog \
    bin/.gstack-cso-generation bin/.gstack-cso-generation.lock
else
  CSO_BUILD_LOG_FILE="$ROOT/bin/.gstack-cso-build.log"
  if ! (set -o pipefail; GSTACK_CSO_BUILD_LOG="$CSO_BUILD_LOG_FILE" BUN_CMD="$BUN_CMD" bash scripts/build-cso.sh 2>&1 | tee "$CSO_BUILD_LOG_FILE"); then
    cso_stage="$(sed -n 's/^stage=//p' bin/.gstack-cso-build-result 2>/dev/null | head -1)"
    if [ "${GSTACK_STRICT_BUILD:-0}" = "1" ]; then
      echo "CSO ${cso_stage:-build} failed and GSTACK_STRICT_BUILD=1 makes it fatal. Log: $CSO_BUILD_LOG_FILE" >&2
      exit 1
    fi
    echo "CSO unavailable: the ${cso_stage:-build} step failed; the rest of the build continues. Log: $CSO_BUILD_LOG_FILE. Retry: cd $ROOT && bun run build:cso" >&2
  fi
fi
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
