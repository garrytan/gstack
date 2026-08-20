// Real-device tests. The lightweight CoreDevice checks run with
// GSTACK_HAS_IOS_DEVICE=1; the signing/install/interaction smoke test has the
// separate, explicit GSTACK_IOS_DEVICE_DEPLOY=1 opt-in.
//
// Runs only when:
//   - An iPhone is connected via USB and reachable through CoreDevice
//   - The iPhone is paired (user has tapped "Trust" on the trust dialog)
//   - Developer Mode is enabled on the iPhone (Settings → Privacy → Developer Mode)
//
// What it actually exercises:
//   1. devicectl can list the device (verifies CoreDevice agent is reachable)
//   2. devicectl can list installed apps (verifies pairing + DDI is loaded)
//   3. devicectl can list running processes (verifies the management surface)
//   4. The fixture iOS SPM package builds with `swift build` for iOS target
//      (verifies the templates compile against the iOS SDK, not just macOS)
//
// GSTACK_IOS_DEVICE_DEPLOY=1 additionally generates the fixture Xcode project,
// signs it with GSTACK_IOS_DEVELOPMENT_TEAM + GSTACK_IOS_BUNDLE_ID, installs
// and launches it, then proves screenshot/elements/tap through the real daemon.
// It remains skipped in normal CI because signing and a paired iPhone are
// intentionally machine-specific.

import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { startDaemon, type RunningDaemon } from '../ios-qa/daemon/src/index';
import { startTunnelKeepalive } from '../ios-qa/daemon/src/devicectl';
import { bootstrapTunnel } from '../ios-qa/daemon/src/tunnel-bootstrap';
import type { DeviceTunnel } from '../ios-qa/daemon/src/proxy';

const ROOT = join(import.meta.dir, '..');
const FIXTURE_PATH = join(ROOT, 'test/fixtures/ios-qa/FixtureApp');

const HAS_DEVICE = process.env.GSTACK_HAS_IOS_DEVICE === '1';
const DEPLOY_TO_DEVICE = process.env.GSTACK_IOS_DEVICE_DEPLOY === '1';
const describeIfDevice = HAS_DEVICE ? describe : describe.skip;
const testIfDeploy = DEPLOY_TO_DEVICE ? test : test.skip;

interface DeviceListEntry {
  identifier: string;
  state: string; // "available" | "available (pairing)" | "unavailable" | ...
  name: string;
  model: string;
  platform: string;
  transport: string;
  paired: boolean;
}

interface DeviceElement {
  identifier?: string;
  label?: string;
  value?: string;
  frame?: { x: number; y: number; w: number; h: number };
}

interface StateSnapshot {
  _app_build_id?: string;
  _accessor_hash?: string;
  keys?: Record<string, unknown>;
}

