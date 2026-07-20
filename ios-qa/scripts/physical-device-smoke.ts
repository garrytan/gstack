#!/usr/bin/env bun

/**
 * Real-iPhone deployment smoke harness for the ios-qa DebugBridge.
 *
 * This intentionally uses Xcode/CoreDevice and the existing daemon bootstrap.
 * It does not use XCTest, XCUITest, Appium, WebDriverAgent, a simulator, or a
 * cloud-device provider.
 */

import { createHash, randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { bootstrapTunnel, type BootstrapErrorReason } from '../daemon/src/tunnel-bootstrap';
import {
  copyFileFromAppContainer,
  startTunnelKeepalive,
} from '../daemon/src/devicectl';
import type { DeviceTunnel } from '../daemon/src/proxy';

export const PHYSICAL_DEVICE_BUNDLE_ID = 'com.gstack.iosqa.fixture.gstack2';
export const REQUIRED_LIVE_ITERATIONS = 5;
export const TEAM_ID_ENV = 'GSTACK_IOS_DEVELOPMENT_TEAM';
export const TEAM_ID_ENV_ALIAS = 'GSTACK_IOS_TEAM_ID';
export const REPLACE_CONFLICT_ENV = 'GSTACK_IOS_ALLOW_REPLACE_FIXTURE';

const ROOT = join(import.meta.dir, '..', '..');
const FIXTURE_SOURCE = join(ROOT, 'test', 'fixtures', 'ios-qa', 'FixtureApp');
const EVIDENCE_DIR = join(ROOT, 'docs', 'gstack-2', 'evidence');
const BOOT_TOKEN_PATH = 'tmp/gstack-ios-qa.token';

export type FailureCategory = 'setup_gate' | 'safety_refusal' | 'product_failure';

export type HarnessErrorCode =
  | 'macos_required'
  | 'xcode_unavailable'
  | 'xcode_not_initialized'
  | 'devicectl_unavailable'
  | 'xcodegen_unavailable'
  | 'devtools_security_disabled'
  | 'device_discovery_failed'
  | 'device_discovery_bad_response'
  | 'no_iphone'
  | 'device_not_found'
  | 'multiple_iphones'
  | 'unsupported_device_type'
  | 'device_not_wired'
  | 'device_not_paired_or_trusted'
  | 'developer_mode_disabled'
  | 'device_locked'
  | 'device_management_unavailable'
  | 'invalid_team_id'
  | 'conflicting_team_ids'
  | 'installed_apps_unavailable'
  | 'existing_bundle_conflict'
  | 'fixture_copy_failed'
  | 'xcodegen_failed'
  | 'release_build_failed'
  | 'release_app_missing'
  | 'release_symbol_scan_failed'
  | 'release_debugbridge_leak'
  | 'signing_unavailable'
  | 'debug_build_failed'
  | 'debug_app_missing'
  | 'install_failed'
  | 'launch_failed'
  | 'boot_token_unavailable'
  | 'coredevice_tunnel_unavailable'
  | 'bootstrap_failed'
  | 'live_checks_failed'
  | 'cleanup_failed'
  | 'invalid_arguments';

export class HarnessError extends Error {
  constructor(
    public readonly code: HarnessErrorCode,
    public readonly category: FailureCategory,
    public readonly phase: string,
    message: string,
    public readonly remediation: string[] = [],
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'HarnessError';
  }

  toJSON(): Record<string, unknown> {
    return {
      ok: false,
      code: this.code,
      category: this.category,
      phase: this.phase,
      message: this.message,
      remediation: this.remediation,
      ...(this.detail ? { detail: this.detail } : {}),
    };
  }
}

export interface PhysicalDevice {
  coreDeviceIdentifier: string;
  hardwareUdid: string | null;
  name: string;
  model: string;
  platform: string;
  tunnelState: string;
  pairingState: string;
  developerModeStatus: string;
  transportType: string | null;
}

export interface ToolchainPreflight {
  developerDir: string;
  xcodeVersion: string;
  xcodeBuildVersion: string;
  xcodegenVersion: string;
  devicectlPath: string;
  devToolsSecurity: 'enabled';
}

export interface InstalledApp {
  bundleIdentifier: string;
  name: string | null;
  displayName: string | null;
  bundleVersion: string | null;
  url: string | null;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error: Error | null;
}

interface JsonCommandResult {
  payload: unknown;
  command: CommandResult;
}

type ParsedJson =
  | { ok: true; payload: unknown }
  | { ok: false; detail: string };

interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

interface PngSummary {
  sha256: string;
  bytes: number;
  width: number;
  height: number;
}

interface FixtureElement {
  identifier: string;
  label: string;
  frame: { x: number; y: number; w: number; h: number };
}

interface LiveIterationResult {
  iteration: number;
  passed: true;
  checks: {
    health_bundle: {
      passed: true;
      bundleBefore: string;
      bundleAfter: string;
    };
    token_rotation: {
      passed: true;
      originalBootTokenRejected: true;
    };
    session_acquire: {
      passed: true;
      sessionIdIssued: true;
      released: true;
    };
    screenshot_elements: {
      passed: true;
      elementCountBefore: number;
      elementCountAfter: number;
      screenshotBefore: PngSummary;
      screenshotAfter: PngSummary;
    };
    coordinate_tap_state_cleanup: {
      passed: true;
      buttonLabelBefore: string;
      buttonLabelAfter: string;
      activeBundleBefore: string;
      activeBundleAfter: string;
      stateCleanup: 'unchanged' | 'restored';
    };
  };
}

interface FailedLiveIteration {
  iteration: number;
  passed: false;
  error: Record<string, unknown>;
}

interface HarnessEvidence {
  schemaVersion: 1;
  kind: 'gstack-ios-qa-physical-device';
  passed: true;
  generatedAt: string;
  requiredIterations: 5;
  passedIterations: 5;
  toolchain: ToolchainPreflight;
  device: {
    identifierSha256: string;
    model: string;
    platform: string;
    transportType: string | null;
    pairingState: string;
    developerModeStatus: string;
  };
  bundleId: string;
  signing: {
    automatic: true;
    explicitTeamFromEnvironment: boolean;
  };
  installSafety: {
    existingBundle: 'absent' | 'related_fixture' | 'explicitly_allowed_conflict';
    appDataDeleted: false;
    appUninstalled: false;
  };
  releaseGuard: {
    built: true;
    debugBridgeSymbolsAbsent: true;
    executableSha256: string;
  };
  bootstrap: {
    transport: 'CoreDevice IPv6';
    daemonBootstrap: true;
    tokenRotated: true;
    stateServerPort: number;
  };
  iterations: LiveIterationResult[];
  cleanup: {
    sessionsReleased: true;
    tunnelKeepaliveStopped: true;
    temporaryWorkspaceRemoved: true;
  };
}

function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: options.timeoutMs ?? 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
    error: result.error ?? null,
  };
}

function commandDetail(result: CommandResult, lines = 80): string {
  const combined = `${result.stdout}\n${result.stderr}`.trim();
  if (!combined) return result.error?.message ?? `exit status ${result.status ?? 'unknown'}`;
  return combined.split('\n').slice(-lines).join('\n');
}

