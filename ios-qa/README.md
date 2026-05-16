# iStack: /ios-qa

AI-powered iOS QA testing that drives your REAL iPhone. Claude connects via USB CoreDevice tunnel, reads your Swift source, then systematically navigates every screen, mutates @Observable state, and finds bugs while you watch.

## The Demo Moment

You type `/ios-qa`. Claude reads your Swift source, understands your @Observable classes, connects to your phone over USB. A blue animated border appears on your phone. "Claude is debugging this app" shows at the top. Claude starts navigating, mutating state, taking screenshots, and filing bug reports with evidence.

## How It Works

```
┌─────────────────────────┐          ┌──────────────────────────────┐
│ Claude Code (Mac)       │          │ iPhone (debug build)         │
│                         │   USB    │                              │
│  /ios-qa skill          │◄────────►│  StateServer (HTTP :9999)    │
│  curl -6 http://[ipv6]  │ CoreDev  │    ├─ Screenshot capture     │
│       :9999/*           │  tunnel  │    ├─ Tap/Swipe/Type inject  │
│                         │          │    ├─ Accessibility tree     │
│  Agent loop:            │          │    ├─ @Observable state R/W  │
│   screenshot → analyze  │          │    └─ Device info            │
│   → decide → act →     │          │                              │
│   verify → repeat       │          │  DebugOverlay (visual):      │
│                         │          │    ├─ Blue animated border   │
│  Reports bugs with:     │          │    ├─ "Claude is debugging"  │
│   - screenshots         │          │    ├─ Action text display    │
│   - state evidence      │          │    └─ State mutation pulse   │
│   - file + line refs    │          │                              │
└─────────────────────────┘          └──────────────────────────────┘
```

**Connection:** Apple's CoreDevice USB tunnel provides direct IPv6 access. No WiFi, no Bonjour, no iproxy. Just `curl -6 http://[tunnel-ipv6]:9999`.

## Requirements

- macOS with Xcode 15+
- iPhone/iPad running iOS 17+ connected via USB
- App using `@Observable` classes (iOS 17 Observation framework)
- CoreDevice tunnel active (automatic when device is connected and trusted)

## Quick Start

```bash
# 1. Find your device tunnel IP
xcrun devicectl list devices 2>&1 | grep connected
xcrun devicectl device info details --device <ID> 2>&1 | grep tunnelIPAddress

# 2. Verify connection (substitute your IPv6)
curl -s -6 http://[fdac:e671:bcd7::1]:9999/health
# → {"status":"ok"}

# 3. Run the skill
/ios-qa
```

## What the Skill Does

1. **Reads source** - scans every ViewModel, View, Model file to understand the app
2. **Generates DebugBridge** (first run) - creates StateServer + typed accessors for your @Observable classes
3. **Connects** - discovers device via `xcrun devicectl`, hits the HTTP StateServer
4. **Runs agent loop** - screenshot, analyze with vision, tap/swipe/type, verify state, repeat
5. **Reports bugs** - structured report with severity, file references, screenshots, state evidence

## API (StateServer Endpoints)

| Endpoint | Method | Returns |
|----------|--------|---------|
| `/health` | GET | `{"status":"ok"}` |
| `/screenshot` | GET | `{"image":"<base64 PNG>"}` |
| `/elements` | GET | JSON array: label, center, frame, traits, interactive |
| `/tap` | POST | Inject tap at `{"x":N,"y":N}` |
| `/swipe` | POST | Swipe `{"fromX","fromY","toX","toY"}` |
| `/type` | POST | Type `{"text":"..."}` into focused field |
| `/device` | GET | Model, OS, screen size, safe area |
| `/state` | GET | All registered state keys |
| `/state/{key}` | GET | Read @Observable property value |
| `/state/{key}` | POST | Write @Observable property (body = new value) |

## Templates

| File | Lines | Purpose |
|------|-------|---------|
| `Package.swift.template` | 22 | SPM manifest (iOS 17+, debug-only) |
| `StateServer.swift.template` | 497 | HTTP server (NWListener): screenshot, tap, swipe, type, elements, state |
| `DebugOverlay.swift.template` | 204 | Blue animated border + "Claude is debugging" header |
| `DebugBridgeManager.swift.template` | 40 | Singleton that starts StateServer + registers accessors |
| `DebugBridgeJSON.swift.template` | 21 | JSON serialization helper |
| `StateAccessor.swift.template` | 39 | Per-class typed read/write accessor pattern |

`DebugBridge/` is a standalone SPM package. Typed state accessors are generated into `<App>/DebugBridgeGenerated/` and added to the app target.

## Integration (2 lines)

```swift
#if DEBUG
import DebugBridge

// In your App struct:
var body: some Scene {
    WindowGroup {
        ContentView()
            .debugBridgeOverlay()
            .task { DebugBridgeManager.shared.start(viewModel1: vm1, viewModel2: vm2) }
    }
}
#endif
```

## Example Results

Tested against QuickShop (demo e-commerce app). Found 5/5 planted bugs:

| Bug | Severity | What |
|-----|----------|------|
| BUG-001 | High | Cart total not recalculated after quantity change |
| BUG-002 | Critical | Force-unwrap crash on empty cart checkout |
| BUG-003 | Medium | AsyncImage URLs fail (missing percent-encoding) |
| BUG-004 | High | Stale cached user after logout/re-login |
| BUG-005 | High | .fixedSize() breaks layout on long product names |

## What's NOT Here

- No simulator (real device only, you watch it happen)
- No XCTest (HTTP + accessibility, not test frameworks)
- No iproxy (CoreDevice tunnel directly, not usbmuxd)
- No auth (debug builds only, USB connection required)
- No external dependencies (just `curl` and `xcrun devicectl`)
