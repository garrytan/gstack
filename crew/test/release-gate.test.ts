/**
 * gstack-release-gate (crew/lib/release-gate.ts, docs/ship-policy.md#release-gate):
 * the full paid gate on main's head at most once per cadence and only when main
 * moved, a release record in refs/notes/gstack-trains, a bisect of a red gate's
 * cases over the commits since the last green gate, and the hold release-cut
 * reads. GitHub is a fake gh (dispatch, run list, run view, artifact download);
 * git, the notes ref and origin are real (a bare origin on disk).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../../lib/bun-isolation';
import {
  MAX_RELEASE_ATTEMPTS, OPEN_GATE_CADENCES, RELEASE_TRIAL_RESERVATION_USD, activeHold, bisectGate, classifyRun, gateStatus, loadReleaseGate, narrow, parseReport, planPrefixes, releaseRecords, runGate,
  type GateEnv, type Run,
} from '../lib/release-gate';
import { RELEASE_GATE_SCHEDULE_HOURS, releaseGateErrors, type ReleaseGatePolicy } from '../../lib/release-gate-policy';
import { RELEASE_GATE_KEY_VERSION, validatePolicy } from '../../lib/ship-policy';
import { NOTES_REF, repoIdentity, type PrefixResult, type ReleaseRecord } from '../lib/ship-queue-train-record';
import { gitIn } from '../scripts/train-gate';

const ROOT = path.resolve(import.meta.dir, '..', '..');
const GATE: ReleaseGatePolicy = { cadence_hours: 8, gate_workflow: 'evals.yml', branch: 'main', stable_ref: 'stable', check_name: 'main-backstop', on_red: 'hold-release', bisect_spend_cap_usd: 40 };
const roots: string[] = [];
const savedStateRoot = process.env.GSTACK_STATE_ROOT;
afterEach(() => { if (savedStateRoot === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = savedStateRoot; });
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const ID = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, ...ID } }).trim();

/** origin with base (also stable) and c1..c5 on main, and work cloned from it; the state root is the fixture's own. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-'));
  roots.push(root);
  const origin = path.join(root, 'origin.git');
  const seed = path.join(root, 'seed');
  const work = path.join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'remote', 'add', 'origin', origin);
  const commit = (name: string) => { fs.writeFileSync(path.join(seed, 'VERSION'), name + '\n'); git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', name); git(seed, 'push', '-q', 'origin', 'main'); return git(seed, 'rev-parse', 'HEAD'); };
  const base = commit('base');
  git(seed, 'push', '-q', 'origin', 'main:stable');
  const c = [1, 2, 3, 4, 5].map(i => commit('c' + i));
  git(root, 'clone', '-q', origin, work);
  process.env.GSTACK_STATE_ROOT = path.join(root, 'state');
  return { root, origin, seed, work, base, c, commit };
}

interface Outcome { conclusion: string; artifacts: Record<string, Record<string, string>>; status?: string }
/** A fake gh: each dispatch becomes a completed run whose outcome the test decides; run list, run view and artifact download read it back. */
function fakeGh(onDispatch: (inputs: Record<string, string>, ref: string) => Outcome) {
  const runs: Run[] = [];
  const artifacts = new Map<number, Record<string, Record<string, string>>>();
  const dispatches: Array<{ ref: string; inputs: Record<string, string> }> = [];
  const gh = (args: string[]) => {
    const ok = (out: unknown) => ({ status: 0, stdout: typeof out === 'string' ? out : JSON.stringify(out), stderr: '' });
    if (args[0] === 'workflow' && args[1] === 'run') {
      const ref = args[args.indexOf('--ref') + 1]!;
      const inputs = Object.fromEntries(args.flatMap((a, i) => (args[i - 1] === '-f' ? [a.split(/=(.*)/s).slice(0, 2)] : [])));
      dispatches.push({ ref, inputs });
      const id = 1000 + runs.length;
      const o = onDispatch(inputs, ref);
      runs.push({ id, status: o.status ?? 'completed', conclusion: o.conclusion, head_sha: inputs.expected_sha!, display_title: 'E2E Evals [eval-bg ' + inputs.nonce + ']', html_url: 'https://github.com/o/r/actions/runs/' + id, run_attempt: 1 });
      artifacts.set(id, o.artifacts);
      return ok('');
    }
    if (args[0] === 'api' && args.some(a => /\/actions\/workflows\/[^/]+\/runs$/.test(a))) return ok({ workflow_runs: [...runs].reverse() });
    const view = args[0] === 'api' ? /actions\/runs\/(\d+)$/.exec(args[1] ?? '') : null;
    if (view) return ok(runs.find(r => r.id === Number(view[1])));
    if (args[0] === 'run' && args[1] === 'download') {
      const files = artifacts.get(Number(args[2]))?.[args[args.indexOf('-n') + 1]!];
      if (!files) return { status: 1, stdout: '', stderr: 'no artifact matches any of the names or patterns provided' };
      const dir = args[args.indexOf('-D') + 1]!;
      for (const [name, text] of Object.entries(files)) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, name), text); }
      return ok('');
    }
    return { status: 1, stdout: '', stderr: 'unexpected gh ' + args.join(' ') };
  };
  return { gh, runs, dispatches };
}