function parseJson(raw: string): ParsedJson {
  try {
    return { ok: true, payload: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function runJsonDevicectl(args: string[], phase: string): JsonCommandResult {
  const dir = mkdtempSync(join(tmpdir(), 'gstack-ios-devicectl-'));
  const output = join(dir, 'result.json');
  try {
    const command = runCommand('xcrun', ['devicectl', ...args, '--json-output', output], {
      timeoutMs: 60_000,
    });
    if (command.status !== 0) {
      throw new HarnessError(
        'device_discovery_failed',
        'setup_gate',
        phase,
        `devicectl failed during ${phase}`,
        ['Reconnect and unlock the iPhone, then rerun `xcrun devicectl list devices`.'],
        commandDetail(command),
      );
    }
    if (!existsSync(output)) {
      throw new HarnessError(
        'device_discovery_bad_response',
        'setup_gate',
        phase,
        'devicectl exited successfully but did not create its JSON output file',
        ['Run `sudo xcodebuild -runFirstLaunch`, reconnect the iPhone, and retry.'],
      );
    }
    const parsed = parseJson(readFileSync(output, 'utf8'));
    if (!parsed.ok) {
      throw new HarnessError(
        'device_discovery_bad_response',
        'setup_gate',
        phase,
        'devicectl returned malformed JSON',
        ['Upgrade or repair Xcode, then verify `xcrun devicectl list devices --json-output <path>` manually.'],
        parsed.detail,
      );
    }
    return { payload: parsed.payload, command };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function parseDeviceListPayload(payload: unknown): PhysicalDevice[] {
  const root = objectRecord(payload);
  const result = objectRecord(root?.result);
  const rawDevices = result?.devices;
  if (!Array.isArray(rawDevices)) {
    throw new HarnessError(
      'device_discovery_bad_response',
      'setup_gate',
      'device_discovery',
      'devicectl JSON is missing result.devices[]',
      ['Run `xcrun devicectl list devices --json-output /tmp/devices.json` and inspect the Xcode installation.'],
    );
  }

  return rawDevices.map((raw, index) => {
    const device = objectRecord(raw);
    const connection = objectRecord(device?.connectionProperties);
    const properties = objectRecord(device?.deviceProperties);
    const hardware = objectRecord(device?.hardwareProperties);
    const identifier = stringValue(device?.identifier);
    if (!identifier) {
      throw new HarnessError(
        'device_discovery_bad_response',
        'setup_gate',
        'device_discovery',
        `devicectl device entry ${index} has no identifier`,
        ['Repair or update Xcode and rerun device discovery.'],
      );
    }
    const developerModeStatus = stringValue(
      properties?.developerModeStatus
        ?? hardware?.developerModeStatus
        ?? properties?.developerMode,
      'unknown',
    );
    return {
      coreDeviceIdentifier: identifier,
      hardwareUdid: stringValue(hardware?.udid) || null,
      name: stringValue(properties?.name, 'unknown'),
      model: stringValue(hardware?.productType, 'unknown'),
      platform: stringValue(hardware?.platform, 'unknown'),
      tunnelState: stringValue(connection?.tunnelState, 'unknown'),
      pairingState: stringValue(connection?.pairingState, 'unknown'),
      developerModeStatus,
      transportType: stringValue(connection?.transportType ?? connection?.connectionType) || null,
    };
  });
}

export function discoverPhysicalDevices(): PhysicalDevice[] {
  const result = runJsonDevicectl(['list', 'devices'], 'device_discovery');
  return parseDeviceListPayload(result.payload);
}

function isIPhone(device: PhysicalDevice): boolean {
  return device.model.toLowerCase().startsWith('iphone')
    || device.platform.toLowerCase() === 'ios';
}

export function selectPhysicalDevice(
  devices: PhysicalDevice[],
  selector?: string,
): PhysicalDevice {
  if (selector) {
    const target = devices.find((device) =>
      device.coreDeviceIdentifier === selector || device.hardwareUdid === selector);
    if (!target) {
      throw new HarnessError(
        'device_not_found',
        'setup_gate',
        'device_selection',
        `No CoreDevice entry matches ${selector}`,
        ['Pass either the hardware UDID or CoreDevice UUID printed by `xcrun devicectl list devices`.'],
      );
    }
    if (!isIPhone(target)) {
      throw new HarnessError(
        'unsupported_device_type',
        'setup_gate',
        'device_selection',
        `${target.name} (${target.model}) is not an iPhone`,
        ['Set `GSTACK_IOS_TARGET_UDID` to a connected iPhone hardware UDID or CoreDevice UUID.'],
      );
    }
    return target;
  }

  const iphones = devices.filter(isIPhone);
  if (iphones.length === 0) {
    throw new HarnessError(
      'no_iphone',
      'setup_gate',
      'device_selection',
      'No iPhone is visible to CoreDevice',
      ['Connect an unlocked iPhone over USB and run `xcrun devicectl list devices`.'],
    );
  }
  if (iphones.length === 1) return iphones[0]!;

  const wired = iphones.filter((device) => device.transportType?.toLowerCase() === 'wired');
  if (wired.length === 1) return wired[0]!;

  const choices = iphones
    .map((device) => `${device.name}: hardware=${device.hardwareUdid ?? 'unknown'} coredevice=${device.coreDeviceIdentifier}`)
    .join('; ');
  throw new HarnessError(
    'multiple_iphones',
    'setup_gate',
    'device_selection',
    'More than one iPhone is available; the harness will not guess',
    [`Set GSTACK_IOS_TARGET_UDID=<hardware-UDID-or-CoreDevice-UUID>. Choices: ${choices}`],
  );
}

export function resolveTeamId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const primary = env[TEAM_ID_ENV]?.trim();
  const alias = env[TEAM_ID_ENV_ALIAS]?.trim();
  if (primary && alias && primary !== alias) {
    throw new HarnessError(
      'conflicting_team_ids',
      'setup_gate',
      'signing',
      `${TEAM_ID_ENV} and ${TEAM_ID_ENV_ALIAS} disagree`,
      [`Unset one variable or set both to the same Apple development team ID.`],
    );
  }
  const teamId = primary || alias;
  if (!teamId) return undefined;
  if (!/^[A-Z0-9]{10}$/.test(teamId)) {
    throw new HarnessError(
      'invalid_team_id',
      'setup_gate',
      'signing',
      `The explicit Apple development team ID is not a 10-character uppercase identifier`,
      [`Set ${TEAM_ID_ENV}=<TEAM_ID> using the value shown in Xcode Settings > Accounts.`],
    );
  }
  return teamId;
}

export function runToolchainPreflight(): ToolchainPreflight {
  if (process.platform !== 'darwin') {
    throw new HarnessError(
      'macos_required',
      'setup_gate',
      'host_preflight',
      'A real-device CoreDevice deployment requires macOS',
      ['Run this harness on the Mac physically connected to the iPhone.'],
    );
  }

  const selected = runCommand('xcode-select', ['-p']);
  const developerDir = selected.stdout.trim();
  if (selected.status !== 0 || !developerDir.includes('.app/Contents/Developer')) {
    throw new HarnessError(
      'xcode_unavailable',
      'setup_gate',
      'host_preflight',
      'The active developer directory is not a full Xcode installation',
      [
        'Install Xcode, then run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.',
        'Run `sudo xcodebuild -runFirstLaunch` once after selecting Xcode.',
      ],
      commandDetail(selected),
    );
  }

  const xcode = runCommand('xcodebuild', ['-version']);
  if (xcode.status !== 0) {
    throw new HarnessError(
      'xcode_unavailable',
      'setup_gate',
      'host_preflight',
      'xcodebuild is unavailable',
      ['Install/select Xcode and run `sudo xcodebuild -runFirstLaunch`.'],
      commandDetail(xcode),
    );
  }
  const versionLines = xcode.stdout.trim().split('\n');

  const initialized = runCommand('xcodebuild', ['-checkFirstLaunchStatus']);
  if (initialized.status !== 0) {
    throw new HarnessError(
      'xcode_not_initialized',
      'setup_gate',
      'host_preflight',
      'Xcode first-launch components or license acceptance are incomplete',
      ['Run `sudo xcodebuild -runFirstLaunch`, accept any license prompt, then retry.'],
      commandDetail(initialized),
    );
  }

  const devicectl = runCommand('xcrun', ['--find', 'devicectl']);
  if (devicectl.status !== 0 || !devicectl.stdout.trim()) {
    throw new HarnessError(
      'devicectl_unavailable',
      'setup_gate',
      'host_preflight',
      'The selected Xcode does not provide devicectl',
      [
        'Select a recent full Xcode with `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.',
        'Verify with `xcrun --find devicectl`.',
      ],
      commandDetail(devicectl),
    );
  }

  const xcodegen = runCommand('xcodegen', ['--version']);
  if (xcodegen.status !== 0) {
    throw new HarnessError(
      'xcodegen_unavailable',
      'setup_gate',
      'host_preflight',
      'xcodegen is required to generate the temporary fixture project',
      ['Install it with `brew install xcodegen`, then verify `xcodegen --version`.'],
      commandDetail(xcodegen),
    );
  }

  const securityTool = existsSync('/usr/sbin/DevToolsSecurity')
    ? '/usr/sbin/DevToolsSecurity'
    : 'DevToolsSecurity';
  const security = runCommand(securityTool, ['-status']);
  const securityOutput = `${security.stdout}\n${security.stderr}`;
  if (security.status !== 0 || !/currently enabled/i.test(securityOutput)) {
    throw new HarnessError(
      'devtools_security_disabled',
      'setup_gate',
      'host_preflight',
      'macOS developer-tool authorization is disabled',
      ['Run `sudo DevToolsSecurity -enable`, then verify with `DevToolsSecurity -status`.'],
      commandDetail(security),
    );
  }

  return {
    developerDir,
    xcodeVersion: versionLines[0] ?? 'unknown',
    xcodeBuildVersion: versionLines[1] ?? 'unknown',
    xcodegenVersion: xcodegen.stdout.trim() || xcodegen.stderr.trim(),
    devicectlPath: devicectl.stdout.trim(),
    devToolsSecurity: 'enabled',
  };
}

function verifyDeviceGates(device: PhysicalDevice): void {
  if (device.transportType?.toLowerCase() !== 'wired') {
    throw new HarnessError(
      'device_not_wired',
      'setup_gate',
      'device_preflight',
      `${device.name} is not reporting a wired CoreDevice connection`,
      [
        'Connect the iPhone directly by USB, unlock it, and accept the accessory prompt.',
        `Verify transportType=wired with \`xcrun devicectl list devices --json-output /tmp/devices.json\`.`,
      ],
    );
  }

  if (device.pairingState.toLowerCase() !== 'paired') {
    throw new HarnessError(
      'device_not_paired_or_trusted',
      'setup_gate',
      'device_preflight',
      `${device.name} is not paired and trusted`,
      [
        `Unlock the iPhone and run \`xcrun devicectl manage pair --device ${device.coreDeviceIdentifier}\`.`,
        'Tap Trust on the iPhone and enter its passcode, then reconnect the cable.',
      ],
    );
  }

  if (device.developerModeStatus.toLowerCase() !== 'enabled') {
    throw new HarnessError(
      'developer_mode_disabled',
      'setup_gate',
      'device_preflight',
      `Developer Mode is ${device.developerModeStatus} on ${device.name}`,
      [
        'On the iPhone open Settings > Privacy & Security > Developer Mode and turn it on.',
        'Restart when prompted, unlock the phone, confirm Enable, then reconnect it.',
      ],
    );
  }

  const probe = runJsonDevicectl(
    ['device', 'info', 'processes', '--device', device.coreDeviceIdentifier],
    'device_management_probe',
  );
  if (!objectRecord(objectRecord(probe.payload)?.result)) {
    throw new HarnessError(
      'device_management_unavailable',
      'setup_gate',
      'device_preflight',
      'CoreDevice returned no process-management result',
      ['Unlock and reconnect the iPhone, then rerun the pairing and Developer Mode steps.'],
    );
  }
}

function parseInstalledApps(payload: unknown): InstalledApp[] {
  const apps = objectRecord(objectRecord(payload)?.result)?.apps;
  if (!Array.isArray(apps)) {
    throw new HarnessError(
      'installed_apps_unavailable',
      'safety_refusal',
      'install_safety',
      'devicectl did not return result.apps[]; installation safety cannot be proven',
      ['Run `xcrun devicectl device info apps --device <id> --bundle-id <bundle-id>` and retry after CoreDevice is healthy.'],
    );
  }
  return apps.map((raw) => {
    const app = objectRecord(raw);
    return {
      bundleIdentifier: stringValue(app?.bundleIdentifier),
      name: stringValue(app?.name) || null,
      displayName: stringValue(app?.displayName) || null,
      bundleVersion: stringValue(app?.bundleVersion) || null,
      url: stringValue(app?.url) || null,
    };
  });
}

export function isRelatedFixtureInstall(app: InstalledApp): boolean {
  if (app.bundleIdentifier !== PHYSICAL_DEVICE_BUNDLE_ID) return false;
  const names = [app.name, app.displayName]
    .filter((name): name is string => Boolean(name))
    .map((name) => name.toLowerCase());
  return names.includes('fixtureapp')
    || names.includes('ios-qa fixture')
    || Boolean(app.url?.includes('/FixtureApp.app/'));
}

function checkInstallSafety(
  device: PhysicalDevice,
  allowConflict: boolean,
): 'absent' | 'related_fixture' | 'explicitly_allowed_conflict' {
  const listed = runJsonDevicectl([
    'device', 'info', 'apps',
    '--device', device.coreDeviceIdentifier,
    '--bundle-id', PHYSICAL_DEVICE_BUNDLE_ID,
  ], 'install_safety');
  const matches = parseInstalledApps(listed.payload)
    .filter((app) => app.bundleIdentifier === PHYSICAL_DEVICE_BUNDLE_ID);
  if (matches.length === 0) return 'absent';
  if (matches.every(isRelatedFixtureInstall)) return 'related_fixture';
  if (allowConflict) return 'explicitly_allowed_conflict';

  const app = matches[0]!;
  throw new HarnessError(
    'existing_bundle_conflict',
    'safety_refusal',
    'install_safety',
    `${PHYSICAL_DEVICE_BUNDLE_ID} is already installed but does not identify as the gstack FixtureApp`,
    [
      `Inspect the existing app first. To explicitly permit an in-place replacement, set ${REPLACE_CONFLICT_ENV}=1.`,
      'The harness will never uninstall the app or delete its data.',
    ],
    JSON.stringify({ name: app.name, displayName: app.displayName, bundleVersion: app.bundleVersion }),
  );
}

export function renderProjectSpec(includeDebugBridge: boolean): string {
  const packageSection = includeDebugBridge
    ? `\npackages:\n  DebugBridge:\n    path: .\n`
    : '';
  const dependencySection = includeDebugBridge
    ? `\n    dependencies:\n      - package: DebugBridge\n        product: DebugBridgeCore\n      - package: DebugBridge\n        product: DebugBridgeUI`
    : '';
  return `name: FixtureApp
options:
  deploymentTarget:
    iOS: "16.0"
  bundleIdPrefix: com.gstack.iosqa.fixture.gstack2
  developmentLanguage: en
  createIntermediateGroups: true
${packageSection}
targets:
  FixtureApp:
    type: application
    platform: iOS
    deploymentTarget: "16.0"
    sources:
      - path: Sources/FixtureApp${dependencySection}
    info:
      path: Sources/FixtureApp/Info.plist
      properties:
        CFBundleDisplayName: ios-qa fixture
        UILaunchScreen: {}
        UISupportedInterfaceOrientations: [UIInterfaceOrientationPortrait]
        UIRequiredDeviceCapabilities: [arm64]
    settings:
      base:
        PRODUCT_NAME: FixtureApp
        PRODUCT_BUNDLE_IDENTIFIER: ${PHYSICAL_DEVICE_BUNDLE_ID}
        CODE_SIGN_STYLE: Automatic
        TARGETED_DEVICE_FAMILY: "1"
        SWIFT_VERSION: "5.9"
        IPHONEOS_DEPLOYMENT_TARGET: "16.0"
        ENABLE_PREVIEWS: YES
`;
}

function copyFixtureToTemporaryWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'gstack-ios-physical-'));
  try {
    cpSync(FIXTURE_SOURCE, workspace, {
      recursive: true,
      filter: (source) => {
        const rel = relative(FIXTURE_SOURCE, source);
        if (!rel) return true;
        const parts = rel.split('/');
        if (parts.includes('.build') || parts.some((part) => part.endsWith('.xcodeproj'))) return false;
        // The checked-in fixture intentionally belongs to a different test
        // lane and contains a historical team ID. Never copy that signing
        // choice into this harness; generate a team-neutral spec below.
        if (rel === 'project.yml') return false;
        return true;
      },
    });
    return workspace;
  } catch (error) {
    rmSync(workspace, { recursive: true, force: true });
    throw new HarnessError(
      'fixture_copy_failed',
      'product_failure',
      'fixture_copy',
      'Could not copy the iOS fixture into an isolated temporary workspace',
      ['Check that test/fixtures/ios-qa/FixtureApp is complete and readable.'],
      error instanceof Error ? error.message : String(error),
    );
  }
}

function generateProject(workspace: string, includeDebugBridge: boolean): void {
  writeFileSync(join(workspace, 'project.yml'), renderProjectSpec(includeDebugBridge), 'utf8');
  rmSync(join(workspace, 'FixtureApp.xcodeproj'), { recursive: true, force: true });
  const generated = runCommand('xcodegen', [
    'generate',
    '--spec', join(workspace, 'project.yml'),
    '--project', workspace,
    '--quiet',
  ], { cwd: workspace, timeoutMs: 60_000 });
  if (generated.status !== 0 || !existsSync(join(workspace, 'FixtureApp.xcodeproj'))) {
    throw new HarnessError(
      'xcodegen_failed',
      'product_failure',
      'project_generation',
      'xcodegen could not generate the temporary FixtureApp project',
      ['Run `xcodegen generate --spec project.yml` in a copy of the fixture and inspect the error.'],
      commandDetail(generated),
    );
  }
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function redactDeviceForEvidence(device: PhysicalDevice): HarnessEvidence['device'] {
  // Evidence may be committed. Never persist the stable hardware UDID, the
  // CoreDevice UUID, or the user-assigned device name. A one-way fingerprint
  // still lets two evidence files prove they exercised the same device.
  const identifierSha256 = createHash('sha256')
    .update(`${device.hardwareUdid ?? 'no-hardware-udid'}\0${device.coreDeviceIdentifier}`)
    .digest('hex');
  return {
    identifierSha256,
    model: device.model,
    platform: device.platform,
    transportType: device.transportType,
    pairingState: device.pairingState,
    developerModeStatus: device.developerModeStatus,
  };
}

function walkFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) files.push(...walkFiles(path));
    else files.push(path);
  }
  return files;
}

