import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SCRIPT = path.join(ROOT, 'setup');
const SETUP_SRC = fs.readFileSync(SETUP_SCRIPT, 'utf-8');

// Slice out the _run_with_timeout helper body via anchors so the test survives
// line-number drift in setup.
function extractHelper(): string {
  const start = SETUP_SRC.indexOf('_run_with_timeout() {');
  const end = SETUP_SRC.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw new Error('Could not locate _run_with_timeout() in setup');
  return SETUP_SRC.slice(start, end + 2);
}

describe('setup: Playwright install timeout invariant', () => {
  test('helper and hang-help printer are defined', () => {
    expect(SETUP_SRC).toContain('_run_with_timeout() {');
    expect(SETUP_SRC).toContain('_print_playwright_install_hang_help() {');
  });

  // The load-bearing tripwire: `playwright install` downloads to 100% and then
  // can hang forever in extraction with no error output. An unguarded call makes
  // ./setup block indefinitely and look like a slow download. If a refactor drops
  // the guard, fail CI here rather than shipping a silent infinite hang.
  test('every `playwright install` invocation runs under the timeout guard', () => {
    const offending: { lineNo: number; line: string }[] = [];
    SETUP_SRC.split('\n').forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) return; // prose mentions in comments are fine
      if (!/playwright\s+install/.test(line)) return;
      if (!line.includes('_run_with_timeout')) {
        offending.push({ lineNo: idx + 1, line: trimmed });
      }
    });
    expect(offending).toEqual([]);
  });

  test('timeout is env-overridable and has a bounded default', () => {
    expect(SETUP_SRC).toContain('GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT');
    const m = SETUP_SRC.match(
      /PLAYWRIGHT_INSTALL_TIMEOUT="\$\{GSTACK_PLAYWRIGHT_INSTALL_TIMEOUT:-(\d+)\}"/,
    );
    expect(m).not.toBeNull();
    // Generous enough for a ~280 MB download on a slow line, still finite.
    expect(Number(m![1])).toBeGreaterThanOrEqual(600);
    expect(Number(m![1])).toBeLessThanOrEqual(7200);
  });

  test('call site treats 124 as the hang case and aborts with guidance', () => {
    const idx = SETUP_SRC.indexOf('_run_with_timeout "$PLAYWRIGHT_INSTALL_TIMEOUT"');
    expect(idx).toBeGreaterThan(-1);
    const after = SETUP_SRC.slice(idx, idx + 600);
    expect(after).toContain('-eq 124');
    expect(after).toContain('_print_playwright_install_hang_help');
  });

  test('kill path signals both the process group and the direct child', () => {
    const helper = extractHelper();
    // Chaining these with `||` would short-circuit: on MSYS/Git Bash a group
    // kill can report success without signalling the child, so the direct kill
    // must not be conditional on the group kill failing.
    for (const sig of ['TERM', 'KILL']) {
      expect(helper).toContain(`kill -${sig} "-$pid" 2>/dev/null || true`);
      expect(helper).toContain(`kill -${sig} "$pid" 2>/dev/null || true`);
    }
  });
});

describe('setup: _run_with_timeout — behavior matrix', () => {
  function runHelper(secs: string, cmd: string): { status: number | null; stderr: string } {
    const helper = extractHelper();
    const script = `${helper}\n_run_with_timeout ${secs} ${cmd}\n`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf-8', timeout: 30_000 });
    return { status: result.status, stderr: result.stderr };
  }

  test('command finishing inside the ceiling returns 0', () => {
    expect(runHelper('5', 'true').status).toBe(0);
  });

  test("command's own non-zero exit status is preserved, not masked as 124", () => {
    expect(runHelper('5', `sh -c 'exit 3'`).status).toBe(3);
  });

  test('command exceeding the ceiling is killed and reports 124', () => {
    // secs=0 trips the deadline on the first poll, so this stays fast.
    expect(runHelper('0', 'sleep 30').status).toBe(124);
  });

  test('killed command does not leave the helper blocked on wait', () => {
    const start = Date.now();
    expect(runHelper('0', 'sleep 30').status).toBe(124);
    // A missed kill would make `wait` block for the full 30s sleep.
    expect(Date.now() - start).toBeLessThan(15_000);
  });
});