const report = (verdict: 'GREEN' | 'RED', failed: string[] = [], cost = '37.40') => ({ 'report-verdict-a1': { 'report.txt': [
  '[test:paid] report: 17/17 slices, 85 planned shards, tier=gate, attempt 1',
  ...(failed.length ? ['FAILED cases:', ...failed.map(l => '  ✗ ' + l)] : []),
  '[test:paid] VERDICT ' + verdict + ' — lane gate/full census, attempt 1',
  '  wall 41m02s · cost $' + cost + ' known + 4 of 139 trial(s) cost unknown',
].join('\n') } });
const green = (flaky: string[] = []): Outcome => ({ conclusion: 'success', artifacts: { ...report('GREEN'), ...(flaky.length ? { 'flake-records-a1': { 'flake-records.jsonl': flaky.map(c => JSON.stringify({ schema: 1, kind: 'gate-flake', case: c })).join('\n') } } : {}) } });

function envFor(f: ReturnType<typeof fixture>, gh: (args: string[]) => { status: number; stdout: string; stderr: string }, shiftHours = 0): GateEnv {
  return { repo: 'o/r', repoRoot: f.work, remote: 'origin', gh, git: gitIn(f.work), now: () => Date.now() + shiftHours * 3_600_000, sleep: () => {}, random: () => 'abc123', pollMs: 1, deadline: Date.now() + 3_600_000 };
}
const records = (f: ReturnType<typeof fixture>) => {
  git(f.work, 'fetch', '-q', 'origin', '+' + NOTES_REF + ':' + NOTES_REF);
  return releaseRecords(gitIn(f.work), repoIdentity(f.work).key);
};

