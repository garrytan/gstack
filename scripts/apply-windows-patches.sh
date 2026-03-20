#!/usr/bin/env bash
# apply-windows-patches.sh
# Apply Windows+Bun compatibility patches to playwright-core node_modules.
# Run this after `bun install` whenever node_modules is refreshed.
#
# Usage:
#   bash scripts/apply-windows-patches.sh
#
# What it patches (playwright-core@1.58.x):
#   - processLauncher.js  : use 3-element stdio on Bun+Windows (fd 3/4 broken)
#   - chromium.js         : force CDP-over-port + HTTP polling for readiness
#   - browserType.js      : pre-allocate free TCP port before Chrome launch
#   - transport.js        : use Bun native WebSocket instead of ws npm library

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PATCHES_DIR="$REPO_DIR/patches"
PW_DIR="$REPO_DIR/node_modules/playwright-core/lib/server"

echo "==> Applying Windows+Bun playwright-core patches..."

if [ ! -d "$PW_DIR" ]; then
  echo "ERROR: node_modules/playwright-core not found. Run 'bun install' first."
  exit 1
fi

apply_patch() {
  local patch_file="$PATCHES_DIR/$1"
  local target_dir="$PW_DIR"
  echo "  Applying $1..."
  if patch -d "$target_dir" -p3 --forward --dry-run < "$patch_file" >/dev/null 2>&1; then
    patch -d "$target_dir" -p3 --forward < "$patch_file"
  elif patch -d "$target_dir" -p3 --forward --dry-run -R < "$patch_file" >/dev/null 2>&1; then
    echo "  (already applied, skipping)"
  else
    echo "  WARNING: $1 failed to apply cleanly — may need updating for this playwright-core version"
  fi
}

apply_patch processLauncher.patch
apply_patch chromium.patch
apply_patch browserType.patch
apply_patch transport.patch

echo "==> Done. Rebuild browse binary: bun run build"