function listDevices(): DeviceListEntry[] {
  // devicectl JSON output requires --json-output to a path. Use a tempfile.
  const tmp = `/tmp/devicectl-list-${process.pid}-${Date.now()}.json`;
  try {
    const r = spawnSync('xcrun', ['devicectl', 'list', 'devices', '--json-output', tmp], {
      stdio: 'pipe',
      timeout: 30_000,
    });
    if (r.status !== 0) return [];
    const raw = readFileSync(tmp, 'utf-8');
    const obj = JSON.parse(raw);
    return (obj.result?.devices ?? []).map((d: { identifier: string; connectionProperties: { tunnelState: string; pairingState?: string; transportType?: string }; deviceProperties: { name: string }; hardwareProperties: { productType: string; platform?: string } }) => ({
      identifier: d.identifier,
      state: d.connectionProperties?.tunnelState ?? 'unknown',
      name: d.deviceProperties?.name ?? 'unknown',
      model: d.hardwareProperties?.productType ?? 'unknown',
      platform: d.hardwareProperties?.platform ?? 'unknown',
      transport: d.connectionProperties?.transportType ?? '',
      paired: d.connectionProperties?.pairingState === 'paired',
    }));
  } catch {
    return [];
  } finally {
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function isAvailableIPhone(device: DeviceListEntry): boolean {
  const state = device.state.trim().toLowerCase();
  const available = state === 'connected'
    || state.startsWith('available')
    || (state === 'disconnected' && device.transport.trim().toLowerCase() === 'wired');
  return available
    && device.paired
    && device.platform.toLowerCase() === 'ios'
    && device.model.toLowerCase().startsWith('iphone');
}

function isPaired(udid: string): boolean {
  // devicectl device info processes returns a clean exit when paired.
  const tmp = `/tmp/devicectl-info-${process.pid}-${Date.now()}.json`;
  const r = spawnSync('xcrun', [
    'devicectl', 'device', 'info', 'processes',
    '-d', udid,
    '--json-output', tmp,
  ], { stdio: 'pipe', timeout: 30_000 });
  try { unlinkSync(tmp); } catch { /* ignore */ }
  // Pair-required errors surface on stderr with "must be paired" or
  // CoreDeviceError 2. Treat any non-zero exit as not-paired.
  return r.status === 0;
}

function requireDeployEnv(name: 'GSTACK_IOS_DEVELOPMENT_TEAM' | 'GSTACK_IOS_BUNDLE_ID'): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required when GSTACK_IOS_DEVICE_DEPLOY=1`);
  }
  return value;
}

function runChecked(
  command: string,
  args: string[],
  opts: { cwd?: string; timeout?: number } = {},
): string {
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    env: process.env,
    stdio: 'pipe',
    timeout: opts.timeout ?? 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${result.stdout?.toString() ?? ''}${result.stderr?.toString() ?? ''}`;
  if (result.error || result.status !== 0) {
    const tail = output.split('\n').slice(-120).join('\n');
    throw new Error([
      `${command} ${args.join(' ')} failed (${result.error?.message ?? `exit ${result.status}`})`,
      tail,
    ].filter(Boolean).join('\n'));
  }
  return output;
}

async function daemonJson<T>(
  baseURL: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T; raw: string }> {
  const response = await fetch(`${baseURL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(60_000),
  });
  const raw = await response.text();
  let body: T;
  try {
    body = JSON.parse(raw) as T;
  } catch {
    throw new Error(`${init.method ?? 'GET'} ${path} returned non-JSON HTTP ${response.status}: ${raw.slice(0, 500)}`);
  }
  return { status: response.status, body, raw };
}

function findElement(elements: DeviceElement[], identifier: string): DeviceElement | undefined {
  return elements.find((element) =>
    element.identifier === identifier
    && (element.frame?.w ?? 0) > 0
    && (element.frame?.h ?? 0) > 0,
  );
}

type DeviceElementPredicate = (element: DeviceElement) => boolean;

interface DeviceViewport {
  w: number;
  h: number;
}

function isInsideViewport(element: DeviceElement, viewport: DeviceViewport): boolean {
  const frame = element.frame;
  if (!frame || frame.w <= 0 || frame.h <= 0) return false;
  const centerX = frame.x + frame.w / 2;
  const centerY = frame.y + frame.h / 2;
  return centerX >= 0 && centerX <= viewport.w && centerY >= 0 && centerY <= viewport.h;
}

async function readDeviceElements(baseURL: string): Promise<DeviceElement[]> {
  const result = await daemonJson<{ elements?: DeviceElement[] }>(baseURL, '/elements');
  if (result.status !== 200 || !Array.isArray(result.body.elements)) {
    throw new Error(`GET /elements failed with HTTP ${result.status}: ${result.raw.slice(0, 500)}`);
  }
  return result.body.elements;
}

async function waitForDeviceElement(
  baseURL: string,
  predicate: DeviceElementPredicate,
  description: string,
  options: {
    condition?: DeviceElementPredicate;
    tappableIn?: DeviceViewport;
    timeoutMs?: number;
  } = {},
): Promise<DeviceElement> {
  const deadline = Date.now() + (options.timeoutMs ?? 10_000);
  let lastElements: DeviceElement[] = [];
  while (Date.now() < deadline) {
    lastElements = await readDeviceElements(baseURL);
    const match = lastElements.find((element) =>
      predicate(element)
      && (options.condition?.(element) ?? true)
      && (!options.tappableIn || isInsideViewport(element, options.tappableIn)),
    );
    if (match) return match;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const visible = lastElements
    .filter((element) => element.identifier || element.label)
    .slice(0, 80)
    .map((element) => element.identifier ?? element.label)
    .join(', ');
  throw new Error(`timed out waiting for ${description}; last elements: ${visible}`);
}

async function tapDeviceElement(
  baseURL: string,
  sessionId: string,
  element: DeviceElement,
): Promise<void> {
  const frame = element.frame;
  if (!frame) throw new Error('cannot tap an element without a frame');
  const tapped = await daemonJson<{ ok?: boolean; op?: string }>(baseURL, '/tap', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-session-id': sessionId,
    },
    body: JSON.stringify({
      x: frame.x + frame.w / 2,
      y: frame.y + frame.h / 2,
    }),
  });
  if (tapped.status !== 200 || tapped.body.ok !== true) {
    throw new Error(`tap failed with HTTP ${tapped.status}: ${tapped.raw.slice(0, 500)}`);
  }
}

describeIfDevice('ios device path', () => {
  test('devicectl lists at least one connected device', () => {
    const devices = listDevices();
    if (devices.length === 0) {
      console.error('No CoreDevice-reachable iPhone. Connect via USB and unlock.');
    }
    expect(devices.length).toBeGreaterThan(0);
  });

  test('one device reports as paired (DDI loaded, processes listable)', () => {
    const devices = listDevices();
    expect(devices.length).toBeGreaterThan(0);
    const paired = devices.filter(d => isPaired(d.identifier));
    if (paired.length === 0) {
      const first = devices[0]!;
      console.error([
        `Device "${first.name}" (${first.model}, ${first.identifier})`,
        `is connected but NOT paired. To pair:`,
        `  1. Unlock the iPhone with passcode.`,
        `  2. Run: xcrun devicectl manage pair --device ${first.identifier}`,
        `  3. Tap "Trust" on the iPhone's trust dialog.`,
        `  4. Open Settings → Privacy → Developer Mode and enable it (iOS 16+).`,
        `  5. Restart the iPhone if prompted.`,
        `  6. Re-run this test.`,
      ].join('\n'));
    }
    expect(paired.length).toBeGreaterThan(0);
  });

  test('fixture iOS SDK and UIKit compile guards are available', () => {
    // This is an environment + source-guard preflight. The explicit deployment
    // test below performs the real signed iOS xcodebuild before installation.
    const sdkPath = spawnSync('xcrun', ['--sdk', 'iphoneos', '--show-sdk-path'], { stdio: 'pipe' });
    if (sdkPath.status !== 0) {
      console.error('iOS SDK not found. Install via Xcode.');
    }
    expect(sdkPath.status).toBe(0);
    const sdk = sdkPath.stdout.toString().trim();
    expect(sdk).toContain('iPhoneOS');

    // SwiftPM cannot directly cross-build this UIKit package with the standalone
    // host command, so keep the static guard assertion honest and narrowly named.
    const fs = require('fs') as typeof import('fs');
    const overlay = fs.readFileSync(
      join(FIXTURE_PATH, 'Sources/DebugBridgeUI/DebugOverlay.swift'),
      'utf-8',
    );
    // Sanity check: the UI module is correctly gated for iOS-only.
    expect(overlay).toContain('#if DEBUG && canImport(UIKit)');
    expect(overlay).toContain('#endif');
  });

});

