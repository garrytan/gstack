/**
 * The weekly tracking issues (evals-periodic.yml, evals-marathon.yml).
 *
 * Only main posts to or closes a tracking issue: a branch-dispatched census
 * writes the same report to its step summary and a report artifact instead.
 * The periodic report carries the full pass-rate alarm lines, the red ledger,
 * session headroom and the all-green estimate, read with an explicit
 * --branch, and every report-derived line passes the published-text
 * sanitizer. The write steps run here as shell scripts with a fake
 * `eval:pass-rates`; the sanitizer is the real one.
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';

const ROOT = path.join(import.meta.dir, '..');
type Step = { name?: string; if?: string; run?: string; uses?: string; with?: Record<string, string> };
type Workflow = { jobs: Record<string, { steps?: Step[] }> };
const WORKFLOWS = ['evals-periodic.yml', 'evals-marathon.yml'] as const;
const parse = (name: string) => Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows', name), 'utf8')) as Workflow;
const MAIN_ONLY = "github.ref == 'refs/heads/main'";

describe('tracking issues are main-only', () => {
  for (const name of WORKFLOWS) {
    test(`${name}: only the upsert and close steps call gh issue, and both run on main only`, () => {
      const issueSteps = Object.values(parse(name).jobs).flatMap(job => job.steps ?? []).filter(step => /\bgh issue\b/.test(step.run ?? ''));
      expect(issueSteps.map(step => step.name).sort()).toEqual(['Close the tracking issue on a green run', 'Upsert tracking issue on failure']);
      for (const step of issueSteps) expect(step.if, step.name).toContain(`always() && ${MAIN_ONLY} && `);
      const upsert = issueSteps.find(step => step.name === 'Upsert tracking issue on failure')!;
      expect(upsert.run).toMatch(/gh issue comment .*--body-file "\$BODY_FILE"/);
      expect(upsert.run).toMatch(/gh issue create .*--body-file "\$BODY_FILE"/);
      expect(issueSteps.find(step => step.name === 'Close the tracking issue on a green run')!.run).toContain('gh issue close');
    });

    test(`${name}: every ref writes the report to the step summary and an artifact`, () => {
      const steps = parse(name).jobs.report!.steps!;
      const write = steps.find(step => /^Write the (census|marathon) report$/.test(step.name ?? ''))!;
      const upload = steps.find(step => /^Upload the (census|marathon) report$/.test(step.name ?? ''))!;
      const upsert = steps.find(step => step.name === 'Upsert tracking issue on failure')!;
      expect(write.if).not.toContain('github.ref');
      expect(upload.if).toBe(write.if);
      expect(upsert.if).toBe(write.if!.replace('always() && ', `always() && ${MAIN_ONLY} && `));
      expect(write.run).toContain('>> "$GITHUB_STEP_SUMMARY"');
      expect(write.run).toContain('docs/evals/census-red.md');
      expect(write.run).toContain('./scripts/lib/published-text');
      const reportFile = /> (\/tmp\/[\w-]+\.md)\n/.exec(write.run!)![1]!;
      expect(upload.uses).toStartWith('actions/upload-artifact@');
      expect(upload.with!.path).toBe(reportFile);
      expect(upload.with!.name).toMatch(/^(census|marathon)-report-a\$\{\{ github\.run_attempt \}\}$/);
      expect(upsert.run).toContain(`BODY_FILE=${reportFile}`);
    });
  }

  test('evals-periodic.yml: every pass-rates read names its branch explicitly', () => {
    const runs = parse('evals-periodic.yml').jobs.report!.steps!.map(step => step.run ?? '').join('\n');
    const calls = [...runs.matchAll(/^\s*bun run eval:pass-rates [^\n>]*/gm)].map(m => m[0].trim());
    expect(calls.length).toBe(3);
    for (const call of calls) expect(call).toContain('--runs 10 --branch "$GITHUB_REF_NAME"');
    expect(calls.some(call => call.includes('--gate'))).toBe(true);
    expect(calls.some(call => call.includes('--reds'))).toBe(true);
    expect(calls.some(call => call.includes('--headroom'))).toBe(true);
  });
});

