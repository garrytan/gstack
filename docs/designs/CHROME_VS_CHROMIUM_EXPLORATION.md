# Chrome vs Chromium: Why We Use Playwright's Bundled Chromium

## The Original Vision

When we built `$B connect`, the plan was to connect to the user's **real Chrome browser** — the one with their cookies, sessions, extensions, and open tabs. No more cookie import. The design called for:

1. `chromium.connectOverCDP(wsUrl)` connecting to a running Chrome via CDP
2. Quit Chrome gracefully, relaunch with `--remote-debugging-port=9222`
3. Access the user's real browsing context

This is why `chrome-launcher.ts` existed (361 LOC of browser binary discovery, CDP port probing, and runtime detection) and why the method was called `connectCDP()`.

## What Actually Happened

Real Chrome silently blocks `--load-extension` when launched via Playwright's `channel: 'chrome'`. The extension wouldn't load. We needed the extension for the side panel (activity feed, refs, chat).

The implementation fell back to `chromium.launchPersistentContext()` with Playwright's bundled Chromium — which reliably loads extensions via `--load-extension` and `--disable-extensions-except`. But the naming stayed: `connectCDP()`, `connectionMode: 'cdp'`, `BROWSE_CDP_URL`, `chrome-launcher.ts`.

The original vision (access user's real browser state) was never implemented. We launched a fresh browser every time — functionally identical to Playwright's Chromium, but with 361 lines of dead code and misleading names.

## The Discovery (2026-03-22)

During a `/office-hours` design session, we traced the architecture and discovered:

1. `connectCDP()` doesn't use CDP — it calls `launchPersistentContext()`
2. `connectionMode: 'cdp'` is misleading — it's just "headed mode"
3. `chrome-launcher.ts` is dead code — its only import was in an unreachable `attemptReconnect()` method
4. `preExistingTabIds` was designed for protecting real Chrome tabs we never connect to
5. `$B handoff` (headless → headed) used a different API (`launch()` + `newContext()`) that couldn't load extensions, creating two different "headed" experiences

## The Fix

### Renamed
- `connectCDP()` → `launchHeaded()`
- `connectionMode: 'cdp'` → `connectionMode: 'headed'`
- `BROWSE_CDP_URL` → `BROWSE_HEADED`

### Deleted
- `chrome-launcher.ts` (361 LOC)
- `attemptReconnect()` (dead method)
- `preExistingTabIds` (dead concept)
- `reconnecting` field (dead state)
- `cdp-connect.test.ts` (tests for deleted code)

### Converged
- `$B handoff` now uses `launchPersistentContext()` + extension loading (same as `$B connect`)
- One headed mode, not two
- Handoff gives you the extension + side panel for free

### Gated
- Sidebar chat behind `--chat` flag
- `$B connect` (default): activity feed + refs only
- `$B connect --chat`: + experimental standalone chat agent

## Architecture (after)

```
Browser States:
  HEADLESS (default) ←→ HEADED ($B connect or $B handoff)
     Playwright            Playwright (same engine)
     launch()              launchPersistentContext()
     invisible             visible + extension + side panel

Sidebar (orthogonal add-on, headed only):
  Activity tab    — always on, shows live browse commands
  Refs tab        — always on, shows @ref overlays
  Chat tab        — opt-in via --chat, experimental standalone agent

Data Bridge (sidebar → workspace):
  Sidebar writes to .context/sidebar-inbox/*.json
  Workspace reads via $B inbox
```

## Why Not Real Chrome?

Real Chrome blocks `--load-extension` when launched by Playwright. This is a Chrome security feature — extensions loaded via command-line args are restricted in Chromium-based browsers to prevent malicious extension injection.

Playwright's bundled Chromium doesn't have this restriction because it's designed for testing and automation. The `ignoreDefaultArgs` option lets us bypass Playwright's own extension-blocking flags.

If we ever want to access the user's real cookies/sessions, the path is:
1. Cookie import (already works via `$B cookie-import`)
2. Conductor session injection (future — sidebar sends messages to workspace agent)

Not reconnecting to real Chrome.
