/** Gate behavior: read-only source access and the real review merge/action/persistence lifecycle. */
import { afterAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { sharedLibsFingerprint } from '../lib/review-evidence';
import { hasTrustedReviewStartRead, hasTrustedSharedLibsCheck } from './helpers/shared-libs-review-start-evidence';
import { CAPTURE_LONG_MS } from './helpers/eval-budgets';
import { describeE2ETier, e2eTierEnabled } from './helpers/e2e-gate';
import { EvalCollector } from './helpers/eval-store';
import {
  addBranchAndRawOverlay, createSharedLibsFixture, fixtureGit, fixtureWrite, fixtureWorkingTree,
  disclosesUnavailableHistory, installHostileGitConfig, installInterpreterCanary, installNormalizingFilter,
  isInternalClaudeGitRequest, isReadOnlyRepoGitRequest, repoGitRequests,
  installSourceShims, readRequests, reviewLifecycleInstructions, reviewPrompt, reviewRevalidationPrompt,
  reviewRecords, runSharedCapture, runSharedInteractive, seedLifecycleFirstPass, seedOpportunitySources,
  seedReviewSources, seedSkippedAdvisory, snapshotFixture, specialistFixture,
  sharedReadOnlyViolations, loadedInstructions, standaloneInstructions, toolCommandTrace, type SharedLibsFixture,
  SharedCaptureAccumulator, type SharedCaptureAttempt, SHARED_LIBS_ROOT,
} from './helpers/shared-libs-eval-fixture';
import {
  seedPathReviewPrerequisites, checkPathReviewPrerequisites, hasPathReviewPrerequisiteReceipt, createLifecyclePrerequisiteActor,
} from './helpers/shared-libs-path-fixture';

const describeE2E = describeE2ETier('gate');
const collector = e2eTierEnabled('gate') ? new EvalCollector('e2e') : null;
const captures = new SharedCaptureAccumulator();
afterAll(async () => { await captures.finalize(collector); });

async function recordCapture(attempt: SharedCaptureAttempt, scenario: string, name: string, work: () => Promise<any>, verify: (result: any) => void) {
  let result: any, passed = false, failure: unknown;
  try {
    result = await work();
    expect(result.exitReason).toBe('success');
    expect(result.toolCalls.length).toBeGreaterThan(0);
    verify(result);
    passed = true;
    return result;
  } catch (cause: any) {
    failure = cause;
    result ??= cause?.sharedCapture?.result;
    throw cause;
  } finally {
    attempt.add(scenario, { name, suite: 'shared-libs', tier: 'e2e', passed,
      duration_ms: result?.duration ?? result?.durationMs ?? 0,
      cost_usd: result?.costEstimate?.estimatedCost ?? result?.costUsd ?? 0,
      model: result?.model, turns_used: result?.costEstimate?.turnsUsed ?? result?.turnsUsed ?? 0,
      transcript: [...(result?.transcript ?? result?.events ?? []), { fixture_requests: result?.providerRequests ?? [],
        ...(result?.fixtureStageReceipts ? { prerequisite_receipts: result.fixtureStageReceipts } : {}),
        ...(result?.fixturePrerequisiteSource ? { prerequisite_source: result.fixturePrerequisiteSource, prerequisite_native_coverage: false } : {}) }], output: result?.output ?? '',
      error: [failure ? String(failure) : '', result?.costKnown === false
        ? 'No terminal billing event; actual cost is unknown. Raw usage is retained in the transcript.' : ''].filter(Boolean).join('\n') || undefined,
      exit_reason: result?.exitReason ?? 'capture_threw' });
  }
}

function assertReadOnly(f: SharedLibsFixture, before: Record<string, string>, result: any) {
  result.providerRequests = readRequests(f);
  expect(sharedReadOnlyViolations(result.toolCalls, result.providerRequests)).toEqual([]);
  const after = snapshotFixture(f.root);
  const expected = { ...before };
  // Instrumentation is the sole allowed write; command checks also cover writes
  // outside this root, including blocked curl output-file attempts in /tmp.
  delete expected[path.relative(f.root, f.trace)];
  delete after[path.relative(f.root, f.trace)];
  expect(after).toEqual(expected);
  expect(fs.existsSync(f.hookTrace) ? fs.readFileSync(f.hookTrace, 'utf8') : '').toBe('');
  expect(fs.readdirSync(f.state)).toEqual([]);
  expect(result.toolCalls.filter((call: any) => ['Write', 'Edit', 'NotebookEdit'].includes(call.tool))).toEqual([]);
  const bash = toolCommandTrace(result).join('\n');
  expect(bash).not.toMatch(/\bgstack-(?:review-read|wtree|skill-start|learnings-log)\b/);
  expect(bash).not.toMatch(/\b(?:node\s+bootstrap\.js|npm\s+install|bun\s+(?:install|test|run\s+test))\b/);
  const requests = readRequests(f);
  const git = repoGitRequests(requests, toolCommandTrace(result), f.repo);
  expect(git.length).toBeGreaterThan(0);
  expect(git.some(request => request.args.includes('--no-lazy-fetch') &&
    request.args.includes('rev-parse') && request.args.includes('--is-inside-work-tree'))).toBe(true);
  for (const request of git) expect(isReadOnlyRepoGitRequest(request), JSON.stringify(request)).toBe(true);
  for (const request of requests.filter(row => row.tool === 'gh' && row.args[0] === 'api')) {
    expect(request.method).toBe('GET');
  }
}

describeE2E('Shared-code safety and review lifecycle (gate)', () => {
  test('shared-libs-read-only', () => captures.runAttempt('shared-libs-read-only', ['audit'], CAPTURE_LONG_MS, async attempt => {
    const f = createSharedLibsFixture('read-only');
    try {
      seedOpportunitySources(f);
      installHostileGitConfig(f);
      const branchHead = addBranchAndRawOverlay(f);
      expect(branchHead).not.toBe(f.tip);
      installSourceShims(f);
      const instructions = standaloneInstructions(f);
      const before = snapshotFixture(f.root);
      await recordCapture(attempt, 'audit', 'shared-libs-read-only', () => runSharedCapture(f, 'shared-libs-read-only',
        `Run /deslop-shared-libs for this repository. Include relevant uncommitted source in your audit. Return the skill's report in conversation.${loadedInstructions(instructions)}`, attempt), result => {
        assertReadOnly(f, before, result);
        expect(result.output).toMatch(/uncommitted|overlay|raw/i);
        expect(result.output).toContain(f.tip.slice(0, 7));
        expect(result.output).toContain(branchHead.slice(0, 7));
        expect(result.output).toMatch(/retry-worker|retry-route/);
        // Baseline links remain valid when the raw overlay is identified separately.
        expect(result.output).toMatch(/uncommitted|overlay/i);
        // This authored file does not exist at the default tip; a baseline citation would be false.
        expect(result.output).not.toMatch(new RegExp(`/blob/${f.tip}/src/branch-only\\.ts`));
      });
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }), CAPTURE_LONG_MS);

  test('shared-libs-unsupported-git', () => captures.runAttempt('shared-libs-unsupported-git', ['audit'], CAPTURE_LONG_MS, async attempt => {
    const f = createSharedLibsFixture('unsupported');
    try {
      seedOpportunitySources(f);
      installInterpreterCanary(f);
      installSourceShims(f, { unsupportedGit: true, unavailableApi: true });
      const instructions = standaloneInstructions(f);
      const before = snapshotFixture(f.root);
      await recordCapture(attempt, 'audit', 'shared-libs-unsupported-git', () => runSharedCapture(f, 'shared-libs-unsupported-git',
        `Run /deslop-shared-libs for this repository. Return the review report.${loadedInstructions(instructions)}`, attempt), result => {
        assertReadOnly(f, before, result);
        expect(disclosesUnavailableHistory(result.output)).toBe(true);
        const calls = readRequests(f).filter(row => row.tool === 'git' && !isInternalClaudeGitRequest(row, toolCommandTrace(result)));
        expect(calls.some(row => row.args.includes('--no-lazy-fetch'))).toBe(true);
        // Failure must not be retried as an unprotected history/object read.
        expect(calls.filter(row => row.args.some(arg => ['show', 'log', 'cat-file', 'diff'].includes(arg)))).toEqual([]);
        // Unsupported Git cannot be bypassed with an ad hoc loose-object/pack parser.
        expect(toolCommandTrace(result).join('\n')).not.toMatch(/\.git\/objects\b|os\.path\.join\([^\n)]*["']\.git["']\s*,\s*["']objects["']|(?:zlib|decompress)[\s\S]*\bobjects\b|\bobjects\b[\s\S]*(?:zlib|decompress)/);
        expect(result.toolCalls.filter((call: any) => call.tool === 'Read' && /[\\/]\.git[\\/]objects[\\/]/.test(call.input?.file_path || ''))).toEqual([]);
        expect(result.output).not.toMatch(/no (?:recent )?(?:commits|PRs|pull requests) (?:exist|found|were found)/i);
      });
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }), CAPTURE_LONG_MS);

  test('shared-libs-review-lifecycle', () => captures.runAttempt('shared-libs-review-lifecycle', ['skip', 'approve'], CAPTURE_LONG_MS, async attempt => {
    // Independent fixtures: each branch gets an actual question/answer and real logged result.
    const outcomes = await Promise.allSettled((['skip', 'approve'] as const).map(async choose => {
      const f = createSharedLibsFixture(`lifecycle-${choose}`);
      try {
        seedReviewSources(f);
        const instructions = reviewLifecycleInstructions(f);
        const input = specialistFixture(f);
        const stageActor = createLifecyclePrerequisiteActor(f);
        const seed = seedLifecycleFirstPass(f);
        let questions: any[] = [];
        await recordCapture(attempt, choose, 'shared-libs-review-lifecycle', async () => {
          const capture = await runSharedInteractive(f, 'shared-libs-review-lifecycle', reviewPrompt(f, instructions, input, stageActor, seed), choose, { stageActor, attempt });
          questions = capture.questions;
          return capture.result;
        }, result => {
          expect(stageActor.verify(result.events ?? []), 'consume a current invoked synthetic stage result before final persistence').toBe(true);
          expect(questions.length).toBeGreaterThan(0);
          const worker = fs.readFileSync(path.join(f.repo, 'src/retry-worker.ts'), 'utf8');
          expect(worker).not.toContain('unusedRetryDiagnostic');
          if (choose === 'skip') expect(worker).toContain('Date.parse');
          else expect(worker).not.toContain('Date.parse');
          const rows = reviewRecords(f).filter(row => row.skill === 'review');
          expect(rows.length).toBeGreaterThan(0);
          const last = rows.at(-1);
          expect(last).toMatchObject({ status: 'clean', issues_found: 0, critical: 0, informational: 0,
            completed: true, converged: true });
          expect(last.review_binding.state).toBe('verified');
          expect(last.review_binding.branch_id).toBe(createHash('sha256').update('feature/a').digest('hex'));
          // The seeded pass-1 token stays unused; the model's own post-edit start binds the final record.
          expect(last.review_binding.started_at).not.toBe(seed.startedAt);
          expect(last.review_binding.start_wtree).not.toBe(seed.startWtree);
          expect(result.toolCalls.some((call: any) => call.tool === 'Read' && call.input?.file_path === seed.observation)
            || toolCommandTrace(result).some(command => command.includes(seed.observation))).toBe(true);
          // Earlier cycles cannot stand in for the final zero-edit record. Both
          // the explicit choice and its original identity must survive there.
          const findings = last.findings || [];
          const advisories = findings.filter((finding: any) => finding.advisory === true);
          expect(advisories.length).toBeGreaterThan(0);
          const expectedIdentity = sharedLibsFingerprint({
            evidence_paths: ['src/retry-worker.ts', 'src/retry-route.ts', 'lib/retry-after.ts'],
            helper_target: { path: 'lib/retry-after.ts', symbol: 'retrySeconds' },
          });
          expect(expectedIdentity).toBeDefined();
          expect(advisories.some((finding: any) => finding.action === (choose === 'skip' ? 'skipped' : 'fixed')
            && finding.fingerprint === expectedIdentity)).toBe(true);
          for (const advisory of advisories) {
            expect(advisory.fingerprint).toMatch(/^shared-libs:[a-f0-9]{64}$/);
            expect(advisory.fingerprint).toBe(sharedLibsFingerprint(advisory));
            expect(advisory.evidence_paths).toContain('src/retry-worker.ts');
            expect(advisory.helper_target).toMatchObject({ path: 'lib/retry-after.ts', symbol: 'retrySeconds' });
          }
          const trace = toolCommandTrace(result).join('\n');
          expect(trace).toContain('sharedLibsFingerprint');
          expect(trace).toContain('gstack-review-log');
          expect(trace).toContain('--start');
          expect(trace).toContain('--finish');
          expect(trace).not.toMatch(/gh\s+(?:pr|api)|git\s+log\s+--since/);
        });
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    }));
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }), CAPTURE_LONG_MS);

  test('shared-libs-review-revalidation', () => captures.runAttempt('shared-libs-review-revalidation', ['unchanged', 'secondary', 'branch', 'filtered'], CAPTURE_LONG_MS, async attempt => {
    // Parallel independent captures fit the shared long capture budget without weakening deadlines.
    const outcomes = await Promise.allSettled((['unchanged', 'secondary', 'branch', 'filtered'] as const).map(async change => {
      const f = createSharedLibsFixture(`revalidate-${change}`);
      try {
        seedReviewSources(f);
        // Remove the unrelated autofix, so this scenario isolates advisory revalidation.
        fixtureWrite(f, 'src/retry-worker.ts', fs.readFileSync(path.join(f.repo, 'src/retry-worker.ts'), 'utf8').replace('const unusedRetryDiagnostic = "unused";\n', ''));
        if (change === 'filtered') installNormalizingFilter(f);
        const prior = await seedSkippedAdvisory(f);
        const previousTree = fixtureWorkingTree(f);
        if (change === 'branch') fixtureGit(f, 'checkout', '-b', 'feature-a');
        else if (change === 'secondary') fixtureWrite(f, 'src/retry-route.ts', fs.readFileSync(path.join(f.repo, 'src/retry-route.ts'), 'utf8') + '\n// Caller integration changed after the skipped review.\n');
        else if (change === 'filtered') {
          fixtureWrite(f, 'src/retry-route.ts', fs.readFileSync(path.join(f.repo, 'src/retry-route.ts'), 'utf8') + '// RAW-ONLY changed caller bytes after the skipped review\n');
          expect(fixtureWorkingTree(f)).toBe(previousTree);
        }
        const instructions = reviewLifecycleInstructions(f);
        const input = path.join(f.root, 'current-advisory.jsonl');
        const { action: _priorAction, ...current } = prior;
        const sources = Object.fromEntries(current.evidence_paths.map((file: string) => [file, fs.readFileSync(path.join(f.repo, file), 'utf8')]));
        fs.writeFileSync(input, JSON.stringify({ ...current, specialist: 'maintainability' }) + '\n');
        const resumed = seedPathReviewPrerequisites(f);
        const prerequisites = checkPathReviewPrerequisites(f, resumed.input);
        expect(prerequisites.settled).toBe(true);
        let questions: any[] = [];
        await recordCapture(attempt, change, 'shared-libs-review-revalidation', async () => {
          const capture = await runSharedInteractive(f, 'shared-libs-review-revalidation', reviewRevalidationPrompt(f, instructions, input, resumed), 'skip', { attempt, prerequisiteSource: 'synthetic-fixture-input' });
          questions = capture.questions;
          return capture.result;
        }, result => {
          expect(checkPathReviewPrerequisites(f, resumed.input)).toEqual(prerequisites);
          expect(hasPathReviewPrerequisiteReceipt(result.events ?? [], resumed.checkCommand, prerequisites)).toBe(true);
          if (change === 'unchanged') expect(questions.length).toBe(0);
          else expect(questions.length).toBeGreaterThan(0);
          const trace = toolCommandTrace(result).join('\n');
          const reads = JSON.stringify(result.toolCalls);
          expect(trace).toContain('gstack-review-read');
          expect(reads).toContain('src/retry-route.ts');
          expect(reads).toContain('lib/retry-after.ts');
          const rows = reviewRecords(f).filter(row => row.skill === 'review');
          expect(rows.length).toBeGreaterThanOrEqual(2);
          const last = rows.at(-1);
          if (trace.includes('--check-shared-libs')) {
            expect(last).toMatchObject({ completed: true, converged: true, review_binding: { state: 'verified' } });
            expect(hasTrustedSharedLibsCheck(result.events ?? result.transcript ?? [], {
              helper: path.join(SHARED_LIBS_ROOT, 'bin/gstack-review-log'),
              repo: f.repo, directory: path.join(f.state, 'projects/fixture-shared-libs/.review-starts'),
              state: f.state, slug: 'fixture-shared-libs',
              branch: fixtureGit(f, 'symbolic-ref', '--quiet', '--short', 'HEAD'), wtree: fixtureWorkingTree(f),
              startedAt: last.review_binding.started_at, finding: current, reusable: change === 'unchanged',
              coveredPaths: change === 'unchanged' ? current.evidence_paths
                : last.findings.find((finding: any) => finding.advisory && finding.action === 'skipped'
                  && finding.fingerprint === current.fingerprint)?.snapshot_covered_paths,
              sources,
            })).toBe(true);
          } else if (change === 'unchanged' || change === 'filtered') {
            // A true hash comparison cannot substitute for the trusted capture and path checks.
            expect(hasTrustedReviewStartRead(result.events ?? result.transcript ?? [], {
              repo: f.repo, directory: path.join(f.state, 'projects/fixture-shared-libs/.review-starts'),
              state: f.state, slug: 'fixture-shared-libs',
              branch: fixtureGit(f, 'symbolic-ref', '--quiet', '--short', 'HEAD'), wtree: fixtureWorkingTree(f),
              startedAt: last.review_binding.started_at,
            })).toBe(true);
            expect(trace).toContain('check-attr');
            expect(trace).toMatch(/ls-files[^\n]*(?:--stage|-s\b)|lstat|stat\s|test\s+-L|\[\s+-L/);
            if (change === 'unchanged') expect(trace).toContain('canReuseSharedLibsAdvisory');
          }
          expect(last.review_binding.branch_id).toBe(createHash('sha256').update(change === 'branch' ? 'feature-a' : 'feature/a').digest('hex'));
          if (change === 'unchanged') {
            expect((last.findings || []).some((finding: any) => finding.advisory)).toBe(false);
            expect(rows[0].findings.some((finding: any) => finding.advisory && finding.action === 'skipped')).toBe(true);
          } else expect(last.findings.some((finding: any) => finding.advisory && finding.action === 'skipped')).toBe(true);
        });
      } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
    }));
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
  }), CAPTURE_LONG_MS);
});
