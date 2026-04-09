#!/bin/bash
# Build NStack Browser.app — macOS application bundle
#
# Creates a self-contained .app with:
#   - Compiled browse binary
#   - Playwright's bundled Chromium
#   - Chrome extension (sidebar)
#   - Info.plist with bundle ID
#
# Output: dist/NStack Browser.app and dist/NStack-Browser.dmg
#
# Usage:
#   ./scripts/build-app.sh           # Build .app + DMG
#   ./scripts/build-app.sh --no-dmg  # Build .app only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
APP_NAME="NStack Browser"
BUNDLE_ID="com.nstack.browser"
VERSION=$(cat "$ROOT/VERSION" 2>/dev/null || echo "0.0.1")
BUILD_DIR="$ROOT/dist"
APP_DIR="$BUILD_DIR/$APP_NAME.app"

echo "Building $APP_NAME v$VERSION..."

# ─── Step 1: Compile browse binary ─────────────────────────────
echo "  Compiling browse binary..."
cd "$ROOT/browse"
bun build --compile src/cli.ts --outfile "$BUILD_DIR/browse-app" --target=bun 2>/dev/null
cd "$ROOT"

# ─── Step 2: Find Playwright's Chromium ─────────────────────────
echo "  Locating Playwright Chromium..."
PW_CACHE="$HOME/Library/Caches/ms-playwright"
CHROMIUM_DIR=$(ls -d "$PW_CACHE"/chromium-*/chrome-mac-arm64 2>/dev/null | sort -V | tail -1)

if [ -z "$CHROMIUM_DIR" ]; then
  echo "ERROR: Playwright Chromium not found in $PW_CACHE"
  echo "Run: bunx playwright install chromium"
  exit 1
fi

