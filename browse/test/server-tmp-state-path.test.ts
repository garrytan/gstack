/**
 * Regression: state-file temp path uniqueness.
 *
 * The daemon writes `.gstack/browse.json` via the standard atomic-rename
 * pattern: `writeFileSync(tmp, …) → renameSync(tmp, stateFile)`. The
 * pattern is correct for a single writer. It breaks for *concurrent*
 * writers when they share a single temp filename:
 *
 *   t0  Writer A: writeFileSync(stateFile + '.tmp', payloadA)
 *   t1  Writer B: writeFileSync(stateFile + '.tmp', payloadB)   // overwrites A
 *   t2  Writer A: renameSync(stateFile + '.tmp', stateFile)    // moves B's payload
 *   t3  Writer B: renameSync(stateFile + '.tmp', stateFile)    // ENOENT — file gone
 *
 * A 15-CLI cold-start race against a fresh repo reproduces this in the
 * wild — one of the spawned daemons dies with:
 *
 *   [browse] Failed to start: ENOENT: no such file or directory,
 *   rename '…/.gstack/browse.json.tmp' -> '…/.gstack/browse.json'
 *
 * Fix: per-process temp path via `tmpStatePath()` (pid + 4 random bytes
 * of suffix). Each concurrent writer gets a unique path; the atomic
 * rename still gives last-writer-wins semantics on the final state file
 * content, but writers no longer kill each other on the rename step.
 *
 * This source-level guard locks two invariants:
 *   1. No remaining `stateFile + '.tmp'` literals in server.ts (regression
 *      catch — a future copy-paste or revert would re-introduce the bug)
 *   2. The 4 known state-write call sites all use `tmpStatePath()`
 *      (positive coverage)
 *
 * Same pattern as terminal-agent.test.ts and dual-listener.test.ts:
 * read source as text, assert invariant, no daemon required.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import * as path from 'path';

const SERVER_TS = readFileSync(
  path.resolve(import.meta.dir, '../src/server.ts'),
  'utf-8',
);

describe('server.ts — state-file temp-path uniqueness', () => {
  test('no remaining `stateFile + \'.tmp\'` literals (regression catch)', () => {
    // The shared-temp-filename pattern that caused the cold-start ENOENT
    // race. A future contributor that copy-pastes the old pattern (or a
    // revert) will fail this test.
    const sharedTempLiterals = [
      ...SERVER_TS.matchAll(/stateFile\s*\+\s*['"`]\.tmp['"`]/g),
    ];
    expect(
      sharedTempLiterals.length,
      `Found ${sharedTempLiterals.length} reference(s) to the shared ` +
        `\`stateFile + '.tmp'\` pattern. Use \`tmpStatePath()\` instead — ` +
        `the shared pattern races on rename when two daemons spawn ` +
        `concurrently (cold-start race + parallel /tunnel/start).`,
    ).toBe(0);
  });

  test('every state-file writeFileSync call uses tmpStatePath()', () => {
    // Find every `writeFileSync(X, JSON.stringify(stateContent...` or
    // `…(state, …)` call and verify X is `tmpStatePath()` or a variable
    // assigned from `tmpStatePath()`.
    const writeCalls = [
      ...SERVER_TS.matchAll(
        /fs\.writeFileSync\s*\(\s*(\w+)\s*,\s*JSON\.stringify\(\s*(state|stateContent)/g,
      ),
    ];
    expect(
      writeCalls.length,
      'expected at least one state-file write site',
    ).toBeGreaterThan(0);

    for (const m of writeCalls) {
      const varName = m[1]!;
      // Walk back to the assignment of varName — must come from tmpStatePath()
      const assignRe = new RegExp(
        `(?:const|let)\\s+${varName}\\s*=\\s*tmpStatePath\\(\\)`,
      );
      expect(
        assignRe.test(SERVER_TS),
        `state-file writeFileSync uses \`${varName}\` but no \`const ${varName} = tmpStatePath()\` ` +
          `assignment was found upstream. Either assign from tmpStatePath() ` +
          `or pass tmpStatePath() inline — the shared \`stateFile + '.tmp'\` ` +
          `pattern races under concurrent daemon startup`,
      ).toBe(true);
    }
  });

  test('tmpStatePath() declaration includes a per-process unique suffix', () => {
    // Lock the suffix shape so a future contributor doesn't accidentally
    // strip the uniqueness back out by simplifying the helper.
    const declMatch = SERVER_TS.match(
      /function tmpStatePath\(\)[^{]*\{([\s\S]*?)\n\}/,
    );
    expect(declMatch, 'tmpStatePath() declaration not found').not.toBeNull();
    const body = declMatch![1]!;

    // Must reference both process.pid and crypto.randomBytes — two
    // independent sources of uniqueness.
    expect(body, 'tmpStatePath() must include process.pid in the suffix').toContain(
      'process.pid',
    );
    expect(
      body,
      'tmpStatePath() must include a random suffix via crypto.randomBytes',
    ).toContain('crypto.randomBytes');
  });
});
