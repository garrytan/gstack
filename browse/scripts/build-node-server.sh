#!/usr/bin/env bash
# Build a Node.js-compatible server bundle for Windows.
#
# On Windows, Bun can't launch or connect to Playwright's Chromium
# (oven-sh/bun#4253, #9911). This script produces a server bundle
# that runs under Node.js with Bun API polyfills.

set -e

GSTACK_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_DIR="$GSTACK_DIR/browse/src"
DIST_DIR="$GSTACK_DIR/browse/dist"

echo "Building Node-compatible server bundle..."

TMP_BUILD_DIR="$DIST_DIR/.node-server-build"
OUT_FILE="$DIST_DIR/server-node.mjs"
rm -rf "$TMP_BUILD_DIR"
mkdir -p "$TMP_BUILD_DIR"

# Step 1: Transpile server.ts for Node. Use an outdir instead of --outfile so
# Bun can emit any native addon sidecar files (for example ngrok *.node)
# without aborting the build with "cannot write multiple output files".
bun build "$SRC_DIR/server.ts" \
  --target=node \
  --outdir "$TMP_BUILD_DIR" \
  --external playwright \
  --external playwright-core \
  --external diff \
  --external "bun:sqlite"

BUNDLED_ENTRY=$(find "$TMP_BUILD_DIR" -maxdepth 1 -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.cjs' \) | head -n 1)
if [ -z "$BUNDLED_ENTRY" ]; then
  echo "Failed to locate bundled Node server entry in $TMP_BUILD_DIR" >&2
  exit 1
fi

mv "$BUNDLED_ENTRY" "$OUT_FILE"
find "$TMP_BUILD_DIR" -maxdepth 1 -type f -name '*.node' -exec mv {} "$DIST_DIR"/ \;
rm -rf "$TMP_BUILD_DIR"

# Step 2: Post-process
# Replace import.meta.dir with a resolvable reference
perl -pi -e 's/import\.meta\.dir/__browseNodeSrcDir/g' "$OUT_FILE"
# Stub out bun:sqlite (macOS-only cookie import, not needed on Windows)
perl -pi -e 's|import { Database } from "bun:sqlite";|const Database = null; // bun:sqlite stubbed on Node|g' "$OUT_FILE"

# Step 3: Create the final file with polyfill header injected after the first line
{
  head -1 "$OUT_FILE"
  echo '// ── Windows Node.js compatibility (auto-generated) ──'
  echo 'import { fileURLToPath as _ftp } from "node:url";'
  echo 'import { dirname as _dn } from "node:path";'
  echo 'const __browseNodeSrcDir = _dn(_dn(_ftp(import.meta.url))) + "/src";'
  echo '{ const _r = createRequire(import.meta.url); _r("./bun-polyfill.cjs"); }'
  echo '// ── end compatibility ──'
  tail -n +2 "$OUT_FILE"
} > "$DIST_DIR/server-node.tmp.mjs"

mv "$DIST_DIR/server-node.tmp.mjs" "$OUT_FILE"

# Step 4: Copy polyfill to dist/
cp "$SRC_DIR/bun-polyfill.cjs" "$DIST_DIR/bun-polyfill.cjs"

echo "Node server bundle ready: $OUT_FILE"
