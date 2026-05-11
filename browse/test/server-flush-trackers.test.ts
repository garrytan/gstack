/**
 * Regression: flushBuffers state-tracker declaration audit.
 *
 * `flushBuffers()` (server.ts) maintains per-buffer cursors so it only
 * appends *new* entries to each on-disk log on every interval tick:
 *
 *   const newConsoleCount  = consoleBuffer.totalAdded  - lastConsoleFlushed;
 *   const newNetworkCount  = networkBuffer.totalAdded  - lastNetworkFlushed;
 *   const newDialogCount   = dialogBuffer.totalAdded   - lastDialogFlushed;
 *
 * The trackers must be declared with `let X = 0;` at module scope so the
 * subtraction returns a real number on the first tick. If a tracker is
 * referenced inside flushBuffers but never declared at module scope, the
 * interval throws `ReferenceError: X is not defined` every second — the
 * throw is swallowed by the catch at the bottom of flushBuffers (logged
 * as `[browse] Buffer flush failed: <name> is not defined`), the
 * corresponding on-disk log file is *never written*, and the regression
 * is silent in production.
 *
 * This source-level guard catches that exact class of regression — a
 * future flush-perf refactor that adds a fourth buffer cursor (or a
 * future contributor that copy-pastes the `last*Flushed` pattern without
 * the matching declaration) will fail this test before it ships.
 *
 * Pattern matches `terminal-agent.test.ts` and `dual-listener.test.ts`:
 * read source as text, assert an invariant, no daemon required.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import * as path from 'path';

const SERVER_TS = readFileSync(
  path.resolve(import.meta.dir, '../src/server.ts'),
  'utf-8',
);

describe('server.ts — flushBuffers tracker declarations', () => {
  test('every `last*Flushed` tracker referenced inside flushBuffers is declared at module scope', () => {
    // Locate the flushBuffers function body. The function is `async function
    // flushBuffers() { ... }` — match through the closing brace at the start
    // of a line (one-level-deep function in the file).
    const fnMatch = SERVER_TS.match(
      /async function flushBuffers\([^)]*\)[^{]*\{([\s\S]*?)\n\}/,
    );
    expect(fnMatch, 'flushBuffers function not found in server.ts').not.toBeNull();
    const body = fnMatch![1]!;

    // Pull every identifier matching the `lastXxxFlushed` cursor pattern.
    const trackerMatches = [...body.matchAll(/\blast([A-Z]\w+)Flushed\b/g)];
    const trackers = Array.from(new Set(trackerMatches.map((m) => `last${m[1]}Flushed`)));

    expect(
      trackers.length,
      'flushBuffers should reference at least one last*Flushed tracker',
    ).toBeGreaterThan(0);

    for (const tracker of trackers) {
      // Module-level `let X = 0;` declaration (not inside a function body).
      // Anchored start-of-line to avoid matching nested re-declarations or
      // string literals.
      const declared = new RegExp(
        `(?:^|\\n)let\\s+${tracker}\\s*=\\s*0\\s*;`,
      ).test(SERVER_TS);
      expect(
        declared,
        `\`${tracker}\` is referenced inside flushBuffers but never declared at module scope ` +
          `with \`let ${tracker} = 0;\` — the interval will throw ReferenceError every tick ` +
          `and the corresponding on-disk log will never be written`,
      ).toBe(true);
    }
  });
});
