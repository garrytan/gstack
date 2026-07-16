import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dir, '..');
const PRE_FIXTURE = join(ROOT, 'test/fixtures/ios-fix/ios-qa-swiftui-tap-pre.json');
const PRE_SCREENSHOT = join(ROOT, 'test/fixtures/ios-fix/ios-qa-swiftui-tap-pre.png');

describe('ios-fix regression fixture — SwiftUI taps reported success without acting', () => {
  test('preserves the pre-fix state and physical-device screenshot', () => {
    const state = JSON.parse(readFileSync(PRE_FIXTURE, 'utf8'));
    expect(state).toEqual({
      _schema_version: 1,
      _app_build_id: 'uninitialized',
      _accessor_hash: 'uninitialized',
      keys: {},
    });

    const png = readFileSync(PRE_SCREENSHOT);
    expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(png.readUInt32BE(16)).toBe(1206);
    expect(png.readUInt32BE(20)).toBe(2622);
  });

  test('keeps the physical-device deploy/tap test opt-in and executable', () => {
    const deviceTest = readFileSync(join(ROOT, 'test/skill-e2e-ios-device.test.ts'), 'utf8');
    expect(deviceTest).toContain("process.env.GSTACK_IOS_DEVICE_DEPLOY === '1'");
    expect(deviceTest).toContain("'primary-button'");
    expect(deviceTest).toContain("'/tap'");
    expect(deviceTest).not.toContain("test.skip('TODO(deploy)");
  });
});