/** Run a workflow step's script with its expressions and /tmp paths bound to a scratch dir. */
function runStep(workflow: string, stepName: string, files: Record<string, string>, expressions: Record<string, string>) {
  const step = parse(workflow).jobs.report!.steps!.find(s => s.name === stepName)!;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tracking-issue-'));
  const work = path.join(dir, 'tmp');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), body);
  }
  const log = path.join(dir, 'pass-rates-calls.log');
  fs.writeFileSync(path.join(bin, 'bun'), [
    '#!/bin/sh',
    'if [ "$1" = run ] && [ "$2" = eval:pass-rates ]; then',
    `  echo "$*" >> '${log}'`,
    `  case " $* " in *" --reds "*) cat '${work}/fake-reds.txt';; *" --headroom "*) cat '${work}/fake-headroom.txt';; esac`,
    '  exit 0',
    'fi',
    `exec '${process.execPath}' "$@"`,
  ].join('\n'), { mode: 0o755 });
  const script = step.run!
    .replace(/\$\{\{ ([^}]+) \}\}/g, (_, expr: string) => expressions[expr.trim()] ?? `<${expr.trim()}>`)
    .replaceAll('/tmp/', `${work}/`);
  const summary = path.join(dir, 'step-summary.md');
  const result = spawnSync('bash', ['-c', script], {
    cwd: ROOT, encoding: 'utf8', timeout: 60_000,
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, GITHUB_STEP_SUMMARY: summary, GITHUB_REF_NAME: 'feature/x',
      GITHUB_SHA: 'abc1234', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_REPOSITORY: 'garrytan/gstack', GITHUB_RUN_ID: '42', REDISPATCH: 'false', REDISPATCH_OF: '' },
  });
  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  const reports = Object.fromEntries(fs.readdirSync(work).filter(name => name.endsWith('.md')).map(name => [name, read(path.join(work, name))]));
  const out = { status: result.status, stderr: result.stderr, summary: read(summary), calls: read(log), body: (name: string) => reports[name] ?? '' };
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

const PERIODIC_EXPRESSIONS = {
  'steps.reconcile.outputs.exit': '1', 'steps.gate-reconcile.outputs.exit': '0', 'steps.pass-rates.outputs.exit': '1',
  'needs.eval-slices.result': 'failure', 'needs.eval-codex-slices.result': 'success', 'needs.gate-census.result': 'success',
};

