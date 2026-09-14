/**
 * Guard: no test file may schedule a delayed process.exit().
 *
 * `bun test` runs EVERY test file in one process. The pattern of arming a
 * 500ms timer in afterAll whose callback calls process.exit(0) — once used
 * in several browse/design tests as a "bm.close() can hang" workaround —
 * assumes each file gets its own process. It doesn't: the armed timer fires
 * 500ms later, mid-way through a LATER test file, and kills the entire
 * suite with exit code 0 and no summary. The truncated run silently masks
 * every downstream failure (observed: only ~16 of 434 files ran, shell
 * exit 0).
 *
 * This test statically scans every *.test.ts in the repo and fails if any
 * schedules process.exit via setTimeout. Teardown must only release the
 * file's own resources (e.g. `await bm.close()` — BrowserManager.close()
 * is already time-boxed internally) — never terminate the shared runner.
 *
 * If a future test legitimately needs this pattern inside a child-process
 * script (template literal passed to `bun -e`), split the child script
 * into a fixture file instead of exempting it here.
 */
import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dir, '..');

// Matches a setTimeout whose arrow callback (with or without an argument)
// immediately calls process.exit. Doesn't match its own escaped source text
// (the backslashes in this regex literal prevent a literal-text match).
const DELAYED_EXIT = /setTimeout\(\s*(?:\(\s*\)|\(?\w+\)?)\s*=>\s*process\.exit\(/;

test('no test file schedules a delayed process.exit (kills the whole bun test run)', () => {
  const glob = new Bun.Glob('**/*.test.ts');
  const violations: string[] = [];

  for (const rel of glob.scanSync({ cwd: repoRoot })) {
    if (rel.includes('node_modules/')) continue;
    const source = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (DELAYED_EXIT.test(lines[i])) {
        violations.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
      }
    }
  }

  expect(violations).toEqual([]);
});
