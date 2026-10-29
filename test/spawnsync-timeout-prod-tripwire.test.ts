/**
 * Production-code sync-spawn timeout tripwire — sibling of
 * test/spawnsync-timeout-tripwire.test.ts, which only scans TEST trees.
 *
 * Mechanism: the same blocking-spawn hazard applies to shipped code, with a
 * worse blast radius than a wedged test shard — an unbounded spawnSync inside
 * a host hook blocks past the host's RPC window (observed 2026-10-29:
 * timeline-stop-hook timed out at 15s because the "native" slug path spawned
 * `git` with no timeout on a host where git children stall for 10s+), and an
 * unbounded spawn in a bin/helper wedges whatever CLI invoked it.
 *
 * Rule: every sync-spawn call site in PRODUCTION code (everything outside the
 * test trees) must carry a `timeout` within its options window
 * (WINDOW_LINES below), or the line above / the call line must carry an
 * explicit exemption marker with a reason:
 *
 *   // tripwire-exempt: <why this call may legitimately block unbounded>
 *
 * Known legitimate exemption today: an interactive $EDITOR session whose
 * duration belongs to the user (browse/src/domain-skill-commands.ts).
 * Exemptions are counted and ratcheted (EXEMPT_CEILING can only go down).
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');

/**
 * Directories that are NOT production code: test trees (owned by the
 * test-side tripwire), fixtures, vendored deps, generated/rendered output,
 * and dot-dirs. Everything else is scanned.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  'test',
  'tests',
  'fixtures',
  '__fixtures__',
  'dist',
  'docs',
  '.gstack-rendered',
]);

const SYNC_SPAWN = /\b(?:spawnSync|execSync|execFileSync|Bun\.spawnSync)\s*\(/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]s$/;
/** Generous on purpose, mirrors the test-side tripwire: multi-line arg arrays
 *  push the options object far below the call line. */
const WINDOW_LINES = 30;
/** Options literals are conventionally named and hoisted a few lines above the
 *  call (e.g. `const options = { ..., timeout: 10_000 }; spawnSync(x, args, options)`).
 *  A short look-back covers that shape without weakening the forward window. */
const LOOKBACK_LINES = 10;
const EXEMPT_MARKER = /tripwire-exempt:/;
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/**
 * Rough inside-a-string heuristic: `spawnSync(` appearing inside a string
 * literal (reason/curation data, doc needles) is not a call site. If the text
 * before the match on the same line contains an odd number of ' or " it is
 * very likely mid-string — escaped quotes are rare enough to ignore.
 */
function insideStringLiteral(line: string, matchIndex: number): boolean {
  const before = line.slice(0, matchIndex);
  const singles = (before.match(/'/g) ?? []).length;
  const doubles = (before.match(/"/g) ?? []).length;
  return singles % 2 === 1 || doubles % 2 === 1;
}

/** Shrink-only: lower it when exemptions burn down; never raise it. */
const EXEMPT_CEILING = 1;

const SELF = path.join('test', 'spawnsync-timeout-prod-tripwire.test.ts');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (/\.(?:[cm]?[jt]s|tsx)$/.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

interface Violation { file: string; line: number; text: string }

function scan(): { violations: Violation[]; exempt: Violation[] } {
  const violations: Violation[] = [];
  const exempt: Violation[] = [];
  for (const file of walk(ROOT)) {
    const rel = path.relative(ROOT, file);
    if (rel === SELF) continue;
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const m = SYNC_SPAWN.exec(lines[i]);
      if (!m) continue;
      if (COMMENT_LINE.test(lines[i])) continue;
      if (insideStringLiteral(lines[i], m.index)) continue;
      const record = { file: rel, line: i + 1, text: lines[i].trim().slice(0, 120) };
      if (EXEMPT_MARKER.test(lines[i]) || (i > 0 && EXEMPT_MARKER.test(lines[i - 1]))) {
        exempt.push(record);
        continue;
      }
      const window = lines.slice(Math.max(0, i - LOOKBACK_LINES), i + WINDOW_LINES).join('\n');
      if (!/\btimeout\b/.test(window)) violations.push(record);
    }
  }
  return { violations, exempt };
}

describe('production sync-spawn timeout tripwire', () => {
  const { violations, exempt } = scan();

  test('every sync spawn in production code carries a timeout (or a reasoned exemption)', () => {
    const detail = violations
      .map((v) => `  ${v.file}:${v.line}  ${v.text}`)
      .join('\n');
    expect(
      violations,
      `production sync-spawn call site(s) without a timeout — in a host hook this blows the RPC window, in a CLI it wedges the caller (bun/node cannot interrupt a blocking spawn):\n${detail}\n`
      + 'Fix: add `timeout: <ms>` to the options (15_000 for git probes, 300_000 max for heavy work), or bound the wrapping helper once. '
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
    let total = 0;
    for (const file of walk(ROOT)) {
      const rel = path.relative(ROOT, file);
      if (rel === SELF) continue;
      const src = fs.readFileSync(file, 'utf-8');
      for (const line of src.split('\n')) if (SYNC_SPAWN.test(line)) total += 1;
    }
    expect(total).toBeGreaterThan(80);
  });
});
