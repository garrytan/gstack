#!/usr/bin/env bash
# Build a Node.js-compatible server bundle for compiled installs.
#
# On Windows, Bun can't launch or connect to Playwright's Chromium
# (oven-sh/bun#4253, #9911). On macOS/Linux compiled exports also need
# a self-contained server bundle because the exported browse binary should
# not depend on source-side node_modules.

set -e

GSTACK_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_DIR="$GSTACK_DIR/browse/src"
DIST_DIR="$GSTACK_DIR/browse/dist"
TMP_DIR="$DIST_DIR/.node-build"

echo "Building Node-compatible server bundle..."

# Step 1: Transpile server.ts to a self-contained Node bundle.
# Keep only Electron external — Playwright's server path imports it lazily.
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"
bun build "$SRC_DIR/server.ts" \
  --target=node \
  --outdir "$TMP_DIR" \
  --external electron \
  --external "bun:sqlite"

# The bundled entry lands as server.js plus any emitted assets.
ENTRY_JS="$TMP_DIR/server.js"
if [ ! -f "$ENTRY_JS" ]; then
  echo "ERROR: expected bundled server entry at $ENTRY_JS" >&2
  exit 1
fi

# Step 2: Post-process
# Replace import.meta.dir with a resolvable reference
perl -pi -e 's/import\.meta\.dir/__browseNodeDistDir/g' "$ENTRY_JS"
# Stub out bun:sqlite (macOS-only cookie import, not needed on Windows)
perl -pi -e 's|import { Database } from "bun:sqlite";|const Database = null; // bun:sqlite stubbed on Node|g' "$ENTRY_JS"

# Step 3: Create the final file with polyfill header injected after the first line
{
  head -1 "$ENTRY_JS"
  echo '// ── Node.js compatibility (auto-generated) ──'
  echo 'import { fileURLToPath as _ftp } from "node:url";'
  echo 'import { dirname as _dn } from "node:path";'
  echo 'const __browseNodeDistDir = _dn(_ftp(import.meta.url));'
  echo '{ const _r = createRequire(import.meta.url); _r("./bun-polyfill.cjs"); }'
  echo '// ── end compatibility ──'
  tail -n +2 "$ENTRY_JS"
} > "$DIST_DIR/server-node.mjs"

# Step 4: Copy emitted assets + polyfill to dist/
find "$TMP_DIR" -mindepth 1 -maxdepth 1 -type f ! -name 'server.js' -exec cp {} "$DIST_DIR"/ \;
cp "$SRC_DIR/bun-polyfill.cjs" "$DIST_DIR/bun-polyfill.cjs"

rm -rf "$TMP_DIR"

echo "Node server bundle ready: $DIST_DIR/server-node.mjs"