function buildAndVerifyRelease(workspace: string): { executableSha256: string } {
  generateProject(workspace, false);
  const derivedData = join(workspace, 'DerivedData-Release');
  const built = runCommand('xcodebuild', [
    '-project', join(workspace, 'FixtureApp.xcodeproj'),
    '-scheme', 'FixtureApp',
    '-configuration', 'Release',
    '-destination', 'generic/platform=iOS',
    '-derivedDataPath', derivedData,
    'CODE_SIGNING_ALLOWED=NO',
    'CODE_SIGNING_REQUIRED=NO',
    'CODE_SIGN_IDENTITY=',
    'build',
  ], { cwd: workspace, timeoutMs: 10 * 60_000 });
  if (built.status !== 0) {
    throw new HarnessError(
      'release_build_failed',
      'product_failure',
      'release_guard',
      'The unsigned Release fixture build failed',
      ['Fix the Release compilation error before attempting a Debug device deployment.'],
      commandDetail(built),
    );
  }

  const app = join(derivedData, 'Build', 'Products', 'Release-iphoneos', 'FixtureApp.app');
  const executable = join(app, 'FixtureApp');
  if (!existsSync(executable)) {
    throw new HarnessError(
      'release_app_missing',
      'product_failure',
      'release_guard',
      'xcodebuild succeeded but the Release FixtureApp executable is missing',
      ['Inspect the Release build products under the temporary DerivedData directory.'],
    );
  }

  const nm = runCommand('/usr/bin/nm', ['-gjU', executable], { timeoutMs: 30_000 });
  const strings = runCommand('/usr/bin/strings', ['-a', executable], { timeoutMs: 30_000 });
  if (nm.status !== 0 || strings.status !== 0) {
    throw new HarnessError(
      'release_symbol_scan_failed',
      'product_failure',
      'release_guard',
      'The Release build succeeded but its symbol/string scan did not complete',
      ['Verify `/usr/bin/nm` and `/usr/bin/strings` can inspect the FixtureApp executable, then rerun.'],
      `nm: ${commandDetail(nm, 20)}\nstrings: ${commandDetail(strings, 20)}`,
    );
  }
  const bundlePaths = walkFiles(app).map((path) => relative(app, path));
  const scan = `${nm.stdout}\n${nm.stderr}\n${strings.stdout}\n${bundlePaths.join('\n')}`;
  // The fixture deliberately renders the human-facing text "StateServer
  // should be on :9999" in both configurations, so the generic word
  // StateServer is not a linkage signal. Product/module names and the private
  // bootstrap log marker are.
  const forbidden = scan.match(/DebugBridge(?:Core|UI|Touch)?|gstack-ios-qa-bootstrap/gi) ?? [];
  if (forbidden.length > 0) {
    throw new HarnessError(
      'release_debugbridge_leak',
      'product_failure',
      'release_guard',
      'Release output contains DebugBridge symbols or artifacts',
      ['Keep DebugBridge package linkage and imports Debug-only, rebuild Release, and rerun the symbol scan.'],
      `forbidden markers: ${[...new Set(forbidden)].join(', ')}`,
    );
  }
  return { executableSha256: sha256File(executable) };
}

