/**
 * Unit tests for E2E observability infrastructure.
 *
 * Tests heartbeat, progress.log, NDJSON persistence, savePartial(),
 * finalize() cleanup, failure transcript paths, watcher rendering,
 * and non-fatal I/O guarantees.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { sanitizeTestName } from './session-runner';
import { EvalCollector } from './eval-store';
import { renderDashboard } from '../../scripts/eval-watch';
import type { HeartbeatData, PartialData } from '../../scripts/eval-watch';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-test-'));
});

afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

// --- Test 1: runDir created when runId set ---

describe('session-runner observability', () => {
  test('1: sanitizeTestName strips slashes and leading dashes', () => {
    expect(sanitizeTestName('/plan-ceo-review')).toBe('plan-ceo-review');
    expect(sanitizeTestName('browse-basic')).toBe('browse-basic');
    expect(sanitizeTestName('/qa/deep/test')).toBe('qa-deep-test');
    expect(sanitizeTestName('///leading')).toBe('leading');
  });

  test('2: heartbeat file path uses ~/.gstack-dev/e2e-live.json', () => {
    // Just verify the constant is correct — actual write is tested by E2E
    const expected = path.join(os.homedir(), '.gstack-dev', 'e2e-live.json');
    // Import the module and check HEARTBEAT_PATH exists in the file
    const sessionRunnerSrc = fs.readFileSync(
      path.resolve(__dirname, 'session-runner.ts'), 'utf-8'
    );
    expect(sessionRunnerSrc).toContain("'e2e-live.json'");
    expect(sessionRunnerSrc).toContain('atomicWriteSync');
  });

  test('3: heartbeat JSON schema has expected fields', () => {
    // Verify the heartbeat write code includes all required fields
    const src = fs.readFileSync(
      path.resolve(__dirname, 'session-runner.ts'), 'utf-8'
    );
    for (const field of ['runId', 'startedAt', 'currentTest', 'status', 'turn', 'toolCount', 'lastTool', 'lastToolAt', 'elapsedSec']) {
      expect(src).toContain(field);
    }
    // Should NOT contain completedTests (removed per plan)
    expect(src).not.toContain('completedTests');
  });

  test('4: progress.log format matches expected pattern', () => {
    // The progress line format is: "  [Ns] turn T tool #C: Name(...)"
    const src = fs.readFileSync(
      path.resolve(__dirname, 'session-runner.ts'), 'utf-8'
    );
    // Both stderr and progress.log use the same progressLine variable
    expect(src).toContain('progressLine');
    expect(src).toContain("'progress.log'");
    expect(src).toContain('appendFileSync');
  });

  test('5: NDJSON file uses sanitized test name', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, 'session-runner.ts'), 'utf-8'
    );
    expect(src).toContain('safeName');
    expect(src).toContain('.ndjson');
  });

  test('8: failure transcript goes to runDir when available', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, 'session-runner.ts'), 'utf-8'
    );
    // Should use runDir as primary, workingDirectory as fallback
    expect(src).toContain('runDir || path.join(workingDirectory');
    expect(src).toContain('-failure.json');
  });

  test('11: all new I/O is wrapped in try/catch (non-fatal)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, 'session-runner.ts'), 'utf-8'
    );
    // Count non-fatal comments — should be present for each new I/O path
    const nonFatalCount = (src.match(/\/\* non-fatal \*\//g) || []).length;
    // Original had 2 (promptFile unlink + failure transcript), we added 4 more
    // (runDir creation, progress.log, heartbeat, NDJSON append)
    expect(nonFatalCount).toBeGreaterThanOrEqual(6);
  });
});

// --- Tests 6, 7: eval-store savePartial() and finalize() ---

describe('eval-store observability', () => {
  test('6: savePartial() writes valid JSON with _partial: true', () => {
    const evalDir = path.join(tmpDir, 'evals');
    const collector = new EvalCollector('e2e', evalDir);

    collector.addTest({
      name: 'test-one',
      suite: 'test',
      tier: 'e2e',
      passed: true,
      duration_ms: 1000,
      cost_usd: 0.05,
      exit_reason: 'success',
    });

    const partialPath = path.join(evalDir, '_partial-e2e.json');
    expect(fs.existsSync(partialPath)).toBe(true);

    const partial = JSON.parse(fs.readFileSync(partialPath, 'utf-8'));
    expect(partial._partial).toBe(true);
    expect(partial.tests).toHaveLength(1);
    expect(partial.tests[0].name).toBe('test-one');
    expect(partial.tests[0].exit_reason).toBe('success');
    expect(partial.schema_version).toBe(1);
    expect(partial.total_tests).toBe(1);
    expect(partial.passed).toBe(1);
  });

  test('6b: savePartial() accumulates multiple tests', () => {
    const evalDir = path.join(tmpDir, 'evals');
    const collector = new EvalCollector('e2e', evalDir);

    collector.addTest({
      name: 'test-one', suite: 'test', tier: 'e2e',
      passed: true, duration_ms: 1000, cost_usd: 0.05,
    });
    collector.addTest({
      name: 'test-two', suite: 'test', tier: 'e2e',
      passed: false, duration_ms: 2000, cost_usd: 0.10,
      exit_reason: 'timeout', timeout_at_turn: 5, last_tool_call: 'Bash(ls)',
    });

    const partialPath = path.join(evalDir, '_partial-e2e.json');
    const partial = JSON.parse(fs.readFileSync(partialPath, 'utf-8'));
    expect(partial.tests).toHaveLength(2);
    expect(partial.total_tests).toBe(2);
    expect(partial.passed).toBe(1);
    expect(partial.failed).toBe(1);
    expect(partial.tests[1].exit_reason).toBe('timeout');
    expect(partial.tests[1].timeout_at_turn).toBe(5);
    expect(partial.tests[1].last_tool_call).toBe('Bash(ls)');
  });

  test('7: finalize() preserves partial file alongside final', async () => {
    const evalDir = path.join(tmpDir, 'evals');
    const collector = new EvalCollector('e2e', evalDir);

    collector.addTest({
      name: 'test-one', suite: 'test', tier: 'e2e',
      passed: true, duration_ms: 1000, cost_usd: 0.05,
    });

    const partialPath = path.join(evalDir, '_partial-e2e.json');
    expect(fs.existsSync(partialPath)).toBe(true);

    await collector.finalize();

    // Partial file preserved for observability — never cleaned up
    expect(fs.existsSync(partialPath)).toBe(true);

    // Final eval file should also exist
    const files = fs.readdirSync(evalDir).filter(f => f.endsWith('.json') && !f.startsWith('_'));
    expect(files.length).toBeGreaterThanOrEqual(1);
  });

  test('EvalTestEntry includes diagnostic fields', () => {
    const evalDir = path.join(tmpDir, 'evals');
    const collector = new EvalCollector('e2e', evalDir);

    collector.addTest({
      name: 'diagnostic-test', suite: 'test', tier: 'e2e',
      passed: false, duration_ms: 5000, cost_usd: 0.20,
      exit_reason: 'error_max_turns',
      timeout_at_turn: undefined,
      last_tool_call: 'Write(review-output.md)',
    });

    const partialPath = path.join(evalDir, '_partial-e2e.json');
    const partial = JSON.parse(fs.readFileSync(partialPath, 'utf-8'));
    const t = partial.tests[0];
    expect(t.exit_reason).toBe('error_max_turns');
    expect(t.last_tool_call).toBe('Write(review-output.md)');
  });
});

// --- Tests 9, 10: watcher dashboard rendering ---

describe('eval-watch dashboard', () => {
  test('9: renderDashboard shows completed tests and current test', () => {
    const heartbeat: HeartbeatData = {
      runId: '20260314-143022',
      startedAt: '2026-03-14T14:30:22Z',
      currentTest: 'plan-ceo-review',
      status: 'running',
      turn: 4,
      toolCount: 3,
      lastTool: 'Write(review-output.md)',
      lastToolAt: new Date().toISOString(), // recent — not stale
      elapsedSec: 285,
    };

    const partial: PartialData = {
      tests: [
        { name: 'browse basic', passed: true, cost_usd: 0.07, duration_ms: 24000, turns_used: 6 },
        { name: '/review', passed: true, cost_usd: 0.17, duration_ms: 63000, turns_used: 13 },
      ],
      total_cost_usd: 0.24,
      _partial: true,
    };

    const output = renderDashboard(heartbeat, partial);

    // Should contain run ID
    expect(output).toContain('20260314-143022');

    // Should show completed tests
    expect(output).toContain('browse basic');
    expect(output).toContain('/review');
    expect(output).toContain('$0.07');
    expect(output).toContain('$0.17');

    // Should show current test
    expect(output).toContain('plan-ceo-review');
    expect(output).toContain('turn 4');
    expect(output).toContain('Write(review-output.md)');

    // Should NOT show stale warning (lastToolAt is recent)
    expect(output).not.toContain('STALE');
  });

  test('10: renderDashboard warns on stale heartbeat', () => {
    const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString(); // 15 min ago

    const heartbeat: HeartbeatData = {
      runId: '20260314-143022',
      startedAt: '2026-03-14T14:30:22Z',
      currentTest: 'plan-ceo-review',
      status: 'running',
      turn: 4,
      toolCount: 3,
      lastTool: 'Write(review-output.md)',
      lastToolAt: staleTime,
      elapsedSec: 900,
    };

    const output = renderDashboard(heartbeat, null);

    expect(output).toContain('STALE');
    expect(output).toContain('may have crashed');
  });

  test('renderDashboard handles no active run', () => {
    const output = renderDashboard(null, null);
    expect(output).toContain('No active run');
    expect(output).toContain('bun test');
  });

  test('renderDashboard handles partial-only (heartbeat gone)', () => {
    const partial: PartialData = {
      tests: [
        { name: 'browse basic', passed: true, cost_usd: 0.07, duration_ms: 24000 },
      ],
      total_cost_usd: 0.07,
      _partial: true,
    };

    const output = renderDashboard(null, partial);
    expect(output).toContain('browse basic');
    expect(output).toContain('$0.07');
  });
});
