import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const workflow = (name: string) => Bun.YAML.parse(readFileSync(resolve(import.meta.dir, '../.github/workflows', name), 'utf8')) as any;
const paid = workflow('evals.yml');
const periodic = workflow('evals-periodic.yml');

test('PR runs and diff dispatches select the fast profile; evals_all and scheduled coverage stay full; dispatches stay fresh', () => {
  // eval:bg:pr dispatches evals_all=false (the PR profile on its diff); every other dispatch runs the full gate census.
  expect(paid.env.EVALS_PROFILE).toBe("${{ (github.event_name == 'pull_request' || (github.event_name == 'workflow_dispatch' && !inputs.evals_all)) && 'pr' || 'full' }}");
  // Dispatches execute fresh unless they name a PR whose receipts they read read-only; the evals-fresh label opts a PR out.
  expect(paid.env.EVALS_FRESH).toBe("${{ ((github.event_name == 'workflow_dispatch' && inputs.pr_receipts == '') || contains(github.event.pull_request.labels.*.name, 'evals-fresh')) && '1' || '' }}");
  expect(periodic.env).toMatchObject({ EVALS_PROFILE: 'full', EVALS_FRESH: '1', EVALS_CACHE_PURPOSE: 'periodic' });
  expect(periodic.on.schedule.length).toBeGreaterThan(0);
  expect(periodic.on).toHaveProperty('workflow_dispatch');
  for (const tier of ['gate', 'periodic']) {
    const plans = periodic.jobs['plan-slices'].steps.filter((s: any) => s.run?.includes(`--tier ${tier} --emit-plan`));
    expect(plans).toHaveLength(1);
    expect(plans[0].env.EVALS_ALL).toBe('1');
  }
});

test('receipt transport: only recover-receipts restores this repository and PR\'s store; the report saves one merged store', () => {
  // The PR store is restored once, by recover-receipts (base-ref code), scoped to this repository and PR, PR events only.
  const recover = paid.jobs['recover-receipts'].steps;
  const restore = recover.filter((s: any) => s.uses?.startsWith('actions/cache/restore@'));
  expect(restore).toHaveLength(1);
  expect(restore[0].if).toBe("github.event_name == 'pull_request'");
  expect(restore[0].with.path).toBe('/tmp/gstack-eval-input-cache');
  expect(restore[0].with['restore-keys']).toBe('eval-input-v1-${{ github.repository_id }}-pr-${{ github.event.pull_request.number }}-');
  expect(recover.find((s: any) => s.with?.name === 'receipt-store').with.path).toBe('/tmp/gstack-eval-input-cache');
  // The planner never touches the cache: it takes that store as an artifact and ships one filtered receipt set only when reuse is on.
  const planner = paid.jobs['plan-slices'].steps;
  expect(planner.filter((s: any) => s.uses?.startsWith('actions/cache/'))).toHaveLength(0);
  expect(planner.find((s: any) => s.with?.name === 'receipt-store').if).toBe("github.event_name == 'pull_request' || inputs.pr_receipts != ''");
  const emit = planner.find((s: any) => s.run?.includes('--emit-plan /tmp/paid-plan/manifest.json'));
  expect(emit.env.EVALS_CACHE_DIR).toBe("${{ steps.reuse.outputs.reuse == 'on' && '/tmp/gstack-eval-input-cache' || '' }}");
  const upload = planner.find((s: any) => s.with?.name === 'paid-plan');
  expect(upload.with.path.trim().split('\n')).toEqual(['/tmp/paid-plan/manifest.json', '/tmp/paid-plan/receipts', '/tmp/paid-plan/store']);
  // Executors never restore or save a cache of their own: every slice sees the plan's one receipt set.
  const executor = paid.jobs['eval-slices'].steps;
  expect(executor.filter((s: any) => s.uses?.startsWith('actions/cache/'))).toHaveLength(0);
  expect(executor.find((s: any) => s.name === "Seed this slice's receipts from the plan").run).toContain('cp -a /tmp/paid-plan/receipts/. /tmp/paid-slice-results/receipts/');
  const report = paid.jobs['slices-report'].steps;
  const merge = report.find((s: any) => s.name === "Merge this run's receipts");
  expect(merge.run).toContain('scripts/e2e-shard-reuse.ts merge /tmp/gstack-eval-input-cache /tmp/paid-report/store');
  expect(merge.if).toBe("always() && github.event_name == 'pull_request'");
  const save = report.filter((s: any) => s.uses?.startsWith('actions/cache/save@'));
  expect(save).toHaveLength(1);
  expect(save[0].with.path).toBe('/tmp/gstack-eval-input-cache');
  expect(save[0].with.key).toBe('eval-input-v1-${{ github.repository_id }}-pr-${{ github.event.pull_request.number }}-${{ github.run_id }}-${{ github.run_attempt }}-merged');
  // Only PR runs save; a pr_receipts dispatch reads the PR store read-only.
  expect(save[0].if).toBe("always() && github.event_name == 'pull_request'");
  expect(report.indexOf(save[0])).toBeGreaterThan(report.indexOf(merge));
  expect(paid.jobs['eval-slices'].permissions).toEqual({ contents: 'read', packages: 'read' });
  expect(paid.jobs['slices-report'].permissions).toEqual({ contents: 'read' });
  expect(paid.jobs['plan-slices'].permissions).toEqual({ contents: 'read' });
  expect(paid.jobs['recover-receipts'].permissions).toEqual({ contents: 'read', actions: 'read' });
  expect(JSON.stringify(periodic)).not.toContain('actions/cache/');
});

