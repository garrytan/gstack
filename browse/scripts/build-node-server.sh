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

mkdir -p "$DIST_DIR"

# On MSYS2/git-bash, native binaries (bun) fail to write when given a POSIX
# /c/Users/... path if MSYS_NO_PATHCONV=1 is set (bun reports "Bundled" but
# writes nothing). Always hand bun a Windows-native path. MSYS tools
# (perl/cat/cp) keep using the POSIX path, which resolves to the same file via
# the /c -> C: mount, so the two never diverge.
if command -v cygpath >/dev/null 2>&1; then
  SRC_W="$(cygpath -w -a "$SRC_DIR")\\server.ts"
  DIST_W="$(cygpath -w -a "$DIST_DIR")"
  RAW_W="$DIST_W\\server-node.raw.mjs"
else
  SRC_W="$SRC_DIR/server.ts"
  DIST_W="$DIST_DIR"
  RAW_W="$DIST_DIR/server-node.raw.mjs"
fi
RAW="$DIST_DIR/server-node.raw.mjs"
FINAL="$DIST_DIR/server-node.mjs"

echo "Building Node-compatible server bundle..."

# Step 1: bundle to a fresh raw file (no compat header yet)
bun build "$SRC_W" \
  --target=node \
  --outfile "$RAW_W" \
  --external playwright \
  --external playwright-core \
  --external diff \
  --external "bun:sqlite" \
  --external "@ngrok/ngrok" \
  --external socks \
  --external sharp

# Step 2: post-process the raw bundle
perl -pi -e 's/import\.meta\.dir/__browseNodeSrcDir/g' "$RAW"
perl -pi -e 's|import { Database } from "bun:sqlite";|const Database = null; // bun:sqlite stubbed on Node|g' "$RAW"

# Step 3: prepend the Windows compat header. Idempotent by construction: the
# raw bundle is rebuilt from source every run (0 headers), so the header is
# added exactly once — no duplicate-identifier errors on re-runs.
{
  echo '// ── Windows Node.js compatibility (auto-generated) ──'
  echo 'import { fileURLToPath as _ftp } from "node:url";'
  echo 'import { dirname as _dn } from "node:path";'
  echo 'const __browseNodeSrcDir = _dn(_dn(_ftp(import.meta.url))) + "/src";'
  echo '{ const _r = createRequire(import.meta.url); _r("./bun-polyfill.cjs"); }'
  echo '// ── end compatibility ──'
  cat "$RAW"
} > "$FINAL"

rm -f "$RAW"

# Step 4: copy polyfill to dist/
cp "$SRC_DIR/bun-polyfill.cjs" "$DIST_DIR/bun-polyfill.cjs"

echo "Node server bundle ready: $FINAL"
