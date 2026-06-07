import { describe, test, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(import.meta.dir, '..');
const SETUP_SRC = fs.readFileSync(path.join(ROOT, 'setup'), 'utf-8');

function runBash(script: string): { stdout: string; stderr: string; status: number } {
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf-8' });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status ?? -1 };
}

// Extract the live Playwright install block from setup. Source-anchored so
// the test is resilient to line-number drift.
function extractPlaywrightBlock(): string {
  const start = SETUP_SRC.indexOf("# 2. Ensure Playwright's Chromium");
  expect(start).toBeGreaterThan(-1);
  // Block ends just before the next top-level section comment.
  const end = SETUP_SRC.indexOf('\n# 2b.', start);
  expect(end).toBeGreaterThan(start);
  return SETUP_SRC.slice(start, end);
}

describe('setup: Playwright failure is best-effort warn, not fatal exit', () => {
  const block = extractPlaywrightBlock();

  test('no `exit 1` is reachable from the Playwright install/verify path', () => {
    // The bug shape used `exit 1` twice. The fix replaces both with a
    // $_PW_FAIL_REASON accumulator that prints a named warning. Either an
    // explicit `exit 1` OR `exit  1` (any spaces) inside the block is the bug.
    expect(block).not.toMatch(/^\s*exit\s+1\b/m);
  });

  test('uses the $_PW_FAIL_REASON accumulator + named warning', () => {
    expect(block).toContain('_PW_FAIL_REASON=""');
    expect(block).toContain('_PW_FAIL_REASON="chromium-install"');
    expect(block).toContain('_PW_FAIL_REASON="post-install-launch"');
    expect(block).toMatch(/warning: Playwright Chromium is unavailable/);
    // Tell users this is recoverable, not a hard fail.
    expect(block).toMatch(/Re-run \.\/setup to retry/);
  });

  test('functional: install failure leaves the script with exit 0 and prints the warning', () => {
    // Run a stripped harness that mimics the live block:
    //   - ensure_playwright_browser stubbed to always fail
    //   - bunx stubbed to fail (simulates Chromium download failure)
    // Assert: exit 0, warning printed, NOT an exit-1 path.
    const r = runBash(`
      set +e
      IS_WINDOWS=0
      SOURCE_GSTACK_DIR=/tmp
      ensure_playwright_browser() { return 1; }   # browser missing
      bunx() { return 1; }                         # install fails

      ${block}

      RC=$?
      echo "FINAL_RC=$RC"
    `);

    // Script must NOT exit non-zero (the bug shape would).
    expect(r.stdout).toContain('FINAL_RC=0');
    // Named warning fires with the expected reason.
    expect(r.stderr).toContain('warning: Playwright Chromium is unavailable (chromium-install)');
    // User-actionable retry hint.
    expect(r.stderr).toContain('Re-run ./setup to retry');
  });

  test('functional: bug shape (with `exit 1`) would have exited non-zero', () => {
    // Inline the BUGGY shape — confirms the difference is real, not an
    // illusion of bash quoting. This is the form we removed.
    const buggy = `
      ensure_playwright_browser() { return 1; }
      bunx() { return 1; }
      if ! ensure_playwright_browser; then
        ( cd /tmp && bunx playwright install chromium )
      fi
      if ! ensure_playwright_browser; then
        echo "gstack setup failed: Playwright Chromium could not be launched" >&2
        exit 1
      fi
    `;
    const r = runBash(`set +e; ( ${buggy} ); echo "FINAL_RC=$?"`);
    expect(r.stdout).toContain('FINAL_RC=1');
  });

  test('functional: post-install verify failure also degrades to warn', () => {
    // Simulate the install succeeding but the post-install launch still failing.
    // The fixed shape sets _PW_FAIL_REASON="post-install-launch" and warns.
    const r = runBash(`
      set +e
      IS_WINDOWS=0
      SOURCE_GSTACK_DIR=/tmp
      ensure_playwright_browser() { return 1; }
      bunx() { return 0; }   # install succeeds

      ${block}

      echo "FINAL_RC=$?"
    `);
    expect(r.stdout).toContain('FINAL_RC=0');
    expect(r.stderr).toContain('warning: Playwright Chromium is unavailable (post-install-launch)');
  });
});
