# gstack on Windows

gstack was built for macOS but works on Windows with automatic compatibility
handling. This document covers what's different and any limitations.

## Prerequisites

- **Bun** (>=1.0.0) — builds the CLI binary
- **Node.js** (>=18) — runs the browse server (Bun's Playwright support is broken on Windows)
- **Git Bash** or equivalent (MSYS2, WSL) — for the setup script

## Setup

```bash
git clone <repo> ~/.claude/skills/gstack
cd ~/.claude/skills/gstack
./setup
```

If the repo lives elsewhere (not inside `~/.claude/skills/`), setup will
automatically create a symlink from `~/.claude/skills/gstack` to your repo
and link all individual skills.

### Windows Defender

Playwright's Chromium may be blocked by Windows Defender on first run.
Add an exclusion for:

```
%LOCALAPPDATA%\ms-playwright
```

(Windows Security > Virus & threat protection > Manage settings > Exclusions > Add folder)

## How it works

Bun on Windows cannot launch Playwright browsers — both IPC pipe and WebSocket
transports fail. gstack works around this automatically:

1. The **CLI binary** (`browse.exe`) is compiled with Bun as normal
2. When starting the browse server, the CLI detects Windows and spawns the
   server via **Node + tsx** instead of Bun
3. A polyfill layer (`bun-polyfill-win.ts`) provides Node-compatible
   implementations of `Bun.serve`, `Bun.write`, `Bun.file`, etc.
4. Playwright runs under Node where its transports work correctly

This is transparent — you use gstack exactly the same way as on macOS.

## Limitations

- **`cookie-import-browser`** — importing cookies from installed browsers
  (Chrome, Edge, etc.) is not supported. This feature requires `bun:sqlite`
  which is unavailable under Node. Use `cookie-import <json-file>` instead.
- **Test suite** — browser integration tests (`commands.test.ts`) fail under
  Bun on Windows for the same Playwright reason. Non-browser tests pass.

## Files added for Windows support

```
browse/src/bun-polyfill-win.ts   # Bun API polyfills for Node
browse/src/server-node.ts        # Node entry point (loads polyfills + server)
WINDOWS.md                       # This file
```

## Files modified for Windows support

```
browse/src/cli.ts                # Windows path detection + Node server spawn
browse/src/server.ts             # import.meta.dir fallback for Node
browse/src/cookie-import-browser.ts  # Conditional bun:sqlite import
package.json                     # tsx dependency, build script fix
setup                            # Cross-platform setup (symlinks, Defender guidance)
```
