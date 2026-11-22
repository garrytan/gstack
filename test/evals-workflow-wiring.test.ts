/**
 * Sliced-lane wiring pins for the paid CI workflows — the successor to
 * evals-workflow-matrix.test.ts, which enforced completeness of a
 * hand-enumerated 17-row matrix (and carried KNOWN_MATRIX_GAPS /
 * KNOWN_TIER_UNSET burn-down ratchets for the files that matrix missed).
 * The matrix is deleted: the sliced lane's planner derives the gate census
 * from the runner itself (collectPaidTestFiles + tier selection), so "every
 * gate-hosting file is in the census" is true BY CONSTRUCTION and the
 * burn-down ratchets retired with the rows.
 *
 * What still needs pinning is the WIRING — the yml plumbing that free tests
 * are the only guard for:
 *   - the legacy matrix (and its `needs: evals` serialization) stays deleted,
 *   - planner/executor/report all run tier=gate and agree on the slice count,
 *   - both surviving lanes register skills through the SHARED composite that
 *     carries the fail-fast dangling-symlink/frontmatter verification loop
 *     (the sliced + periodic copies had silently dropped it — the loop was
 *     written after a silent "Unknown command" + 35-min-timeout incident),
 *   - the PR comment survives the matrix-report deletion (it moved into
 *     slices-report, keyed on the same "## E2E Evals" upsert marker).
 */
import { describe, test, expect } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { buildRunManifest, isCodexShard, isOverlayTestFile, parseCliOptions, resolvePaidShardTimeoutMs, sliceExecutionOrder, sliceSupervisedWallMs, CI_SETUP_ALLOWANCE_MINUTES } from '../scripts/test-paid-shards';
import { CENSUS_ARMS, MONTHLY_CENSUS_ARMS, MONTHLY_CENSUS_SCHEDULE, WEEKLY_CENSUS_ARMS, WEEKLY_CENSUS_SCHEDULE, censusArmEnv, censusMatrix, selectCensus } from '../crew/scripts/census-arms';

const ROOT = path.join(import.meta.dir, '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const evalsYml = read('.github/workflows/evals.yml');
const periodicYml = read('.github/workflows/evals-periodic.yml');
const marathonYml = read('.github/workflows/evals-marathon.yml');
const registerAction = read('.github/actions/register-gstack-skills/action.yml');

/** Every planner site: its manifest path and budget (`--slice-budget S --jobs J`). */
function plannerSites(source: string): Array<{ manifest: string; budgetSeconds: number; jobs: number }> {
  return [...source.matchAll(/--emit-plan\s+(\S+)\s+--slice-budget\s+(\d+)\s+--jobs\s+(\d+)/g)]
    .map((m) => ({ manifest: m[1]!, budgetSeconds: Number(m[2]), jobs: Number(m[3]) }));
}

type Step = { id?: string; name?: string; run?: string; uses?: string; env?: Record<string, string>; with?: Record<string, string> };
type Job = { needs?: string[]; env?: Record<string, string>; outputs?: Record<string, string>; 'timeout-minutes': string | number;
  strategy?: { 'max-parallel': number; matrix: { slice?: string; include?: string } }; steps: Step[] };

/**
 * An executor's matrix and timeout must come from the planner step that wrote
 * the manifest it downloads: `slices` from `[range(1; .sliceCount + 1)]` and
 * `timeout-minutes` from the plan, never hand-written numbers: per slice from
 * `.plan.sliceCiTimeoutMinutes` (indexed by matrix.slice, W2c/ENG-2), or one
 * `.plan.ciTimeoutMinutes` (the largest per-slice ceiling) for every slice.
 */
function expectPlannedExecutor(source: string, executorName: string, prefix: string) {
  const workflow = Bun.YAML.parse(source) as { jobs: Record<string, Job> };
  const planner = workflow.jobs['plan-slices']!;
  const executor = workflow.jobs[executorName]!;
  expect(executor.needs).toContain('plan-slices');
  expect(executor.strategy!.matrix.slice).toBe(`\${{ fromJSON(needs.plan-slices.outputs.${prefix}slices) }}`);
  const perSlice = executor['timeout-minutes'] === `\${{ fromJSON(needs.plan-slices.outputs.${prefix}slice_timeouts)[matrix.slice] }}`;
  if (!perSlice) expect(executor['timeout-minutes']).toBe(`\${{ fromJSON(needs.plan-slices.outputs.${prefix}timeout_minutes) }}`);
  const [stepId] = /^\$\{\{ steps\.([\w-]+)\.outputs\.slices \}\}$/.exec(planner.outputs![`${prefix}slices`]!)!.slice(1);
  const output = perSlice ? 'slice_timeouts' : 'timeout_minutes';
  expect(planner.outputs![`${prefix}${output}`]).toBe(`\${{ steps.${stepId}.outputs.${output} }}`);
  const matrixStep = planner.steps.find(step => step.id === stepId)!;
  const manifest = /jq -c '\[range\(1; \.sliceCount \+ 1\)\](?: - \.plan\.codexSlices)?' (\S+)\)/.exec(matrixStep.run!)![1]!;
  expect(matrixStep.run).toContain(perSlice ? `jq -ec '[0] + .plan.sliceCiTimeoutMinutes' ${manifest})` : `jq -e '.plan.ciTimeoutMinutes' ${manifest})`);
  if (perSlice) {
    // The deadline's clock: the executor's first step records the job start.
    expect(executor.steps[0]!.run).toBe('echo "GSTACK_SLICE_JOB_STARTED_AT=$(date +%s)" >> "$GITHUB_ENV"');
  }
  const emit = planner.steps.filter(step => step.run?.includes(`--emit-plan ${manifest} `));
  expect(emit).toHaveLength(1);
  const execute = executor.steps.filter(step => step.run?.includes('--plan '));
  expect(execute).toHaveLength(1);
  expect(execute[0]!.run).toContain(`--plan ${manifest} --slice \${{ matrix.slice }}`);
  expect(executor.steps.some(step => step.with?.path === manifest.replace(/\/manifest\.json$/, ''))).toBe(true);
  // The planner packs for exactly the executor's worker count.
  const site = plannerSites(emit[0]!.run!)[0]!;
  expect(execute[0]!.env?.EVALS_JOBS).toBe(String(site.jobs));
  return { site, emit: emit[0]!, execute: execute[0]!, executor, planner };
}

