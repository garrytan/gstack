/**
 * Synchronous-spawn timeout tripwire — the enforcement for the shard-wedge
 * class that reached main.
 *
 * Mechanism: spawnSync / execSync / Bun.spawnSync BLOCK the main thread, so
 * bun's in-process per-test timeout can never fire while one waits. A child
 * that hangs (stdin read, network probe, dead daemon) wedges the whole shard
 * until the runner's external wall-clock SIGKILL — observed live on main:
 * test/gstack-memory-ingest.test.ts (normally 2.3s) held shard 2 at the
 * 360s wall on free-tests run 33262077256 while its five siblings finished
 * in ~65s. The 2026-08 sweep added a `timeout` to ~400 call sites across
 * ~130 test files; this tripwire keeps the class extinct.
 *
 * Rule: every sync-spawn call site in the test trees must carry a `timeout`
 * within its options window (WINDOW_LINES below), or the line above / the
 * call line must carry an explicit exemption marker with a reason:
 *
 *   // tripwire-exempt: <why this call may legitimately block unbounded>
 *
 * Exemptions are counted and ratcheted (EXEMPT_CEILING can only go down).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

// Mirrors the free runner's TEST_ROOTS plus test/helpers (helpers spawn on
// behalf of tests and wedge shards just the same).
const SCAN_ROOTS = [
  'test',
  'browse/test',
  'design/test',
  'make-pdf/test',
  'ios-qa/daemon/test',
  'ios-qa/scripts',
  'browser-skills',
];

const SYNC_SPAWN = /\b(?:spawnSync|execSync|execFileSync|Bun\.spawnSync)\s*\(/;
/** Generous on purpose: multi-line arg arrays push the options object far
 *  below the call line (observed: +13 lines in codex-model-probe). A wide
 *  window trades a sliver of false-negative risk for zero rename churn. */
const WINDOW_LINES = 30;
const EXEMPT_MARKER = /tripwire-exempt:/;
/** Comment lines legitimately NAME the calls (doc headers, grep-needle
 *  tables in sibling tripwires) without being call sites. */
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/** Shrink-only: lower it when exemptions burn down; never raise it. */
const EXEMPT_CEILING = 8;

const SELF = path.join('test', 'spawnsync-timeout-tripwire.test.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

interface Violation { file: string; line: number; text: string }

function scan(): { violations: Violation[]; exempt: Violation[] } {
  const violations: Violation[] = [];
  const exempt: Violation[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = path.join(ROOT, root);
    if (!fs.existsSync(abs)) continue;
    for (const file of walk(abs)) {
      const rel = path.relative(ROOT, file);
      if (rel === SELF) continue;
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (!SYNC_SPAWN.test(lines[i])) continue;
        if (COMMENT_LINE.test(lines[i])) continue;
        const record = { file: rel, line: i + 1, text: lines[i].trim().slice(0, 120) };
        if (EXEMPT_MARKER.test(lines[i]) || (i > 0 && EXEMPT_MARKER.test(lines[i - 1]))) {
          exempt.push(record);
          continue;
        }
        const window = lines.slice(i, i + WINDOW_LINES).join('\n');
        if (!/\btimeout\b/.test(window)) violations.push(record);
      }
    }
  }
  return { violations, exempt };
}

describe('sync-spawn timeout tripwire', () => {
  const { violations, exempt } = scan();

  test('every sync spawn in the test trees carries a timeout (or a reasoned exemption)', () => {
    const detail = violations
      .map((v) => `  ${v.file}:${v.line}  ${v.text}`)
      .join('\n');
    expect(
      violations,
      `sync-spawn call site(s) without a timeout — each one can wedge a whole shard to its wall-clock kill (bun's per-test timeout cannot interrupt a blocking spawn):\n${detail}\n`
      + 'Fix: add `timeout: 30_000` (120_000 for genuinely slow ops) to the options, or fix the wrapping helper once. '
      + 'A call that must legitimately block unbounded gets `// tripwire-exempt: <reason>` on or above the line.',
    ).toEqual([]);
  });

  test('exemptions only shrink', () => {
    expect(
      exempt.length,
      `tripwire-exempt count ${exempt.length} exceeds the ceiling ${EXEMPT_CEILING}. `
      + 'New unbounded sync spawns are not allowed — add a timeout instead. If an exemption was '
      + `removed, lower EXEMPT_CEILING in ${SELF} in the same commit:\n`
      + exempt.map((v) => `  ${v.file}:${v.line}`).join('\n'),
    ).toBeLessThanOrEqual(EXEMPT_CEILING);
  });

  test('scan sanity: the pattern still matches real code (must not rot to vacuous green)', () => {
    // The test trees legitimately contain hundreds of sync spawns WITH
    // timeouts; if the scanner suddenly sees none at all, the regex or the
    // roots rotted and the tripwire is scanning nothing.
    let total = 0;
    for (const root of SCAN_ROOTS) {
      const abs = path.join(ROOT, root);
      if (!fs.existsSync(abs)) continue;
      for (const file of walk(abs)) {
        const src = fs.readFileSync(file, 'utf-8');
        for (const line of src.split('\n')) if (SYNC_SPAWN.test(line)) total += 1;
      }
    }
    expect(total).toBeGreaterThan(100);
  });
});
