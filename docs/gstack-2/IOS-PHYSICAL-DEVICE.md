# iOS physical-device harness

`ios-qa/scripts/physical-device-smoke.ts` is the real-iPhone deployment lane for the existing DebugBridge backend. It uses Xcode, `devicectl`, and the daemon's CoreDevice tunnel bootstrap. It does not add an Appium, XCUITest, WebDriverAgent, simulator, or cloud-device backend.

The harness is intentionally fail-closed. A setup problem is not a product failure, and neither one is a pass.

## Current validation status

The earlier target was validated locally at the July 17, 2026 checkpoint with
Xcode 26.6:

| Identifier kind | Example form | Used for |
|---|---|---|
| Hardware UDID | `<hardware-udid>` | Xcode build destination |
| CoreDevice UUID | `<coredevice-uuid>` | `devicectl`, tunnel bootstrap, install, launch |

Exact local identifiers are deliberately not committed. Successful evidence stores only a SHA-256 fingerprint derived from both identifiers and omits the user-assigned device name.

The daemon suite is green at 95 pass / 0 fail and 229 assertions. For that
earlier target, the physical E2E preflight records 9 pass / 0 fail / 1 deploy
skip and 29 assertions. Its host, pairing/trust, Developer Mode, wired
transport, `devicectl`, `xcodegen`, and DevToolsSecurity gates pass. The
unsigned Release build also passes and contains no DebugBridge module symbols
or artifacts.

The earlier direct physical-device smoke was externally blocked at automatic
signing. It returned typed code `signing_unavailable`, category `setup_gate`. The
underlying Xcode diagnostic is:

```text
Signing for "FixtureApp" requires a development team.
```

That is a setup gate, not a DebugBridge failure. No app was installed or
launched, and no pass artifact was written. The deploy skip and typed smoke
failure must not be represented as a physical-device pass.

The next user-selected target was a legacy iPhone (`iPhone10,6`) on iOS
16.7.10. Its lockdown/USB pairing validates, but `devicectl` reports
`pairingState=unsupported`, no wired CoreDevice transport, and pairing fails
with CoreDevice error 1011. The harness therefore returns typed code
`device_not_wired` before build or deploy. Because CoreDevice is the locked
backend, substituting a legacy or third-party device driver would not satisfy
this gate; a CoreDevice-compatible iPhone is required.

The user then explicitly authorized the other connected, CoreDevice-compatible
iPhone. That run passed pairing, signing, build, install, launch, and tunnel
setup. The full five-check loop did not complete: `POST /session/acquire`
closed the socket before returning a session. At harness stop, the fixture app
was left installed with its data intact and no console/device session remained
attached. This is a retained operator observation, not a pass artifact; no pass
artifact was written.

The user then explicitly stopped and waived further iPhone testing. No more
device access is authorized for this checkpoint. The preflight, Release guard,
typed setup-gate failures, and partial signed deployment above remain valid
evidence, but the waiver does not convert them into a P0 pass: the five-check
loop did not complete and no pass artifact exists.

## Hardware UDID versus CoreDevice UUID

An iPhone has two identifiers relevant to this flow:

- The hardware UDID is the stable device identifier shown by Xcode. `xcodebuild -destination 'platform=iOS,id=…'` uses it.
- The CoreDevice UUID is the session-facing identifier in `devicectl` JSON. Device inspection, install, launch, app-container copy, and tunnel keepalive use it.

The harness accepts either value through `--device` or `GSTACK_IOS_TARGET_UDID`. It matches the supplied value against both fields, then uses the correct identifier for each tool. It never assumes they are interchangeable internally.

Inspect both values with:

```bash
tmp=$(mktemp)
xcrun devicectl list devices --json-output "$tmp"
jq '.result.devices[] | {
  name: .deviceProperties.name,
  coreDeviceUUID: .identifier,
  hardwareUDID: .hardwareProperties.udid,
  transport: .connectionProperties.transportType,
  pairing: .connectionProperties.pairingState,
  developerMode: .deviceProperties.developerModeStatus
}' "$tmp"
rm "$tmp"
```

If exactly one wired iPhone is visible, the harness selects it. If selection is ambiguous, it refuses to guess and prints both identifier forms.

## Setup gates

Run the non-deploying preflight first:

```bash
GSTACK_IOS_TARGET_UDID=<hardware-UDID-or-CoreDevice-UUID> \
  bun run ios-qa/scripts/physical-device-smoke.ts --preflight-only --json
```

The preflight checks these gates before any build or install:

| Gate | Exact remediation |
|---|---|
| Full Xcode selected | `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer` |
| First-launch components/license | `sudo xcodebuild -runFirstLaunch` |
| `devicectl` available | Verify `xcrun --find devicectl`; repair or update Xcode if missing |
| `xcodegen` available | `brew install xcodegen` |
| macOS DevToolsSecurity | `sudo DevToolsSecurity -enable`, then `DevToolsSecurity -status` |
| Wired iPhone | Connect directly over USB, unlock it, and accept the accessory prompt |
| Pairing and trust | `xcrun devicectl manage pair --device <CoreDevice-UUID>`, tap Trust, enter the iPhone passcode |
| iPhone Developer Mode | Settings > Privacy & Security > Developer Mode; enable, restart, unlock, and confirm Enable |
| CoreDevice management surface | Keep the phone unlocked and verify `xcrun devicectl device info processes --device <CoreDevice-UUID>` |