describe('the periodic census report', () => {
  const passRates = [
    'scope: garrytan/gstack evals-periodic.yml on feature/x + main, last 10 completed run(s) per branch: 1, 2',
    'pass-rates: policy v1, 40 post-policy trial(s), 0 pre-policy (display only)',
    '  label         kind      tier      current series                 pre-policy          manual  case',
    '  ACTION        rule      gate      9/10 [59.6%–98.2%]             -                        0  noisy-case',
    'ACTION REQUIRED (3):',
    '  [drift] noisy-case passes 9/10 (below 95% over >= 10 trials): fix it, or propose a CASE_QUARANTINE entry with a written diagnosis',
    '  [headroom] slow-case session sdk:slow-case#1: max 520s of 600s (87%) above the 85% cap; cut work, never raise the budget',
    '  [drift] mention @attacker ``` </details><img src=x onerror=alert(1)> ghp_' + 'a'.repeat(36),
    'free-suite flaky-passes (/home/x/.gstack/flake-ledger.jsonl):',
    '    2x  test/unrelated.test.ts',
  ].join('\n');
  const reds = [
    'scope: garrytan/gstack evals-periodic.yml on feature/x + main, last 10 completed run(s) per branch: 1, 2',
    'reds: verdict reds per census lane by failure class and machine cause',
    '  1 periodic/full census: 1 red of 146 verdicts — class: assertion 1; cause: provider_stall 1',
    '    ✗ noisy-case FAIL t1 assertion/provider_stall — Error: expect(received).toBe(expected)',
    'pooled: 1 red of 146 verdicts = 0.7% per verdict [95% 0.1%–3.8%]',
    'all-green probability (approximation, assumes independent verdicts): 81.2% for the latest census\'s 146 verdicts [55%–95% with the pooled rate\'s 95% interval as prior]; formula Π(1 - p_i) over its cases; rerun: bun run eval:pass-rates --reds',
  ].join('\n');
  const headroom = [
    'scope: garrytan/gstack evals-periodic.yml on feature/x + main',
    'headroom: slowest armed session per case (warn > 75%, alarm > 85%; insufficient below 3 samples; censored = timed out)',
    '  ALARM         520s/600s (87%)             3        540s                                           slow-case',
  ].join('\n');
  const files = {
    'pass-rates.txt': passRates, 'fake-reds.txt': reds, 'fake-headroom.txt': headroom,
    'paid-report/report-summary.md': '## Periodic summary\n✗ noisy-case', 'report.txt': 'reconcile tail',
  };

  test('carries the full alarm lines, red ledger, headroom and all-green estimate, sanitized, for an explicit branch', () => {
    const run = runStep('evals-periodic.yml', 'Write the census report', files, PERIODIC_EXPRESSIONS);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const body = run.body('census-report.md');
    expect(run.summary).toBe(body);
    expect(body).toStartWith('Periodic census report: branch feature/x @ abc1234, event workflow_dispatch, run https://github.com/garrytan/gstack/actions/runs/42');
    expect(body).toContain('triage with https://github.com/garrytan/gstack/blob/abc1234/docs/evals/census-red.md');
    expect(body).toContain('- periodic reconciliation exit: 1 (slices job: failure, Codex slices job: success)');
    expect(body).toContain('- all-green probability (approximation, assumes independent verdicts): 81.2% for the latest census');
    expect(body).toContain('## Periodic summary');
    // Every alarm line, not just the header; the flaky-pass block is not an alarm.
    expect(body).toContain('ACTION REQUIRED (3):');
    expect(body).toContain('[drift] noisy-case passes 9/10 (below 95% over >= 10 trials): fix it');
    expect(body).toContain('[headroom] slow-case session sdk:slow-case#1: max 520s of 600s (87%) above the 85% cap');
    expect(body).not.toContain('test/unrelated.test.ts');
    expect(body).toContain('✗ noisy-case FAIL t1 assertion/provider_stall — Error: expect(received).toBe(expected)');
    expect(body).toContain('ALARM         520s/600s (87%)');
    // Hostile alarm text stays literal inside a fence it cannot close; mentions and tokens are neutralized.
    const hostile = body.split('\n').findIndex(line => line.includes('mention @'));
    const fence = body.split('\n').slice(0, hostile).reverse().find(line => /^`{3,}$/.test(line))!;
    expect(fence.length).toBeGreaterThan(3);
    expect(body).toContain('@\u200battacker');
    expect(body).not.toContain('ghp_' + 'a'.repeat(36));
    expect(run.calls.trim().split('\n')).toEqual([
      'run eval:pass-rates --reds --runs 10 --branch feature/x',
      'run eval:pass-rates --headroom --runs 10 --branch feature/x',
    ]);
  });

  test('missing history becomes a visible line, never a failed step', () => {
    const run = runStep('evals-periodic.yml', 'Write the census report', { 'fake-reds.txt': '', 'fake-headroom.txt': '' }, PERIODIC_EXPRESSIONS);
    expect(run.status).toBe(0);
    const body = run.body('census-report.md');
    expect(body).toContain('all-green probability: unavailable (see the red ledger)');
    expect(body).toContain('(no pass-rate alarms)');
    expect(body).toContain('(no periodic report summary)');
  });
});

describe('the marathon report', () => {
  test('fences the sanitized reconciliation output and links the guide', () => {
    const run = runStep('evals-marathon.yml', 'Write the marathon report', { 'report.txt': 'red slice\nping @someone ```' },
      { 'steps.reconcile.outputs.exit': '1', 'needs.eval-slices.result': 'success' });
    expect(run.status).toBe(0);
    const body = run.body('marathon-report.md');
    expect(run.summary).toBe(body);
    expect(body).toStartWith('Marathon report (non-blocking lane): branch feature/x @ abc1234, event workflow_dispatch');
    expect(body).toContain('docs/evals/census-red.md');
    expect(body).toContain('- reconciliation exit: 1');
    expect(body).toContain('````\nred slice\nping @\u200bsomeone ```\n````');
  });
});
