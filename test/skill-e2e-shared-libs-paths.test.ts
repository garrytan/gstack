/** Gate: real filesystem boundaries must invalidate reuse of a skipped extraction. */
import { afterAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier, e2eTierEnabled } from './helpers/e2e-gate';
import { EvalCollector } from './helpers/eval-store';
import {
  fixtureWorkingTree, reviewLifecycleInstructions, reviewRevalidationPrompt, reviewRecords,
  runSharedInteractive, toolCommandTrace, readRequests, SharedCaptureAccumulator, type SharedLibsFixture,
} from './helpers/shared-libs-eval-fixture';
import { preparePathEligibilityFixture, type PathEligibilityCase } from './helpers/shared-libs-path-fixture';

const describeE2E = describeE2ETier('gate');
const collector = e2eTierEnabled('gate') ? new EvalCollector('e2e') : null;
const captures = new SharedCaptureAccumulator();
afterAll(async () => { await captures.finalize(collector); });

function sourceReadTrace(result: any): string {
  return result.toolCalls.flatMap((call: any) => {
    if (call.tool === 'Read') return [String(call.input?.file_path || '')];
    const command = String(call.input?.command || '');
    if (call.tool === 'Bash' && /\b(?:cat|sed|head|tail|nl)\b|readFile|Bun\.file/.test(command)) return [command];
    return [];
  }).join('\n');
}