test('the judge binds cache receipts to the PR and installed runtime, not the commit cache key', () => {
  const runtime = paid.jobs['build-image'].steps.find((s: any) => s.id === 'runtime');
  expect(runtime.run).toContain('docker manifest inspect "$EVAL_IMAGE"');
  expect(runtime.run).toContain('sha256sum /tmp/eval-runtime-manifest.json');
  const run = paid.jobs['eval-slices'].steps.find((s: any) => s.run?.includes('--plan /tmp/paid-plan/manifest.json'));
  expect(run.env).toMatchObject({
    EVALS_CACHE_DIR: '/tmp/paid-slice-results/receipts',
    EVALS_CACHE_REPOSITORY: '${{ github.repository }}',
    // A dispatch names its PR explicitly (pr_receipts); receipts stay bound to repository + PR either way.
    EVALS_CACHE_PR: '${{ github.event.pull_request.number || inputs.pr_receipts }}',
    EVALS_CACHE_RUNTIME_ID: '${{ needs.build-image.outputs.runtime-id }}',
  });
});

test.skipIf(!Bun.which('jq'))('the actual comment shows deferred coverage and never recomputes a verdict', () => {
  const comment = paid.jobs['slices-comment'].steps.find((s: any) => s.name === 'Post PR comment').run as string;
  const evaluate = (filter: string, value: unknown) => {
    const result = spawnSync('jq', ['-r', filter], { input: JSON.stringify(value), encoding: 'utf8', timeout: 5000 });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  expect(comment).not.toContain('group_by(.name)');
  expect(comment).not.toMatch(/flaky pass\(es\)|passed only on retry|not blocking/);
  const coverage = comment.match(/COVERAGE=\$\(jq -r '([^']+)'/)![1]!;
  const text = evaluate(coverage, { profile: 'pr', selection: { e2e: ['probe'], judges: ['judge'] },
    prCoverage: { mode: 'pr', deferred: [{ id: 'broad' }], deferredPromptFiles: ['health/SKILL.md'] } });
  expect(text).toContain('selected behaviors: 1, judges: 1');
  expect(text).toContain('1 behaviors and 1 changed prompt files');
  expect(text).toContain('receive no PR-pass credit');
  expect(comment).not.toContain('diff-selected gate census');
});

test.skipIf(!Bun.which('jq') || !Bun.which('bash'))('comment consumes verified final counts without running repository code and fails closed without them', () => {
  const job = paid.jobs['slices-comment'];
  expect(job.permissions).toMatchObject({ 'pull-requests': 'write' });
  expect(JSON.stringify(job.steps)).not.toMatch(/actions\/checkout|setup-bun|bun run|npm |node /);
  const upload = paid.jobs['slices-report'].steps.find((step: any) => step.with?.name === 'report-verdict-a${{ github.run_attempt }}');
  expect(upload.with.path.trim().split('\n')).toEqual(['/tmp/report.txt', '/tmp/paid-report/collector-outcomes.json', '/tmp/paid-report/report-summary.md', '/tmp/paid-report/report-receipts']);
  expect(job.steps.find((step: any) => step.with?.name === 'report-verdict-a${{ github.run_attempt }}').with.path).toBe('/tmp/verdict');
  const root = mkdtempSync(join(tmpdir(), 'ci-comment-'));
  const paidDir = join(root, 'paid-report');
  const verdictDir = join(root, 'verdict');
  const binDir = join(root, 'bin');
  mkdirSync(paidDir); mkdirSync(verdictDir); mkdirSync(binDir);
  writeFileSync(join(binDir, 'gh'), '#!/bin/sh\ncase "$*" in *--jq*) exit 0;; esac\nfor arg do case "$arg" in body=*) printf "%s\\n" "${arg#body=}";; esac; done\n');
  chmodSync(join(binDir, 'gh'), 0o755);
  writeFileSync(join(binDir, 'bc'), '#!/bin/sh\nread -r expression\n[ "$expression" = "0 + 0" ] && printf "0\\n"\n');
  chmodSync(join(binDir, 'bc'), 0o755);
  writeFileSync(join(paidDir, 'manifest.json'), JSON.stringify({ profile: 'pr', selection: { e2e: [], judges: [] } }));
  writeFileSync(join(paidDir, 'judge.json'), JSON.stringify({ total_tests: 2, tier: 'llm-judge', shard: 1,
    tests: [{ name: 'manual', passed: false, manual_review: { unverified: true } },
      { name: 'reused', passed: true, execution: 'reused' }], flaky_retries: [] }));
  const summary = { version: 2, files: [{ file: 'judge.json', tier: 'llm-judge', shard: 1, cost: 0,
    total: 2, passed: 1, failed: 0, manual_accepted: 1, executed: 1, reused: 1, attempts: 2, flaky: 0 }],
    totals: { total: 2, passed: 1, failed: 0, manual_accepted: 1, executed: 1, reused: 1, attempts: 2, flaky: 0 },
    verdict: { verdict: 'GREEN' }, headline: ['[test:paid] VERDICT GREEN — lane gate/pr, attempt 1'], panels: [],
    failures: ['⚠ case-x  behavior  PASS 2/3 (✓✗✓)  t2: timeout at turn 3 — @\u200bsomeone said no'] };
  mkdirSync(join(verdictDir, 'paid-report'));
  const summaryPath = join(verdictDir, 'paid-report/collector-outcomes.json');
  const script = (job.steps.find((step: any) => step.name === 'Post PR comment').run as string)
    .replaceAll('/tmp/paid-report', paidDir).replaceAll('/tmp/verdict', verdictDir)
    .replaceAll('${{ github.repository }}', 'garrytan/gstack')
    .replaceAll('${{ github.event.pull_request.number }}', '123');
  const check = spawnSync('bash', ['-n', '-c', script], { cwd: root, encoding: 'utf8', timeout: 5000 });
  expect(check.status, check.stderr).toBe(0);
  const run = () => spawnSync('bash', ['-e', '-c', script], { cwd: root,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, RECONCILE_EXIT: '0' },
    encoding: 'utf8', timeout: 5000 });
  try {
    writeFileSync(summaryPath, JSON.stringify(summary));
    const verified = run();
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.stdout).toContain('⚠ MANUAL ACCEPTED (unscored)');
    expect(verified.stdout).toContain('VERDICT GREEN — lane gate/pr, attempt 1');
    expect(verified.stdout).toContain('1 executed, 1 reused** rule/judge records');
    expect(verified.stdout).toContain('1 manual accepted');
    expect(verified.stdout).toContain('### Failures and split verdicts');
    expect(verified.stdout).toContain('PASS 2/3 (✓✗✓)  t2: timeout at turn 3');

    const unrelatedFailure = { ...summary, files: [{ ...summary.files[0], total: 3, failed: 1,
      executed: 2, attempts: 3 }], totals: { ...summary.totals, total: 3, failed: 1,
      executed: 2, attempts: 3 } };
    writeFileSync(summaryPath, JSON.stringify(unrelatedFailure));
    const red = run();
    expect(red.status, red.stderr).toBe(0);
    expect(red.stdout).toContain('❌ FAIL');

    writeFileSync(summaryPath, JSON.stringify({ ...summary, verdict: { verdict: 'RED' } }));
    const redVerdict = run();
    expect(redVerdict.status, redVerdict.stderr).toBe(0);
    expect(redVerdict.stdout).toContain('❌ FAIL');

    writeFileSync(summaryPath, JSON.stringify({ ...summary, totals: { ...summary.totals, manual_accepted: 2 } }));
    const tampered = run();
    expect(tampered.status, tampered.stderr).toBe(0);
    expect(tampered.stdout).toContain('verified report unavailable');
    expect(tampered.stdout).not.toContain('⚠ MANUAL ACCEPTED (unscored)');
    rmSync(summaryPath);
    const absent = run();
    expect(absent.status, absent.stderr).toBe(0);
    expect(absent.stdout).toContain('verified report unavailable');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
