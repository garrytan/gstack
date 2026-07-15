# How to test iOS apps with GStack iOS

This is the end-to-end walkthrough for the iOS QA capability that ships with gstack: install the canonical Swift templates into your app, connect a real iPhone over USB, and drive it from any agent (Claude Code locally, or any HTTP-capable agent over Tailscale). No simulators, no XCTest harness, no WebDriverAgent.

Everything below has been verified end-to-end on a real iPhone 17 Pro Max running iOS 26.5. The same flow works on any iOS 16+ device.

## What you'll need

- macOS with Xcode 16.0+ installed (`xcrun devicectl --version` must succeed). Xcode 16 ships the CoreDevice tunnel `devicectl` uses to reach the device over USB.
- A real iPhone running iOS 16 or later. Unlocked, paired with your Mac, with **Developer Mode** enabled in Settings → Privacy & Security.
- An Apple developer team — the free personal team works fine for live-device debug deploys. You'll need the team ID (e.g. `623FYQ2M88`), not the certificate ID. Find it in Xcode → Settings → Accounts → your Apple ID → team list. The setup signs the app for your device on first deploy via `-allowProvisioningUpdates -allowProvisioningDeviceRegistration`.
- gstack installed (`./setup` complete; `gstack-ios-qa-regen` and `gstack-ios-qa-daemon` must be on PATH).
- Bun runtime on PATH (`bun --version`). The Mac-side daemon is a bun process.

For the optional remote-agent (Tailscale) mode, you'll additionally need Tailscale installed on the Mac with `/var/run/tailscale.sock` readable.

## Architecture in one breath

```
┌─────────────────┐   tailnet (opt)    ┌──────────────────────┐   USB CoreDevice    ┌─────────────────────┐
│ Remote agent    │ ─────────────────▶ │ gstack-ios-qa-daemon │ ──────────────────▶ │ iOS app StateServer │
│ (Claude, GPT,   │  bearer + session  │  (Mac, bun/TS)       │  IPv6 ULA tunnel    │  (loopback only)    │
│  OpenClaw, ...) │                    │                      │                     │                     │
└─────────────────┘                    └──────────────────────┘                     └─────────────────────┘
```

- iOS app embeds a `StateServer` (`DebugBridge` SPM library, `#if DEBUG` only) listening on `::1` + `127.0.0.1` port 9999. Bearer-token gated. Boot token rotates within ~5 seconds of daemon spawn so anything scraping `os_log` past then sees a dead credential.
- Mac daemon brokers traffic over the CoreDevice IPv6 tunnel that `xcrun devicectl` opens automatically when a paired device is connected.
- In Tailscale mode, the daemon exposes a separate listener bound to your tailnet IP, with capability tiers (observe / interact / mutate / restore) enforced per session token. Tokens are minted explicitly by the Mac owner via `gstack-ios-qa-mint`; remote callers never auto-allowlist.

The iOS `StateServer` is loopback-only **always**, even in remote mode. Identity validation happens Mac-side because the iPhone has no way to validate a Tailscale identity.

## Step 1: Generate the DebugBridge package

Run `/ios-qa` from the app root, or invoke the same deterministic regenerator directly:

```bash
gstack-ios-qa-regen \
  --app-source "$PWD/Sources/YourApp" \
  --bridge-dir "$PWD/DebugBridge"
```

The command copies an explicit allowlist of canonical templates into the local
`DebugBridge/` Swift package, generates
`DebugBridgeGenerated/StateAccessor.swift`, and writes the installed version to
`DebugBridgeGenerated/.gstack-version`. It excludes generated output from its
own schema hash, so rerunning it with unchanged source is a fast, byte-stable
cache hit. It also removes the explicit legacy generated-file set from older
flat harness layouts so stale bridge sources cannot shadow the package.

1. Add `DebugBridge/` as a local package dependency. Depend on the
   `DebugBridgeUI` product only in Debug configuration; `DebugBridgeCore` and
   `DebugBridgeTouch` come in transitively.
2. Add `DebugBridgeGenerated/StateAccessor.swift` to the app target.
3. In your `@main` App init, install the UIKit resolvers before starting the
   server, then register the generated accessor. Replace the example
   state/accessor names with the type the generator found:

   ```swift
   #if DEBUG
   import DebugBridgeCore
   #if canImport(UIKit)
   import DebugBridgeUI
   #endif
   #endif

   // Inside App.init(), after appState is initialized:
   #if DEBUG
   #if canImport(UIKit)
   DebugBridgeUIWiring.installAll()
   #endif
   DebugBridgeManager.shared.start(
       appState: appState,
       register: AppStateAccessor.register
   )
   #endif
   ```

The three Swift targets split as: `DebugBridgeCore` is cross-platform (so `swift build` on a CI Mac host can validate the bulk of the code without UIKit), `DebugBridgeUI` and `DebugBridgeTouch` are iOS-only (they link UIKit). `DebugBridgeTouch` is Objective-C — it carries the KIF-derived UITouch synthesis with the iOS 18+ `_UIHitTestContext` fix that makes SwiftUI Button taps actually fire.