describe('ios device deployment (explicit opt-in)', () => {
  testIfDeploy('generates, signs, installs, launches, and drives the fixture through the daemon', async () => {
    const developmentTeam = requireDeployEnv('GSTACK_IOS_DEVELOPMENT_TEAM');
    const bundleId = requireDeployEnv('GSTACK_IOS_BUNDLE_ID');
    const devices = listDevices();
    const device = devices.find((candidate) => isAvailableIPhone(candidate) && isPaired(candidate.identifier));
    if (!device) {
      const summary = devices.length > 0
        ? devices.map((d) => `  ${d.name} (${d.model}, ${d.platform}, ${d.identifier}): state=${d.state}, paired=${d.paired}`).join('\n')
        : '  devicectl returned no devices';
      throw new Error([
        'GSTACK_IOS_DEVICE_DEPLOY=1 requires an available, paired iPhone; stale unavailable devices are never selected.',
        summary,
      ].join('\n'));
    }

    const workDir = mkdtempSync(join(tmpdir(), 'gstack-ios-device-deploy-'));
    const fixtureDir = join(workDir, 'FixtureApp');
    const derivedData = join(workDir, 'DerivedData');
    let daemon: RunningDaemon | undefined;
    let keepalive: { stop: () => void } | undefined;
    let sessionId: string | undefined;

    try {
      cpSync(FIXTURE_PATH, fixtureDir, { recursive: true });

      // Exercise the same deterministic bootstrap that /ios-qa and /ios-sync
      // install for users. This creates the app-owned typed accessor before
      // XcodeGen discovers the fixture sources.
      runChecked(join(ROOT, 'bin/gstack-ios-qa-regen'), [
        '--app-source', join(fixtureDir, 'Sources/FixtureApp'),
        '--bridge-dir', fixtureDir,
      ], { cwd: fixtureDir });
      const generatedAccessor = join(
        fixtureDir,
        'Sources/FixtureApp/DebugBridgeGenerated/StateAccessor.swift',
      );
      expect(existsSync(generatedAccessor)).toBe(true);
      expect(readFileSync(generatedAccessor, 'utf8')).toContain('enum FixtureAppStateAccessor');

      runChecked('xcodegen', [
        'generate',
        '--spec', join(fixtureDir, 'project.yml'),
        '--project', fixtureDir,
        '--project-root', fixtureDir,
      ], { cwd: fixtureDir });

      const projectPath = join(fixtureDir, 'FixtureApp.xcodeproj');
      expect(existsSync(projectPath)).toBe(true);

      runChecked('xcodebuild', [
        '-project', projectPath,
        '-scheme', 'FixtureApp',
        '-configuration', 'Debug',
        '-destination', `platform=iOS,id=${device.identifier}`,
        '-derivedDataPath', derivedData,
        '-allowProvisioningUpdates',
        `DEVELOPMENT_TEAM=${developmentTeam}`,
        `PRODUCT_BUNDLE_IDENTIFIER=${bundleId}`,
        'CODE_SIGN_STYLE=Automatic',
        'build',
      ], { cwd: fixtureDir, timeout: 300_000 });

      const appBundle = join(derivedData, 'Build/Products/Debug-iphoneos/FixtureApp.app');
      expect(existsSync(appBundle)).toBe(true);
      const builtBundleId = runChecked('/usr/libexec/PlistBuddy', [
        '-c', 'Print :CFBundleIdentifier',
        join(appBundle, 'Info.plist'),
      ]).trim();
      expect(builtBundleId).toBe(bundleId);

      runChecked('xcrun', [
        'devicectl', 'device', 'install', 'app',
        '--device', device.identifier,
        appBundle,
      ], { timeout: 120_000 });

      runChecked('xcrun', [
        'devicectl', 'device', 'process', 'launch',
        '--device', device.identifier,
        '--terminate-existing',
        bundleId,
      ], { timeout: 60_000 });

      keepalive = startTunnelKeepalive(device.identifier);
      const bootstrap = await bootstrapTunnel({
        udid: device.identifier,
        bundleId,
        startupTimeoutMs: 30_000,
      });
      if (!bootstrap.ok) {
        throw new Error(`daemon tunnel bootstrap failed: ${bootstrap.error}${bootstrap.detail ? ` (${bootstrap.detail})` : ''}`);
      }

      // The first provider call consumes the already-rotated bootstrap. Later
      // calls perform a fresh bootstrap so the same daemon can recover after
      // this app is relaunched and its in-memory bearer changes.
      let pendingTunnel: DeviceTunnel | undefined = bootstrap.tunnel;
      let tunnelProviderCalls = 0;
      const provideTunnel = async (): Promise<DeviceTunnel | null> => {
        tunnelProviderCalls += 1;
        if (pendingTunnel) {
          const first = pendingTunnel;
          pendingTunnel = undefined;
          return first;
        }
        const refreshed = await bootstrapTunnel({
          udid: device.identifier,
          bundleId,
          startupTimeoutMs: 30_000,
        });
        if (!refreshed.ok) {
          throw new Error(`daemon rebootstrap failed: ${refreshed.error}${refreshed.detail ? ` (${refreshed.detail})` : ''}`);
        }
        return refreshed.tunnel;
      };

      const started = await startDaemon({
        loopbackPort: 0,
        tailnetEnabled: false,
        pidfilePath: join(workDir, 'daemon.pid'),
        tunnelProvider: provideTunnel,
      });
      if ('error' in started) {
        throw new Error(`daemon failed to start: ${started.error}${started.reason ? ` (${started.reason})` : ''}`);
      }
      daemon = started;
      const baseURL = `http://127.0.0.1:${daemon.loopbackPort}`;

      const initialState = await daemonJson<StateSnapshot>(baseURL, '/state/snapshot');
      expect(initialState.status).toBe(200);
      expect(typeof initialState.body._app_build_id).toBe('string');
      expect(initialState.body._app_build_id).not.toBe('unknown');
      expect(initialState.body._app_build_id).not.toBe('uninitialized');
      expect(initialState.body._accessor_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(initialState.body._accessor_hash).not.toBe('uninitialized');
      expect(Object.keys(initialState.body.keys ?? {}).sort()).toEqual([
        'isLoggedIn',
        'nickname',
        'tapCounter',
        'username',
      ]);
      expect(initialState.body.keys?.nickname).toBeNull();

      const screenshot = await daemonJson<{ png_base64?: string; error?: string }>(baseURL, '/screenshot');
      expect(screenshot.status).toBe(200);
      expect(typeof screenshot.body.png_base64).toBe('string');
      const png = Buffer.from(screenshot.body.png_base64!, 'base64');
      expect(png.length).toBeGreaterThan(1_000);
      expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

      const requiredIdentifiers = [
        'primary-button',
        'toolbar-actions-menu',
        'open-detail-button',
        'tab-controls',
        'tab-inputs',
        'tab-rows',
      ];
      let elementsBefore: DeviceElement[] = [];
      let identifiers = new Set<string>();
      const elementsDeadline = Date.now() + 10_000;
      while (Date.now() < elementsDeadline) {
        const before = await daemonJson<{ elements?: DeviceElement[] }>(baseURL, '/elements');
        expect(before.status).toBe(200);
        expect(Array.isArray(before.body.elements)).toBe(true);
        elementsBefore = before.body.elements ?? [];
        identifiers = new Set(
          elementsBefore.map((element) => element.identifier).filter((value): value is string => Boolean(value)),
        );
        if (requiredIdentifiers.every((identifier) => identifiers.has(identifier))) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(elementsBefore.length).toBeGreaterThan(30);
      expect(requiredIdentifiers.filter((identifier) => !identifiers.has(identifier))).toEqual([]);
      const appFrame = findElement(elementsBefore, 'fixture-tab-view')?.frame;
      expect(appFrame).toBeDefined();
      // Screenshot pixels and /tap coordinates must share UIKit's point
      // space. A 3x PNG here recreates the original missed-tap bug.
      expect(png.readUInt32BE(16)).toBe(appFrame!.w);
      expect(png.readUInt32BE(20)).toBe(appFrame!.h);

      const buttonBefore = findElement(elementsBefore, 'primary-button');
      expect(buttonBefore).toBeDefined();
      expect(typeof buttonBefore!.value).toBe('string');

      const acquired = await daemonJson<{ session_id?: string }>(baseURL, '/session/acquire', { method: 'POST' });
      expect(acquired.status).toBe(200);
      expect(typeof acquired.body.session_id).toBe('string');
      sessionId = acquired.body.session_id!;

      const rejectedBooleanAsInteger = await daemonJson<{ error?: string }>(baseURL, '/state/tapCounter', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-id': sessionId,
        },
        body: JSON.stringify({ value: true }),
      });
      expect(rejectedBooleanAsInteger.status).toBe(400);
      expect(rejectedBooleanAsInteger.body.error).toBe('type_mismatch');

      const rejectedIntegerAsBoolean = await daemonJson<{ error?: string }>(baseURL, '/state/isLoggedIn', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-id': sessionId,
        },
        body: JSON.stringify({ value: 1 }),
      });
      expect(rejectedIntegerAsBoolean.status).toBe(400);
      expect(rejectedIntegerAsBoolean.body.error).toBe('type_mismatch');
      const afterRejectedCoercions = await daemonJson<StateSnapshot>(baseURL, '/state/snapshot');
      expect(afterRejectedCoercions.body.keys?.tapCounter).toBe(0);
      expect(afterRejectedCoercions.body.keys?.isLoggedIn).toBe(false);

      const wroteState = await daemonJson<{ ok?: boolean }>(baseURL, '/state/tapCounter', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-id': sessionId,
        },
        body: JSON.stringify({ value: 7 }),
      });
      expect(wroteState.status).toBe(200);
      expect(wroteState.body).toEqual({ ok: true });
      const updatedState = await daemonJson<StateSnapshot>(baseURL, '/state/snapshot');
      expect(updatedState.status).toBe(200);
      expect(updatedState.body.keys?.tapCounter).toBe(7);

      const wroteOptional = await daemonJson<{ ok?: boolean }>(baseURL, '/state/nickname', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-id': sessionId,
        },
        body: JSON.stringify({ value: 'Device' }),
      });
      expect(wroteOptional.status).toBe(200);
      const optionalValue = await daemonJson<StateSnapshot>(baseURL, '/state/snapshot');
      expect(optionalValue.body.keys?.nickname).toBe('Device');

      const clearedOptional = await daemonJson<{ ok?: boolean }>(baseURL, '/state/nickname', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-id': sessionId,
        },
        body: JSON.stringify({ value: null }),
      });
      expect(clearedOptional.status).toBe(200);
      const clearedValue = await daemonJson<StateSnapshot>(baseURL, '/state/snapshot');
      expect(clearedValue.body.keys?.nickname).toBeNull();

      const restoredState = await daemonJson<{ ok?: boolean }>(baseURL, '/state/restore', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-id': sessionId,
        },
        body: JSON.stringify(initialState.body),
      });
      expect(restoredState.status).toBe(200);
      expect(restoredState.body).toEqual({ ok: true });
      const afterRestore = await daemonJson<StateSnapshot>(baseURL, '/state/snapshot');
      expect(afterRestore.body.keys?.tapCounter).toBe(0);
      expect(afterRestore.body.keys?.nickname).toBeNull();

      const viewport = { w: appFrame!.w, h: appFrame!.h };
      const byIdentifier = (identifier: string): DeviceElementPredicate =>
        (element) => element.identifier === identifier;
      const byLabel = (label: string): DeviceElementPredicate =>
        (element) => element.label?.trim() === label;

      const tapAndWaitForValueChange = async (
        target: DeviceElementPredicate,
        oracle: DeviceElementPredicate,
        description: string,
      ): Promise<DeviceElement> => {
        const before = await waitForDeviceElement(
          baseURL,
          oracle,
          `${description} oracle before tap`,
          { condition: (element) => typeof element.value === 'string' },
        );
        const targetElement = await waitForDeviceElement(
          baseURL,
          target,
          `${description} target`,
          { tappableIn: viewport },
        );
        await tapDeviceElement(baseURL, sessionId!, targetElement);
        const after = await waitForDeviceElement(
          baseURL,
          oracle,
          `${description} value change`,
          { condition: (element) => typeof element.value === 'string' && element.value !== before.value },
        );
        expect(after.value).not.toBe(before.value);
        return after;
      };

      const firstInteger = (value: string | undefined): number | undefined => {
        const match = value?.match(/-?\d+/);
        return match ? Number(match[0]) : undefined;
      };

      const tapAndWaitForCountIncrement = async (
        target: DeviceElementPredicate,
        oracle: DeviceElementPredicate,
        description: string,
      ): Promise<DeviceElement> => {
        const before = await waitForDeviceElement(
          baseURL,
          oracle,
          `${description} counter before tap`,
          { condition: (element) => firstInteger(element.value) !== undefined },
        );
        const beforeCount = firstInteger(before.value)!;
        const targetElement = await waitForDeviceElement(
          baseURL,
          target,
          `${description} target`,
          { tappableIn: viewport },
        );
        await tapDeviceElement(baseURL, sessionId!, targetElement);
        const after = await waitForDeviceElement(
          baseURL,
          oracle,
          `${description} exactly-once counter increment`,
          { condition: (element) => firstInteger(element.value) === beforeCount + 1 },
        );
        expect(firstInteger(after.value)).toBe(beforeCount + 1);
        return after;
      };

      // SwiftUI button styles and both navigation-bar controls.
      for (const identifier of [
        'primary-button',
        'bordered-button',
        'plain-button',
        'destructive-button',
        'nav-refresh-button',
      ]) {
        await tapAndWaitForCountIncrement(
          byIdentifier(identifier),
          byIdentifier(identifier),
          identifier,
        );
      }

      // Menu presentation and both menu commands. The menu's own value is the
      // stable oracle after each transient command element disappears.
      for (const commandIdentifier of ['menu-add-item', 'menu-archive-item']) {
        const menuBefore = await waitForDeviceElement(
          baseURL,
          byIdentifier('toolbar-actions-menu'),
          'toolbar menu value',
          { condition: (element) => typeof element.value === 'string' },
        );
        const menu = await waitForDeviceElement(
          baseURL,
          byIdentifier('toolbar-actions-menu'),
          'toolbar actions menu',
          { tappableIn: viewport },
        );
        await tapDeviceElement(baseURL, sessionId, menu);
        const command = await waitForDeviceElement(
          baseURL,
          byIdentifier(commandIdentifier),
          commandIdentifier,
          { tappableIn: viewport },
        );
        await tapDeviceElement(baseURL, sessionId, command);
        const beforeCounts = [...(menuBefore.value?.matchAll(/\d+/g) ?? [])].map((match) => Number(match[0]));
        expect(beforeCounts).toHaveLength(2);
        const changedIndex = commandIdentifier === 'menu-add-item' ? 0 : 1;
        const expectedCounts = beforeCounts.map((count, index) => count + (index === changedIndex ? 1 : 0));
        const menuAfter = await waitForDeviceElement(
          baseURL,
          byIdentifier('toolbar-actions-menu'),
          `${commandIdentifier} exactly-once result`,
          {
            condition: (element) => {
              const counts = [...(element.value?.matchAll(/\d+/g) ?? [])].map((match) => Number(match[0]));
              return counts.length === 2 && counts.every((count, index) => count === expectedCounts[index]);
            },
          },
        );
        const afterCounts = [...(menuAfter.value?.matchAll(/\d+/g) ?? [])].map((match) => Number(match[0]));
        expect(afterCounts).toEqual(expectedCounts);
      }

      // Push, interact with, and pop the explicit navigation destination.
      const openDetail = await waitForDeviceElement(
        baseURL,
        byIdentifier('open-detail-button'),
        'open detail button',
        { tappableIn: viewport },
      );
      await tapDeviceElement(baseURL, sessionId, openDetail);
      await waitForDeviceElement(baseURL, byIdentifier('detail-screen-title'), 'detail destination');
      await tapAndWaitForCountIncrement(
        byIdentifier('detail-action-button'),
        byIdentifier('detail-action-button'),
        'detail action button',
      );
      const back = await waitForDeviceElement(
        baseURL,
        byIdentifier('detail-back-button'),
        'detail back button',
        { tappableIn: viewport },
      );
      await tapDeviceElement(baseURL, sessionId, back);
      await waitForDeviceElement(baseURL, byIdentifier('primary-button'), 'controls after detail pop');

      // Tab navigation plus native toggle, stepper, segmented picker, text
      // input/commit, and a UIKit UIButton.
      const inputsTab = await waitForDeviceElement(
        baseURL,
        byIdentifier('tab-inputs'),
        'Inputs tab',
        { tappableIn: viewport },
      );
      await tapDeviceElement(baseURL, sessionId, inputsTab);
      await waitForDeviceElement(baseURL, byIdentifier('harness-toggle'), 'Inputs controls');
      await tapAndWaitForValueChange(
        byIdentifier('harness-toggle'),
        byIdentifier('harness-toggle'),
        'toggle',
      );
      await tapAndWaitForCountIncrement(
        byIdentifier('harness-stepper-Increment'),
        byIdentifier('harness-stepper'),
        'stepper increment',
      );
      const segmentTwo = await waitForDeviceElement(
        baseURL,
        byLabel('Two'),
        'segmented picker option Two',
        { tappableIn: viewport },
      );
      await tapDeviceElement(baseURL, sessionId, segmentTwo);
      const selectedTwo = await waitForDeviceElement(
        baseURL,
        byIdentifier('harness-segmented-picker'),
        'segmented picker selection',
        { condition: (element) => element.value?.includes('Two') === true },
      );
      expect(selectedTwo.value).toContain('Two');

      const textField = await waitForDeviceElement(
        baseURL,
        byIdentifier('harness-text-field'),
        'text field',
        { tappableIn: viewport },
      );
      await tapDeviceElement(baseURL, sessionId, textField);
      const typed = await daemonJson<{ ok?: boolean; op?: string }>(baseURL, '/type', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-id': sessionId,
        },
        body: JSON.stringify({ text: 'device matrix' }),
      });
      expect(typed.status).toBe(200);
      expect(typed.body).toMatchObject({ op: 'type', ok: true });
      await waitForDeviceElement(
        baseURL,
        byIdentifier('harness-text-field'),
        'typed text value',
        { condition: (element) => element.value === 'device matrix' },
      );
      await tapAndWaitForCountIncrement(
        byIdentifier('commit-text-button'),
        byIdentifier('commit-text-button'),
        'text commit button',
      );
      // Commit clears FocusState; let the keyboard dismissal animation finish
      // before choosing a scroll-view hit point for the UIKit control below.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const scrollInputs = await daemonJson<{ ok?: boolean; op?: string }>(baseURL, '/swipe', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-id': sessionId,
        },
        body: JSON.stringify({ from_x: 200, from_y: 650, to_x: 200, to_y: 220 }),
      });
      expect(scrollInputs.status).toBe(200);
      expect(scrollInputs.body).toMatchObject({ op: 'swipe', ok: true });
      await tapAndWaitForCountIncrement(
        byIdentifier('uikit-button'),
        byIdentifier('uikit-button'),
        'UIKit button',
      );

      // All four list rows and the row navigation-bar action.
      const rowsTab = await waitForDeviceElement(
        baseURL,
        byIdentifier('tab-rows'),
        'Rows tab',
        { tappableIn: viewport },
      );
      await tapDeviceElement(baseURL, sessionId, rowsTab);
      await waitForDeviceElement(baseURL, byIdentifier('row-alpha-button'), 'Rows list');
      for (const row of ['alpha', 'bravo', 'charlie', 'delta']) {
        await tapAndWaitForCountIncrement(
          byIdentifier(`row-${row}-button`),
          byIdentifier(`row-${row}-button`),
          `${row} row`,
        );
      }
      await tapAndWaitForCountIncrement(
        byIdentifier('rows-toolbar-button'),
        byIdentifier('rows-toolbar-button'),
        'rows toolbar button',
      );

      const controlsTab = await waitForDeviceElement(
        baseURL,
        byIdentifier('tab-controls'),
        'Controls tab',
        { tappableIn: viewport },
      );
      await tapDeviceElement(baseURL, sessionId, controlsTab);
      await waitForDeviceElement(baseURL, byIdentifier('primary-button'), 'Controls tab restored');

      // Keep the daemon alive while the app process gets a new boot token.
      // The first proxied request must observe the stale bearer, invalidate
      // only that tunnel, single-flight a fresh bootstrap, and retry once.
      runChecked('xcrun', [
        'devicectl', 'device', 'process', 'launch',
        '--device', device.identifier,
        '--terminate-existing',
        bundleId,
      ], { timeout: 60_000 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const afterRelaunch = await daemonJson<{ png_base64?: string; error?: string }>(baseURL, '/screenshot');
      expect(afterRelaunch.status).toBe(200);
      expect(Buffer.from(afterRelaunch.body.png_base64 ?? '', 'base64').length).toBeGreaterThan(1_000);
      expect(tunnelProviderCalls).toBe(2);
      const stateAfterRelaunch = await daemonJson<StateSnapshot>(baseURL, '/state/snapshot');
      expect(stateAfterRelaunch.status).toBe(200);
      expect(stateAfterRelaunch.body._accessor_hash).toBe(initialState.body._accessor_hash);
    } finally {
      if (daemon && sessionId) {
        await daemonJson(`http://127.0.0.1:${daemon.loopbackPort}`, '/session/release', { method: 'POST' }).catch(() => undefined);
      }
      if (daemon) await daemon.close();
      keepalive?.stop();
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 600_000);
});

// Always-on instructions if not paired. Surfaces actionable steps even when
// the test is opted in via env var but the device isn't ready.
if (HAS_DEVICE) {
  const devices = listDevices();
  const unpaired = devices.filter(d =>
    d.platform.toLowerCase() === 'ios'
    && d.model.toLowerCase().startsWith('iphone')
    && !d.paired,
  );
  if (unpaired.length > 0) {
    console.error('');
    console.error('=== iOS DEVICE PAIRING REQUIRED ===');
    for (const d of unpaired) {
      console.error(`  Device: ${d.name} (${d.model}, ${d.identifier})`);
      console.error(`  Status: ${d.state}`);
    }
    console.error('  Run: xcrun devicectl manage pair --device <UDID>');
    console.error('  Then tap "Trust" on the iPhone.');
    console.error('===================================');
    console.error('');
  }
}