const SIGNING_FAILURE = /requires a development team|No Accounts|No signing certificate|No profiles for|provisioning profile|Apple ID account|not logged in|Developer Mode.*disabled|register.*device|communication with Apple failed/i;

export function classifyXcodebuildFailure(output: string): 'signing_unavailable' | 'build_failed' {
  return SIGNING_FAILURE.test(output) ? 'signing_unavailable' : 'build_failed';
}

function buildSignedDebug(
  workspace: string,
  device: PhysicalDevice,
  teamId?: string,
): string {
  generateProject(workspace, true);
  const derivedData = join(workspace, 'DerivedData-Debug');
  const destinationId = device.hardwareUdid ?? device.coreDeviceIdentifier;
  const args = [
    '-project', join(workspace, 'FixtureApp.xcodeproj'),
    '-scheme', 'FixtureApp',
    '-configuration', 'Debug',
    '-destination', `platform=iOS,id=${destinationId}`,
    '-derivedDataPath', derivedData,
    '-allowProvisioningUpdates',
    '-allowProvisioningDeviceRegistration',
    'CODE_SIGN_STYLE=Automatic',
    `PRODUCT_BUNDLE_IDENTIFIER=${PHYSICAL_DEVICE_BUNDLE_ID}`,
  ];
  if (teamId) args.push(`DEVELOPMENT_TEAM=${teamId}`);
  args.push('build');

  const built = runCommand('xcodebuild', args, { cwd: workspace, timeoutMs: 15 * 60_000 });
  if (built.status !== 0) {
    const detail = commandDetail(built);
    if (classifyXcodebuildFailure(detail) === 'signing_unavailable') {
      throw new HarnessError(
        'signing_unavailable',
        'setup_gate',
        'debug_signing',
        'Automatic signing or provisioning is not available for this Xcode installation',
        [
          'Open Xcode > Settings > Accounts, add the Apple ID that owns the development team, and create/download an Apple Development certificate.',
          `Optionally set ${TEAM_ID_ENV}=<TEAM_ID> to select that signed-in team explicitly; the harness never hardcodes an account or team.`,
          'Leave the iPhone connected and unlocked so Xcode can register it, then rerun the deploy harness.',
        ],
        detail,
      );
    }
    throw new HarnessError(
      'debug_build_failed',
      'product_failure',
      'debug_build',
      'The Debug FixtureApp build failed for the selected iPhone',
      ['Fix the compiler/linker error, then rerun the same physical-device harness.'],
      detail,
    );
  }

  const app = join(derivedData, 'Build', 'Products', 'Debug-iphoneos', 'FixtureApp.app');
  if (!existsSync(join(app, 'FixtureApp'))) {
    throw new HarnessError(
      'debug_app_missing',
      'product_failure',
      'debug_build',
      'xcodebuild succeeded but the signed Debug FixtureApp bundle is missing',
      ['Inspect the Debug-iphoneos build products and confirm the FixtureApp scheme builds an application.'],
    );
  }
  return app;
}