The structural Release-build guard is the `.when(configuration: .debug)` clause in `Package.swift`. SwiftPM refuses to link any `DebugBridge*` target in a Release build, so the bridge cannot ship to TestFlight even if you forget to clean up.

## Step 2: Build + install to the device

From the app's project directory:

```
xcodebuild \
  -scheme YourAppScheme \
  -configuration Debug \
  -destination 'generic/platform=iOS' \
  -derivedDataPath /tmp/build \
  -allowProvisioningUpdates -allowProvisioningDeviceRegistration \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM=YOUR_TEAM_ID \
  build
```

Then install + launch:

```
UDID=$(xcrun devicectl list devices 2>/dev/null | awk 'NR>2 && $0!="" {print $(NF-2); exit}')
xcrun devicectl device install app --device "$UDID" /tmp/build/Build/Products/Debug-iphoneos/YourApp.app
xcrun devicectl device process launch --device "$UDID" --terminate-existing your.bundle.id
```

If the phone is locked you'll get `FBSOpenApplicationServiceErrorDomain error 1 — Locked`. Unlock and retry. First-time installs surface a Trust dialog on the phone; tap Trust, then re-run.

## Step 3: Start the Mac-side daemon

Two options.

**Option A — let the skill spawn it.** Run `/ios-qa` in Claude Code from anywhere; the skill spawns the daemon on demand, bootstraps the tunnel, rotates the boot token, and exposes the device through the proxy. Cleanest path for local-USB use.

**Option B — start it yourself.** Run:

```
gstack-ios-qa-daemon
```

The daemon prints `READY: port=<n> pid=<pid>` once both loopback listeners are bound. The default port is 9099. Spawners can read that line with a ~5 second timeout to confirm readiness; you can also point `curl` at the printed port.

Either way the daemon takes an exclusive flock on `~/.gstack/ios-qa-daemon.pid` — running it twice from two Claude Code sessions is safe; the second invocation discovers the running daemon's port and joins.

Set these env vars to target a specific device or bundle:

```
GSTACK_IOS_TARGET_UDID=248C3A58-B843-5BDB-8F5D-89ADB7D7BF6A
GSTACK_IOS_TARGET_BUNDLE_ID=com.yourorg.yourapp
GSTACK_IOS_DAEMON_PORT=9099       # loopback listener port; default 9099
```

If `GSTACK_IOS_TARGET_UDID` is unset, the daemon picks the best paired,
available iPhone.
Automatic selection is restricted to available iPhones and prefers a wired
phone. The daemon keeps a healthy rotated tunnel, then invalidates and
rebootstraps once on an app-relaunch 401 or recoverable CoreDevice connection
failure.
If a newly started daemon reaches an already-running target whose one-use boot
token was consumed by an earlier daemon, it verifies the bundle owner, force
relaunches that target once, waits for a fresh token, verifies ownership again,
and rotates normally.

## Step 4: Drive the device

Once the daemon is running, you have an HTTP surface at `http://127.0.0.1:9099` (or `[::1]:9099`). The skill flow does this for you, but the raw endpoints are:

| Endpoint | What it does | Auth |
|---|---|---|
| `GET /healthz` | Version probe. | none (loopback) |
| `POST /auth/rotate` | Daemon-only; rotates the boot token to an in-memory-only value. | boot token |
| `POST /session/acquire` | Acquire the per-device session lock. Returns `{session_id, ttl_seconds}`. | bearer |
| `POST /session/release` | Release the lock. | bearer + session |
| `GET /screenshot` | Capture a PNG of the active window. Returns `{png_base64: "..."}`. | bearer |
| `GET /elements` | Accessibility-tree snapshot. | bearer |
| `GET /state/snapshot` | Dump every `// @Snapshotable` field as JSON. | bearer |
| `POST /state/restore` | Validate the full snapshot, then restore it on MainActor. | bearer + session, mutate tier |
| `POST /tap` `{x,y}` | Synthesize a real UITouch at window coordinates. SwiftUI Buttons fire. | bearer + session, interact tier |
| `POST /swipe` `{from_x,from_y,to_x,to_y}` | Scroll the nearest enclosing UIScrollView. | bearer + session, interact tier |
| `POST /type` `{text}` | Set text on the current first responder. | bearer + session, interact tier |

Mutating requests require both an `Authorization: Bearer <token>` header AND an `X-Session-Id` header. Read endpoints (`/screenshot`, `/elements`, `GET /state/*`) only need the bearer.

The state snapshot is opt-in per field via a standalone generator marker
comment immediately above a property. It is intentionally not a property
wrapper, so it compiles cleanly with Observation:

```swift
@Observable
final class AppState {
    // @Snapshotable
    var username: String = ""

    var authToken: String = "" // never exported
}
```

