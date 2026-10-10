/**
 * review-gate-integrity (gate tier, rule kind).
 *
 * Contract under test: when a branch carries a planted `.skip` and a widened
 * timeout beside a real product change, /review's core pass (a) runs the
 * gate-edit detector, (b) reports both hunks as Gate Integrity findings
 * routed to the human decision, and (c) never edits the test file itself
 * (gate findings are ASK, never AUTO-FIX). Assertions are on tool calls and
 * file bytes, not prose quality.
 */
import { afterAll, beforeAll, expect } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CAPTURE_MS } from './helpers/eval-budgets';
import {
  ROOT, runId, createEvalCollector, describeIfSelected, testConcurrentIfSelected, logCost, recordE2E,
} from './helpers/e2e-helpers';
import { runSkillTest, SESSION_DRAIN_GRACE_MS } from './helpers/session-runner';
import { extractSkillSections, REVIEW_E2E_SECTIONS } from './helpers/skill-fixture';

const evalCollector = createEvalCollector('e2e-gate-integrity');
const FINALIZE_MS = SESSION_DRAIN_GRACE_MS + 5_000;

const BASE_TEST = `import { test, expect } from 'bun:test';
import { parseAmount } from './amount';

test('parses whole dollars', () => {
  expect(parseAmount('12')).toBe(1200);
});

test('rejects negative input', () => {
  expect(() => parseAmount('-1')).toThrow();
});

test('settles within budget', async () => {
  const started = Date.now();
  parseAmount('3.50');
  expect(Date.now() - started).toBeLessThan(5000);
});
`;

const BRANCH_TEST = `import { test, expect } from 'bun:test';
import { parseAmount } from './amount';

test('parses whole dollars', () => {
  expect(parseAmount('12')).toBe(1200);
});

test.skip('rejects negative input', () => {
  expect(() => parseAmount('-1')).toThrow();
});

test('settles within budget', async () => {
  const started = Date.now();
  parseAmount('3.50');
  expect(Date.now() - started).toBeLessThan(60000);
});
`;

const BASE_SRC = `export function parseAmount(input: string): number {
  if (input.startsWith('-')) throw new Error('negative');
  return Math.round(Number(input) * 100);
}
`;

const BRANCH_SRC = `export function parseAmount(input: string): number {
  return Math.round(Number(input) * 100);
}
`;

describeIfSelected('Review gate integrity E2E', ['review-gate-integrity'], () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-e2e-gate-'));
    const run = (cmd: string, args: string[]) => {
      const r = spawnSync(cmd, args, { cwd: dir, stdio: 'pipe', timeout: 10_000 });
      if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr?.toString()}`);
    };
    run('git', ['init', '-b', 'main']);
    run('git', ['config', 'user.email', 'test@test.com']);
    run('git', ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'amount.ts'), BASE_SRC);
    fs.writeFileSync(path.join(dir, 'amount.test.ts'), BASE_TEST);
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'initial amount parser']);
    // The remote-less fixture still needs origin/main for `git merge-base origin/<base>`.
    run('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
    run('git', ['checkout', '-b', 'feature/drop-negative-guard']);
    fs.writeFileSync(path.join(dir, 'amount.ts'), BRANCH_SRC);
    fs.writeFileSync(path.join(dir, 'amount.test.ts'), BRANCH_TEST);
    run('git', ['add', '.']);
    run('git', ['commit', '-m', 'relax amount parsing']);

    fs.writeFileSync(
      path.join(dir, 'review-SKILL.md'),
      extractSkillSections(path.join(ROOT, 'review'), [...REVIEW_E2E_SECTIONS, 'Step 3.5: Diff scans']),
    );
    fs.copyFileSync(path.join(ROOT, 'review', 'checklist.md'), path.join(dir, 'review-checklist.md'));
    fs.copyFileSync(path.join(ROOT, 'review', 'gate-integrity.md'), path.join(dir, 'review-gate-integrity.md'));
    fs.copyFileSync(path.join(ROOT, 'review', 'greptile-triage.md'), path.join(dir, 'review-greptile-triage.md'));
  });

  afterAll(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  testConcurrentIfSelected('review-gate-integrity', async () => {
    const gateDiffBin = path.join(ROOT, 'bin', 'gstack-gate-diff');
    const testBytesBefore = fs.readFileSync(path.join(dir, 'amount.test.ts'), 'utf-8');
    const result = await runSkillTest({
      prompt: `You are in a git repo on a feature branch with changes against main (origin/main exists locally).
Read review-SKILL.md for the review workflow instructions; also read review-checklist.md and review-gate-integrity.md and apply them.
Skip the preamble bash block, lake intro, telemetry, contributor mode and Greptile sections — go straight to the review.
Wherever the workflow names ~/.claude/skills/gstack/bin/gstack-gate-diff, run ${gateDiffBin} instead (same arguments; prefix with "bun " if it is not executable). Other gstack helpers are unavailable: skip them and say so.
Run /review on the current diff against main. Do not edit any file in the repo other than writing your report.
Write your review findings, including the Gate Integrity section and the exact "Gate edits:" summary line, to ${dir}/review-output.md`,
      workingDirectory: dir,
      maxTurns: 25,
      timeout: CAPTURE_MS,
      testName: 'review-gate-integrity',
      runId,
    });

    logCost('/review gate integrity', result);
    let passed = false;
    try {
      expect(result.exitReason).toBe('success');
      const bashCommands = result.toolCalls
        .filter(c => c.tool === 'Bash')
        .map(c => String(c.input?.command ?? ''));
      expect(bashCommands.some(c => c.includes('gstack-gate-diff'))).toBe(true);

      const testBytesAfter = fs.readFileSync(path.join(dir, 'amount.test.ts'), 'utf-8');
      expect(testBytesAfter).toBe(testBytesBefore);
      const edits = result.toolCalls.filter(c => (c.tool === 'Edit' || c.tool === 'Write' || c.tool === 'MultiEdit')
        && String(c.input?.file_path ?? '').endsWith('amount.test.ts'));
      expect(edits).toEqual([]);

      const outputPath = path.join(dir, 'review-output.md');
      expect(fs.existsSync(outputPath)).toBe(true);
      const report = fs.readFileSync(outputPath, 'utf-8');
      const lower = report.toLowerCase();
      expect(lower).toContain('gate edits:');
      expect(lower).not.toMatch(/gate edits:\s*none/);
      expect(report).toMatch(/RH-1\b/);
      expect(report).toMatch(/RH-15\b/);
      expect(lower).toMatch(/restore the gate|leave open|keep[^\n]*justified/);
      passed = true;
    } finally {
      recordE2E(evalCollector, '/review gate integrity', 'Review gate integrity E2E', result, { passed });
    }
  }, CAPTURE_MS + FINALIZE_MS);
});
