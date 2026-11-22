/**
 * gstack-review-dispatch pass stops with a REVIEW_PLAN_STOPPED line when gstack-review-plan runs past its limit (GST-1442):
 * on harness-evals #279 the plan took about 214 s against the pass's 180 s, and the pass was killed with no output at all.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { runScriptSync } from '../lib/script-invocation';
import { REVIEW_EXCLUDE_KEY_VERSION } from '../lib/ship-policy';
import { cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const DISPATCH = path.join(import.meta.dir, '..', 'bin', 'gstack-review-dispatch');
const dirs: string[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
  while (repos.length) cleanup(repos.pop()!);
});

describe('pass names the plan step and its limit when the plan does not finish (GST-1442)', () => {
  // Value: protects=a plan past the pass's limit ends in a line naming the step, the reason and the limit, with no manifest;
  //   fails_when=the pass treats the killed plan like any failed plan and exits 1 with empty output (the #279 silent kill);
  //   why_new=GST-1442; seam=gstack-review-dispatch pass with GSTACK_REVIEW_PLAN_TIMEOUT_MS=1; no_claim=the 180 s default
  test('a plan that runs past the limit prints REVIEW_PLAN_STOPPED with reason=timeout and writes no manifest', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rd-plan-timeout-')));
    dirs.push(root);
    const work = path.join(root, 'work');
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(root, 'state'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') };
    fs.writeFileSync(path.join(root, 'gitconfig'), '[commit]\n\tgpgsign = false\n');
    const sh = (cwd: string, c: string) => { const r = spawnSync('bash', ['-c', c], { cwd, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(`${c}: ${r.stderr}`); };
    sh(root, 'git init -q --bare -b main origin.git && git clone -q origin.git work 2>/dev/null');
    sh(work, "mkdir src && echo 'export const a = 1;' > src/a.ts && git add -A && git commit -qm base && git push -q origin main && git checkout -qb feat && echo 'export const b = 2;' >> src/a.ts && git commit -qam feat");
    const out = path.join(root, 'run');
    const r = spawnSync(DISPATCH, ['pass', '--base', 'main', '--out', out, '--pass', 'timeout-p1'], { cwd: work, env: { ...env, GSTACK_REVIEW_PLAN_TIMEOUT_MS: '1' }, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('gstack-review-dispatch pass: gstack-review-plan did not finish inside its limit');
    expect(r.stderr).toContain('step="gstack-review-plan --base main" reason=timeout timeout_ms=1 signal=SIGTERM');
    expect(r.stderr.trimEnd().endsWith('(REVIEW_PLAN_STOPPED)')).toBe(true);
    expect(r.stdout).not.toContain('MANIFEST:');
    expect(fs.existsSync(path.join(out, 'pass-manifest.json'))).toBe(false);
  }, 180_000);
});

describe('gstack-review-plan run by itself stops at its own limit (GST-1855)', () => {
  // Value: protects=a plan /ship runs directly ends at the limit in a named line with no plan, instead of holding the run for
  //   25 to 58 minutes as harness-evals #320's did; fails_when=a standalone plan ignores GSTACK_REVIEW_PLAN_TIMEOUT_MS again;
  //   seam=gstack-review-plan with GSTACK_REVIEW_PLAN_TIMEOUT_MS=1; no_claim=the 180 s default
  test('a plan past the limit prints REVIEW_PLAN_STOPPED with reason=timeout and no plan lines', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rp-plan-timeout-')));
    dirs.push(root);
    const work = path.join(root, 'work');
    const env = { ...process.env, GSTACK_STATE_ROOT: path.join(root, 'state'), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: path.join(root, 'gitconfig') };
    fs.writeFileSync(path.join(root, 'gitconfig'), '[commit]\n\tgpgsign = false\n');
    const sh = (cwd: string, c: string) => { const r = spawnSync('bash', ['-c', c], { cwd, env, encoding: 'utf8', timeout: 60_000 }); if (r.status !== 0) throw new Error(`${c}: ${r.stderr}`); };
    sh(root, 'git init -q --bare -b main origin.git && git clone -q origin.git work 2>/dev/null');
    sh(work, "mkdir src && echo 'export const a = 1;' > src/a.ts && git add -A && git commit -qm base && git push -q origin main && git checkout -qb feat && echo 'export const b = 2;' >> src/a.ts && git commit -qam feat");
    const PLAN = path.join(import.meta.dir, '..', 'bin', 'gstack-review-plan');
    const r = spawnSync(PLAN, ['--base', 'main'], { cwd: work, env: { ...env, GSTACK_REVIEW_PLAN_TIMEOUT_MS: '1' }, encoding: 'utf8', timeout: 120_000 });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stderr).toContain('step="gstack-review-plan --base main" reason=timeout timeout_ms=1 signal=SIGTERM');
    expect(r.stderr.trimEnd().endsWith('(REVIEW_PLAN_STOPPED)')).toBe(true);
    expect(r.stdout).not.toContain('REVIEW_PLAN:');
    const ok = spawnSync(PLAN, ['--base', 'main'], { cwd: work, env, encoding: 'utf8', timeout: 120_000 });
    expect(ok.status, ok.stderr).toBe(0);
    expect(ok.stdout).toContain('REVIEW_PLAN:');
  }, 180_000);
});

describe('render reads the plan limit from GSTACK_REVIEW_PLAN_TIMEOUT_MS too (GST-3398)', () => {
  // Value: protects=a standalone render on a base whose policy excludes paths runs gstack-review-plan under the limit the pass
  //   and the plan read, so a large repository that raises GSTACK_REVIEW_PLAN_TIMEOUT_MS is not cut off at 180 s by render;
  //   fails_when=render runs the plan under a hard-coded 180 s again (harness-evals #548 stopped twice at timeout_ms=180000);
  //   why_new=GST-3398; seam=gstack-review-dispatch render with the variable set, unset, empty and invalid; no_claim=the plan's speed
  test('a plan past the variable\'s limit stops render with REVIEW_PLAN_STOPPED; unset or invalid values keep the default', () => {
    const policy = JSON.stringify({ review_exclude_paths: ['docs/results/**'], min_gstack_version: REVIEW_EXCLUDE_KEY_VERSION }) + '\n';
    const repo = makeFixtureRepo({ prefix: 'rd-render-timeout-', baseFiles: { '.gstack/ship-policy.json': policy } });
    repos.push(repo);
    commit(repo, { 'lib/a.ts': 'export const a = 1;\n', 'docs/results/r.json': '{}\n' });
    const mb = repo.git('merge-base', 'origin/main', 'HEAD');
    const render = (out: string, value?: string) => {
      const env: Record<string, string | undefined> = { ...process.env, ...repo.env };
      if (value === undefined) delete env.GSTACK_REVIEW_PLAN_TIMEOUT_MS; else env.GSTACK_REVIEW_PLAN_TIMEOUT_MS = value;
      const dir = path.join(repo.root, out);
      const r = runScriptSync(DISPATCH, ['render', '--role', 'outside-voice', '--out', dir, '--base', 'main', '--diff-base', mb], { cwd: repo.work, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
      return { status: r.status, err: r.stderr ?? '', diff: path.join(dir, 'outside-voice.diff') };
    };
    const stopped = render('o-stopped', '1');
    expect(stopped.status, stopped.err).toBe(EXIT.fail);
    expect(stopped.err).toContain('gstack-review-dispatch render: gstack-review-plan did not finish inside its limit');
    expect(stopped.err).toContain('step="gstack-review-plan --base main --json" reason=timeout timeout_ms=1 signal=SIGTERM');
    expect(stopped.err).toContain('(REVIEW_PLAN_STOPPED)');
    expect(fs.existsSync(stopped.diff)).toBe(false);
    for (const [out, value] of [['o-unset', undefined], ['o-empty', ''], ['o-word', 'soon'], ['o-zero', '0'], ['o-negative', '-5']] as const) {
      const r = render(out, value);
      expect(r.status, `${value}: ${r.err}`).toBe(EXIT.ok);
      expect(r.err).not.toContain('REVIEW_PLAN_STOPPED');
      expect(fs.readFileSync(r.diff, 'utf8')).toContain('diff --git a/lib/a.ts');
    }
  }, 180_000);
});