function installFixture(device: PhysicalDevice, appPath: string): void {
  const installed = runCommand('xcrun', [
    'devicectl', 'device', 'install', 'app',
    '--device', device.coreDeviceIdentifier,
    appPath,
  ], { timeoutMs: 120_000 });
  if (installed.status !== 0) {
    throw new HarnessError(
      'install_failed',
      'product_failure',
      'install',
      'devicectl could not install the signed FixtureApp',
      ['Keep the iPhone unlocked and verify the provisioning profile includes this hardware UDID.'],
      commandDetail(installed),
    );
  }
}

function launchFixture(device: PhysicalDevice): void {
  const launched = runCommand('xcrun', [
    'devicectl', 'device', 'process', 'launch',
    '--device', device.coreDeviceIdentifier,
    '--terminate-existing',
    '--activate',
    PHYSICAL_DEVICE_BUNDLE_ID,
  ], { timeoutMs: 60_000 });
  if (launched.status !== 0) {
    const detail = commandDetail(launched);
    const locked = /not.*unlocked|device.*locked/i.test(detail);
    throw new HarnessError(
      locked ? 'device_locked' : 'launch_failed',
      locked ? 'setup_gate' : 'product_failure',
      'launch',
      locked ? 'The iPhone must be unlocked before FixtureApp can launch' : 'devicectl could not launch FixtureApp',
      locked
        ? ['Unlock the iPhone, leave it on the Home Screen, and rerun the harness.']
        : ['Inspect the install and launch diagnostics; do not uninstall or erase app data.'],
      detail,
    );
  }
}

async function captureBootToken(device: PhysicalDevice, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const token = copyFileFromAppContainer({
      udid: device.coreDeviceIdentifier,
      bundleId: PHYSICAL_DEVICE_BUNDLE_ID,
      sourceRelativePath: BOOT_TOKEN_PATH,
    });
    if (token) return token;
    await delay(250);
  }
  throw new HarnessError(
    'boot_token_unavailable',
    'product_failure',
    'bootstrap',
    'FixtureApp launched but did not publish its short-lived bootstrap token',
    ['Inspect the app launch logs and StateServer startup; do not substitute a fabricated token.'],
  );
}

function bootstrapError(error: BootstrapErrorReason, detail?: string): HarnessError {
  const setupErrors = new Set<BootstrapErrorReason>([
    'device_discovery_unavailable',
    'device_discovery_failed',
    'device_discovery_bad_response',
    'no_devices',
    'no_paired_device',
    'device_not_found',
    'device_locked',
    'resolve_failed',
  ]);
  if (error === 'resolve_failed') {
    return new HarnessError(
      'coredevice_tunnel_unavailable',
      'setup_gate',
      'bootstrap',
      'CoreDevice did not expose a routable IPv6 tunnel for the iPhone',
      [
        'Keep the iPhone unlocked, reconnect USB, and run `xcrun devicectl device info details --device <CoreDevice-UUID>`.',
        'Retry after the JSON shows connectionProperties.tunnelIPAddress.',
      ],
      detail,
    );
  }
  return new HarnessError(
    'bootstrap_failed',
    setupErrors.has(error) ? 'setup_gate' : 'product_failure',
    'bootstrap',
    `The existing daemon bootstrap failed: ${error}`,
    setupErrors.has(error)
      ? ['Repair the reported CoreDevice setup gate and rerun the same harness.']
      : ['Inspect StateServer startup/token rotation; do not mark the device run as passed.'],
    detail,
  );
}

