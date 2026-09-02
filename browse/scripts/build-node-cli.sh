#!/usr/bin/env bash
# Build a Node.js-compatible CLI bundle for Windows.
#
# `bun build --compile` emits an executable with no Authenticode signature, and
# Windows Smart App Control in enforcement mode refuses to load unsigned
# binaries. Every locally compiled browse.exe is unique to the machine that
# built it, so it can never accumulate the reputation SAC accepts either. The
# result is that browse.exe cannot launch at all: every $B command dies, taking
# /browse, /qa, /design-review, /benchmark and /canary with it. SAC has no
# per-file allowlist and cannot be re-enabled once disabled without a clean
# Windows reinstall.
#
# bun.exe and node.exe are both signed (Codeblog CORP and OpenJS Foundation),
# so they run fine. The server half already exploits that: build-node-server.sh
# plus the IS_WINDOWS branch in src/cli.ts spawns `node server-node.mjs`. This
# script builds the missing other half, so no unsigned binary has to launch.

set -e

GSTACK_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SRC_DIR="$GSTACK_DIR/browse/src"
DIST_DIR="$GSTACK_DIR/browse/dist"

echo "Building Node-compatible CLI bundle..."

# Step 1: Transpile cli.ts to a single .mjs bundle (externalize runtime deps).
# Same externals as build-node-server.sh.
bun build "$SRC_DIR/cli.ts" \
  --target=node \
  --outfile "$DIST_DIR/cli-node.mjs" \
  --external playwright \
  --external playwright-core \
  --external diff \
  --external "bun:sqlite" \
  --external "@ngrok/ngrok"

# Step 2: Post-process
# Replace import.meta.dir with a resolvable reference
perl -pi -e 's/import\.meta\.dir/__browseNodeSrcDir/g' "$DIST_DIR/cli-node.mjs"

# Step 3: Create the final file with polyfill header injected after the first line.
# bun-polyfill.cjs already covers Bun.spawn, Bun.spawnSync and Bun.sleep, which is
# everything the CLI's import graph uses except Bun.stdin (reached only by `chain`
# when it reads from stdin), so shim that one here.
{
  head -1 "$DIST_DIR/cli-node.mjs"
  echo '// ── Windows Node.js compatibility (auto-generated) ──'
  echo 'import { fileURLToPath as _ftp } from "node:url";'
  echo 'import { dirname as _dn } from "node:path";'
  echo 'import { createRequire as _cr } from "node:module";'
  echo 'const __browseNodeSrcDir = _dn(_dn(_ftp(import.meta.url))) + "/src";'
  echo '{'
  echo '  const _r = _cr(import.meta.url);'
  echo '  _r("./bun-polyfill.cjs");'
  echo '  if (globalThis.Bun && !globalThis.Bun.stdin) {'
  echo '    globalThis.Bun.stdin = {'
  echo '      text() {'
  echo '        return new Promise((resolve, reject) => {'
  echo '          let data = "";'
  echo '          process.stdin.setEncoding("utf8");'
  echo '          process.stdin.on("data", (chunk) => { data += chunk; });'
  echo '          process.stdin.on("end", () => resolve(data));'
  echo '          process.stdin.on("error", reject);'
  echo '        });'
  echo '      },'
  echo '    };'
  echo '  }'
  echo '}'
  echo '// ── end compatibility ──'
  tail -n +2 "$DIST_DIR/cli-node.mjs"
} > "$DIST_DIR/cli-node.tmp.mjs"

mv "$DIST_DIR/cli-node.tmp.mjs" "$DIST_DIR/cli-node.mjs"

# Step 4: Copy polyfill to dist/
cp "$SRC_DIR/bun-polyfill.cjs" "$DIST_DIR/bun-polyfill.cjs"

echo "Node CLI bundle ready: $DIST_DIR/cli-node.mjs"

# Step 5: Launcher wrappers, Windows only.
#
# On macOS and Linux, build.sh compiles the real binary to browse/dist/browse,
# so writing a wrapper there would clobber it. On Windows that same step emits
# browse.exe instead, leaving the extensionless path free — which is what keeps
# the SETUP block in browse/SKILL.md working unchanged, since it resolves $B to
# browse/dist/browse and gates on -x.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    cat > "$DIST_DIR/browse" <<'WRAPPER'
#!/usr/bin/env bash
# Node launcher for gstack browse (Windows / Smart App Control).
#
# dist/browse.exe is unsigned, so Smart App Control blocks it. node.exe is
# signed, so running the CLI as a Node bundle works.
#
# Rebuild with: bash browse/scripts/build-node-cli.sh
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI="$DIR/cli-node.mjs"

if [ ! -f "$CLI" ]; then
  echo "cli-node.mjs missing. Run: bash browse/scripts/build-node-cli.sh" >&2
  exit 1
fi

# node.exe is a native Windows binary and cannot read MSYS-style /c/... paths.
if command -v cygpath >/dev/null 2>&1; then
  CLI="$(cygpath -w "$CLI")"
fi

exec node "$CLI" "$@"
WRAPPER

    cat > "$DIST_DIR/browse.cmd" <<'WRAPPER'
@echo off
REM Node launcher for gstack browse (Windows / Smart App Control).
REM dist\browse.exe is unsigned and blocked by Smart App Control; node.exe is signed.
REM Rebuild with: bash browse/scripts/build-node-cli.sh
node "%~dp0cli-node.mjs" %*
WRAPPER

    chmod +x "$DIST_DIR/browse"
    echo "Launcher wrappers written: $DIST_DIR/browse, $DIST_DIR/browse.cmd"
    ;;
  *)
    echo "Skipping launcher wrappers (non-Windows: dist/browse is the compiled binary)."
    ;;
esac