DevToolsSecurity and iPhone Developer Mode are separate gates. DevToolsSecurity authorizes developer tools on the Mac. Developer Mode authorizes development services on the iPhone.

### Signing and provisioning

The temporary Xcode project contains no hardcoded account or development team. The Debug build always requests automatic signing and provisioning updates.

To unblock signing:

1. Open Xcode > Settings > Accounts.
2. Add the Apple ID that owns the development team.
3. Create or download an Apple Development certificate.
4. Leave the iPhone connected and unlocked so Xcode can register it.
5. Optionally select a team explicitly for the harness:

```bash
export GSTACK_IOS_DEVELOPMENT_TEAM=<10-character-team-id>
```

`GSTACK_IOS_TEAM_ID` is accepted as a compatibility alias. If both variables are present and disagree, the harness stops. It never discovers a team and silently hardcodes it.

## Install safety

The deployment fixture uses the reserved bundle ID:

```text
com.gstack.iosqa.fixture.gstack2
```

Before building, the harness asks `devicectl` whether that exact bundle ID is already installed.

- No match: installation may proceed.
- A clearly identified prior `FixtureApp`: an in-place fixture update may proceed; app data is preserved.
- An app with the same bundle ID that does not identify as the fixture: the harness refuses to replace it.

Only after inspecting a conflict may an operator explicitly allow an in-place replacement:

```bash
export GSTACK_IOS_ALLOW_REPLACE_FIXTURE=1
```

The harness never uninstalls an app and never deletes app data. It uses `devicectl device install app` only after the conflict check.

## Build, deploy, and verify

The full lane is opt-in in the Bun E2E test:

```bash
GSTACK_HAS_IOS_DEVICE=1 \
GSTACK_IOS_DEVICE_DEPLOY=1 \
GSTACK_IOS_TARGET_UDID=<hardware-UDID-or-CoreDevice-UUID> \
  bun test test/skill-e2e-ios-device.test.ts
```

It can also run directly:

```bash
GSTACK_IOS_TARGET_UDID=<hardware-UDID-or-CoreDevice-UUID> \
  bun run ios-qa/scripts/physical-device-smoke.ts --json
```

The harness performs these phases:

1. Copies `test/fixtures/ios-qa/FixtureApp` into a new temporary directory, excluding previous build output and the fixture's unrelated signing spec.
2. Generates a team-neutral Release project with `xcodegen`, builds it unsigned for iPhoneOS, and scans the app executable and bundle for DebugBridge module names/artifacts.
3. Regenerates the Debug project with local DebugBridge package products, then asks Xcode for automatic signing/provisioning. An optional team comes only from the environment.
4. Checks the reserved bundle ID on the selected phone, installs without uninstalling or erasing data, and launches a fresh foreground fixture process.
5. Captures the short-lived boot token, calls the existing `bootstrapTunnel`, rotates the credential, and starts the existing CoreDevice tunnel keepalive.
6. Runs all five live iterations. A partial run is never promoted to pass evidence.

## The five checks in every iteration

Each of the five iterations executes the same five real-device checks:

| Check | Required evidence |
|---|---|
| Health and bundle | `/healthz` returns `com.gstack.iosqa.fixture.gstack2` before and after the tap |
| Token rotation | Reusing the captured original boot token returns `401 boot_token_invalid` while the rotated credential remains usable |
| Session acquire | `/session/acquire` returns a session ID; the session is released even on failure |
| Screenshot and elements | `/screenshot` returns a valid PNG and `/elements` returns a live accessibility tree containing `tap-button` |
| Coordinate tap and cleanup | A center-coordinate `/tap` reports the expected active bundle before/after, the button count and screenshot both change, state is snapshotted/restored if needed, and the session is released |

The loop records no bearer tokens or session IDs. It continues through all five iteration slots to make a 5/5 claim meaningful, then fails the run if any iteration failed.

## Evidence policy

JSON evidence is written atomically under `docs/gstack-2/evidence/` only after:

- the Release guard passes;
- Debug signing, build, install, launch, and daemon bootstrap pass;
- all five iterations pass all five checks;
- the final session is released;
- the keepalive is stopped; and
- the temporary workspace is removed.

Setup-gate failures, safety refusals, product failures, and partial live runs create no evidence file. A signing error must never be represented as a live pass.

## Failure categories

The CLI emits a typed `GSTACK_IOS_PHYSICAL_DEVICE_ERROR` JSON object and uses these categories:

| Category | Exit code | Meaning |
|---|---:|---|
| `setup_gate` | 2 | Host, cable, trust, Developer Mode, account, certificate, provisioning, or CoreDevice setup prevents the product from being exercised |
| `safety_refusal` | 3 | The harness cannot prove an install is safe, usually because of an unrelated bundle-ID conflict |
| `product_failure` | 1 | The fixture or DebugBridge compiled incorrectly, leaked into Release, failed install/launch/bootstrap, or failed a live assertion |

Fix setup gates without filing them as DebugBridge regressions. Treat a product failure as actionable only after all setup gates pass.

## Cleanup guarantees

Every session release is in a `finally` path. The outer cleanup stops the CoreDevice keepalive and removes the harness-owned temporary workspace whether the run passes or fails. The fixture remains installed and its data remains intact; uninstalling or deleting its data requires separate, explicit operator approval.