describe('release gate: run', () => {
  // Value: protects=a gate only when main moved: the first run dispatches the full gate once on main's head (evals_all, expected_sha, a backstop nonce),
  // records GREEN with its run, cost and rule-16 flaky cases in origin's notes and prints the RELEASE green line without moving stable; a second run on
  // the same head, and a head equal to stable, skip without dispatching; fails_when=the gate dispatches again on an unchanged main (a $37 repeat), a
  // green gate moves stable, or the record never reaches origin; why_new=new module; seam=fake gh; no_claim=a live gate run (the PR's one live proof)
  test('green: one dispatch on the moved head, a GREEN release record on origin, stable untouched; an unchanged main skips', () => {
    const f = fixture();
    const fake = fakeGh(() => green(['judge-x']));
    const head = f.c[4]!;
    const out = runGate(envFor(f, fake.gh), { gate: GATE, label: 'test', dryRun: false, ignoreCadence: false });
    expect(out.action, out.lines.join('\n')).toBe('gated');
    expect(fake.dispatches).toHaveLength(1);
    expect(fake.dispatches[0]!.ref).toBe('main');
    expect(fake.dispatches[0]!.inputs).toMatchObject({ evals_all: 'true', expected_sha: head });
    expect(fake.dispatches[0]!.inputs.nonce).toMatch(/^gate\.backstop-/);
    expect(out.lines).toContain('RELEASE: green sha=' + head + ' stable=' + f.base + ' run=1000 cost=37.40');
    expect(out.lines.some(l => l.includes('flaky (failed once, passed its one rule-16 rerun in run 1000): judge-x'))).toBe(true);
    const [rec] = records(f);
    expect(rec).toMatchObject({ kind: 'release', sha: head, verdict: 'GREEN', flaky: ['judge-x'], cost_usd: 37.4, since: f.base, attempts: 1, run: { id: 1000 } });
    expect(git(f.seed, 'ls-remote', 'origin', 'refs/heads/stable').split('\t')[0]).toBe(f.base);

    const again = runGate(envFor(f, fake.gh, 9), { gate: GATE, label: 'test', dryRun: false, ignoreCadence: true });
    expect(again.action).toBe('skipped');
    expect(again.lines[0]).toContain('main has not moved since the last gate: GREEN run 1000');
    git(f.seed, 'push', '-q', '-f', 'origin', 'main:stable');
    const atStable = runGate(envFor(f, fake.gh), { gate: GATE, label: 'test', dryRun: false, ignoreCadence: true });
    expect(atStable.lines[0]).toContain('main has not moved since stable');
    expect(fake.dispatches).toHaveLength(1);
  });

  // Value: protects=without a release_gate block nothing runs; --dry-run names the head, the base and the pending count and writes and dispatches
  // nothing; the cadence holds a moved main until cadence_hours minus the grace pass, and --ignore-cadence gates now; fails_when=an inert policy spends,
  // a dry run writes a record, or the schedule gates more often than the policy says; why_new=new module; seam=fake gh and a shifted clock;
  // no_claim=GitHub's cron timing
  test('inert, dry run and cadence: nothing is spent until the policy and the clock allow it', () => {
    const f = fixture();
    const fake = fakeGh(() => green());
    expect(runGate(envFor(f, fake.gh), { gate: null, label: 'origin/main@x', dryRun: false, ignoreCadence: false }).action).toBe('inert');
    const dry = runGate(envFor(f, fake.gh), { gate: GATE, label: 'test', dryRun: true, ignoreCadence: false });
    expect(dry.action).toBe('dry-run');
    expect(dry.lines[0]).toBe('RELEASE: gate sha=' + f.c[4] + ' since=' + f.base.slice(0, 12) + ' (stable) pending=5 stable=' + f.base.slice(0, 12));
    expect(fake.dispatches).toHaveLength(0);
    expect(spawnSync('git', ['ls-remote', 'origin', NOTES_REF], { cwd: f.work, encoding: 'utf8', timeout: 30_000 }).stdout).toBe('');

    expect(runGate(envFor(f, fake.gh), { gate: GATE, label: 'test', dryRun: false, ignoreCadence: false }).action).toBe('gated');
    const next = f.commit('c6');
    const early = runGate(envFor(f, fake.gh, 2), { gate: GATE, label: 'test', dryRun: false, ignoreCadence: false });
    expect(early.action).toBe('skipped');
    expect(early.lines[0]).toMatch(/the last gate was dispatched 2\.0 h ago on [0-9a-f]{12}; cadence 8 h/);
    const due = runGate(envFor(f, fake.gh, 7.5), { gate: GATE, label: 'test', dryRun: false, ignoreCadence: false });
    expect(due.action, due.lines.join('\n')).toBe('gated');
    expect(fake.dispatches.map(d => d.inputs.expected_sha)).toEqual([f.c[4], next]);
    expect(records(f).find(r => r.sha === next)?.since).toBe(f.c[4]);
  });

  // Value: protects=an INCOMPLETE census (only INFRA reds) is recorded as such, re-dispatched once by the next run (EVAL_POLICY.infraRedispatch), then
  // skipped with its run named, and never treated as green or red; fails_when=an infra-only failure holds the release like a red, is retried without
  // end, or is never retried; why_new=new module; seam=fake gh; no_claim=a real runner loss
  test('incomplete: recorded, re-dispatched once, then skipped with the run named', () => {
    const f = fixture();
    const fake = fakeGh(() => ({ conclusion: 'failure', artifacts: report('RED', ['case-a  rule  FAIL  INFRA']) }));
    const env = envFor(f, fake.gh);
    const first = runGate(env, { gate: GATE, label: 'test', dryRun: false, ignoreCadence: true });
    expect(first.action).toBe('failed');
    expect(first.lines.at(-1)).toContain('RELEASE: incomplete sha=' + f.c[4] + ' run=1000');
    expect(first.lines.at(-1)).toContain('the next run re-dispatches it once');
    expect(runGate(env, { gate: GATE, label: 'test', dryRun: false, ignoreCadence: true }).action).toBe('failed');
    const third = runGate(env, { gate: GATE, label: 'test', dryRun: false, ignoreCadence: true });
    expect(third.action).toBe('skipped');
    expect(third.lines[0]).toContain('incomplete ' + MAX_RELEASE_ATTEMPTS + ' times');
    expect(fake.dispatches).toHaveLength(MAX_RELEASE_ATTEMPTS);
    expect(activeHold(records(f), () => true)).toBeNull();
  });

  // Value: protects=a successful gate run whose report-verdict artifact is missing records INCOMPLETE, prints no green line and publishes no gated
  // action, so a lost artifact never reads as a green main; fails_when=run success alone records GREEN (GST-1263); why_new=reader note on #3917;
  // seam=fake gh; no_claim=a real artifact upload failure
  test('a successful run with no report artifact is incomplete, never gated', () => {
    const f = fixture();
    const fake = fakeGh(() => ({ conclusion: 'success', artifacts: {} }));
    const out = runGate(envFor(f, fake.gh), { gate: GATE, label: 'test', dryRun: false, ignoreCadence: true });
    expect(out.action, out.lines.join('\n')).toBe('failed');
    expect(out.lines.some(l => l.startsWith('RELEASE: green'))).toBe(false);
    expect(records(f)[0]).toMatchObject({ sha: f.c[4], verdict: 'INCOMPLETE' });
  });

  // Value: protects=a gate run still going at the budget stays PENDING with its run, and the next run finishes that verdict on the old commit before
  // gating main's new head, so a red verdict still records RED and holds release-cut after main moved; the new head is gated on the run after;
  // fails_when=main moving orphans a PENDING record and its red verdict never becomes a hold; why_new=review finding (red-team, l1-p1); seam=fake gh;
  // no_claim=a real six-hour run
  test('an unfinished gate is finished on its own commit after main moves, then the new head is gated', () => {
    const f = fixture();
    let dispatched = 0;
    const fake = fakeGh(() => (dispatched++ === 0 ? { conclusion: 'failure', status: 'in_progress', artifacts: report('RED', ['case-a  rule  FAIL  VERDICT']) } : green()));
    const gate = { ...GATE, bisect_spend_cap_usd: 0 };
    const first = runGate({ ...envFor(f, fake.gh), deadline: 0 }, { gate, label: 'test', dryRun: false, ignoreCadence: true });
    expect(first.action).toBe('failed');
    expect(records(f)[0]).toMatchObject({ sha: f.c[4], verdict: 'PENDING', run: { id: 1000 } });
    const next = f.commit('c6');
    fake.runs[0]!.status = 'completed';
    const dry = runGate(envFor(f, fake.gh), { gate, label: 'test', dryRun: true, ignoreCadence: true });
    expect(dry.lines[0]).toContain('would finish the open gate on ' + f.c[4]!.slice(0, 12));
    const second = runGate(envFor(f, fake.gh), { gate, label: 'test', dryRun: false, ignoreCadence: true });
    expect(second.action, second.lines.join('\n')).toBe('held');
    expect(second.sha).toBe(f.c[4]);
    expect(second.lines[0]).toContain('finishing the open gate on ' + f.c[4]!.slice(0, 12));
    expect(fake.dispatches).toHaveLength(1);
    expect(activeHold(records(f), () => true)?.sha).toBe(f.c[4]);
    const third = runGate(envFor(f, fake.gh), { gate, label: 'test', dryRun: false, ignoreCadence: true });
    expect(third.action, third.lines.join('\n')).toBe('gated');
    expect(third.sha).toBe(next);
    expect(fake.dispatches).toHaveLength(2);
    expect(fake.dispatches[1]!.inputs.expected_sha).toBe(next);
  });

  // Value: protects=no paid dispatch follows a record that did not reach origin's notes (a fresh checkout reads only origin, so the next run would
  // dispatch the same $37 gate again); fails_when=a notes push failure repeats the full gate every cadence; why_new=review finding (targeted money,
  // l1-p2); seam=fake gh and a pre-receive hook on the bare origin; no_claim=a real ruleset
  test('a record that cannot reach origin dispatches nothing', () => {
    const f = fixture();
    const hook = path.join(f.origin, 'hooks', 'pre-receive');
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/notes/*) exit 1;; esac; done\nexit 0\n', { mode: 0o755 });
    const fake = fakeGh(() => green());
    const out = runGate(envFor(f, fake.gh), { gate: GATE, label: 'test', dryRun: false, ignoreCadence: true });
    expect(out.action).toBe('failed');
    expect(out.lines.at(-1)).toContain('nothing dispatched');
    expect(fake.dispatches).toHaveLength(0);
  });

  // Value: protects=an open gate is finished even after release-cut moved stable onto its commit, and an open gate older than OPEN_GATE_CADENCES
  // cadences stops holding up main's head; fails_when=an open record on stable's commit skips forever, or an unresolvable run blocks every later gate;
  // why_new=review findings (state-machines and red-team, l1-p2); seam=fake gh; no_claim=a real deleted run
  test('an open gate on the commit stable moved to is still finished; a stale open gate no longer blocks the head', () => {
    const f = fixture();
    let dispatched = 0;
    const fake = fakeGh(() => (dispatched++ === 0 ? { conclusion: 'success', status: 'in_progress', artifacts: report('GREEN') } : green()));
    expect(runGate({ ...envFor(f, fake.gh), deadline: 0 }, { gate: GATE, label: 'test', dryRun: false, ignoreCadence: true }).action).toBe('failed');
    git(f.seed, 'push', '-q', '-f', 'origin', f.c[4] + ':refs/heads/stable');
    f.commit('c6');
    fake.runs[0]!.status = 'completed';
    const finished = runGate(envFor(f, fake.gh), { gate: GATE, label: 'test', dryRun: false, ignoreCadence: true });
    expect(finished.action, finished.lines.join('\n')).toBe('gated');
    expect(finished.sha).toBe(f.c[4]);

    const g = fixture();
    const fake2 = fakeGh(() => ({ conclusion: 'success', status: 'in_progress', artifacts: report('GREEN') }));
    expect(runGate({ ...envFor(g, fake2.gh), deadline: 0 }, { gate: GATE, label: 'test', dryRun: false, ignoreCadence: true }).action).toBe('failed');
    const head = g.commit('c6');
    const late = runGate({ ...envFor(g, fake2.gh, OPEN_GATE_CADENCES * GATE.cadence_hours + 1), deadline: 0 }, { gate: GATE, label: 'test', dryRun: false, ignoreCadence: true });
    expect(late.lines.some(l => l.includes('finishing the open gate'))).toBe(false);
    expect(fake2.dispatches.at(-1)!.inputs.expected_sha).toBe(head);
  });
});

describe('release gate: red, bisect and the hold', () => {
  // Value: protects=a red gate records RED (the hold release-cut reads), bisects only its red verdict cases on release-gate/<id> with prefixes between
  // stable and the red head, narrows round by round to the first red commit after a green one, deletes the bisect branch, and prints first_bad; a later
  // green gate on a newer commit lifts the hold; fails_when=a red gate moves or leaves stable releasable, the bisect blames the wrong commit, tests the
  // known-red head again, leaks its branch, or a green gate on an older commit lifts the hold; why_new=new module; seam=fake gh; no_claim=a live bisect
  test('red: RED record, a bisect that names first_bad, the branch cleaned up, and the hold until a later green', () => {
    const f = fixture();
    const order = [f.base, ...f.c];
    const fake = fakeGh((inputs) => {
      if (!inputs.prefix_shas) return { conclusion: 'failure', artifacts: report('RED', ['case-a  rule  FAIL  VERDICT', 'case-z  rule  FAIL  INFRA']) };
      const files: Record<string, Record<string, string>> = {};
      for (const sha of inputs.prefix_shas.split(',')) {
        const red = order.indexOf(sha) >= 3;
        files['gstack-release-record-bisect-' + sha.slice(0, 12)] = { 'bisect-prefix.json': JSON.stringify({ schema: 1, kind: 'train-bisect-prefix', nonce: inputs.nonce, prefix_sha: sha, checked_out_sha: sha,
          panels: [{ case: 'case-a', kind: 'rule', status: red ? 'FAIL' : 'PASS', red_class: red ? 'VERDICT' : null, cost_usd: 1.25 }] }) };
      }
      return { conclusion: 'success', artifacts: files };
    });
    const out = runGate(envFor(f, fake.gh), { gate: GATE, label: 'test', dryRun: false, ignoreCadence: true });
    expect(out.action, out.lines.join('\n')).toBe('held');
    expect(out.lines).toContain('RELEASE: red sha=' + f.c[4] + ' first_bad=' + f.c[2] + ' run=1000');
    expect(fake.dispatches).toHaveLength(2);
    const bisect = fake.dispatches[1]!;
    expect(bisect.ref).toMatch(/^release-gate\/abc123-[0-9a-f]{12}$/);
    expect(bisect.inputs).toMatchObject({ cases: 'case-a', prefix_shas: f.c.slice(0, 4).join(','), expected_sha: f.c[4] });
    expect(bisect.inputs.nonce).toMatch(/^gate\.bisect-/);
    expect(git(f.seed, 'ls-remote', 'origin', 'refs/heads/release-gate/*')).toBe('');
    const recs = records(f);
    expect(recs[0]).toMatchObject({ verdict: 'RED', red_cases: ['case-a'], bisect: { state: 'found', first_bad: f.c[2], good: f.c[1], bad: f.c[2], spent_usd: 5 } });
    expect(git(f.seed, 'ls-remote', 'origin', 'refs/heads/stable').split('\t')[0]).toBe(f.base);
    const isAncestor = (a: string, b: string) => spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: f.work, timeout: 30_000 }).status === 0;
    expect(activeHold(recs, isAncestor)?.sha).toBe(f.c[4]);
    const status = gateStatus(envFor(f, fake.gh), { gate: GATE, label: 'test' });
    expect(status.action).toBe('held');
    expect(status.lines.find(l => l.startsWith('HOLD:'))).toContain('red on ' + f.c[4]);
    const older: ReleaseRecord = { ...recs[0]!, sha: f.c[1]!, verdict: 'GREEN', bisect: null };
    expect(activeHold([...recs, older], isAncestor)?.sha).toBe(f.c[4]);
    const later: ReleaseRecord = { ...recs[0]!, sha: f.commit('fix'), verdict: 'GREEN', bisect: null };
    git(f.work, 'fetch', '-q', 'origin');
    expect(activeHold([later, ...recs], isAncestor)).toBeNull();
  });

  // Value: protects=the bisect spends within its cap: a 0 cap records no bisect and first_bad unknown, a small cap tests only the prefixes it covers
  // and stops capped, and bisect --spend-cap resumes a capped one; fails_when=a bisect dispatches past its cap or a capped bisect cannot be resumed;
  // why_new=new module; seam=fake gh; no_claim=real case prices
  test('bisect spend: a zero cap skips it, a small cap stops capped, and bisect --spend-cap resumes', () => {
    const f = fixture();
    const fake = fakeGh((inputs) => (inputs.prefix_shas ? { conclusion: 'success', artifacts: {} } : { conclusion: 'failure', artifacts: report('RED', ['case-a  rule  FAIL  VERDICT', 'case-b  judge  FAIL']) }));
    const none = runGate(envFor(f, fake.gh), { gate: { ...GATE, bisect_spend_cap_usd: 0 }, label: 'test', dryRun: false, ignoreCadence: true });
    expect(none.lines).toContain('RELEASE: red sha=' + f.c[4] + ' first_bad=unknown run=1000');
    expect(none.lines.some(l => l.includes('bisect unknown: bisect_spend_cap_usd is 0'))).toBe(true);
    expect(fake.dispatches).toHaveLength(1);

    const g = fixture();
    const fake2 = fakeGh((inputs) => (inputs.prefix_shas ? { conclusion: 'success', artifacts: {} } : { conclusion: 'failure', artifacts: report('RED', ['case-a  rule  FAIL  VERDICT', 'case-b  judge  FAIL']) }));
    const capped = runGate(envFor(g, fake2.gh), { gate: { ...GATE, bisect_spend_cap_usd: 2 }, label: 'test', dryRun: false, ignoreCadence: true });
    expect(capped.lines.some(l => l.includes('bisect capped: the next round needs $6.00 a prefix'))).toBe(true);
    expect(fake2.dispatches).toHaveLength(1);
    const plan = bisectGate(envFor(g, fake2.gh), { gate: GATE, label: 'test', spendCap: 30, dryRun: true });
    expect(plan.lines.some(l => l.startsWith('RELEASE: bisect round 1: 2 case(s) on 4 of 4 commit(s)'))).toBe(true);
    expect(fake2.dispatches).toHaveLength(1);
  });
});

describe('release gate: the bisect cap with unknown costs', () => {
  // Value: protects=a bisect whose prefix records report cost_usd null (what crew/scripts/train-gate.ts writes today) books
  // RELEASE_TRIAL_RESERVATION_USD per case and prefix, so a later round sees the spend and the bisect stops capped within its cap; fails_when=null
  // costs count as $0 and every round reserves the whole cap again (about 4x the cap over MAX_BISECT_ROUNDS); why_new=review finding (targeted
  // money, l1 fix-check); seam=fake gh; no_claim=real case prices
  test('null prefix costs are charged at the reservation, and the bisect ends capped within its cap', () => {
    const f = fixture();
    const order = [f.base, ...f.c, ...[6, 7, 8, 9, 10, 11, 12].map(i => f.commit('c' + i))];
    const fake = fakeGh((inputs) => {
      if (!inputs.prefix_shas) return { conclusion: 'failure', artifacts: report('RED', ['case-a  rule  FAIL  VERDICT']) };
      const files: Record<string, Record<string, string>> = {};
      for (const sha of inputs.prefix_shas.split(',')) {
        const red = order.indexOf(sha) >= 7;
        files['gstack-release-record-bisect-' + sha.slice(0, 12)] = { 'bisect-prefix.json': JSON.stringify({ schema: 1, kind: 'train-bisect-prefix', nonce: inputs.nonce, prefix_sha: sha, checked_out_sha: sha,
          panels: [{ case: 'case-a', kind: 'rule', status: red ? 'FAIL' : 'PASS', red_class: red ? 'VERDICT' : null, cost_usd: null }] }) };
      }
      return { conclusion: 'success', artifacts: files };
    });
    const out = runGate(envFor(f, fake.gh), { gate: { ...GATE, bisect_spend_cap_usd: 4 }, label: 'test', dryRun: false, ignoreCadence: true });
    expect(out.action, out.lines.join('\n')).toBe('held');
    const bisect = records(f)[0]!.bisect!;
    expect(bisect).toMatchObject({ state: 'capped', spent_usd: 1.5 });
    expect(bisect.spent_usd).toBeLessThanOrEqual(4);
    expect(fake.dispatches).toHaveLength(2);
    expect(fake.dispatches[1]!.inputs.prefix_shas!.split(',')).toHaveLength(1);
  });
  // Value: protects=a red prefix runs its case twice (one trial plus its one rule-16 rerun in crew/scripts/train-gate.ts runBisectPrefix),
  // so each prefix reserves both trials and books the trials it ran, and the bisect ends capped at or under its dollar cap;
  // fails_when=a round reserves one trial a prefix, dispatches more prefixes than the cap pays for once they rerun, and books
  // half of what ran; why_new=GSTA-36 condition before adoption (l1 fix-check open note); seam=fake gh; no_claim=real case prices
  test('a red case and its rule-16 rerun count against the cap: the bisect ends capped at or under bisect_spend_cap_usd', () => {
    const f = fixture();
    [6, 7, 8, 9, 10, 11, 12].forEach(i => f.commit('c' + i));
    const fake = fakeGh((inputs) => {
      if (!inputs.prefix_shas) return { conclusion: 'failure', artifacts: report('RED', ['case-a  rule  FAIL  VERDICT']) };
      const files: Record<string, Record<string, string>> = {};
      for (const sha of inputs.prefix_shas.split(',')) {
        files['gstack-release-record-bisect-' + sha.slice(0, 12)] = { 'bisect-prefix.json': JSON.stringify({ schema: 1, kind: 'train-bisect-prefix', nonce: inputs.nonce, prefix_sha: sha, checked_out_sha: sha,
          panels: [{ case: 'case-a', kind: 'rule', status: 'FAIL', red_class: 'VERDICT', cost_usd: null }] }) };
      }
      return { conclusion: 'success', artifacts: files };
    });
    const cap = 4;
    const out = runGate(envFor(f, fake.gh), { gate: { ...GATE, bisect_spend_cap_usd: cap }, label: 'test', dryRun: false, ignoreCadence: true });
    expect(out.action, out.lines.join('\n')).toBe('held');
    const bisect = records(f)[0]!.bisect!;
    const prefixesRun = fake.dispatches.slice(1).reduce((n, d) => n + d.inputs.prefix_shas!.split(',').length, 0);
    const trialsRun = prefixesRun * 2;
    expect(bisect.state).toBe('capped');
    expect(bisect.spent_usd).toBe(trialsRun * RELEASE_TRIAL_RESERVATION_USD);
    expect(trialsRun * RELEASE_TRIAL_RESERVATION_USD).toBeLessThanOrEqual(cap);
    expect(prefixesRun).toBeGreaterThan(0);
  });
  // Value: protects=a running release bisect never spends past the current policy cap: a scheduled resume takes the current policy cap, so
  // lowering bisect_spend_cap_usd (to 0 here) stops further rounds, and a one-off bisect --spend-cap applies to that invocation only and is not
  // stored as a floor; fails_when=the stored cap only rises (Math.max), so a lowered policy keeps dispatching and a one-off raise keeps
  // spending on every later scheduled run; why_new=GSTA-36 condition before adoption (targeted reader at 598467d); seam=fake gh; no_claim=real case prices
  test('lowering the cap mid-bisect stops further spend, and a one-off --spend-cap is not stored', () => {
    const f = fixture();
    [6, 7, 8, 9, 10, 11, 12].forEach(i => f.commit('c' + i));
    let roundStatus = 'in_progress';
    const fake = fakeGh((inputs) => {
      if (!inputs.prefix_shas) return { conclusion: 'failure', artifacts: report('RED', ['case-a  rule  FAIL  VERDICT']) };
      const files: Record<string, Record<string, string>> = {};
      for (const sha of inputs.prefix_shas.split(',')) {
        files['gstack-release-record-bisect-' + sha.slice(0, 12)] = { 'bisect-prefix.json': JSON.stringify({ schema: 1, kind: 'train-bisect-prefix', nonce: inputs.nonce, prefix_sha: sha, checked_out_sha: sha,
          panels: [{ case: 'case-a', kind: 'rule', status: 'PASS', red_class: null, cost_usd: null }] }) };
      }
      return { conclusion: roundStatus === 'in_progress' ? '' : 'success', status: roundStatus, artifacts: files };
    });
    const env = envFor(f, fake.gh);
    runGate({ ...env, deadline: 0 }, { gate: { ...GATE, bisect_spend_cap_usd: 7 }, label: 'test', dryRun: false, ignoreCadence: true });
    expect(fake.dispatches).toHaveLength(2);
    expect(records(f)[0]!.bisect!.state).toBe('running');
    Object.assign(fake.runs[1]!, { status: 'completed', conclusion: 'success' });
    roundStatus = 'completed';

    const lowered = bisectGate(env, { gate: { ...GATE, bisect_spend_cap_usd: 0 }, label: 'test', dryRun: false });
    const afterLower = records(f)[0]!.bisect!;
    expect(fake.dispatches, lowered.lines.join('\n')).toHaveLength(2);
    expect(afterLower.state).toBe('capped');
    expect(afterLower.spend_cap).toBe(0);

    const oneOff = bisectGate(env, { gate: { ...GATE, bisect_spend_cap_usd: 0 }, label: 'test', spendCap: 40, dryRun: false });
    expect(fake.dispatches.length, oneOff.lines.join('\n')).toBeGreaterThan(2);
    expect(records(f)[0]!.bisect!.spend_cap).toBe(0);
  });
  test('a bisect capped under a lower cap resumes once bisect runs under a raised policy cap above what it spent', () => {
    const f = fixture();
    [6, 7, 8, 9, 10, 11, 12].forEach(i => f.commit('c' + i));
    const fake = fakeGh((inputs) => {
      if (!inputs.prefix_shas) return { conclusion: 'failure', artifacts: report('RED', ['case-a  rule  FAIL  VERDICT']) };
      const files: Record<string, Record<string, string>> = {};
      for (const sha of inputs.prefix_shas.split(',')) {
        files['gstack-release-record-bisect-' + sha.slice(0, 12)] = { 'bisect-prefix.json': JSON.stringify({ schema: 1, kind: 'train-bisect-prefix', nonce: inputs.nonce, prefix_sha: sha, checked_out_sha: sha,
          panels: [{ case: 'case-a', kind: 'rule', status: 'FAIL', red_class: 'VERDICT', cost_usd: null }] }) };
      }
      return { conclusion: 'success', artifacts: files };
    });
    const env = envFor(f, fake.gh);
    runGate(env, { gate: { ...GATE, bisect_spend_cap_usd: 4 }, label: 'test', dryRun: false, ignoreCadence: true });
    expect(records(f)[0]!.bisect!).toMatchObject({ state: 'capped', spent_usd: 3 });
    expect(fake.dispatches).toHaveLength(2);
    const raised = bisectGate(env, { gate: { ...GATE, bisect_spend_cap_usd: 80 }, label: 'test', dryRun: false });
    expect(fake.dispatches.length, raised.lines.join('\n')).toBe(3);
    expect(records(f)[0]!.bisect!.spend_cap).toBe(80);
  });
});

describe('release gate: verdict, range and policy units', () => {
  test('parseReport and classifyRun: verdict reds bisect, other classes keep a red incomplete, success is green, and a contradiction is incomplete', () => {
    const r = parseReport(report('RED', ['case-a  rule  FAIL  VERDICT', 'judge one  judge  FAIL', 'case-z  rule  FAIL  INFRA'])['report-verdict-a1']['report.txt']);
    expect(r).toEqual({ verdict: 'RED', red: ['case-a', 'judge one'], other: ['case-z'], cost: 37.4 });
    expect(classifyRun({ status: 'completed', conclusion: 'failure' }, r)).toMatchObject({ verdict: 'RED', red: ['case-a', 'judge one'] });
    expect(classifyRun({ status: 'completed', conclusion: 'failure' }, { ...r, red: [] }).verdict).toBe('INCOMPLETE');
    expect(classifyRun({ status: 'completed', conclusion: 'cancelled' }, null).verdict).toBe('INCOMPLETE');
    expect(classifyRun({ status: 'completed', conclusion: 'success' }, { ...r, verdict: 'GREEN' }).verdict).toBe('GREEN');
    expect(classifyRun({ status: 'completed', conclusion: 'success' }, r).verdict).toBe('INCOMPLETE');
    expect(classifyRun({ status: 'in_progress', conclusion: null }, null).verdict).toBe('PENDING');
  });

  // Value: protects=green needs the run's success and a report that says GREEN; a missing or verdict-less report on a successful run is INCOMPLETE;
  // fails_when=a lost or truncated report-verdict artifact records GREEN (GST-1263); why_new=reader note on #3917; seam=none; no_claim=report-verdict's writer
  test('classifyRun: a successful run without a GREEN report is incomplete', () => {
    expect(classifyRun({ status: 'completed', conclusion: 'success' }, null)).toMatchObject({ verdict: 'INCOMPLETE', detail: 'the run concluded success but its report artifact is missing' });
    expect(classifyRun({ status: 'completed', conclusion: 'success' }, { verdict: 'NONE', red: [], other: [], cost: null }).verdict).toBe('INCOMPLETE');
  });

  test('planPrefixes spreads at most MAX_PREFIXES over the interior; narrow moves good and bad and refuses a non-monotone or missing result', () => {
    const shas = Array.from({ length: 20 }, (_, i) => String(i).padStart(40, '0'));
    expect(planPrefixes(shas.slice(0, 3))).toEqual(shas.slice(0, 3));
    const picked = planPrefixes(shas, 7);
    expect(picked).toHaveLength(7);
    expect(new Set(picked).size).toBe(7);
    expect(picked[0]).not.toBe(shas[0]);
    const t = (rs: string[]) => rs.map((r, i): { sha: string; results: Record<string, PrefixResult> } => ({ sha: shas[i]!, results: r === '?' ? {} : { a: r === 'R' ? 'red' : 'green' } }));
    expect(narrow({ good: 'g', bad: 'b' }, t(['G', 'G', 'R']), ['a'])).toEqual({ good: shas[1], bad: shas[2] });
    expect(narrow({ good: 'g', bad: 'b' }, t(['G', 'G']), ['a'])).toEqual({ good: shas[1], bad: 'b' });
    expect(narrow({ good: 'g', bad: 'b' }, t(['R', 'R']), ['a'])).toEqual({ good: 'g', bad: shas[0] });
    expect(narrow({ good: 'g', bad: 'b' }, t(['G', 'R', 'G']), ['a'])).toEqual({ unknown: 'a is not monotone over the tested commits (GRG)' });
    expect(narrow({ good: 'g', bad: 'b' }, t(['G', '?']), ['a'])).toHaveProperty('unknown');
  });

  // Value: protects=the release_gate key is read only with min_gstack_version at its introducing version, validates every field (cadence at least the
  // workflow schedule, a workflow file, branch names, hold-release), and --policy runs the same validation; fails_when=an older gstack reads the block
  // silently, a bad field passes, or the command-line policy skips validation; why_new=new key; seam=none; no_claim=the json adoption (a follow-up PR)
  test('policy: the release_gate key needs its min_gstack_version and every field; --policy is validated the same way', () => {
    const raw = { release_gate: GATE };
    expect(validatePolicy(raw).map(e => e.path)).toEqual(['release_gate']);
    expect(validatePolicy({ ...raw, min_gstack_version: RELEASE_GATE_KEY_VERSION })).toEqual([]);
    expect(releaseGateErrors({ ...GATE, cadence_hours: RELEASE_GATE_SCHEDULE_HOURS - 1, on_red: 'freeze', stable_ref: 'main', extra: 1 }).map(e => e.path).sort())
      .toEqual(['release_gate.cadence_hours', 'release_gate.extra', 'release_gate.on_red', 'release_gate.stable_ref']);
    expect(releaseGateErrors({ cadence_hours: 8 }).filter(e => e.message.startsWith('missing'))).toHaveLength(6);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-policy-'));
    roots.push(dir);
    const good = path.join(dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify({ ...raw, min_gstack_version: RELEASE_GATE_KEY_VERSION }));
    expect(loadReleaseGate(ROOT, { policyFile: good })).toEqual({ gate: GATE, label: good });
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify(raw));
    expect((loadReleaseGate(ROOT, { policyFile: bad }) as { error: string }).error).toContain('release_gate introduced in gstack ' + RELEASE_GATE_KEY_VERSION);
  });

  test('crew/bin/gstack-release-gate: usage exits 2; an inert policy file exits 0 without touching GitHub', () => {
    const bin = path.join(ROOT, 'crew/bin/gstack-release-gate');
    const usage = spawnSync('bun', [...bunIsolationArgs(), bin, 'frobnicate'], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(usage.status).toBe(2);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-gate-bin-'));
    roots.push(dir);
    const inert = path.join(dir, 'policy.json');
    fs.writeFileSync(inert, '{}');
    const r = spawnSync('bun', [...bunIsolationArgs(), bin, 'run', '--repo', 'o/r', '--policy', inert], { cwd: ROOT, encoding: 'utf8', timeout: 60_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe('RELEASE: inert (' + inert + ' declares no release_gate block; the per-push main backstop gates main)');
  });
});
