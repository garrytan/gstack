/**
 * Pins the consolidated E2E tier gate (test/helpers/e2e-gate.ts).
 *
 * Two invariants:
 *   1. The env matrix — including the tierless-run trap: EVALS=1 with
 *      EVALS_TIER unset must SKIP both tiers (that is how `test:evals` /
 *      `eval:bg:all` have always treated whole-file tier gates; per-test
 *      diff selection covers those runs instead).
 *   2. Module purity — e2e-gate.ts is imported at module scope by every
 *      tier-gated paid test file, one-process-each under the sharded
 *      runner. Its only import must be `bun:test` and it must contain no
 *      spawn/network/fs machinery (the reason it cannot live in
 *      e2e-helpers.ts, whose EVALS=1 module scope runs a ~30s claude ping).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { describeE2ETier, e2eTierEnabled } from './e2e-gate';

const SAVED_EVALS = process.env.EVALS;
const SAVED_TIER = process.env.EVALS_TIER;

function restoreEnv() {
  if (SAVED_EVALS === undefined) delete process.env.EVALS;
  else process.env.EVALS = SAVED_EVALS;
  if (SAVED_TIER === undefined) delete process.env.EVALS_TIER;
  else process.env.EVALS_TIER = SAVED_TIER;
}

describe('e2e-gate: env matrix (read at call time)', () => {
  beforeEach(() => {
    delete process.env.EVALS;
    delete process.env.EVALS_TIER;
  });
  afterEach(restoreEnv);

  test('EVALS unset → skip, even when EVALS_TIER matches', () => {
    process.env.EVALS_TIER = 'gate';
    expect(e2eTierEnabled('gate')).toBe(false);
    expect(describeE2ETier('gate')).toBe(describe.skip);
    expect(describeE2ETier('periodic')).toBe(describe.skip);
  });

  test('EVALS=1 + matching tier → run', () => {
    process.env.EVALS = '1';
    process.env.EVALS_TIER = 'gate';
    expect(e2eTierEnabled('gate')).toBe(true);
    expect(describeE2ETier('gate')).toBe(describe);

    process.env.EVALS_TIER = 'periodic';
    expect(e2eTierEnabled('periodic')).toBe(true);
    expect(describeE2ETier('periodic')).toBe(describe);
  });

  test('EVALS=1 + other tier → skip', () => {
    process.env.EVALS = '1';
    process.env.EVALS_TIER = 'periodic';
    expect(e2eTierEnabled('gate')).toBe(false);
    expect(describeE2ETier('gate')).toBe(describe.skip);

    process.env.EVALS_TIER = 'gate';
    expect(e2eTierEnabled('periodic')).toBe(false);
    expect(describeE2ETier('periodic')).toBe(describe.skip);
  });

  test('EVALS=1 + EVALS_TIER unset → skip both tiers (the tierless test:evals / eval:bg:all trap)', () => {
    process.env.EVALS = '1';
    expect(e2eTierEnabled('gate')).toBe(false);
    expect(e2eTierEnabled('periodic')).toBe(false);
    expect(describeE2ETier('gate')).toBe(describe.skip);
    expect(describeE2ETier('periodic')).toBe(describe.skip);
  });
});

describe('e2e-gate: module purity (side-effect-free import)', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, 'e2e-gate.ts'), 'utf-8');

  test('the only import specifier is bun:test', () => {
    const specifiers = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => s !== 'bun:test')).toEqual([]);
    // No dynamic escape hatches either.
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });

  test('no spawn / network / fs machinery in the module body', () => {
    // Strip comments so prose explaining WHY the module must stay pure
    // (which legitimately names spawnSync etc.) doesn't trip the scan.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const banned of [
      'spawnSync', 'spawn(', 'execSync', 'child_process',
      'Bun.spawn', 'Bun.file', 'Bun.write',
      'fetch(', 'WebSocket', 'XMLHttpRequest',
      'readFileSync', 'writeFileSync', 'mkdirSync', 'node:fs', "from 'fs'",
    ]) {
      expect(code.includes(banned), `e2e-gate.ts must not contain "${banned}"`).toBe(false);
    }
  });
});
