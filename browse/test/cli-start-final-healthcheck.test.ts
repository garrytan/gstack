/**
 * Coverage for #1846 — `browse` CLI must not report "Server failed to start
 * within Ns" when the detached daemon actually came up healthy a moment later.
 *
 * The spawned server is `detached: true` + `.unref()`'d, so it keeps booting
 * independently of the CLI's poll loop. On a loaded machine (the issue repro is
 * Windows under load) the loop's budget can elapse in the gap between its last
 * health tick and the daemon becoming ready — the very next `browse status`
 * then shows a healthy, listening server. #1732 only widened the budget; the
 * throw site itself still fired on timeout regardless of real health.
 *
 * Two invariants are defended here:
 *   1. `startServer` does a final readState()+isServerHealthy() re-check before
 *      the timeout throw (structural — removes the false negative at any budget).
 *   2. The startup budget is env-overridable via BROWSE_START_TIMEOUT, matching
 *      the BROWSE_* tunable convention (BROWSE_PORT, BROWSE_IDLE_TIMEOUT, ...).
 *
 * (1) is a static source invariant (live spawn cycles belong in the e2e tier);
 * (2) is exercised behaviorally against the exported pure helper.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveStartTimeout } from '../src/cli';

const CLI = path.join(import.meta.dir, '..', 'src', 'cli.ts');
const read = (): string => fs.readFileSync(CLI, 'utf-8');

describe('#1846 startServer false-negative on a late-healthy detached daemon', () => {
  test('a final health re-check sits between the poll loop and the timeout throw', () => {
    const src = read();
    const throwIdx = src.indexOf('Server failed to start within');
    expect(throwIdx).toBeGreaterThan(-1);

    // The startServer poll loop ends at its `await Bun.sleep(100)`; the final
    // re-check must live AFTER that loop and BEFORE the timeout throw.
    const loopEnd = src.lastIndexOf('await Bun.sleep(100)', throwIdx);
    expect(loopEnd).toBeGreaterThan(-1);
    const between = src.slice(loopEnd, throwIdx);

    // It must re-read state and re-probe health, then be able to return — i.e.
    // a genuine recovery path, not just a comment.
    expect(between).toContain('readState()');
    expect(between).toMatch(/isServerHealthy\([^)]*\)/);
    expect(between).toMatch(/return\s+\w+;/);
  });

  test('the re-check returns the recovered state rather than swallowing it', () => {
    const src = read();
    // Guard against a refactor that probes health but forgets to return the
    // state (which would re-introduce the false negative).
    expect(src).toMatch(/if\s*\([^)]*await\s+isServerHealthy\([^)]*\)\)\s*\{\s*return\s+\w+;/);
  });
});

describe('#1846 BROWSE_START_TIMEOUT env override (resolveStartTimeout)', () => {
  const platformDefault = resolveStartTimeout({} as NodeJS.ProcessEnv);

  test('platform default is a positive millisecond budget when unset', () => {
    expect(platformDefault).toBeGreaterThan(0);
  });

  test('honors a positive BROWSE_START_TIMEOUT override', () => {
    expect(resolveStartTimeout({ BROWSE_START_TIMEOUT: '42000' } as NodeJS.ProcessEnv)).toBe(42000);
  });

  test('falls back to the platform default for non-positive / unparseable values', () => {
    for (const bad of ['0', '-5', 'abc', '', '   ']) {
      expect(resolveStartTimeout({ BROWSE_START_TIMEOUT: bad } as NodeJS.ProcessEnv)).toBe(platformDefault);
    }
  });

  test('MAX_START_WAIT is wired through resolveStartTimeout (no stray hardcoded constant)', () => {
    const src = read();
    expect(src).toMatch(/const\s+MAX_START_WAIT\s*=\s*resolveStartTimeout\(\)/);
  });
});
