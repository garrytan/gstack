/**
 * The release gate's workflow wiring (docs/ship-policy.md#release-gate):
 * release-gate.yml runs bin/gstack-release-gate on its schedule and publishes
 * the gated commit's check run from a code-free job; the per-push backstop
 * stands down once main's policy declares a release_gate block; evals.yml routes
 * a release bisect only under that block. Policy steps run for real (bash, git,
 * jq) against a scratch repository; the rest is read from the YAML.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { RELEASE_GATE_SCHEDULE_HOURS } from '../lib/release-gate-policy';
import { RELEASE_BISECT_ARTIFACT } from '../scripts/train-gate';

const ROOT = path.resolve(import.meta.dir, '..');
type Step = { id?: string; name?: string; uses?: string; if?: string; run?: string; env?: Record<string, string> };
type Job = { if?: string; needs?: string; outputs?: Record<string, string>; permissions?: Record<string, string>; steps: Step[] };
type Workflow = { on: Record<string, any>; concurrency: unknown; permissions?: unknown; jobs: Record<string, Job> };
const load = (rel: string) => Bun.YAML.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as Workflow;
const release = load('.github/workflows/release-gate.yml');
const backstop = load('.github/workflows/evals-main-backstop.yml');
const evals = load('.github/workflows/evals.yml');
const scratch: string[] = [];
afterAll(() => { for (const d of scratch) fs.rmSync(d, { recursive: true, force: true }); });
const GIT_ENV = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };

/**
 * Run a policy step's script in a scratch repo whose one commit holds this policy; returns its GITHUB_OUTPUT lines as an object.
 * Git Bash's argument conversion is off, as on the Linux runners these steps run on: it rewrites `origin/main:.gstack/…` into a path list.
 */
function runStep(step: Step, policy: unknown): Record<string, string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-wf-'));
  scratch.push(dir);
  const g = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...GIT_ENV } }).trim();
  g('init', '-q', '-b', 'main');
  if (policy !== undefined) {
    fs.mkdirSync(path.join(dir, '.gstack'));
    fs.writeFileSync(path.join(dir, '.gstack/ship-policy.json'), JSON.stringify(policy));
  }
  fs.writeFileSync(path.join(dir, 'README'), 'x');
  g('add', '-A');
  g('commit', '-q', '-m', 'base');
  const sha = g('rev-parse', 'HEAD');
  g('update-ref', 'refs/remotes/origin/main', sha);
  const out = path.join(dir, 'out');
  const r = spawnSync('bash', ['-e', '-c', step.run!], {
    cwd: dir, encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*', GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), GITHUB_SHA: sha, BASE_SHA: '', DEFAULT_BRANCH: 'main' },
  });
  expect(r.status, r.stderr).toBe(0);
  const lines = (fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '').split('\n').filter(Boolean);
  return Object.fromEntries(lines.map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
}
const GATE = { cadence_hours: 8, gate_workflow: 'evals.yml', branch: 'main', stable_ref: 'stable', check_name: 'main-backstop', on_red: 'hold-release', bisect_spend_cap_usd: 40 };
const TRAIN = { gate_workflow: 'evals.yml', record_artifact: 'gstack-train-record', full_gate_check: 'gstack/full-gate' };