async function exerciseEligibility(testId: string, kinds: PathEligibilityCase[]) {
  return captures.runAttempt(testId, kinds, CAPTURE_LONG_MS, async attempt => {
    // One wave fits the SDK's default semaphore of three. Serial outer tests keep
    // --concurrent from queueing later waves inside another test's 600-second wall.
    if (kinds.length > 3) throw new Error('Path eligibility groups must fit one SDK capture wave');
    const exercise = async (kind: PathEligibilityCase) => {
      let f: SharedLibsFixture | undefined;
      let result: any, passed = false;
      let scenarioError: string | undefined;
      let captureDiagnostic: string | undefined;
      try {
        const prepared = preparePathEligibilityFixture(kind);
        f = prepared.fixture;
        const sourceBefore = new Map(prepared.current.evidence_paths.map((source: string) =>
          [source, fs.readFileSync(path.join(prepared.fixture.repo, source), 'utf8')]));
        const instructions = reviewLifecycleInstructions(f);
        const supplied = path.join(f.root, 'current-advisory.jsonl');
        fs.writeFileSync(supplied, JSON.stringify({ ...prepared.current, specialist: 'maintainability' }) + '\n');
        const prompt = reviewRevalidationPrompt(f, instructions, supplied)
          + '\nAll named caller sources are first-party authored runtime code. Inspect them directly, including any Git/path boundary, before deciding whether the previous review decision can be reused. The fixture contains no generated caller sources.';
        const capture = await runSharedInteractive(f, testId, prompt, 'skip');
        result = capture.result;
        expect(result.exitReason, `${kind}: ${result.output}`).toBe('success');
        expect(result.toolCalls.length).toBeGreaterThan(0);
        expect(capture.questions.length, `${kind}: old decision must be revalidated and presented again`).toBeGreaterThan(0);
        const trace = toolCommandTrace(result).join('\n');
        expect(trace).toContain('gstack-review-read');
        expect(trace).toContain('sharedLibsFingerprint');
        expect(trace).toContain('gstack-review-log');
        expect(trace).toContain('--start');
        expect(trace).toContain('--finish');
        const reads = sourceReadTrace(result);
        expect(reads).toContain('src/retry-worker.ts');
        expect(reads).toContain('lib/retry-after.ts');
        for (const source of prepared.sourcePaths) {
          expect(reads, `${kind}: reread ${source}`).toContain(source);
        }
        if (kind === 'symlinks') expect(trace).toMatch(/readlink|lstat|stat\b|test\s+-L|\[\s+-L|ls-files[^\n]*(?:--stage|-s\b)/);
        if (kind === 'submodule') expect(trace + '\n' + result.output).toMatch(/submodule|160000/i);
        if (kind === 'ignored') expect(trace + '\n' + result.output).toMatch(/check-ignore|ignored|exclude-standard/i);
        expect(fixtureWorkingTree(f), `${kind}: Skip must not refactor any source`).toBe(prepared.beforeTree);
        for (const [source, before] of sourceBefore) {
          expect(fs.readFileSync(path.join(f.repo, source as string), 'utf8'), `${kind}: preserve raw ${source}`).toBe(before);
        }
        const rows = reviewRecords(f).filter(row => row.skill === 'review');
        expect(rows.length).toBeGreaterThanOrEqual(2);
        const last = rows.at(-1);
        expect(last).toMatchObject({ status: 'clean', issues_found: 0, completed: true, converged: true });
        expect(last.review_binding.state).toBe('verified');
        const skipped = (last.findings || []).filter((finding: any) => finding.advisory === true && finding.action === 'skipped');
        expect(skipped.length, `${kind}: the new explicit decision must be saved`).toBeGreaterThan(0);
        expect(skipped.some((finding: any) => finding.helper_target?.path === 'lib/retry-after.ts'
          && finding.helper_target?.symbol === 'retrySeconds')).toBe(true);
        for (const finding of skipped) {
          expect(finding.fingerprint).toMatch(/^shared-libs:[0-9a-f]{64}$/);
          expect(finding.evidence_paths).toContain('src/retry-worker.ts');
          expect(Array.isArray(finding.snapshot_covered_paths)).toBe(true);
          if (kind !== 'legacy' && kind !== 'removed-filter') {
            for (const source of prepared.sourcePaths) {
              expect(finding.snapshot_covered_paths, `${kind}: unsafe raw source must not receive coverage proof`).not.toContain(source);
            }
          }
        }
        passed = true;
      } catch (error) {
        const partial = (error as any)?.sharedCapture;
        result ??= partial?.result;
        captureDiagnostic = partial?.diagnostic;
        scenarioError = String(error);
        throw error;
      } finally {
        try {
          attempt.add(kind, { name: testId, suite: 'shared-libs', tier: 'e2e', passed,
            duration_ms: result?.durationMs ?? 0, cost_usd: result?.costUsd ?? 0,
            model: result?.model, turns_used: result?.turnsUsed ?? 0,
            transcript: [{ scenario: kind, error: scenarioError, diagnostic: captureDiagnostic,
              cost_known: result?.costKnown, provider_requests: f ? readRequests(f) : [] }, ...(result?.events ?? [])],
            output: `[${kind}]${scenarioError ? ` ${scenarioError}` : ''}\n${result?.output ?? ''}`,
            error: scenarioError,
            exit_reason: result?.exitReason ?? 'capture_threw' });
        } finally { if (f) fs.rmSync(f.root, { recursive: true, force: true }); }
      }
    };
    const results = await Promise.allSettled(kinds.map(exercise));
    const failures = results.flatMap((result, index) => result.status === 'rejected'
      ? [`${kinds[index]}: ${String(result.reason)}`] : []);
    expect(failures).toEqual([]);
  });
}

describeE2E('Shared-code skipped advice across real source boundaries (gate)', () => {
  test.serial('shared-libs-review-path-eligibility', () => exerciseEligibility(
    'shared-libs-review-path-eligibility', ['symlinks', 'submodule', 'ignored'],
  ), CAPTURE_LONG_MS);

  test.serial('shared-libs-review-index-flags', () => exerciseEligibility(
    'shared-libs-review-index-flags', ['assume-unchanged', 'skip-worktree'],
  ), CAPTURE_LONG_MS);

  test.serial('shared-libs-review-prior-coverage', () => exerciseEligibility(
    'shared-libs-review-prior-coverage', ['legacy', 'removed-filter'],
  ), CAPTURE_LONG_MS);
});
