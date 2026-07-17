// Physical-device E2E lane.
//
// Fast host/device gates run with GSTACK_HAS_IOS_DEVICE=1. The signed build,
// install, launch, CoreDevice tunnel, and 5x5 live loop are invoked only with
// the stronger GSTACK_IOS_DEVICE_DEPLOY=1 opt-in.

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  PHYSICAL_DEVICE_BUNDLE_ID,
  REQUIRED_LIVE_ITERATIONS,
  TEAM_ID_ENV,
  classifyXcodebuildFailure,
  parseDeviceListPayload,
  redactDeviceForEvidence,
  renderProjectSpec,
  resolveTeamId,
  runPreflightOnly,
  selectPhysicalDevice,
  type PhysicalDevice,
} from '../ios-qa/scripts/physical-device-smoke';

const ROOT = join(import.meta.dir, '..');
const FIXTURE_PATH = join(ROOT, 'test/fixtures/ios-qa/FixtureApp');
const HARNESS_PATH = join(ROOT, 'ios-qa/scripts/physical-device-smoke.ts');

const DEPLOY = process.env.GSTACK_IOS_DEVICE_DEPLOY === '1';
const HAS_DEVICE = DEPLOY || process.env.GSTACK_HAS_IOS_DEVICE === '1';
const describeIfDevice = HAS_DEVICE ? describe : describe.skip;
const testIfDeploy = DEPLOY ? test : test.skip;

const DEVICE_SAMPLE: PhysicalDevice = {
  coreDeviceIdentifier: 'COREDEVICE-UUID',
  hardwareUdid: '00008140-HARDWARE-UDID',
  name: 'Test iPhone',
  model: 'iPhone17,1',
  platform: 'iOS',
  tunnelState: 'connected',
  pairingState: 'paired',
  developerModeStatus: 'enabled',
  transportType: 'wired',
};

describe('physical-device harness invariants', () => {
  test('uses a reserved fixture bundle and requires a real 5/5 run', () => {
    expect(PHYSICAL_DEVICE_BUNDLE_ID).toBe('com.gstack.iosqa.fixture.gstack2');
    expect(REQUIRED_LIVE_ITERATIONS).toBe(5);
  });

  test('selects the same device by hardware UDID or CoreDevice UUID', () => {
    expect(selectPhysicalDevice([DEVICE_SAMPLE], DEVICE_SAMPLE.hardwareUdid!))
      .toEqual(DEVICE_SAMPLE);
    expect(selectPhysicalDevice([DEVICE_SAMPLE], DEVICE_SAMPLE.coreDeviceIdentifier))
      .toEqual(DEVICE_SAMPLE);
  });

  test('redacts stable identifiers and the device name from commit-ready evidence', () => {
    const redacted = redactDeviceForEvidence(DEVICE_SAMPLE);
    const serialized = JSON.stringify(redacted);
    expect(redacted.identifierSha256).toHaveLength(64);
    expect(serialized).not.toContain(DEVICE_SAMPLE.coreDeviceIdentifier);
    expect(serialized).not.toContain(DEVICE_SAMPLE.hardwareUdid!);
    expect(serialized).not.toContain(DEVICE_SAMPLE.name);
  });

  test('preserves typed discovery failures instead of treating bad JSON as no devices', () => {
    expect(() => parseDeviceListPayload({ result: { unexpected: [] } }))
      .toThrow('result.devices');
  });

  test('temporary project specs never inherit a hardcoded signing team', () => {
    const debugSpec = renderProjectSpec(true);
    const releaseSpec = renderProjectSpec(false);
    expect(debugSpec).toContain('DebugBridgeCore');
    expect(debugSpec).toContain('DebugBridgeUI');
    expect(releaseSpec).not.toContain('DebugBridgeCore');
    expect(releaseSpec).not.toContain('DebugBridgeUI');
    expect(debugSpec).not.toContain('DEVELOPMENT_TEAM');
    expect(releaseSpec).not.toContain('DEVELOPMENT_TEAM');
  });

  test('accepts only an explicit valid team ID from the harness environment', () => {
    expect(resolveTeamId({})).toBeUndefined();
    expect(resolveTeamId({ [TEAM_ID_ENV]: 'ABCDEFGHIJ' })).toBe('ABCDEFGHIJ');
    expect(() => resolveTeamId({ [TEAM_ID_ENV]: 'not-a-team' }))
      .toThrow('10-character');
  });

  test('classifies account/provisioning failures as setup gates', () => {
    expect(classifyXcodebuildFailure('Signing for FixtureApp requires a development team.'))
      .toBe('signing_unavailable');
    expect(classifyXcodebuildFailure('error: cannot find value in scope'))
      .toBe('build_failed');
  });
});
describeIfDevice('ios physical-device path', () => {
  test('Xcode/CoreDevice setup gates pass for one selected wired iPhone', () => {
    const result = runPreflightOnly({
      selector: process.env.GSTACK_IOS_TARGET_UDID,
    });
    expect(result.ok).toBe(true);
    expect(result.device.transportType?.toLowerCase()).toBe('wired');
    expect(result.device.pairingState.toLowerCase()).toBe('paired');
    expect(result.device.developerModeStatus.toLowerCase()).toBe('enabled');
    expect(result.acceptedIdentifiers.coreDeviceIdentifier.length).toBeGreaterThan(0);
  });

  test('fixture keeps DebugBridge imports and startup Debug-only', () => {
    const app = readFileSync(
      join(FIXTURE_PATH, 'Sources/FixtureApp/FixtureAppApp.swift'),
      'utf8',
    );
    expect(app).toContain('#if DEBUG');
    expect(app).toContain('import DebugBridgeCore');
    expect(app).toContain('DebugBridgeUIWiring.installAll()');
    expect(app).toContain('#endif');
  });

  testIfDeploy('builds, signs, installs, launches, and passes five live iterations', () => {
    const result = spawnSync(process.execPath, [HARNESS_PATH, '--json'], {
      cwd: ROOT,
      env: process.env,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: 30 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      console.error(result.stderr || result.stdout);
    }
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout) as {
      passedIterations: number;
      requiredIterations: number;
      evidencePath: string;
    };
    expect(output.passedIterations).toBe(5);
    expect(output.requiredIterations).toBe(5);
    expect(existsSync(output.evidencePath)).toBe(true);
  }, 30 * 60_000);
});