describe('release-gate.yml', () => {
  // Value: protects=the schedule fires every RELEASE_GATE_SCHEDULE_HOURS (the cadence floor the policy validates), one gate at a time, only from the
  // default branch, with contents and actions write but no checks write, and runs the bin without --sha (main's head from the remote, so an open gate on an older commit
  // is finished first) with its outputs wired, and a held or failed verdict on a gated commit leaves the job green (so main's head never carries a
  // failed native check release-cut would read as red; the exit is exercised below); the policy step
  // uses git and jq only and is inert without a release_gate block; fails_when=the cron and the cadence drift apart, two gates overlap, the job that
  // runs repository code can write check runs, or an inert policy reaches bun; why_new=new workflow; seam=none; no_claim=GitHub's cron jitter
  test('schedule, concurrency, permissions and the gate step', () => {
    const cron = release.on.schedule[0].cron as string;
    expect(cron).toMatch(/^\d+ \*\/\d+ \* \* \*$/);
    expect(Number(cron.split(' ')[1]!.slice(2))).toBe(RELEASE_GATE_SCHEDULE_HOURS);
    expect(Object.keys(release.on).sort()).toEqual(['schedule', 'workflow_dispatch']);
    expect(Object.keys(release.on.workflow_dispatch.inputs).sort()).toEqual(['dry_run', 'ignore_cadence']);
    expect(release.concurrency).toEqual({ group: 'release-gate', 'cancel-in-progress': false });
    expect(release.permissions).toEqual({});
    const job = release.jobs['release-gate']!;
    expect(job.if).toBe('github.ref_name == github.event.repository.default_branch');
    expect(job.permissions).toEqual({ contents: 'write', actions: 'write', checks: 'read' });
    const policy = job.steps.find(s => s.id === 'policy')!;
    expect(policy.run).not.toContain('bun');
    expect(runStep(policy, undefined)).toEqual({ release: 'false' });
    expect(runStep(policy, { train: TRAIN })).toEqual({ release: 'false' });
    expect(runStep(policy, { release_gate: GATE })).toEqual({ release: 'true' });
    const gate = job.steps.find(s => s.id === 'gate')!;
    expect(gate.if).toBe("steps.policy.outputs.release == 'true'");
    expect(gate.run).toContain('./bin/gstack-release-gate run --repo "$GITHUB_REPOSITORY" --budget-minutes');
    expect(gate.run).not.toContain('--sha');
    expect(gate.run).toContain("|| rc=$?");
    expect(gate.run).toContain(`if [ "$rc" != 0 ] && ! { grep -qE '^action=(held|failed)$' "$GITHUB_OUTPUT" && grep -qE '^sha=[0-9a-f]{40}$' "$GITHUB_OUTPUT"; }; then exit "$rc"; fi`);
    expect(gate.run).toContain('--outputs "$GITHUB_OUTPUT"');
    expect(job.outputs).toEqual({ action: '${{ steps.gate.outputs.action }}', sha: '${{ steps.gate.outputs.sha }}', check: '${{ steps.gate.outputs.check }}' });
  });

  // Value: protects=the gate step's exit: a held or failed verdict on a gated commit leaves the job green (release-check publishes its check run), but a
  // failed verdict with no commit (a refused policy, unreadable notes, an unresolved branch) or no recorded action fails the job, since no check run
  // follows it; fails_when=a sha-less failure leaves the job green while the backstop stands down (GST-1263); why_new=reader note on #3917;
  // seam=a stub bin in place of bin/gstack-release-gate; no_claim=a live scheduled run
  test('the gate step fails the job when the bin fails without a gated commit', () => {
    const gate = release.jobs['release-gate']!.steps.find(s => s.id === 'gate')!;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-step-'));
    scratch.push(dir);
    const sha = 'a'.repeat(40);
    const exit = (written: string, code: number) => {
      const stub = path.join(dir, 'stub');
      fs.writeFileSync(stub, `#!/usr/bin/env bash\nprintf '%s' '${written}' >> "$GITHUB_OUTPUT"\nexit ${code}\n`, { mode: 0o755 });
      const out = path.join(dir, 'out');
      fs.writeFileSync(out, '');
      const r = spawnSync('bash', ['-e', '-c', gate.run!.replace('./bin/gstack-release-gate', stub)], {
        cwd: dir, encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), GITHUB_REPOSITORY: 'o/r', DRY_RUN: '', IGNORE_CADENCE: '' },
      });
      return r.status;
    };
    expect(exit(`action=gated\nsha=${sha}\ncheck=main-backstop\n`, 0)).toBe(0);
    expect(exit(`action=held\nsha=${sha}\ncheck=main-backstop\n`, 1)).toBe(0);
    expect(exit(`action=failed\nsha=${sha}\ncheck=main-backstop\n`, 1)).toBe(0);
    expect(exit('action=failed\nsha=\ncheck=\n', 1)).toBe(1);
    expect(exit('', 1)).toBe(1);
  });

  // Value: protects=the gated commit's check run (what release-cut reads) comes from a job with checks: write and no checkout or action, only for a
  // gate that ran (success for gated, failure for held, neutral for failed so a later green on the same sha stays releasable), on a validated sha
  // and check name; fails_when=repository code runs with checks: write, a skipped or inert run publishes a check, a red gate publishes success, or
  // an unfinished gate leaves a failure release-cut reads as red; why_new=new workflow; seam=none; no_claim=GitHub's check API
  test('the check run is published from a code-free job, success only for gated', () => {
    const job = release.jobs['release-check']!;
    expect(job.needs).toBe('release-gate');
    expect(job.if).toContain("contains(fromJSON('[\"gated\",\"held\",\"failed\"]'), needs.release-gate.outputs.action)");
    expect(job.permissions).toEqual({ checks: 'write' });
    expect(job.steps.filter(s => s.uses)).toEqual([]);
    const run = job.steps[0]!.run!;
    expect(run).toContain('gated) conclusion=success ;;');
    expect(run).toContain('held) conclusion=failure ;;');
    expect(run).toContain('failed) conclusion=neutral ;;');
    expect(run).toContain('[[ "$SHA" =~ ^[0-9a-f]{40}$ ]]');
    expect(run).toContain('-f name="$CHECK" -f head_sha="$SHA"');
    expect(run).not.toContain('bun');
  });
});

