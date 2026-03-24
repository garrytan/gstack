#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

build_or_wrap() {
  local entry="$1"
  local outfile="$2"
  local rel_script="$3"

  mkdir -p "$(dirname "$outfile")"
  if bun build --compile "$entry" --outfile "$outfile"; then
    return 0
  fi

  echo "warning: bun build --compile failed for $entry; falling back to bun run wrapper at $outfile" >&2
  cat > "$outfile" <<EOF
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="\$(cd "\$(dirname "\$0")" && pwd)"
exec bun run "\$SCRIPT_DIR/$rel_script" "\$@"
EOF
  chmod +x "$outfile"
}

bun run gen:skill-docs
bun run gen:skill-docs --host codex

build_or_wrap "browse/src/cli.ts" "browse/dist/browse" "../src/cli.ts"
build_or_wrap "browse/src/find-browse.ts" "browse/dist/find-browse" "../src/find-browse.ts"
build_or_wrap "bin/gstack-global-discover.ts" "bin/gstack-global-discover" "gstack-global-discover.ts"

bash browse/scripts/build-node-server.sh
git rev-parse HEAD > browse/dist/.version
rm -f .*.bun-build
