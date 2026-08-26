/**
 * Telemetry consent tiers — the user-consent enforcement point.
 *
 * Telemetry is OPT-IN: it emits only when the user granted a tier through
 * the consent prompt (`telemetry: community` or `telemetry: anonymous` in
 * ~/.gstack/config.yaml). An absent key, an absent config file, an explicit
 * `off`, or any unrecognized value all mean DISABLED — the same default
 * bin/gstack-config's DEFAULTS table reports for an unset key, so a daemon
 * spawned outside a skill preamble (direct $B use, embedders) can never
 * emit while `gstack-config get telemetry` tells the user 'off'.
 *
 * The persistent tier reads through the shared flat-YAML helper in
 * config.ts (readGstackConfigYamlKey), same parser as the pair-agent gate.
 * Env tier: GSTACK_TELEMETRY_OFF=1 always disables; =0 is a harness-side
 * consent assertion that covers the no-config default only — it never
 * overrides an explicit `telemetry: off`.
 *
 * Harness mirrors pair-agent-optin-gate.test.ts: GSTACK_HOME → temp dir,
 * env saved/restored per test, cache reset via _resetTelemetryCache.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { isTelemetryDisabled, logTelemetry, _resetTelemetryCache } from '../src/telemetry';

const savedEnv = {
  GSTACK_HOME: process.env.GSTACK_HOME,
  GSTACK_TELEMETRY_OFF: process.env.GSTACK_TELEMETRY_OFF,
};
const tmpHomes: string[] = [];

/** Fresh GSTACK_HOME with the given config.yaml body (null = no file). */
function tmpHomeWith(configYaml: string | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-telemetry-optout-'));
  tmpHomes.push(dir);
  if (configYaml !== null) {
    fs.writeFileSync(path.join(dir, 'config.yaml'), configYaml);
  }
  process.env.GSTACK_HOME = dir;
  delete process.env.GSTACK_TELEMETRY_OFF;
  _resetTelemetryCache();
  return dir;
}

afterEach(() => {
  for (const k of ['GSTACK_HOME', 'GSTACK_TELEMETRY_OFF'] as const) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  _resetTelemetryCache();
  while (tmpHomes.length) fs.rmSync(tmpHomes.pop()!, { recursive: true, force: true });
});

describe('telemetry persistent opt-out tier (config.yaml)', () => {
  test('DISABLED when config.yaml has plain `telemetry: off`', () => {
    tmpHomeWith('telemetry: off\n');
    expect(isTelemetryDisabled()).toBe(true);
  });

  test("DISABLED when the value is single-quoted: telemetry: 'off'", () => {
    tmpHomeWith("telemetry: 'off'\n");
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('DISABLED when the value is double-quoted: telemetry: "off"', () => {
    tmpHomeWith('telemetry: "off"\n');
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('DISABLED with a trailing comment: telemetry: off # user opted out', () => {
    tmpHomeWith('telemetry: off # user opted out\n');
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('DISABLED when the key sits among other keys', () => {
    tmpHomeWith('pair_agent: off\ntelemetry: off\nskill_prefix: none\n');
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('ENABLED when the user granted the `anonymous` tier', () => {
    tmpHomeWith('telemetry: anonymous\n');
    expect(isTelemetryDisabled()).toBe(false);
  });

  test('ENABLED when the user granted the `community` tier', () => {
    tmpHomeWith('telemetry: community\n');
    expect(isTelemetryDisabled()).toBe(false);
  });

  test('DISABLED when the key is absent — consent was never granted', () => {
    // bin/gstack-config's DEFAULTS table reports 'off' for an unset telemetry
    // key; the daemon must agree or direct-$B spawns emit while the user is
    // told telemetry is off (default-polarity split-brain).
    tmpHomeWith('pair_agent: on\n');
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('DISABLED when config.yaml does not exist — fresh installs emit nothing', () => {
    tmpHomeWith(null);
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('DISABLED on an unrecognized tier value (fail-closed)', () => {
    tmpHomeWith('telemetry: banana\n');
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('a commented-out consent line does not enable: `# telemetry: community`', () => {
    tmpHomeWith('# telemetry: community\n');
    expect(isTelemetryDisabled()).toBe(true);
  });
});

describe('telemetry env tier + cache semantics', () => {
  test('GSTACK_TELEMETRY_OFF=1 disables even when config says anonymous', () => {
    tmpHomeWith('telemetry: anonymous\n');
    process.env.GSTACK_TELEMETRY_OFF = '1';
    _resetTelemetryCache();
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('GSTACK_TELEMETRY_OFF=0 never overrides an explicit `telemetry: off`', () => {
    // The =0 hint is a harness-side consent assertion for scratch homes with
    // no config store; a user's written opt-out always wins over it.
    tmpHomeWith('telemetry: off\n');
    process.env.GSTACK_TELEMETRY_OFF = '0';
    _resetTelemetryCache();
    expect(isTelemetryDisabled()).toBe(true);
  });

  test('GSTACK_TELEMETRY_OFF=0 enables when no config store exists (harness seam)', () => {
    tmpHomeWith(null);
    process.env.GSTACK_TELEMETRY_OFF = '0';
    _resetTelemetryCache();
    expect(isTelemetryDisabled()).toBe(false);
  });

  test('verdict is cached per process; _resetTelemetryCache re-reads config', () => {
    const dir = tmpHomeWith('telemetry: anonymous\n');
    expect(isTelemetryDisabled()).toBe(false);
    // Opt out on disk mid-process: the cached verdict holds until reset.
    fs.writeFileSync(path.join(dir, 'config.yaml'), 'telemetry: off\n');
    expect(isTelemetryDisabled()).toBe(false);
    _resetTelemetryCache();
    expect(isTelemetryDisabled()).toBe(true);
  });
});

describe('enforcement: logTelemetry writes only with granted consent', () => {
  test('config-tier opt-out suppresses the JSONL append', async () => {
    const dir = tmpHomeWith('telemetry: off\n');
    logTelemetry({ event: 'domain_skill_fired', host: 'example.com' });
    // Fire-and-forget path: give any (incorrect) async append time to land.
    await new Promise((r) => setTimeout(r, 30));
    expect(fs.existsSync(path.join(dir, 'analytics', 'browse-telemetry.jsonl'))).toBe(false);
  });

  test('no consent ever recorded (absent key) suppresses the JSONL append', async () => {
    const dir = tmpHomeWith('pair_agent: on\n');
    logTelemetry({ event: 'domain_skill_fired', host: 'example.com' });
    await new Promise((r) => setTimeout(r, 30));
    expect(fs.existsSync(path.join(dir, 'analytics', 'browse-telemetry.jsonl'))).toBe(false);
  });

  test('granted `community` tier appends the event', async () => {
    const dir = tmpHomeWith('telemetry: community\n');
    logTelemetry({ event: 'domain_skill_fired', host: 'example.com' });
    await new Promise((r) => setTimeout(r, 30));
    const file = path.join(dir, 'analytics', 'browse-telemetry.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf-8')).toContain('domain_skill_fired');
  });
});