Unmarked fields never appear in the snapshot, which keeps tokens, PII, and
auth state out of recorded fixtures by default. A marked field must be a
writable instance `var` on a file-scope observable class, with an explicit type
and an internal or public setter. Supported snapshot types are JSON-native
scalars (`String`, `Bool`, signed/unsigned integer widths, `Float`, `Double`,
`CGFloat`), arrays, String-keyed dictionaries, and Optional compositions of
those types. Snapshot keys must be unique across observable classes. The
generator reports and stops on invalid declarations, custom values, implicitly
unwrapped Optionals, nested observable classes, or duplicate keys instead of
emitting broken or lossy Swift. Restore uses two phases: every model validates
the complete input first, and only then are assignments applied on MainActor.

## Step 5: Make remote agents work (optional)

To let an agent on another machine drive the device, run the daemon with `--tailnet`:

```
gstack-ios-qa-daemon --tailnet
```

The daemon probes `/var/run/tailscale.sock` first; if the socket is missing or unreadable, it refuses to open the tailnet listener at all (loopback still runs). Remote mode never half-starts.

Then mint a session token for the identity that should be able to connect:

```
gstack-ios-qa-mint grant --remote 'alice@example.com' --capability interact
gstack-ios-qa-mint grant --remote 'tag:ci' --capability mutate --ttl 86400 --note 'nightly'
gstack-ios-qa-mint list
```

Capability tiers are nested: `observe` (read endpoints only) ⊂ `interact` (taps, swipes, type) ⊂ `mutate` (`POST /state/*`) ⊂ `restore` (`POST /state/restore`). Pick the smallest tier that does the job. The allowlist file is at `~/.gstack/ios-qa-allowlist.json` (mode 0600) — the daemon reads it on every `/auth/mint` request, so changes take effect immediately without restarting.

The remote agent then hits `POST /auth/mint` against the daemon's tailnet listener. The daemon canonicalizes the caller's identity via tailscaled's WhoIs endpoint, checks the allowlist, and returns a short-lived session token (1 hour default, 24 hour cap). Every authenticated mutating request lands in `~/.gstack/security/ios-qa-audit.jsonl`; rejected requests land in `~/.gstack/security/attempts.jsonl`.

## Step 6: Ship a release build

Before you ship to TestFlight or the App Store, run `/ios-clean`. It removes the `DebugBridge` SPM dependency and strips the `#if DEBUG` wiring from your `@main` App. The structural guard in `Package.swift` (`condition: .when(configuration: .debug)`) means a Release build wouldn't link the bridge even if you forgot to clean up, but `/ios-clean` gives you a tidy diff to review and ship.

## Common failures

| Symptom | What broke |
|---|---|
| `xcodebuild` fails with `Could not locate device support files for iOS X.Y` | Run `xcodebuild -downloadPlatform iOS` to fetch the device support package for your iPhone's iOS version (~8GB). |
| Install succeeds, `process launch` fails with `Locked` | The phone is locked. Unlock and retry. |
| First install on a paired device fails with no clear error | The phone needs to Trust the Mac. Open Settings → General → VPN & Device Management on the phone and confirm. |
| `Developer Mode` toggle missing from Settings → Privacy | Connect the device to Xcode → Window → Devices and Simulators once, or try any `devicectl device install` against it. iOS will surface the toggle after the first attempt. |
| `xcrun devicectl device copy from` returns ERROR 7000 | The source path is wrong — boot token lives at `tmp/gstack-ios-qa.token` inside the app's data container (NSTemporaryDirectory), not at the path's root. |
| `/healthz` returns 200 but `/tap` returns ok:true with no UI change | The phone is paired but the StateServer port may have changed across launches. Re-resolve the CoreDevice IPv6 (`dscacheutil -q host -a name '<DeviceName>.coredevice.local'`). |
| `403 identity_not_allowed` from `/auth/mint` | The remote caller's identity isn't on the Mac's allowlist. Run `gstack-ios-qa-mint grant --remote <identity> --capability interact` on the Mac. |
| Daemon won't open the tailnet listener | Tailscale isn't installed, or `/var/run/tailscale.sock` is unreadable. Fix Tailscale, then restart the daemon. Loopback still runs in the meantime. |
| SwiftUI Button tap returns `ok:true` but the action never fires | You're on iOS 17 or older where `_UIHitTestContext` doesn't exist. The DebugBridgeTouch implementation falls back to plain `hitTest:` which doesn't resolve into SwiftUI's gesture container. Update to iOS 18+ on the device, or tap a UIKit control instead. |

## What this gets you

You can write an agent loop in any language that speaks HTTP. Take a screenshot, ask a model what to do, send a tap. Capture state snapshots before and after to record deterministic fixtures for `/ios-fix` regression tests. Add a colleague to the allowlist and they drive your iPhone from their laptop over Tailscale without ever touching the hardware. Plug the same daemon into CI by minting a `tag:ci` session token with mutate-tier capability and a 24-hour TTL.

The whole stack is a Mac you already own, an iPhone you already own, a free Apple developer account, and gstack. No paid testing service. No simulator drift. The thing the user sees is what the agent drives.