describe('evals.yml sliced-lane wiring (post-matrix)', () => {
  test('the legacy matrix job stays deleted', () => {
    // Row-enumeration shapes from the deleted matrix. Any reappearance means
    // someone is re-growing a hand-maintained enumeration next to a lane
    // whose census is derived — the drift class the deletion killed.
    expect(evalsYml).not.toMatch(/^\s+suite:\s*$/m);
    expect(evalsYml).not.toMatch(/^\s+file: test\//m);
    expect(evalsYml).not.toContain('needs: [build-image, evals]');
    expect(evalsYml).not.toMatch(/^\s+needs: evals\s*$/m);
  });

  test('no workflow-level EVALS_TIER env (each command sets its own)', () => {
    // The workflow-level `EVALS_TIER: gate` was dead config once every
    // consumer set its own; a resurrected copy would silently leak gate
    // semantics into steps that must choose explicitly.
    expect(evalsYml).not.toMatch(/^env:[\s\S]{0,120}^\s+EVALS_TIER:/m);
  });

  test('planner, executors, and report all run tier=gate on the shared runner', () => {
    expect(evalsYml).toMatch(/EVALS_TIER=gate bun --no-install run scripts\/test-paid-shards\.ts --tier gate --emit-plan/);
    expect(evalsYml).toMatch(/EVALS_TIER=gate bun run scripts\/test-paid-shards\.ts --tier gate --plan .* --slice /);
    expect(evalsYml).toMatch(/EVALS_TIER=gate bun --no-install run scripts\/test-paid-shards\.ts --tier gate --report /);
  });

  test('executor matrix and timeout come from the one budget planner', () => {
    expect(plannerSites(evalsYml), 'expected exactly one --emit-plan site in evals.yml').toHaveLength(1);
    const { site } = expectPlannedExecutor(evalsYml, 'eval-slices', '');
    expect(site).toEqual({ manifest: '/tmp/paid-plan/manifest.json', budgetSeconds: 420, jobs: 2 });
  });

  test('reconcile exit is captured via PIPESTATUS, never $? after a pipe', () => {
    // GitHub's default run-step shell is `bash -e {0}` with NO pipefail, so
    // `$?` after `... | tee` is tee's exit — always 0. That made the
    // fail-closed reconcile gate silently fail-open (ship review army,
    // 2026-08-31). Both lanes must read PIPESTATUS[0].
    for (const [name, source] of [['evals.yml', evalsYml], ['evals-periodic.yml', periodicYml], ['evals-marathon.yml', marathonYml]] as const) {
      const reconcileBlocks = [...source.matchAll(/--report[^\n]*\| tee[^\n]*\n([\s\S]{0,400}?)GITHUB_OUTPUT/g)];
      expect(reconcileBlocks.length, `${name}: expected a tee'd reconcile step`).toBeGreaterThanOrEqual(1);
      for (const block of reconcileBlocks) {
        expect(block[1], `${name} reconcile captures tee's exit, not the runner's`).toContain('PIPESTATUS[0]');
        expect(block[1]).not.toMatch(/exit=\$\?/);
      }
    }
  });

  test('the PR comment survived the matrix-report deletion (moved to slices-comment)', () => {
    // Keyed on the upsert marker so the migration keeps updating the SAME
    // comment; and the job holding it needs the issues permission (#1802).
    expect(evalsYml).toContain('## E2E Evals');
    expect(evalsYml).toMatch(/pull-requests: write/);
    expect(evalsYml).toMatch(/issues: write/);
  });

  test('the write-token job runs ZERO repo code (token/exec separation)', () => {
    // slices-report executes PR-authored code (bun install + the reconcile
    // runner), so it must hold contents:read ONLY; the write token lives in
    // slices-comment, which may only download artifacts and run jq/gh —
    // $GITHUB_ENV persistence is job-scoped, so this split IS the trust
    // boundary (codex adversarial, 2026-08-31; the matrix-era report job had
    // this property and the consolidation briefly regressed it).
    const commentJob = evalsYml.slice(evalsYml.indexOf('  slices-comment:'));
    expect(commentJob.length).toBeGreaterThan(100);
    expect(commentJob).not.toContain('actions/checkout');
    expect(commentJob).not.toContain('bun install');
    expect(commentJob).not.toMatch(/run: .*bun run/);
    expect(commentJob).not.toContain('uses: ./');
    // No checkout also means no git context: `gh pr comment` resolves the
    // repo FROM git and dies with "not a git repository" here (PR #2746's
    // first run). Every comment call must be explicit-repo REST (gh api).
    expect(commentJob).not.toContain('gh pr comment');
    // And the code-executing report job must NOT hold write scopes.
    const reportJob = evalsYml.slice(evalsYml.indexOf('  slices-report:'), evalsYml.indexOf('  slices-comment:'));
    expect(reportJob).not.toMatch(/pull-requests: write/);
    expect(reportJob).not.toMatch(/issues: write/);
  });
});

describe('evals-periodic.yml sliced-lane wiring', () => {
  const lanes = [
    { source: periodicYml, name: 'evals-periodic.yml', executor: 'eval-slices', prefix: 'periodic_', tier: 'periodic' },
    { source: evalsYml, name: 'evals.yml', executor: 'eval-slices', prefix: '', tier: 'gate' },
    { source: marathonYml, name: 'evals-marathon.yml', executor: 'eval-slices', prefix: '', tier: 'marathon' },
  ] as const;

  for (const lane of lanes) {
    test(`${lane.name}:${lane.executor} — the planned CI job cap covers every slice's supervised wall plus setup, and every slice starts at once`, () => {
      const { emit, execute, executor } = expectPlannedExecutor(lane.source, lane.executor, lane.prefix);
      const cliArgs = (run: string) => {
        const command = /\bbun(?: --no-install)? run scripts\/test-paid-shards\.ts /.exec(run);
        expect(command).not.toBeNull();
        return run.slice(command!.index + command![0].length)
          .replace(/\$\{\{\s*matrix\.slice\s*\}\}/g, '1').trim().split(/\s+/);
      };
      const workflow = Bun.YAML.parse(lane.source) as { env?: Record<string, string> };
      // The complete census (EVALS_ALL) is the largest plan any event can produce.
      const plannerEnv = { ...workflow.env, ...emit.env, EVALS_ALL: '1', EVALS_PROFILE: 'full' };
      const planned = parseCliOptions(cliArgs(emit.run!), plannerEnv);
      const active = parseCliOptions(cliArgs(execute.run!), { ...workflow.env, ...executor.env, ...execute.env, EVALS_PROFILE: 'full' });
      expect(planned.tier).toBe(lane.tier);
      expect(active.tier).toBe(lane.tier);
      expect(active.jobs).toBe(planned.jobs);
      const manifest = buildRunManifest({ tier: planned.tier, profile: 'full', sliceBudgetMs: planned.sliceBudgetMs!, jobs: planned.jobs,
        evalsAll: true, env: plannerEnv, rootDir: ROOT, skipJudges: planned.skipJudges });
      // W2c/ENG-2: each slice's ceiling is max(2x budget, its longest shard's supervised wall, the
      // serialized overlay envelope) + setup; the executor's deadline turns the rest into not_run.
      const sliceFiles = Array.from({ length: manifest.sliceCount }, (_, i) => sliceExecutionOrder(
        manifest.entries.filter(entry => entry.status === 'planned' && entry.slice === i + 1)).map(entry => entry.file));
      const ceilings = sliceFiles.map(files => Math.ceil(Math.max(2 * planned.sliceBudgetMs!,
        ...files.map(file => resolvePaidShardTimeoutMs([file])),
        files.some(isOverlayTestFile) ? sliceSupervisedWallMs(files, planned.jobs) : 0) / 60_000) + CI_SETUP_ALLOWANCE_MINUTES);
      expect(CI_SETUP_ALLOWANCE_MINUTES).toBe(20);
      expect(manifest.plan!.sliceCiTimeoutMinutes).toEqual(ceilings);
      expect(manifest.plan!.ciTimeoutMinutes).toBe(Math.max(...ceilings));
      // GitHub-hosted-style job ceiling: a plan past it must be split, not truncated.
      expect(manifest.plan!.ciTimeoutMinutes).toBeLessThanOrEqual(360);
      expect(manifest.sliceCount, `${lane.name}:${lane.executor} plans more slices than max-parallel starts at once`)
        .toBeLessThanOrEqual(executor.strategy!['max-parallel']);
    });
  }

  test('evals-periodic.yml:gate-census — one row per census arm and planned slice with its plan\'s ceiling, and every row of a scheduled census starts at once', () => {
    const workflow = Bun.YAML.parse(periodicYml) as { env?: Record<string, string>; jobs: Record<string, Job> };
    const planner = workflow.jobs['plan-slices']!;
    const executor = workflow.jobs['gate-census']!;
    expect(executor.needs).toContain('plan-slices');
    expect(executor.strategy!.matrix).toEqual({ include: '${{ fromJSON(needs.plan-slices.outputs.gate_matrix) }}' });
    expect(executor['timeout-minutes']).toBe('${{ matrix.timeout }}');
    expect(executor.steps[0]!.run).toBe('echo "GSTACK_SLICE_JOB_STARTED_AT=$(date +%s)" >> "$GITHUB_ENV"');
    expect(planner.outputs!.gate_matrix).toBe('${{ steps.gate-matrix.outputs.gate_matrix }}');
    expect(planner.steps.find(step => step.id === 'gate-matrix')!.run).toBe('bun --no-install run crew/scripts/census-arms.ts --matrix /tmp/gate-census-plan "$ARMS" >> "$GITHUB_OUTPUT"');
    const emit = planner.steps.filter(step => step.run?.includes('--emit-plan "/tmp/gate-census-plan/$arm/manifest.json" '));
    expect(emit).toHaveLength(1);
    expect(emit[0]!.run).toContain('mapfile -t arm_env < <(bun --no-install run crew/scripts/census-arms.ts --env "$arm")');
    expect(emit[0]!.run).toContain('env "${arm_env[@]}" EVALS_TIER=gate bun run scripts/test-paid-shards.ts');
    const execute = executor.steps.filter(step => step.run?.includes('--plan '));
    expect(execute).toHaveLength(1);
    expect(execute[0]!.run).toContain('--plan /tmp/gate-census-plan/${{ matrix.arm }}/manifest.json --slice ${{ matrix.slice }}');
    // The executor runs with its arm's host and model, and downloads every arm's plan.
    expect(executor.steps.find(step => step.name === "Select the census arm's host and model")!.run).toBe('bun --no-install run crew/scripts/census-arms.ts --env "$ARM" >> "$GITHUB_ENV"');
    expect(executor.steps.some(step => step.with?.path === '/tmp/gate-census-plan')).toBe(true);
    const cliArgs = (run: string) => {
      const command = /\bbun(?: --no-install)? run scripts\/test-paid-shards\.ts (.*)$/m.exec(run)!;
      return command[1]!.replace(/\$\{\{\s*matrix\.slice\s*\}\}/g, '1').replace(/\$\{\{\s*matrix\.arm\s*\}\}/g, 'claude-opus').trim().split(/\s+/);
    };
    const planned = parseCliOptions(cliArgs(emit[0]!.run!), { ...workflow.env, ...emit[0]!.env, EVALS_ALL: '1', EVALS_PROFILE: 'full' });
    const active = parseCliOptions(cliArgs(execute[0]!.run!), { ...workflow.env, ...executor.env, ...execute[0]!.env, EVALS_PROFILE: 'full' });
    expect(planned.tier).toBe('gate');
    expect(active.tier).toBe('gate');
    expect(active.jobs).toBe(planned.jobs);
    expect(execute[0]!.env?.EVALS_JOBS).toBe(String(planned.jobs));
    const planDir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-arms-'));
    try {
      for (const arm of Object.keys(CENSUS_ARMS)) {
        const env = { ...workflow.env, ...emit[0]!.env, EVALS_ALL: '1', EVALS_PROFILE: 'full', ...censusArmEnv(arm) };
        const manifest = buildRunManifest({ tier: 'gate', profile: 'full', sliceBudgetMs: planned.sliceBudgetMs!, jobs: planned.jobs,
          evalsAll: true, env, rootDir: ROOT, skipJudges: planned.skipJudges });
        expect(manifest.host ?? 'claude').toBe(CENSUS_ARMS[arm]!.host);
        const sliceFiles = Array.from({ length: manifest.sliceCount }, (_, i) => sliceExecutionOrder(
          manifest.entries.filter(entry => entry.status === 'planned' && entry.slice === i + 1)).map(entry => entry.file));
        const ceilings = sliceFiles.map(files => Math.ceil(Math.max(2 * planned.sliceBudgetMs!,
          ...files.map(file => resolvePaidShardTimeoutMs([file])),
          files.some(isOverlayTestFile) ? sliceSupervisedWallMs(files, planned.jobs) : 0) / 60_000) + CI_SETUP_ALLOWANCE_MINUTES);
        expect(manifest.plan!.sliceCiTimeoutMinutes).toEqual(ceilings);
        expect(manifest.plan!.ciTimeoutMinutes).toBeLessThanOrEqual(360);
        fs.mkdirSync(path.join(planDir, arm));
        fs.writeFileSync(path.join(planDir, arm, 'manifest.json'), JSON.stringify(manifest));
        expect(censusMatrix([arm], planDir)).toEqual(ceilings.map((timeout, i) => ({ arm, slice: i + 1, timeout })));
      }
      for (const arms of [WEEKLY_CENSUS_ARMS, MONTHLY_CENSUS_ARMS]) {
        const rows = censusMatrix(arms, planDir);
        expect(new Set(rows.map(row => `${row.arm}/${row.slice}`)).size).toBe(rows.length);
        expect(rows.length, `${arms.join('+')} rows exceed max-parallel`).toBeLessThanOrEqual(executor.strategy!['max-parallel']);
      }
    } finally {
      fs.rmSync(planDir, { recursive: true, force: true });
    }
  });

  test('planner/executor/report tier=periodic agree and plan with the ~7-minute budget (W5c)', () => {
    expect(periodicYml).toMatch(/EVALS_TIER=periodic bun --no-install run scripts\/test-paid-shards\.ts --tier periodic --emit-plan/);
    expect(periodicYml).toMatch(/EVALS_TIER=periodic bun run scripts\/test-paid-shards\.ts --tier periodic --plan .* --slice /);
    expect(periodicYml).toMatch(/EVALS_TIER=periodic bun --no-install run scripts\/test-paid-shards\.ts --tier periodic --report /);
    // Periodic work and the full gate census have distinct immutable plans.
    expect(plannerSites(periodicYml)).toEqual([
      { manifest: '/tmp/paid-plan/manifest.json', budgetSeconds: 420, jobs: 2 },
      { manifest: '"/tmp/gate-census-plan/$arm/manifest.json"', budgetSeconds: 420, jobs: 2 },
    ]);
  });
});

describe('evals-periodic.yml host-run Codex slices', () => {
  type HostJob = Job & { if?: string; container?: unknown; 'runs-on': string; permissions?: Record<string, string>;
    steps: Array<Step & { uses?: string; shell?: string }> };
  const jobs = (Bun.YAML.parse(periodicYml) as { jobs: Record<string, HostJob> }).jobs;
  const codex = jobs['eval-codex-slices']!;
  const container = jobs['eval-slices']!;
  const planner = jobs['plan-slices']!;
  const uploadNames = (job: HostJob) => job.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@')).map(step => step.with!.name);

  test('the planner gives Codex slices to the host job and every other slice to the container job', () => {
    const matrixStep = planner.steps.find(step => step.id === 'periodic-matrix')!;
    expect(matrixStep.run).toContain(`echo "slices=$(jq -c '[range(1; .sliceCount + 1)] - .plan.codexSlices' /tmp/paid-plan/manifest.json)"`);
    expect(matrixStep.run).toContain(`echo "codex_slices=$(jq -c '.plan.codexSlices' /tmp/paid-plan/manifest.json)"`);
    expect(matrixStep.run).toContain('} >> "$GITHUB_OUTPUT"');
    expect(planner.outputs!.periodic_codex_slices).toBe('${{ steps.periodic-matrix.outputs.codex_slices }}');
    expect(codex.needs).toEqual(['build-image', 'plan-slices']);
    expect(codex.if).toBe("${{ needs.plan-slices.outputs.periodic_lane == 'true' && needs.plan-slices.outputs.periodic_codex_slices != '[]' }}");
    expect(codex.strategy!.matrix.slice).toBe('${{ fromJSON(needs.plan-slices.outputs.periodic_codex_slices) }}');
    expect(codex['timeout-minutes']).toBe('${{ fromJSON(needs.plan-slices.outputs.periodic_slice_timeouts)[matrix.slice] }}');
    expect(codex.steps[0]!.run).toBe('echo "GSTACK_SLICE_JOB_STARTED_AT=$(date +%s)" >> "$GITHUB_ENV"');
    const manifest = buildRunManifest({ tier: 'periodic', profile: 'full', sliceBudgetMs: 540_000, jobs: 2, evalsAll: true, env: { EVALS_ALL: '1' }, rootDir: ROOT });
    const codexSlices = manifest.plan!.codexSlices!;
    expect(codexSlices.length).toBeGreaterThan(0);
    expect(codex.strategy!['max-parallel']).toBeGreaterThanOrEqual(codexSlices.length);
    for (const entry of manifest.entries.filter(entry => entry.status === 'planned')) {
      expect(codexSlices.includes(entry.slice), entry.file).toBe(isCodexShard(entry.file, 'periodic'));
    }
    // Gate plans (evals.yml and the weekly gate census) never give a shard Codex, so they have no Codex slices.
    expect(buildRunManifest({ tier: 'gate', profile: 'full', sliceBudgetMs: 540_000, jobs: 2, evalsAll: true, env: { EVALS_ALL: '1' }, rootDir: ROOT })
      .plan!.codexSlices).toEqual([]);
  });

  test('runs on the runner VM, lifts the user-namespace restriction, then runs the CI image with seccomp and AppArmor unconfined', () => {
    expect(codex.container).toBeUndefined();
    expect(codex['runs-on']).toBe(container['runs-on']);
    expect(codex.permissions).toEqual({ contents: 'read', packages: 'read' });
    const sysctl = codex.steps.findIndex(step => step.run?.includes('sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0'));
    const execute = codex.steps.findIndex(step => step.run?.includes('docker run '));
    expect(sysctl).toBeGreaterThan(-1);
    expect(execute).toBeGreaterThan(sysctl);
    const step = codex.steps[execute]!;
    expect(step.run).toContain('--security-opt seccomp=unconfined --security-opt apparmor=unconfined');
    expect(step.run).toContain('--user "$(id -u):$(id -g)"');
    expect(step.run).not.toMatch(/--privileged|--cap-add|--pid[ =]host|--network[ =]host|docker\.sock/);
    expect(step.env!.EVAL_IMAGE).toBe('${{ needs.build-image.outputs.image-tag }}');
    expect(step.run).toContain('"$EVAL_IMAGE" bash -c');
    expect(step.env!.SLICE).toBe('${{ matrix.slice }}');
    expect(step.run).toContain('EVALS_TIER=periodic bun run scripts/test-paid-shards.ts --tier periodic --plan /tmp/paid-plan/manifest.json --slice "$SLICE"');
    expect(step.run).toContain('-v "$RUNNER_TEMP/paid-plan:/tmp/paid-plan:ro"');
    expect(codex.steps.some(other => other.uses?.startsWith('actions/download-artifact@') && other.with?.name === 'paid-plan'
      && other.with?.path === '${{ runner.temp }}/paid-plan')).toBe(true);
    const containerRun = container.steps.find(other => other.run?.includes('--plan '))!;
    expect(step.env!.EVALS_JOBS).toBe(containerRun.env!.EVALS_JOBS);
    for (const name of ['EVALS_CONCURRENCY', 'GSTACK_EVAL_DIR', 'PLAYWRIGHT_BROWSERS_PATH']) {
      expect(step.run, name).toContain(`-e ${name}=${containerRun.env![name]}`);
    }
  });

  test('uploads under the container executor\'s artifact names, and the report waits for it and fails on it', () => {
    expect(uploadNames(codex)).toEqual(uploadNames(container));
    const report = jobs.report!;
    expect(report.needs).toContain('eval-codex-slices');
    const guards = (report.steps as Array<Step & { if?: string }>).filter(step => step.if?.includes('needs.eval-slices.result'));
    expect(guards.length).toBeGreaterThanOrEqual(3);
    for (const guard of guards) expect(guard.if, guard.name).toContain('needs.eval-codex-slices.result');
  });
});

describe('evals-marathon.yml non-blocking lane', () => {
  const workflow = Bun.YAML.parse(marathonYml) as { on: Record<string, unknown>; env: Record<string, string>; jobs: Record<string, Job> };

  test('runs weekly and on dispatch, always fresh, with its own fail-closed report and tracking issue', () => {
    expect(Object.keys(workflow.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(workflow.env).toMatchObject({ EVALS_PROFILE: 'full', EVALS_FRESH: '1', EVALS_CACHE_PURPOSE: 'marathon' });
    expect(marathonYml).not.toContain('actions/cache');
    expect(marathonYml).toMatch(/EVALS_TIER=marathon bun --no-install run scripts\/test-paid-shards\.ts --tier marathon --emit-plan \/tmp\/marathon-plan\/manifest\.json --slice-budget 1 --jobs 1/);
    expect(marathonYml).toMatch(/EVALS_TIER=marathon bun run scripts\/test-paid-shards\.ts --tier marathon --plan .* --slice /);
    const report = workflow.jobs.report!;
    expect(report.needs).toEqual(['plan-slices', 'eval-slices']);
    const reconcile = report.steps.find(step => step.id === 'reconcile')!;
    expect(reconcile.run).toContain('EVALS_TIER=marathon bun --no-install run scripts/test-paid-shards.ts --tier marathon --report /tmp/marathon-report');
    const guards = report.steps.filter(step => /Upsert tracking|Fail the workflow/.test(step.name ?? ''));
    expect(guards).toHaveLength(2);
    for (const step of guards) {
      expect((step as { if?: string }).if).toContain("steps.reconcile.outputs.exit != '0'");
      expect((step as { if?: string }).if).toContain("needs.eval-slices.result != 'success'");
    }
    expect(marathonYml).toContain('Weekly marathon evals: red lane needs triage');
  });

  test('the blocking lanes never plan or execute the marathon tier', () => {
    for (const source of [evalsYml, periodicYml]) {
      expect(source).not.toContain('--tier marathon');
      expect(source).not.toContain('EVALS_TIER=marathon');
    }
  });
});

describe('shared setup composites (every paid lane)', () => {
  test('every lane registers skills through the shared composite', () => {
    for (const [name, source] of [['evals.yml', evalsYml], ['evals-periodic.yml', periodicYml], ['evals-marathon.yml', marathonYml]] as const) {
      expect(source, `${name} must use the register-gstack-skills composite`)
        .toContain('uses: ./.github/actions/register-gstack-skills');
      // No inline re-implementation creeping back beside the composite.
      expect(source, `${name} re-inlines the skill registry instead of using the composite`)
        .not.toContain('ln -snf "$REPO" "$SKILLS_DIR/gstack"');
    }
  });

  test('the register composite carries the fail-fast verification loop', () => {
    // The loop is the POINT of the composite: a dangling symlink or renamed
    // committed target fails in seconds with a named path, never as a wedged
    // PTY session at the shard wall. Pin its load-bearing markers.
    expect(registerAction).toContain('skill registry OK');
    expect(registerAction).toContain('skill-registry target missing');
    expect(registerAction).toContain('gstack root symlink dangles');
    expect(registerAction).toMatch(/grep -m1 "\^name: \$s\\\$"/);
  });

  test('seed/deps/temp composites exist and both lanes use them', () => {
    for (const action of ['seed-claude-config', 'restore-deps', 'fix-bun-temp']) {
      expect(fs.existsSync(path.join(ROOT, '.github', 'actions', action, 'action.yml')), `missing composite: ${action}`).toBe(true);
    }
    for (const [name, source] of [['evals.yml', evalsYml], ['evals-periodic.yml', periodicYml], ['evals-marathon.yml', marathonYml]] as const) {
      expect(source, `${name} must use seed-claude-config`).toContain('uses: ./.github/actions/seed-claude-config');
      expect(source, `${name} must use restore-deps`).toContain('uses: ./.github/actions/restore-deps');
      expect(source, `${name} must use fix-bun-temp`).toContain('uses: ./.github/actions/fix-bun-temp');
    }
  });
});

describe('panel verdict surfaces (eval reliability policy)', () => {
  type AnyJob = { if?: string; needs?: string[]; permissions?: Record<string, string>; outputs?: Record<string, string>;
    strategy?: { 'max-parallel': number }; steps: Array<Step & { if?: string; uses?: string }> };
  const jobsOf = (source: string) => (Bun.YAML.parse(source) as { jobs: Record<string, AnyJob> }).jobs;

  test('planners size the capacity preflight with their executor cap', () => {
    for (const [source, executor, manifest] of [[evalsYml, 'eval-slices', '/tmp/paid-plan/manifest.json'],
      [periodicYml, 'eval-slices', '/tmp/paid-plan/manifest.json'], [periodicYml, 'gate-census', '"/tmp/gate-census-plan/$arm/manifest.json"']] as const) {
      const jobs = jobsOf(source);
      const emit = jobs['plan-slices']!.steps.find(step => step.run?.includes(`--emit-plan ${manifest} `))!;
      const cap = Number(/--max-parallel (\d+)/.exec(emit.run!)?.[1]);
      expect(cap, `${executor}: --max-parallel`).toBe(jobs[executor]!.strategy!['max-parallel']);
    }
  });

  test('slice artifacts are attempt-scoped and never merged into one tree', () => {
    for (const source of [evalsYml, periodicYml, marathonYml]) {
      const jobs = jobsOf(source);
      const uploads = Object.values(jobs).flatMap(job => job.steps).filter(step => step.uses?.startsWith('actions/upload-artifact@'))
        .map(step => step.with?.name ?? '').filter(name => /slice|census-\$/.test(name))
        // GSTA-49 T1b: the train record keeps the fixed name gstack-ship-queue reads; it is built from the
        // first attempt's slice results only (crew/scripts/train-gate.ts buildTrainRecord), so a re-run cannot change it.
        .filter(name => name !== '${{ needs.plan-slices.outputs.record_artifact }}');
      expect(uploads.length).toBeGreaterThan(0);
      for (const name of uploads) expect(name, name).toContain('-a${{ github.run_attempt }}');
      const downloads = Object.values(jobs).flatMap(job => job.steps).filter(step => step.uses?.startsWith('actions/download-artifact@') && step.with?.pattern);
      for (const step of downloads) expect((step.with as Record<string, unknown>)['merge-multiple'], step.with!.pattern).toBeUndefined();
    }
  });

  test('the PR comment reads collector-outcomes v2 and never recomputes a verdict', () => {
    const comment = evalsYml.slice(evalsYml.indexOf('  slices-comment:'));
    expect(comment).toContain('.version == 2');
    expect(comment).toContain("jq -r '.failures[]'");
    expect(comment).toContain('name: report-verdict-a${{ github.run_attempt }}');
    expect(evalsYml).not.toContain('group_by(.name)');
    expect(comment).not.toMatch(/paid-slice-/);
    const report = jobsOf(evalsYml)['slices-report']!;
    expect(report.steps.some(step => step.run?.includes('scripts/eval-trial-series.ts /tmp/paid-report/trial-outcomes.jsonl'))).toBe(true);
    expect(report.steps.some(step => step.with?.name?.startsWith('trial-outcomes-'))).toBe(true);
  });

  test('the weekly report gates on pass-rate history, closes its issue on green, and re-dispatches INFRA-only reds once', () => {
    const jobs = jobsOf(periodicYml);
    const report = jobs.report!;
    expect(report.permissions).toEqual({ contents: 'read', issues: 'write', actions: 'read' });
    const gate = report.steps.find(step => step.id === 'pass-rates')!;
    expect(gate.run).toContain('bun run eval:pass-rates --gate --runs 10');
    expect(gate.if).toBe('always()');
    for (const name of ['Write the census report', 'Upsert tracking issue on failure', 'Fail the workflow when reconciliation failed']) {
      expect(report.steps.find(step => step.name === name)!.if).toContain("steps.pass-rates.outputs.exit != '0'");
    }
    // The report body is written once on every ref; the main-only upsert posts it (test/evals-tracking-issue.test.ts).
    expect(report.steps.find(step => step.name === 'Write the census report')!.run).toContain('report-summary.md');
    expect(report.steps.find(step => step.name === 'Close the tracking issue on a green run')!.run).toContain('gh issue close');
    expect(report.steps.filter(step => step.with?.name?.startsWith('trial-outcomes-')).length).toBe(2);
    const redispatch = jobs.redispatch!;
    expect([redispatch.needs].flat()).toEqual(['report']);
    expect(redispatch.permissions).toEqual({ actions: 'write' });
    expect(redispatch.if).toBe("${{ !cancelled() && needs.report.outputs.redispatch == 'true' }}");
    expect(redispatch.steps[0]!.run).toContain('-f redispatch_of="$GITHUB_RUN_ID"');
    // A census-only run re-dispatches with its own arms, never as a weekly run.
    expect(redispatch.steps[0]!.run).toContain('${CENSUS_ARMS:+-f census_arms="$CENSUS_ARMS"}');
    expect(redispatch.steps[0]!.env?.CENSUS_ARMS).toBe('${{ needs.report.outputs.redispatch_census_arms }}');
    expect(report.outputs!.redispatch_census_arms).toBe("${{ needs.plan-slices.outputs.periodic_lane != 'true' && join(fromJSON(needs.plan-slices.outputs.census_arms), ',') || '' }}");
    const classify = report.steps.find(step => step.id === 'verdict')!;
    expect(classify.run).toContain('.verdict.redispatchEligible == true');
    expect(classify.run).toContain('[ -z "$REDISPATCH_OF" ]');
    expect(periodicYml).toMatch(/group: evals-periodic-\$\{\{ github\.ref \}\}-\$\{\{ github\.event_name \}\}\$\{\{ inputs\.redispatch_of/);
  });
});

describe('scheduled paid lanes: concurrency and branch dispatch scope', () => {
  type Wf = { on: { workflow_dispatch?: { inputs?: Record<string, { type?: string; default?: unknown }> } };
    concurrency: { group: string; 'cancel-in-progress': boolean }; jobs: Record<string, { if?: string; steps: Step[] }> };
  const parse = (source: string) => Bun.YAML.parse(source) as Wf;

  test('periodic and marathon groups key on ref and event, so a branch or manual dispatch never cancels the scheduled main run', () => {
    for (const [name, source, prefix] of [['evals-periodic.yml', periodicYml, 'evals-periodic'], ['evals-marathon.yml', marathonYml, 'evals-marathon']] as const) {
      const { concurrency } = parse(source);
      expect(concurrency['cancel-in-progress'], name).toBe(true);
      expect(concurrency.group.startsWith(`${prefix}-\${{ github.ref }}-\${{ github.event_name }}`), `${name}: ${concurrency.group}`).toBe(true);
    }
    // The re-dispatch keeps its own group so it never cancels its dispatcher.
    expect(parse(periodicYml).concurrency.group).toContain("format('-redispatch-{0}', inputs.redispatch_of)");
  });

  test('a branch dispatch of evals-periodic runs the periodic lane only unless it opts into the gate census', () => {
    const wf = parse(periodicYml);
    expect(wf.on.workflow_dispatch!.inputs!.include_gate_census).toMatchObject({ type: 'boolean', default: false });
    // The planner selects the census arms (crew/scripts/census-arms.ts); no arm, no census job.
    expect(wf.jobs['gate-census']!.if).toBe("${{ needs.plan-slices.outputs.gate_matrix != '[]' }}");
    const select = wf.jobs['plan-slices']!.steps.find(step => step.id === 'census')!;
    expect(select.env?.INCLUDE_GATE_CENSUS).toBe("${{ github.ref == 'refs/heads/main' || inputs.include_gate_census }}");
    expect(select.run).toBe('bun --no-install run crew/scripts/census-arms.ts --select >> "$GITHUB_OUTPUT"');
    expect(selectCensus({ schedule: '', censusArms: '', includeGateCensus: false })).toEqual({ arms: [], periodicLane: true });
    expect(selectCensus({ schedule: WEEKLY_CENSUS_SCHEDULE, includeGateCensus: true })).toEqual({ arms: [...WEEKLY_CENSUS_ARMS], periodicLane: true });
    const report = wf.jobs.report!.steps;
    const reconcile = report.find(step => step.name === 'Reconcile gate census against the manifest (fail-closed)')!;
    expect(reconcile.env?.GATE_CENSUS).toBe('${{ needs.gate-census.result }}');
    expect(reconcile.run).toContain('if [ "$GATE_CENSUS" = "skipped" ]');
    // A skipped census is not a red lane; a failed or cancelled one still is.
    const fail = report.find(step => step.name === 'Fail the workflow when reconciliation failed') as Step & { if?: string };
    expect(fail.if).toContain(`!contains(fromJSON('["success","skipped"]'), needs.gate-census.result)`);
  });
});

describe('evals-periodic.yml census arms: Monday two-arm census, monthly Fable/Astra census', () => {
  type CensusStep = Step & { if?: string };
  type CensusWf = { on: { schedule: Array<{ cron: string }>; workflow_dispatch: { inputs: Record<string, { type?: string; default?: unknown }> } };
    concurrency: { group: string }; jobs: Record<string, { if?: string; outputs?: Record<string, string>; steps: CensusStep[] }> };
  const wf = Bun.YAML.parse(periodicYml) as CensusWf;
  const planner = wf.jobs['plan-slices']!;
  const census = wf.jobs['gate-census']!;
  const report = wf.jobs.report!;

  test('each arm is one host and model: the capture default and gpt-6.1-sol weekly, claude-fable-5-1 and gpt-6-astra monthly', () => {
    expect(WEEKLY_CENSUS_ARMS).toEqual(['claude-opus', 'codex-sol']);
    expect(MONTHLY_CENSUS_ARMS).toEqual(['claude-fable', 'codex-astra']);
    // claude-opus pins no model: the Claude runners' capture default (lib/eval-model.ts) applies.
    expect(censusArmEnv('claude-opus')).toEqual({ EVALS_HOST: 'claude' });
    expect(censusArmEnv('codex-sol')).toEqual({ EVALS_HOST: 'codex', GSTACK_CODEX_MODEL: 'gpt-6.1-sol' });
    expect(censusArmEnv('claude-fable')).toEqual({ EVALS_HOST: 'claude', EVALS_MODEL: 'claude-fable-5-1' });
    expect(censusArmEnv('codex-astra')).toEqual({ EVALS_HOST: 'codex', GSTACK_CODEX_MODEL: 'gpt-6-astra' });
    expect(() => censusArmEnv('codex-luna')).toThrow('unknown census arm');
    // The report files slice artifacts by arm suffix: no arm id may end another one.
    const ids = Object.keys(CENSUS_ARMS);
    for (const a of ids) for (const b of ids) if (a !== b) expect(a.endsWith(`-${b}`)).toBe(false);
    for (const id of ids) expect(id).toMatch(/^[a-z]+-[a-z]+$/);
  });

  test('the monthly cron runs only the census, under its own concurrency group; the Monday and daily canary schedules are unchanged', () => {
    expect(wf.on.schedule.map(entry => entry.cron)).toEqual([WEEKLY_CENSUS_SCHEDULE, '30 7 * * *', MONTHLY_CENSUS_SCHEDULE]);
    expect(MONTHLY_CENSUS_SCHEDULE).toBe('0 6 1 * *');
    expect(wf.concurrency.group.endsWith("${{ github.event.schedule == '0 6 1 * *' && '-monthly' || '' }}")).toBe(true);
    expect(wf.concurrency.group).toContain("(github.event.schedule == '30 7 * * *' || inputs.schema_canary_only) && '-schema-canary'");
    expect(selectCensus({ schedule: MONTHLY_CENSUS_SCHEDULE, includeGateCensus: true })).toEqual({ arms: [...MONTHLY_CENSUS_ARMS], periodicLane: false });
    const select = planner.steps.find(step => step.id === 'census')!;
    expect(select.env).toMatchObject({ SCHEDULE: '${{ github.event.schedule }}', CENSUS_ARMS: '${{ inputs.census_arms }}' });
    expect(planner.outputs).toMatchObject({ periodic_lane: '${{ steps.census.outputs.periodic_lane }}', census_arms: '${{ steps.census.outputs.arms }}' });
    // Without the periodic lane no periodic plan is emitted, executed or reconciled.
    for (const step of planner.steps.filter(step => step.run?.includes('/tmp/paid-plan/manifest.json') || step.with?.name === 'paid-plan')) {
      expect(step.if, step.name ?? step.with?.name).toBe("steps.census.outputs.periodic_lane == 'true'");
    }
    const reconcile = report.steps.find(step => step.id === 'reconcile')!;
    expect(reconcile.env?.PERIODIC_LANE).toBe('${{ needs.plan-slices.outputs.periodic_lane }}');
    expect(reconcile.run).toContain('if [ "$PERIODIC_LANE" != "true" ]; then');
    // A census-only green run never closes the weekly tracking issue.
    expect(report.steps.find(step => step.name === 'Close the tracking issue on a green run')!.if)
      .toContain("needs.plan-slices.outputs.periodic_lane == 'true' && needs.eval-slices.result == 'success'");
  });

  test('a census_arms dispatch runs only the named arms and refuses unknown ones', () => {
    expect(wf.on.workflow_dispatch.inputs.census_arms).toMatchObject({ type: 'string', default: '' });
    expect(selectCensus({ censusArms: 'codex-sol', includeGateCensus: true })).toEqual({ arms: ['codex-sol'], periodicLane: false });
    expect(selectCensus({ censusArms: 'claude-opus, codex-sol,codex-sol', includeGateCensus: false })).toEqual({ arms: ['claude-opus', 'codex-sol'], periodicLane: false });
    expect(() => selectCensus({ censusArms: 'codex-sol,gpt', includeGateCensus: false })).toThrow('unknown census arm(s): gpt');
    const cli = (args: string[], env: Record<string, string>) => {
      const proc = spawnSync(process.execPath, ['--no-install', 'run', 'crew/scripts/census-arms.ts', ...args],
        { cwd: ROOT, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 15_000 });
      expect(proc.status, proc.stderr).toBe(0);
      return proc.stdout;
    };
    expect(cli(['--select'], { SCHEDULE: MONTHLY_CENSUS_SCHEDULE })).toBe('arms=["claude-fable","codex-astra"]\nperiodic_lane=false\n');
    expect(cli(['--select'], { CENSUS_ARMS: 'codex-sol', INCLUDE_GATE_CENSUS: 'true' })).toBe('arms=["codex-sol"]\nperiodic_lane=false\n');
    expect(cli(['--env', 'codex-sol'], {})).toBe('EVALS_HOST=codex\nGSTACK_CODEX_MODEL=gpt-6.1-sol\n');
  });

  test('census artifacts and reconciliation are per arm', () => {
    const upload = census.steps.find(step => step.name === 'Upload census results')!;
    expect(upload.with!.name).toBe('gate-census-${{ matrix.slice }}-a${{ github.run_attempt }}-${{ matrix.arm }}');
    expect(census.steps.find(step => step.name?.startsWith('Run gate census slice'))!.name).toContain('(${{ matrix.arm }})');
    expect(report.steps.some(step => step.with?.pattern === 'gate-census-[0-9]*' && step.with?.path === '/tmp/gate-census-slices')).toBe(true);
    const reconcile = report.steps.find(step => step.id === 'gate-reconcile')!;
    expect(reconcile.env?.ARMS).toBe('${{ needs.plan-slices.outputs.census_arms }}');
    expect(reconcile.run).toContain('cp "/tmp/gate-census-plan/$arm/manifest.json" "$dir/manifest.json" || status=1');
    expect(reconcile.run).toContain('for slice in /tmp/gate-census-slices/gate-census-*-"$arm"; do');
    expect(reconcile.run).toContain('EVALS_TIER=gate bun run scripts/test-paid-shards.ts --tier gate --report "$dir"');
    // Every arm's report counts: one red arm fails the census.
    expect(reconcile.run).toContain('if [ "$code" -ne 0 ]; then status=$code; fi');
    expect(reconcile.run).toContain('echo "exit=$status" >> "$GITHUB_OUTPUT"');
  });
});