CHROME_APP=$(ls -d "$CHROMIUM_DIR"/*.app 2>/dev/null | head -1)
if [ -z "$CHROME_APP" ]; then
  echo "ERROR: Chrome .app not found in $CHROMIUM_DIR"
  exit 1
fi
echo "  Found: $(basename "$CHROME_APP")"

# ─── Step 3: Create .app structure ──────────────────────────────
echo "  Building .app bundle..."
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Launcher script
cp "$ROOT/scripts/app/nstack-browser" "$APP_DIR/Contents/MacOS/nstack-browser"
chmod +x "$APP_DIR/Contents/MacOS/nstack-browser"

# Browse binary
cp "$BUILD_DIR/browse-app" "$APP_DIR/Contents/Resources/browse"
chmod +x "$APP_DIR/Contents/Resources/browse"

# Extension
cp -r "$ROOT/extension" "$APP_DIR/Contents/Resources/extension"
# Remove .auth.json if present (auth now via /health endpoint)
rm -f "$APP_DIR/Contents/Resources/extension/.auth.json"

# Server source (needed for `bun run server.ts` subprocess)
# The launcher sets BROWSE_SERVER_SCRIPT to point at this.
# Copy the full src/ directory since server.ts imports other modules.
echo "  Copying browse source..."
cp -r "$ROOT/browse/src" "$APP_DIR/Contents/Resources/src"
# Also need package.json for module resolution
cp "$ROOT/browse/package.json" "$APP_DIR/Contents/Resources/" 2>/dev/null || true

# Chromium
mkdir -p "$APP_DIR/Contents/Resources/chromium"
echo "  Copying Chromium (~330MB)..."
cp -a "$CHROME_APP" "$APP_DIR/Contents/Resources/chromium/"

# ─── Step 3b: Rebrand Chromium ────────────────────────────────────
# Patch the bundled Chromium's Info.plist so macOS shows "NStack Browser"
# in the menu bar, Dock, and Cmd+Tab instead of "Google Chrome for Testing"
CHROMIUM_PLIST="$APP_DIR/Contents/Resources/chromium/$(basename "$CHROME_APP")/Contents/Info.plist"
if [ -f "$CHROMIUM_PLIST" ]; then
  echo "  Rebranding Chromium → $APP_NAME..."
  /usr/libexec/PlistBuddy -c "Set :CFBundleName '$APP_NAME'" "$CHROMIUM_PLIST"
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName '$APP_NAME'" "$CHROMIUM_PLIST"
  # Also update the localized strings if present
  CHROMIUM_STRINGS="$APP_DIR/Contents/Resources/chromium/$(basename "$CHROME_APP")/Contents/Resources/en.lproj/InfoPlist.strings"
  if [ -f "$CHROMIUM_STRINGS" ]; then
    # InfoPlist.strings may be binary plist, convert to xml first
    plutil -convert xml1 "$CHROMIUM_STRINGS" 2>/dev/null || true
    sed -i '' "s/Google Chrome for Testing/$APP_NAME/g" "$CHROMIUM_STRINGS" 2>/dev/null || true
  fi
  # Replace Chromium's icon with ours so the Dock shows the NStack icon
  # (Chromium's process owns the Dock icon, not our launcher)
  ICON_SRC="$SCRIPT_DIR/app/icon.icns"
  if [ -f "$ICON_SRC" ]; then
    CHROMIUM_RESOURCES="$APP_DIR/Contents/Resources/chromium/$(basename "$CHROME_APP")/Contents/Resources"
    # Find the original icon filename from Chromium's plist
    ORIG_ICON=$(/usr/libexec/PlistBuddy -c "Print :CFBundleIconFile" "$CHROMIUM_PLIST" 2>/dev/null || echo "app")
    # Add .icns extension if not present
    [[ "$ORIG_ICON" != *.icns ]] && ORIG_ICON="${ORIG_ICON}.icns"
    cp "$ICON_SRC" "$CHROMIUM_RESOURCES/$ORIG_ICON"
    echo "  Replaced Chromium icon → $ORIG_ICON"
  fi
fi

# ─── Step 3c: App icon ────────────────────────────────────────────
ICON_SRC="$SCRIPT_DIR/app/icon.icns"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$APP_DIR/Contents/Resources/icon.icns"
  echo "  App icon installed"
else
  echo "  WARNING: No icon.icns found at $ICON_SRC — app will use default icon"
fi

# ─── Step 4: Info.plist ──────────────────────────────────────────
cat > "$APP_DIR/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>$APP_NAME</string>
  <key>CFBundleDisplayName</key>
  <string>$APP_NAME</string>
  <key>CFBundleIdentifier</key>
  <string>$BUNDLE_ID</string>
  <key>CFBundleVersion</key>
  <string>$VERSION</string>
  <key>CFBundleShortVersionString</key>
  <string>$VERSION</string>
  <key>CFBundleExecutable</key>
  <string>nstack-browser</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleSignature</key>
  <string>????</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>CFBundleIconFile</key>
  <string>icon</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>LSApplicationCategoryType</key>
  <string>public.app-category.developer-tools</string>
  <key>NSSupportsAutomaticTermination</key>
  <false/>
</dict>
</plist>
PLIST

# ─── Step 5: App size report ────────────────────────────────────
APP_SIZE=$(du -sh "$APP_DIR" | cut -f1)
echo ""
echo "  $APP_NAME.app: $APP_SIZE"
echo "    Contents/MacOS/nstack-browser     (launcher)"
echo "    Contents/Resources/browse          ($(du -sh "$APP_DIR/Contents/Resources/browse" | cut -f1))"
echo "    Contents/Resources/extension/      ($(du -sh "$APP_DIR/Contents/Resources/extension" | cut -f1))"
echo "    Contents/Resources/chromium/       ($(du -sh "$APP_DIR/Contents/Resources/chromium" | cut -f1))"

# ─── Step 6: DMG (optional) ─────────────────────────────────────
if [ "${1:-}" = "--no-dmg" ]; then
  echo ""
  echo "Done. App at: $APP_DIR"
  exit 0
fi

DMG_PATH="$BUILD_DIR/NStack-Browser.dmg"
echo ""
echo "  Creating DMG..."
rm -f "$DMG_PATH"

# Create a temporary directory for DMG contents
DMG_TMP=$(mktemp -d)
cp -a "$APP_DIR" "$DMG_TMP/"
ln -s /Applications "$DMG_TMP/Applications"

hdiutil create -volname "$APP_NAME" \
  -srcfolder "$DMG_TMP" \
  -ov -format UDZO \
  "$DMG_PATH" \
  > /dev/null 2>&1

rm -rf "$DMG_TMP"

DMG_SIZE=$(du -sh "$DMG_PATH" | cut -f1)
echo "  DMG: $DMG_SIZE → $DMG_PATH"
echo ""
echo "Done. Install: open $DMG_PATH"
