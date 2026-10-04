/**
 * Static tripwire for .github/workflows/free-tests.yml — the Linux free-suite
 * lane. Pins the three properties that made the lane worth having:
 *
 *   1. It invokes the CANONICAL runner (bun run test:free), not a raw
 *      `bun test <dirs>` glob — the runner owns TEST_ROOTS and strict-output
 *      classification, so a truncated run can't report green.
 *   2. It is SECRETLESS: free tests make no API calls, and keeping keys out
 *      means fork PRs get real signal here. Any `secrets.` reference is a
 *      regression.
 *   3. It triggers on `pull_request` (never `pull_request_target`, which
 *      would hand a fork PR the base repo's context).
 *
 * Same wiring-tripwire class as test/hermetic-wiring.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'node:child_process';

const WORKFLOW = path.resolve(import.meta.dir, '..', '.github', 'workflows', 'free-tests.yml');

describe('free-tests workflow wiring', () => {
  const source = fs.readFileSync(WORKFLOW, 'utf-8');

  test('workflow exists and invokes the canonical runner', () => {
    expect(source).toContain('bun run test:free');
    expect(source).not.toMatch(/run:\s*bun test\s/);
  });

  test('secretless: no secrets reach the free lane', () => {
    expect(source).not.toContain('secrets.');
    expect(source).not.toContain('ANTHROPIC_API_KEY');
    expect(source).not.toContain('OPENAI_API_KEY');
  });

  test('pull_request trigger, never pull_request_target', () => {
    expect(source).toContain('pull_request:');
    expect(source).not.toContain('pull_request_target');
  });

  test('the isolated matrix consumes one plan and the required aggregate verifies all receipts', () => {
    const workflow = Bun.YAML.parse(source) as any;
    const planner = workflow.jobs['free-plan'];
    const suite = workflow.jobs['free-suite'];
    const aggregate = workflow.jobs['free-tests'];
    expect(planner.steps.find((step: any) => step.id === 'plan').run).toContain('--ci-plan');
    expect(suite.needs).toBe('free-plan');
    expect(suite.strategy.matrix).toBe('${{ fromJSON(needs.free-plan.outputs.matrix) }}');
    expect(suite.strategy['fail-fast']).toBe(false);
    expect(suite.strategy['max-parallel']).toBe(20);
    expect(suite.steps.find((step: any) => step.name === 'Run free suite').run).toContain('--ci-run');
    expect(suite.steps.find((step: any) => step.name === 'Upload strict shard result').if).toBe('always()');
    expect(aggregate.if).toBe('always()');
    expect(aggregate.needs).toContain('free-suite');
    expect(aggregate.steps.some((step: any) => step.run?.includes('--ci-verify'))).toBe(true);
    expect(aggregate.needs).toContain('typecheck');
    const gate = aggregate.steps.find((step: any) => step.env?.TYPECHECK_RESULT);
    expect(gate.env.TYPECHECK_RESULT).toBe('${{ needs.typecheck.result }}');
    expect(gate.run).toContain('test "$TYPECHECK_RESULT" = success');
    const typecheck = workflow.jobs.typecheck.steps.map((step: any) => step.run).filter(Boolean);
    expect(typecheck).toEqual(expect.arrayContaining(['bun run typecheck', 'bun run typecheck:test', 'bun run format:cso:check']));
    expect(source).not.toContain('--quick');
  });

  test('zsh is installed so the bash+zsh portability arms run instead of skipping (#2669)', () => {
    const suite = (Bun.YAML.parse(source) as any).jobs['free-suite'];
    const apt = suite.steps.find((step: any) => step.name === 'Install Xvfb + X11 utilities + gate tools').run;
    expect(apt.split(/\s+/)).toContain('zsh');
    const ubicloud = fs.readFileSync(path.resolve(import.meta.dir, '..', 'scripts', 'ubicloud', 'setup-free-suite.sh'), 'utf-8');
    const ubicloudApt = ubicloud.match(/apt-get install(?:[^\n]*\\\n)*[^\n]*/)![0];
    expect(ubicloudApt.split(/\s+/)).toContain('zsh');
  });

  test('the plan job runs the seed ratchet against the merge-base with full history', () => {
    const planner = (Bun.YAML.parse(source) as any).jobs['free-plan'];
    expect(planner.steps[0].with['fetch-depth']).toBe(0);
    const ratchet = planner.steps.find((step: any) => step.name?.startsWith('Seed growth ratchet'));
    expect(ratchet.run).toContain('GSTACK_FREE_SEED_BASE="$(git merge-base HEAD origin/main)"');
    expect(ratchet.run).toContain('test/free-seed-ratchet.test.ts');
  });

  test('flake telemetry stays wired: retry flag, single-writer ledger, unconditional artifact', () => {
    // WS1: a timing flake must not red the required lane, but every
    // flaky-pass must be recorded and uploaded — a green run is exactly when
    // the evidence matters. Removing any of these silently returns flakes to
    // either merge-blocking (flag off) or invisibility (ledger/artifact off).
    expect(source).toMatch(/GSTACK_FREE_RETRY_FLAKY:\s*"1"/);
    expect(source).toMatch(/GSTACK_FLAKE_LEDGER:\s*\$\{\{ runner\.temp \}\}\/flake-ledger\.jsonl/);
    expect(source).toContain('name: flake-ledger');
    expect(source).toMatch(/name: Upload flake ledger\s*\n\s*if: always\(\)/);
  });

  test.skipIf(!Bun.which('bash'))('a recovered retry retains its original detailed spool', () => {
    const steps = (Bun.YAML.parse(source) as any).jobs['free-suite'].steps;
    const probe = steps.find((step: any) => step.id === 'flake_spool');
    const upload = steps.find((step: any) => step.with?.name === 'free-test-shard-logs-${{ matrix.shard }}');
    expect(probe.if).toBe('always()');
    expect(upload.if).toBe("failure() || steps.flake_spool.outputs.present == 'true'");
    expect(upload.with.path).toBe('.context/free-test-logs/gstack-free-test-*.log');
    expect(upload.with['include-hidden-files']).toBe(true);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'free spool '));
    const output = path.join(directory, 'step-output');
    const ledger = path.join(directory, 'flake-ledger.jsonl');
    try {
      for (const contents of [null, '', '{"kind":"flaky-pass","file":"test/example.test.ts"}\n']) {
        if (contents !== null) fs.writeFileSync(ledger, contents);
        fs.writeFileSync(output, '');
        const result = spawnSync('bash', ['-e', '-c', probe.run], {
          // Git Bash accepts C:/... paths; native backslashes are not shell paths.
          env: { ...process.env, RUNNER_TEMP: directory.split(path.sep).join('/'),
            GITHUB_OUTPUT: output.split(path.sep).join('/') },
          encoding: 'utf8', timeout: 5000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(fs.readFileSync(output, 'utf8')).toBe(contents ? 'present=true\n' : '');
      }
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });

  test('least-privilege token: contents read-only, credentials not persisted', () => {
    // The job executes PR-controlled code (install lifecycle scripts + the
    // suite itself). A default-grant GITHUB_TOKEN persisted into .git/config
    // by checkout would hand that code whatever the repo default allows.
    expect(source).toMatch(/permissions:\s*\n\s*contents:\s*read/);
    expect(source).toMatch(/persist-credentials:\s*false/);
  });
});