describe('the backstop stands down and evals.yml routes the release bisect', () => {
  // Value: protects=while trains exist the per-push backstop keeps gating, and once main declares release_gate it stands down (train=false: no gate,
  // no freeze, no check run), so main is never gated twice; fails_when=both gates run on main, or the backstop stops before the release gate is on;
  // why_new=new stand-down rule; seam=none; no_claim=a live push
  test('evals-main-backstop.yml: train=true with only a train block, train=false once release_gate is declared', () => {
    const policy = backstop.jobs.backstop!.steps.find(s => s.id === 'policy')!;
    expect(runStep(policy, { train: TRAIN })).toEqual({ train: 'true' });
    expect(runStep(policy, { train: TRAIN, release_gate: GATE })).toEqual({ train: 'false' });
  });

  // Value: protects=the route job reads release_gate from the base revision with git and jq only and hands it to the route as RELEASE_POLICY, and the
  // bisect jobs name their artifact from the route's record_artifact first (gstack-release-record for a release bisect); fails_when=a release bisect
  // publishes under the train artifact name the gate never reads, or repository code decides the release policy; why_new=new route input;
  // seam=none; no_claim=a live bisect run
  test('evals.yml: the release policy step, the RELEASE_POLICY input and the record_artifact override', () => {
    const route = evals.jobs.route!;
    const step = route.steps.find(s => s.id === 'release_policy')!;
    expect(step.run).not.toContain('bun');
    expect(runStep(step, { release_gate: GATE })).toEqual({ release: 'true' });
    expect(runStep(step, { train: TRAIN })).toEqual({ release: 'false' });
    expect(runStep(step, undefined)).toEqual({ release: 'false' });
    const ids = route.steps.map(s => s.id);
    expect(ids.indexOf('release_policy')).toBeLessThan(ids.indexOf('route'));
    expect(route.steps.find(s => s.id === 'route')!.env!.RELEASE_POLICY).toBe('${{ steps.release_policy.outputs.release }}');
    expect(route.outputs!.record_artifact).toBe('${{ steps.route.outputs.record_artifact || steps.policy.outputs.record_artifact }}');
    expect(RELEASE_BISECT_ARTIFACT).toBe('gstack-release-record');
  });
});