async function deviceRequest(
  tunnel: DeviceTunnel,
  path: string,
  options: {
    method?: string;
    token?: string | null;
    sessionId?: string;
    expectedBundle?: string;
    body?: Record<string, unknown>;
    timeoutMs?: number;
  } = {},
): Promise<ApiResponse> {
  const host = tunnel.ipv6Addr.includes(':') ? `[${tunnel.ipv6Addr}]` : tunnel.ipv6Addr;
  const token = options.token === undefined ? tunnel.bootTokenRotated : options.token;
  // StateServer intentionally closes every response. Bun's fetch pool can
  // otherwise race to reuse that just-closed CoreDevice IPv6 socket: the first
  // two requests succeed and the next request fails with "socket connection
  // was closed unexpectedly". Mark each request non-persistent so every live
  // check gets a fresh tunnel connection, matching the server contract.
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    connection: 'close',
  };
  if (token) headers.authorization = `Bearer ${token}`;
  if (options.sessionId) headers['x-session-id'] = options.sessionId;
  if (options.expectedBundle) headers['x-gstack-expected-bundle-id'] = options.expectedBundle;
  try {
    const response = await fetch(`http://${host}:${tunnel.port}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
    const text = await response.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(text);
      body = objectRecord(parsed) ?? { value: parsed };
    } catch {
      body = { raw: text };
    }
    return { status: response.status, body };
  } catch (error) {
    throw new HarnessError(
      'live_checks_failed',
      'product_failure',
      'live_request',
      `${options.method ?? 'GET'} ${path} could not reach StateServer`,
      ['Keep the iPhone foregrounded and connected; inspect the CoreDevice tunnel and StateServer.'],
      error instanceof Error ? error.message : String(error),
    );
  }
}

function requireStatus(response: ApiResponse, expected: number, label: string): void {
  if (response.status !== expected) {
    throw new HarnessError(
      'live_checks_failed',
      'product_failure',
      'live_checks',
      `${label} returned HTTP ${response.status}; expected ${expected}`,
      ['Treat this as a product failure unless the response identifies a setup gate.'],
      JSON.stringify(response.body),
    );
  }
}

function summarizePng(base64: unknown): PngSummary {
  if (typeof base64 !== 'string' || base64.length === 0) {
    throw new HarnessError(
      'live_checks_failed',
      'product_failure',
      'screenshot',
      'StateServer returned no PNG payload',
      ['Verify DebugBridgeUIWiring.installAll() ran in the Debug app.'],
    );
  }
  const png = Buffer.from(base64, 'base64');
  if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new HarnessError(
      'live_checks_failed',
      'product_failure',
      'screenshot',
      'The screenshot payload is not a valid PNG',
      ['Inspect ScreenshotBridge.capturePNG() on the foreground app.'],
    );
  }
  return {
    sha256: createHash('sha256').update(png).digest('hex'),
    bytes: png.length,
    width: png.readUInt32BE(16),
    height: png.readUInt32BE(20),
  };
}

function parseFixtureElements(body: Record<string, unknown>): FixtureElement[] {
  if (!Array.isArray(body.elements)) {
    throw new HarnessError(
      'live_checks_failed',
      'product_failure',
      'elements',
      'StateServer response is missing elements[]',
      ['Verify the DebugBridgeUI elements resolver is installed.'],
    );
  }
  return body.elements.flatMap((raw): FixtureElement[] => {
    const element = objectRecord(raw);
    const frame = objectRecord(element?.frame);
    const x = Number(frame?.x);
    const y = Number(frame?.y);
    const w = Number(frame?.w);
    const h = Number(frame?.h);
    if (![x, y, w, h].every(Number.isFinite)) return [];
    return [{
      identifier: stringValue(element?.identifier),
      label: stringValue(element?.label),
      frame: { x, y, w, h },
    }];
  });
}

function findTapButton(elements: FixtureElement[]): FixtureElement {
  const candidates = elements.filter((element) =>
    element.frame.w > 0
      && element.frame.h > 0
      && (element.identifier === 'tap-button' || /^Tap \(\d+\)$/.test(element.label)));
  const button = candidates.find((element) => element.identifier === 'tap-button') ?? candidates[0];
  if (!button) {
    throw new HarnessError(
      'live_checks_failed',
      'product_failure',
      'elements',
      'The live accessibility tree does not contain the fixture tap button',
      ['Keep FixtureApp foregrounded and inspect /elements for tap-button.'],
      JSON.stringify(elements.slice(0, 20)),
    );
  }
  return button;
}

function tapCount(label: string): number | null {
  const match = label.match(/^Tap \((\d+)\)$/);
  return match ? Number.parseInt(match[1]!, 10) : null;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = objectRecord(value);
  if (record) {
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validateSnapshot(response: ApiResponse): Record<string, unknown> {
  requireStatus(response, 200, 'state snapshot');
  if (typeof response.body._schema_version !== 'number' || !objectRecord(response.body.keys)) {
    throw new HarnessError(
      'live_checks_failed',
      'product_failure',
      'state_snapshot',
      'StateServer returned a malformed state snapshot envelope',
      ['Fix the snapshot schema before trusting cleanup evidence.'],
      JSON.stringify(response.body),
    );
  }
  return response.body;
}

async function runLiveIteration(
  iteration: number,
  tunnel: DeviceTunnel,
  originalBootToken: string,
): Promise<LiveIterationResult> {
  let sessionId: string | undefined;
  let released = false;
  let primaryError: unknown;
  try {
    const healthBefore = await deviceRequest(tunnel, '/healthz', { token: null });
    requireStatus(healthBefore, 200, 'health before tap');
    if (healthBefore.body.bundle_id !== PHYSICAL_DEVICE_BUNDLE_ID) {
      throw new HarnessError(
        'live_checks_failed',
        'product_failure',
        'health_bundle',
        'StateServer health identifies a different active bundle',
        ['Stop the run; never send coordinates when the active bundle does not match the fixture.'],
        JSON.stringify(healthBefore.body),
      );
    }

    const deadBootToken = await deviceRequest(tunnel, '/auth/rotate', {
      method: 'POST',
      token: originalBootToken,
      body: { new_token: `must-not-activate-${randomUUID()}` },
    });
    requireStatus(deadBootToken, 401, 'original boot token reuse');
    if (deadBootToken.body.error !== 'boot_token_invalid') {
      throw new HarnessError(
        'live_checks_failed',
        'product_failure',
        'token_rotation',
        'The original bootstrap credential was rejected for an unexpected reason',
        ['Inspect StateServer auth rotation and do not accept ambiguous token evidence.'],
        JSON.stringify(deadBootToken.body),
      );
    }

    const acquired = await deviceRequest(tunnel, '/session/acquire', { method: 'POST' });
    requireStatus(acquired, 200, 'session acquire');
    sessionId = stringValue(acquired.body.session_id);
    if (!sessionId) {
      throw new HarnessError(
        'live_checks_failed',
        'product_failure',
        'session_acquire',
        'StateServer did not issue a session ID',
        ['Fix the device-lock response before allowing coordinate mutations.'],
      );
    }

    const snapshotBefore = validateSnapshot(await deviceRequest(tunnel, '/state/snapshot'));
    const screenshotBeforeResponse = await deviceRequest(tunnel, '/screenshot');
    requireStatus(screenshotBeforeResponse, 200, 'screenshot before tap');
    const screenshotBefore = summarizePng(screenshotBeforeResponse.body.png_base64);
    const elementsBeforeResponse = await deviceRequest(tunnel, '/elements');
    requireStatus(elementsBeforeResponse, 200, 'elements before tap');
    const elementsBefore = parseFixtureElements(elementsBeforeResponse.body);
    const buttonBefore = findTapButton(elementsBefore);
    const countBefore = tapCount(buttonBefore.label);
    if (countBefore === null) {
      throw new HarnessError(
        'live_checks_failed',
        'product_failure',
        'elements',
        `The fixture button label is not count-bearing: ${buttonBefore.label}`,
        ['Keep the fixture UI contract as `Tap (<count>)` for observable tap verification.'],
      );
    }

    const tapped = await deviceRequest(tunnel, '/tap', {
      method: 'POST',
      sessionId,
      expectedBundle: PHYSICAL_DEVICE_BUNDLE_ID,
      body: {
        x: buttonBefore.frame.x + buttonBefore.frame.w / 2,
        y: buttonBefore.frame.y + buttonBefore.frame.h / 2,
      },
    });
    requireStatus(tapped, 200, 'coordinate tap');
    if (
      tapped.body.ok !== true
      || tapped.body.active_bundle_before !== PHYSICAL_DEVICE_BUNDLE_ID
      || tapped.body.active_bundle_after !== PHYSICAL_DEVICE_BUNDLE_ID
    ) {
      throw new HarnessError(
        'live_checks_failed',
        'product_failure',
        'coordinate_tap',
        'The coordinate tap did not preserve and report the expected active bundle',
        ['Treat any active-bundle mismatch as a hard safety failure.'],
        JSON.stringify(tapped.body),
      );
    }

    let screenshotAfter: PngSummary | null = null;
    let elementsAfter: FixtureElement[] = [];
    let buttonAfter: FixtureElement | null = null;
    const updateDeadline = Date.now() + 4_000;
    while (Date.now() < updateDeadline) {
      await delay(200);
      const elementsResponse = await deviceRequest(tunnel, '/elements');
      requireStatus(elementsResponse, 200, 'elements after tap');
      elementsAfter = parseFixtureElements(elementsResponse.body);
      buttonAfter = findTapButton(elementsAfter);
      const screenshotResponse = await deviceRequest(tunnel, '/screenshot');
      requireStatus(screenshotResponse, 200, 'screenshot after tap');
      screenshotAfter = summarizePng(screenshotResponse.body.png_base64);
      if (
        tapCount(buttonAfter.label) === countBefore + 1
        && screenshotAfter.sha256 !== screenshotBefore.sha256
      ) break;
    }
    if (
      !buttonAfter
      || !screenshotAfter
      || tapCount(buttonAfter.label) !== countBefore + 1
      || screenshotAfter.sha256 === screenshotBefore.sha256
    ) {
      throw new HarnessError(
        'live_checks_failed',
        'product_failure',
        'coordinate_tap',
        'The tap returned success but the real UI did not advance visually',
        ['Inspect DebugBridgeTouch and the SwiftUI hit-test path on this iOS version.'],
        JSON.stringify({ before: buttonBefore.label, after: buttonAfter?.label ?? null }),
      );
    }

    const healthAfter = await deviceRequest(tunnel, '/healthz', { token: null });
    requireStatus(healthAfter, 200, 'health after tap');
    if (healthAfter.body.bundle_id !== PHYSICAL_DEVICE_BUNDLE_ID) {
      throw new HarnessError(
        'live_checks_failed',
        'product_failure',
        'health_bundle',
        'The active bundle changed after the coordinate tap',
        ['Stop the run and inspect foreground-app activation before any further mutation.'],
        JSON.stringify(healthAfter.body),
      );
    }

    const snapshotAfter = validateSnapshot(await deviceRequest(tunnel, '/state/snapshot'));
    let stateCleanup: 'unchanged' | 'restored' = 'unchanged';
    if (stableJson(snapshotAfter) !== stableJson(snapshotBefore)) {
      const restored = await deviceRequest(tunnel, '/state/restore', {
        method: 'POST',
        sessionId,
        body: snapshotBefore,
      });
      requireStatus(restored, 200, 'state restore cleanup');
      const snapshotClean = validateSnapshot(await deviceRequest(tunnel, '/state/snapshot'));
      if (stableJson(snapshotClean) !== stableJson(snapshotBefore)) {
        throw new HarnessError(
          'live_checks_failed',
          'product_failure',
          'state_cleanup',
          'State restore returned success but did not restore the captured snapshot',
          ['Fix atomic state restore before claiming cleanup succeeded.'],
        );
      }
      stateCleanup = 'restored';
    }

    const releasedResponse = await deviceRequest(tunnel, '/session/release', {
      method: 'POST',
      sessionId,
    });
    requireStatus(releasedResponse, 200, 'session release');
    released = true;

    return {
      iteration,
      passed: true,
      checks: {
        health_bundle: {
          passed: true,
          bundleBefore: String(healthBefore.body.bundle_id),
          bundleAfter: String(healthAfter.body.bundle_id),
        },
        token_rotation: {
          passed: true,
          originalBootTokenRejected: true,
        },
        session_acquire: {
          passed: true,
          sessionIdIssued: true,
          released: true,
        },
        screenshot_elements: {
          passed: true,
          elementCountBefore: elementsBefore.length,
          elementCountAfter: elementsAfter.length,
          screenshotBefore,
          screenshotAfter,
        },
        coordinate_tap_state_cleanup: {
          passed: true,
          buttonLabelBefore: buttonBefore.label,
          buttonLabelAfter: buttonAfter.label,
          activeBundleBefore: String(tapped.body.active_bundle_before),
          activeBundleAfter: String(tapped.body.active_bundle_after),
          stateCleanup,
        },
      },
    };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (sessionId && !released) {
      try {
        const cleanupRelease = await deviceRequest(tunnel, '/session/release', { method: 'POST', sessionId });
        requireStatus(cleanupRelease, 200, 'failed-iteration session cleanup');
      } catch (cleanupError) {
        if (primaryError) {
          throw new AggregateError(
            [primaryError, cleanupError],
            'Live iteration failed and its session cleanup also failed',
            { cause: primaryError },
          );
        }
        throw cleanupError;
      }
    }
  }
}

function serializeUnknownError(error: unknown): Record<string, unknown> {
  if (error instanceof HarnessError) return error.toJSON();
  if (error instanceof AggregateError) {
    return {
      name: error.name,
      message: error.message,
      errors: [...error.errors].map((nested) => serializeUnknownError(nested)),
    };
  }
  if (error instanceof Error) return { name: error.name, message: error.message };
  return { message: String(error) };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runFiveLiveIterations(
  tunnel: DeviceTunnel,
  originalBootToken: string,
): Promise<LiveIterationResult[]> {
  // Clear any lock left by startup probing. This bundle was just installed and
  // relaunched by this harness, so no unrelated app/session is in scope.
  const initialRelease = await deviceRequest(tunnel, '/session/release', { method: 'POST' });
  requireStatus(initialRelease, 200, 'initial session cleanup');

  const results: Array<LiveIterationResult | FailedLiveIteration> = [];
  for (let iteration = 1; iteration <= REQUIRED_LIVE_ITERATIONS; iteration++) {
    try {
      results.push(await runLiveIteration(iteration, tunnel, originalBootToken));
    } catch (error) {
      results.push({ iteration, passed: false, error: serializeUnknownError(error) });
    }
  }

  const failed = results.filter((result): result is FailedLiveIteration => !result.passed);
  if (failed.length > 0) {
    throw new HarnessError(
      'live_checks_failed',
      'product_failure',
      'live_checks',
      `${failed.length} of ${REQUIRED_LIVE_ITERATIONS} live iterations failed`,
      ['Fix the first failing check, then rerun all five iterations; partial passes do not count.'],
      JSON.stringify(results),
    );
  }
  return results as LiveIterationResult[];
}

function writePassingEvidence(evidence: HarnessEvidence): string {
  if (
    evidence.passedIterations !== REQUIRED_LIVE_ITERATIONS
    || evidence.iterations.length !== REQUIRED_LIVE_ITERATIONS
    || !evidence.iterations.every((iteration) => iteration.passed)
  ) {
    throw new HarnessError(
      'live_checks_failed',
      'product_failure',
      'evidence',
      'Refusing to write evidence for an incomplete device run',
      ['Evidence is written only after a real 5/5 pass.'],
    );
  }
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const stamp = evidence.generatedAt.replace(/[:.]/g, '-');
  const destination = join(EVIDENCE_DIR, `ios-physical-device-${stamp}.json`);
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: 'utf8', mode: 0o644 });
    renameSync(temporary, destination);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw new HarnessError(
      'cleanup_failed',
      'product_failure',
      'evidence',
      'The live run passed, but its evidence file could not be written atomically',
      ['Fix permissions on docs/gstack-2/evidence and rerun the complete 5/5 lane.'],
      error instanceof Error ? error.message : String(error),
    );
  }
  return destination;
}

interface CliOptions {
  preflightOnly: boolean;
  json: boolean;
  selector?: string;
}

function parseArguments(args: string[]): CliOptions {
  const options: CliOptions = { preflightOnly: false, json: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--preflight-only') options.preflightOnly = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--device') {
      const value = args[++index];
      if (!value) {
        throw new HarnessError(
          'invalid_arguments',
          'setup_gate',
          'arguments',
          '--device requires a hardware UDID or CoreDevice UUID',
        );
      }
      options.selector = value;
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write([
        'Usage: bun run ios-qa/scripts/physical-device-smoke.ts [options]',
        '',
        '  --preflight-only  Check Xcode, devicectl, pairing/trust, Developer Mode, and DevToolsSecurity.',
        '  --device <id>     Select by hardware UDID or CoreDevice UUID.',
        '  --json            Print the success result as JSON.',
        '',
        `Optional signing team: ${TEAM_ID_ENV}=<TEAM_ID>`,
        `Conflict replacement opt-in: ${REPLACE_CONFLICT_ENV}=1`,
        '',
      ].join('\n'));
      process.exit(0);
    } else {
      throw new HarnessError(
        'invalid_arguments',
        'setup_gate',
        'arguments',
        `Unknown argument: ${arg}`,
        ['Run with --help for supported options.'],
      );
    }
  }
  return options;
}

export async function runPhysicalDeviceHarness(options: CliOptions): Promise<{
  evidence: HarnessEvidence;
  evidencePath: string;
}> {
  const toolchain = runToolchainPreflight();
  const devices = discoverPhysicalDevices();
  const selector = options.selector ?? process.env.GSTACK_IOS_TARGET_UDID?.trim();
  const device = selectPhysicalDevice(devices, selector);
  verifyDeviceGates(device);
  const teamId = resolveTeamId();

  if (options.preflightOnly) {
    throw new HarnessError(
      'invalid_arguments',
      'setup_gate',
      'arguments',
      'runPhysicalDeviceHarness cannot be called with preflightOnly; use runPreflightOnly instead',
    );
  }

  const existingBundle = checkInstallSafety(
    device,
    process.env[REPLACE_CONFLICT_ENV] === '1',
  );
  const workspace = copyFixtureToTemporaryWorkspace();
  let keepalive: { stop: () => void } | null = null;
  let activeTunnel: DeviceTunnel | null = null;
  let originalBootToken = '';
  let finalSessionCleanupSucceeded = false;
  let evidenceWithoutPath: HarnessEvidence | null = null;
  let primaryError: unknown = null;

  try {
    const release = buildAndVerifyRelease(workspace);
    const debugApp = buildSignedDebug(workspace, device, teamId);
    installFixture(device, debugApp);
    launchFixture(device);
    originalBootToken = await captureBootToken(device);

    const bootstrapped = await bootstrapTunnel({
      udid: device.coreDeviceIdentifier,
      bundleId: PHYSICAL_DEVICE_BUNDLE_ID,
      bootTokenPath: BOOT_TOKEN_PATH,
      startupTimeoutMs: 20_000,
    });
    if (!bootstrapped.ok) throw bootstrapError(bootstrapped.error, bootstrapped.detail);
    activeTunnel = bootstrapped.tunnel;
    keepalive = startTunnelKeepalive(bootstrapped.tunnel.udid);

    const iterations = await runFiveLiveIterations(bootstrapped.tunnel, originalBootToken);

    evidenceWithoutPath = {
      schemaVersion: 1,
      kind: 'gstack-ios-qa-physical-device',
      passed: true,
      generatedAt: new Date().toISOString(),
      requiredIterations: 5,
      passedIterations: 5,
      toolchain,
      device: redactDeviceForEvidence(device),
      bundleId: PHYSICAL_DEVICE_BUNDLE_ID,
      signing: {
        automatic: true,
        explicitTeamFromEnvironment: Boolean(teamId),
      },
      installSafety: {
        existingBundle,
        appDataDeleted: false,
        appUninstalled: false,
      },
      releaseGuard: {
        built: true,
        debugBridgeSymbolsAbsent: true,
        executableSha256: release.executableSha256,
      },
      bootstrap: {
        transport: 'CoreDevice IPv6',
        daemonBootstrap: true,
        tokenRotated: true,
        stateServerPort: bootstrapped.tunnel.port,
      },
      iterations,
      cleanup: {
        sessionsReleased: true,
        tunnelKeepaliveStopped: true,
        temporaryWorkspaceRemoved: true,
      },
    };
  } catch (error) {
    primaryError = error;
  } finally {
    originalBootToken = '';
    if (activeTunnel) {
      try {
        const finalRelease = await deviceRequest(activeTunnel, '/session/release', { method: 'POST' });
        requireStatus(finalRelease, 200, 'final session cleanup');
        finalSessionCleanupSucceeded = true;
      } catch (error) {
        if (!primaryError) {
          primaryError = new HarnessError(
            'cleanup_failed',
            'product_failure',
            'cleanup',
            'The final StateServer session release failed',
            ['Reconnect the fixture and release its session before rerunning; do not delete app data.'],
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    }
    try {
      keepalive?.stop();
      keepalive = null;
      rmSync(workspace, { recursive: true, force: true });
    } catch (error) {
      if (!primaryError) {
        primaryError = new HarnessError(
          'cleanup_failed',
          'product_failure',
          'cleanup',
          'The temporary workspace or tunnel keepalive could not be cleaned up',
          ['Remove only the reported temporary gstack workspace after inspecting it; never erase device app data.'],
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  if (primaryError) throw primaryError;
  if (!evidenceWithoutPath || !finalSessionCleanupSucceeded) {
    throw new HarnessError(
      'cleanup_failed',
      'product_failure',
      'cleanup',
      'The harness finished without verified session cleanup',
      ['Do not write pass evidence until session cleanup succeeds.'],
    );
  }
  const evidencePath = writePassingEvidence(evidenceWithoutPath);
  return { evidence: evidenceWithoutPath, evidencePath };
}

export function runPreflightOnly(options: Pick<CliOptions, 'selector'>): {
  ok: true;
  mode: 'preflight-only';
  toolchain: ToolchainPreflight;
  device: PhysicalDevice;
  acceptedIdentifiers: { hardwareUdid: string | null; coreDeviceIdentifier: string };
} {
  const toolchain = runToolchainPreflight();
  const devices = discoverPhysicalDevices();
  const selector = options.selector ?? process.env.GSTACK_IOS_TARGET_UDID?.trim();
  const device = selectPhysicalDevice(devices, selector);
  verifyDeviceGates(device);
  resolveTeamId();
  return {
    ok: true,
    mode: 'preflight-only',
    toolchain,
    device,
    acceptedIdentifiers: {
      hardwareUdid: device.hardwareUdid,
      coreDeviceIdentifier: device.coreDeviceIdentifier,
    },
  };
}

function reportFailure(error: unknown): void {
  const failure = error instanceof HarnessError
    ? error
    : new HarnessError(
        'live_checks_failed',
        'product_failure',
        'unknown',
        error instanceof Error ? error.message : String(error),
      );
  process.stderr.write(`GSTACK_IOS_PHYSICAL_DEVICE_ERROR ${JSON.stringify(failure.toJSON())}\n`);
  for (const remediation of failure.remediation) {
    process.stderr.write(`REMEDIATION: ${remediation}\n`);
  }
  process.exitCode = failure.category === 'product_failure'
    ? 1
    : failure.category === 'setup_gate'
      ? 2
      : 3;
}

if (import.meta.main) {
  try {
    const options = parseArguments(process.argv.slice(2));
    if (options.preflightOnly) {
      const result = runPreflightOnly(options);
      process.stdout.write(`${JSON.stringify(result, null, options.json ? 2 : 0)}\n`);
    } else {
      const result = await runPhysicalDeviceHarness(options);
      const printable = {
        ok: true,
        passedIterations: result.evidence.passedIterations,
        requiredIterations: result.evidence.requiredIterations,
        evidencePath: result.evidencePath,
      };
      process.stdout.write(`${JSON.stringify(options.json ? { ...printable, evidence: result.evidence } : printable, null, options.json ? 2 : 0)}\n`);
    }
  } catch (error) {
    reportFailure(error);
  }
}
