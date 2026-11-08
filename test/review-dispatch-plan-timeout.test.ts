/**
 * gstack-review-dispatch pass stops with a REVIEW_PLAN_STOPPED line when gstack-review-plan runs past its limit (GST-1442):
 * on harness-evals #279 the plan took about 214 s against the pass's 180 s, and the pass was killed with no output at all.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DISPATCH = path.join(import.meta.dir, '..', 'bin', 'gstack-review-dispatch');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

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
    expect(r.stderr).toContain('gstack-review-dispatch pass: gstack-review-plan did not finish inside the pass');
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
