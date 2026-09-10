/**
 * Two-phase timeout pins for the claude session runner (WS4c).
 *
 * The old single timer charged API queue latency to the work budget — the
 * recurring '0 turns / $0.00 / x3 attempts' failure with four budget-bump
 * receipts (180→300s, 240→360s, 300→420s, 90→300s). The split:
 *   startup phase — no NDJSON byte yet; killed at the grace with the
 *     DISTINCT reason 'timeout_startup' (availability, not behavior);
 *   work phase — armed on the first byte for the REMAINING budget, so the
 *     total wall never exceeds `timeout` (tier envelopes are margin-free:
 *     tests pass `timeout: CAPTURE_MS` and use the same tier as bun budget).
 *
 * Also pins the TODOS-filed 300s CI startup floor: shared CI runners queue
 * harder, and a floor below 300s converts ordinary queueing into false reds.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  runSkillTest,
  STARTUP_GRACE_CI_FLOOR_MS,
  STARTUP_GRACE_MS,
} from './helpers/session-runner';

describe('session-runner two-phase timeout', () => {
  test('CI startup-grace floor is 300s and the local default is sane', () => {
    expect(STARTUP_GRACE_CI_FLOOR_MS).toBe(300_000);
    expect(STARTUP_GRACE_MS).toBeGreaterThanOrEqual(60_000);
    expect(STARTUP_GRACE_MS).toBeLessThanOrEqual(STARTUP_GRACE_CI_FLOOR_MS);
  });

  test('a run whose first byte arrives late still gets its work budget honored within the total', async () => {
    // Fake claude: silent for 2s (startup latency), then streams NDJSON and
    // wedges. startupGraceMs=4s tolerates the latency; work budget then
    // kills at ~timeout. exitReason must be plain 'timeout' (work phase),
    // NOT 'timeout_startup', and the wall must respect the total envelope.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grace-'));
    const shimDir = path.join(dir, 'bin');
    fs.mkdirSync(shimDir);
    fs.writeFileSync(path.join(shimDir, 'claude'), [
      '#!/bin/bash',
      'sleep 2',
      'echo \'{"type":"system","subtype":"init"}\'',
      `exec sleep 6071.${process.pid}`,
    ].join('\n') + '\n', { mode: 0o755 });

    const realPath = process.env.PATH;
    const realCI = process.env.CI;
    process.env.PATH = `${shimDir}:${realPath}`;
    // This probe pins LOCAL grace semantics (caller honored verbatim). In CI
    // the runner clamps explicit graces up to the 300s floor by design, so
    // the small shim grace would never take effect — clear CI for the call
    // and pin the floor itself in its own probe below.
    delete process.env.CI;
    try {
      const started = Date.now();
      const result = await runSkillTest({
        prompt: 'ignored',
        workingDirectory: dir,
        maxTurns: 1,
        timeout: 5_000,
        startupGraceMs: 4_000,
        testName: 'grace-probe-work-phase',
      });
      const wall = Date.now() - started;
      expect(result.exitReason).toBe('timeout');
      expect(result.firstResponseMs).toBeGreaterThanOrEqual(1_500);
      // Total envelope: startup consumed ~2s, work phase gets the remainder —
      // wall ≈ timeout (5s) + stderr grace (5s), never grace+timeout stacked.
      expect(wall).toBeLessThan(20_000);
    } finally {
      process.env.PATH = realPath;
      if (realCI !== undefined) process.env.CI = realCI;
      Bun.spawnSync(['pkill', '-f', `sleep 6071\\.${process.pid}`], { timeout: 5_000 });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('a silent API is killed at the grace, early, with the startup reason', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grace-'));
    const shimDir = path.join(dir, 'bin');
    fs.mkdirSync(shimDir);
    fs.writeFileSync(path.join(shimDir, 'claude'), `#!/bin/bash\nexec sleep 6072.${process.pid}\n`, { mode: 0o755 });

    const realPath = process.env.PATH;
    const realCI = process.env.CI;
    process.env.PATH = `${shimDir}:${realPath}`;
    // LOCAL semantics again: in CI the floor clamps this 2s grace to 300s
    // (capped by timeout → 30s), which is exactly the false red this test
    // shipped with. The floor's own behavior is pinned in the next probe.
    delete process.env.CI;
    try {
      const started = Date.now();
      const result = await runSkillTest({
        prompt: 'ignored',
        workingDirectory: dir,
        maxTurns: 1,
        timeout: 30_000,       // generous work budget…
        startupGraceMs: 2_000, // …but startup dies fast when nothing answers
        testName: 'grace-probe-startup',
      });
      const wall = Date.now() - started;
      expect(result.exitReason).toBe('timeout_startup');
      // The whole point: ~2s + drain grace, NOT the 30s work budget.
      expect(wall).toBeLessThan(15_000);
      expect(result.costEstimate.turnsUsed).toBe(0);
    } finally {
      process.env.PATH = realPath;
      if (realCI !== undefined) process.env.CI = realCI;
      Bun.spawnSync(['pkill', '-f', `sleep 6072\\.${process.pid}`], { timeout: 5_000 });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('in CI the floor clamps an explicit low grace (adversarial pin — the clamp is real)', async () => {
    // The floor exists because CI queueing converts a low grace into false
    // reds; an explicit startupGraceMs must NOT bypass it (review finding:
    // "the name promised a clamp the code lacked"). With CI set, a 2s grace
    // request against a 6s timeout floors to min(300s, timeout) = 6s — the
    // silent shim survives PAST the requested 2s and dies at the cap, still
    // in the startup phase.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grace-'));
    const shimDir = path.join(dir, 'bin');
    fs.mkdirSync(shimDir);
    fs.writeFileSync(path.join(shimDir, 'claude'), `#!/bin/bash\nexec sleep 6073.${process.pid}\n`, { mode: 0o755 });

    const realPath = process.env.PATH;
    const realCI = process.env.CI;
    process.env.PATH = `${shimDir}:${realPath}`;
    process.env.CI = '1';
    try {
      const started = Date.now();
      const result = await runSkillTest({
        prompt: 'ignored',
        workingDirectory: dir,
        maxTurns: 1,
        timeout: 6_000,
        startupGraceMs: 2_000, // must be clamped up, not honored
        testName: 'grace-probe-ci-floor',
      });
      const wall = Date.now() - started;
      expect(result.exitReason).toBe('timeout_startup');
      // Proof the clamp fired: the kill lands at the 6s timeout cap, not the
      // requested 2s (drain grace can only extend, never shorten).
      expect(wall).toBeGreaterThanOrEqual(5_500);
      expect(wall).toBeLessThan(20_000);
    } finally {
      process.env.PATH = realPath;
      if (realCI !== undefined) process.env.CI = realCI;
      else delete process.env.CI;
      Bun.spawnSync(['pkill', '-f', `sleep 6073\\.${process.pid}`], { timeout: 5_000 });
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
