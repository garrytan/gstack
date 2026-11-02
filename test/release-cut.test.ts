/**
 * release-cut (free): the stable release picks the newest green commit on
 * main's first-parent history, tags it v<VERSION>, fast-forwards stable and
 * publishes notes from the CHANGELOG headlines; a hotfix --ref promotes a
 * named main commit; stable never moves backwards; a frozen queue, a pending
 * check run or a red one keeps a commit out; a cut that stopped half-way is
 * finished by the next run (docs/releases.md).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { gitFixtureTemplate, rebindGitDir } from './helpers/git-fixture-template';
import {
  BACKSTOP_CHECK, FLOOR_HOURS, NOTES_CAP, NOTES_REF, REQUIRED_CHECK, SCHEDULED_GRACE_HOURS, changelogEntries, compareVersions, cutRelease, describePlan, floorStatus,
  gateVerdict, gitIn, planRelease, readTrainNotes, releaseNotes, sanitizeReason, stableMovedAt, verifyRegression, verifySecurity, type Gh, type Git,
} from '../scripts/release-cut';

const bases: string[] = [];
// A cut made a moment ago clears the 72-hour floor at this clock.
const pastFloor = () => Date.now() + (FLOOR_HOURS + 1) * 3_600_000;
// The CLI reads GITHUB_EVENT_NAME (schedule grace) and GITHUB_ACTIONS (annotations); a test sets them itself, never inherits the runner's.
function cliEnv(shim: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, PATH: shim + path.delimiter + process.env.PATH };
  for (const k of ['GITHUB_EVENT_NAME', 'GITHUB_ACTIONS', 'GITHUB_STEP_SUMMARY']) delete env[k];
  return { ...env, ...extra };
}
afterEach(() => { for (const b of bases.splice(0)) fs.rmSync(b, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
}

type CheckRun = { name: string; status: string; conclusion: string | null };
interface State { checks: Record<string, CheckRun[]>; released: Set<string>; createFails?: string; calls: string[][]; api?: Record<string, unknown> }

const GREEN: CheckRun[] = [{ name: REQUIRED_CHECK, status: 'completed', conclusion: 'success' }, { name: BACKSTOP_CHECK, status: 'completed', conclusion: 'success' }, { name: 'typecheck', status: 'completed', conclusion: 'success' }];
const backstop = (status: string, conclusion: string | null): CheckRun[] => [...GREEN.filter(c => c.name !== BACKSTOP_CHECK), { name: BACKSTOP_CHECK, status, conclusion }];

function fakeGh(state: State): Gh {
  return (args) => {
    state.calls.push(args);
    const api = args[0] === 'api' ? args[args.length - 1]! : '';
    const m = /commits\/([0-9a-f]+)\/check-runs/.exec(api);
    if (m) return { status: 0, stdout: JSON.stringify([{ check_runs: state.checks[m[1]!] ?? GREEN }]), stderr: '' };
    if (api && state.api && api in state.api) return { status: 0, stdout: JSON.stringify(state.api[api]), stderr: '' };
    if (api) return { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
    if (args[0] === 'release' && args[1] === 'view') return state.released.has(args[2]!) ? { status: 0, stdout: '{}', stderr: '' } : { status: 1, stdout: '', stderr: 'release not found' };
    if (args[0] === 'release' && args[1] === 'create') {
      if (state.createFails === args[2]) return { status: 1, stdout: '', stderr: 'HTTP 502 Bad Gateway' };
      state.released.add(args[2]!); return { status: 0, stdout: 'https://github.com/o/r/releases/tag/' + args[2], stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected gh ' + args.join(' ') };
  };
}

/** Commits a release (VERSION, a CHANGELOG headline, optional files) in seed and pushes it to origin. */
function releaser(seed: string, shas: Record<string, string>) {
  let changelog = fs.existsSync(path.join(seed, 'CHANGELOG.md')) ? fs.readFileSync(path.join(seed, 'CHANGELOG.md'), 'utf8') : '# Changelog\n';
  return (version: string, headline: string, o: { message?: string; files?: Record<string, string> } = {}) => {
    changelog = changelog.replace('# Changelog\n', '# Changelog\n\n## [' + version + '] - 2026-10-2' + version.slice(-1) + '\n\n**' + headline + '**\n\n### Fixed\n- a thing\n');
    fs.writeFileSync(path.join(seed, 'VERSION'), version + '\n');
    fs.writeFileSync(path.join(seed, 'CHANGELOG.md'), changelog);
    for (const [file, text] of Object.entries(o.files ?? {})) fs.writeFileSync(path.join(seed, file), text);
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', o.message ?? 'v' + version);
    git(seed, 'push', '-q', 'origin', 'main');
    shas[version] = git(seed, 'rev-parse', 'HEAD');
    return shas[version]!;
  };
}

/** origin with releases 1.0.0..1.0.3 pushed from seed, and work cloned from it; built once for this file, copied per test. */
const template = gitFixtureTemplate({
  prefix: 'gstack-release-cut-',
  build: (base) => {
    const origin = path.join(base, 'origin.git');
    const seed = path.join(base, 'seed');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000 });
    fs.mkdirSync(seed);
    git(seed, 'init', '-q', '-b', 'main');
    git(seed, 'remote', 'add', 'origin', origin);
    const shas: Record<string, string> = {};
    const release = releaser(seed, shas);
    release('1.0.0', 'First one.');
    release('1.0.1', 'Second: the updater no longer skips.');
    release('1.0.2', 'Third fixes Windows.');
    release('1.0.3', 'Fourth trims the preamble.');
    execFileSync('git', ['clone', '-q', origin, path.join(base, 'work')], { timeout: 30_000 });
    return shas;
  },
  rebind: (copy, tpl) => { for (const repo of ['seed', 'work']) rebindGitDir(path.join(copy, repo, '.git'), tpl, copy); },
});
afterAll(() => template.dispose());

function fixture() {
  const { root: base, meta } = template.copy();
  bases.push(base);
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  const work = path.join(base, 'work');
  const shas: Record<string, string> = { ...meta };
  const release = releaser(seed, shas);
  const refresh = () => { git(work, 'fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*'); git(work, 'fetch', '-q', '--tags', 'origin'); };
  const state: State = { checks: {}, released: new Set(), calls: [] };
  return { base, origin, seed, work, shas, release, refresh, state, gh: fakeGh(state), git: gitIn(work), repo: 'o/r' };
}

describe('release-cut: planning', () => {
  test('the newest green first-parent commit wins; a pending backstop or a red check keeps a commit out and is named', () => {
    const f = fixture();
    f.state.checks[f.shas['1.0.3']!] = backstop('in_progress', null);
    f.state.checks[f.shas['1.0.2']!] = [...GREEN, { name: 'windows-free-tests', status: 'completed', conclusion: 'failure' }];
    const r = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.plan.sha).toBe(f.shas['1.0.1']);
    expect(r.plan.version).toBe('1.0.1');
    expect(r.plan.tag).toBe('v1.0.1');
    expect(r.plan.prevStable).toBeNull();
    expect(r.plan.skipped).toEqual([
      f.shas['1.0.3']!.slice(0, 12) + ': ' + BACKSTOP_CHECK + ' is still running',
      f.shas['1.0.2']!.slice(0, 12) + ': red check runs: windows-free-tests',
    ]);
    expect(r.plan.notes).toContain('First tagged release: the 2 versions, one line each');
    expect(r.plan.notes).toContain('- **1.0.1** (2026-10-21): Second: the updater no longer skips.');
    expect(r.plan.notes).toContain('- **1.0.0**');
    expect(r.plan.notes).not.toContain('1.0.2');
    const lines = describePlan(r.plan, true);
    expect(lines.some(l => l.startsWith('DRY_RUN:'))).toBe(true);
    expect(lines).toContain('  git push --force-with-lease=refs/heads/stable: origin ' + f.shas['1.0.1'] + ':refs/heads/stable');
  });

  test('a missing free-tests run, a running free-tests run, no backstop check run and a superseded (neutral) backstop are not green', () => {
    const f = fixture();
    const head = f.shas['1.0.3']!;
    f.state.checks[head] = [{ name: 'typecheck', status: 'completed', conclusion: 'success' }];
    f.state.checks[f.shas['1.0.2']!] = [{ name: REQUIRED_CHECK, status: 'in_progress', conclusion: null }];
    f.state.checks[f.shas['1.0.1']!] = GREEN.filter(c => c.name !== BACKSTOP_CHECK);
    const r = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.sha).toBe(f.shas['1.0.0']);
    expect(r.plan.skipped.map(s => s.split(': ')[1])).toEqual(['no free-tests check run', 'free-tests is still running', 'no ' + BACKSTOP_CHECK + ' check run']);
    // A push main moved past before the backstop gated it (train-backstop.ts
    // 'superseded', exit 0) publishes a neutral check run: never green.
    f.state.checks[f.shas['1.0.1']!] = backstop('completed', 'neutral');
    const neutral = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(neutral.ok).toBe(true);
    if (neutral.ok) { expect(neutral.plan.sha).toBe(f.shas['1.0.0']); expect(neutral.plan.skipped[2]).toBe(f.shas['1.0.1']!.slice(0, 12) + ': ' + BACKSTOP_CHECK + ' concluded neutral'); }
  });

  test('no green commit in the window is NO_GREEN_COMMIT with every skip named; an empty window is NOTHING_NEW', () => {
    const f = fixture();
    for (const sha of Object.values(f.shas)) f.state.checks[sha] = backstop('completed', 'failure');
    const r = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('NO_GREEN_COMMIT');
    expect(r.skipped).toHaveLength(4);
    expect(r.skipped![0]).toContain(BACKSTOP_CHECK + ' concluded failure');
    const stale = planRelease({ repo: f.repo, git: f.git, gh: f.gh, now: () => Date.now() + 30 * 86_400_000 });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('NOTHING_NEW');
  });

  // Value: protects=gateVerdict names a failed free-tests run and an unreadable check-runs API as not green, holds a commit with any check run still going as
  // pending, and merges paginated check pages; fails_when=a required-check failure is treated as red-list noise, a gh error reads as green or pending, a queued
  // unrelated check run is read as green, or only the first page of check runs is read; why_new=the planning tests cover missing, running and red runs only,
  // never a failed required run, a gh error, an unrelated running check or a second page; seam=none; no_claim=GitHub's real check-runs payload shape (a fake gh answers; unit only)
  test('gateVerdict: a failed free-tests run, an unreadable check-runs API, an unrelated running check and a paginated check list', () => {
    const checks = (runs: unknown[]): Gh => (args) => {
      const api = args[args.length - 1]!;
      if (/check-runs/.test(api)) return { status: 0, stdout: JSON.stringify(runs), stderr: '' };
      return { status: 1, stdout: '', stderr: 'unexpected gh ' + args.join(' ') };
    };
    const failed = checks([{ check_runs: [{ name: REQUIRED_CHECK, status: 'completed', conclusion: 'failure' }] }]);
    expect(gateVerdict(failed, 'o/r', 'a'.repeat(40))).toEqual({ green: false, why: REQUIRED_CHECK + ' concluded failure', pending: false });
    const unreadable: Gh = () => ({ status: 1, stdout: '', stderr: 'HTTP 403' });
    expect(gateVerdict(unreadable, 'o/r', 'a'.repeat(40))).toEqual({ green: false, why: 'cannot read its check runs', pending: false });
    const garbled: Gh = () => ({ status: 0, stdout: 'not json', stderr: '' });
    expect(gateVerdict(garbled, 'o/r', 'a'.repeat(40))).toEqual({ green: false, why: 'cannot read its check runs', pending: false });
    const queued = checks([{ check_runs: [...GREEN, { name: 'slices-report', status: 'queued', conclusion: null }] }]);
    expect(gateVerdict(queued, 'o/r', 'a'.repeat(40))).toEqual({ green: false, why: 'check runs still going: slices-report', pending: true });
    const paged = checks([{ check_runs: [{ name: 'typecheck', status: 'completed', conclusion: 'success' }, { name: BACKSTOP_CHECK, status: 'completed', conclusion: 'success' }] }, { check_runs: [{ name: REQUIRED_CHECK, status: 'completed', conclusion: 'success' }] }]);
    expect(gateVerdict(paged, 'o/r', 'a'.repeat(40))).toEqual({ green: true, via: BACKSTOP_CHECK });
    const pagedRed = checks([{ check_runs: GREEN }, { check_runs: [{ name: 'windows-free-tests', status: 'completed', conclusion: 'timed_out' }] }]);
    expect(gateVerdict(pagedRed, 'o/r', 'a'.repeat(40))).toEqual({ green: false, why: 'red check runs: windows-free-tests', pending: false });
    const cancelled = checks([{ check_runs: [...GREEN, { name: 'quality', status: 'completed', conclusion: 'cancelled' }, { name: 'docs', status: 'completed', conclusion: 'skipped' }] }]);
    expect(gateVerdict(cancelled, 'o/r', 'a'.repeat(40))).toEqual({ green: false, why: 'red check runs: quality', pending: false });
    const skipped = checks([{ check_runs: [...GREEN, { name: 'docs', status: 'completed', conclusion: 'skipped' }] }]);
    expect(gateVerdict(skipped, 'o/r', 'a'.repeat(40))).toEqual({ green: true, via: BACKSTOP_CHECK });
  });

  test('an active freeze in refs/notes/gstack-trains refuses the cut; a cleared one does not', () => {
    const f = fixture();
    const freeze = { schema: 1, kind: 'freeze', repo_key: 'k', train: 'abc', reason: 'backstop red on 2 cases', created_at: 'x', cleared_at: null };
    git(f.seed, 'notes', '--ref=' + NOTES_REF, 'add', '-m', JSON.stringify(freeze), 'HEAD');
    git(f.seed, 'push', '-q', 'origin', NOTES_REF);
    const frozen = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) { expect(frozen.code).toBe('REFUSED'); expect(frozen.message).toContain('queue frozen since train abc: backstop red on 2 cases'); }
    git(f.seed, 'notes', '--ref=' + NOTES_REF, 'add', '-f', '-m', JSON.stringify({ ...freeze, cleared_at: 'y' }), 'HEAD');
    git(f.seed, 'push', '-q', '-f', 'origin', NOTES_REF);
    expect(planRelease({ repo: f.repo, git: f.git, gh: f.gh }).ok).toBe(true);
  });

  // Value: protects=one read of the trains notes ref feeds both gates: a fetch failure other than a missing ref refuses the plan with its message, a
  // missing ref is no freeze and no evidence, a blob that is not JSON, is JSON that is not an object (null, an array, a string, a number), carries a
  // malformed merged[] or a non-string nonce, or is a train without a nonce is skipped while a freeze and a train in the same
  // ref are both read (the freeze still wins over the evidence); fails_when=a fetch error is read as "no notes" and a frozen or ungated main is
  // released, an unparsable note aborts the read, or evidence from a later note is lost once a freeze is seen; why_new=the freeze test covers one
  // readable freeze record only and the evidence tests never mix record kinds or break the fetch; seam=none; no_claim=a real origin outage
  test('readTrainNotes: a fetch error refuses, a missing ref holds nothing, junk notes are skipped, and a freeze beside train evidence still refuses', () => {
    const f = fixture();
    const head = f.shas['1.0.3']!;
    const failing: Git = (args) => (args[0] === 'fetch' ? { ok: false, out: 'fatal: unable to access the remote: Could not resolve host' } : f.git(args));
    const broken = planRelease({ repo: f.repo, git: failing, gh: f.gh });
    expect(broken).toEqual({ ok: false, code: 'REFUSED', message: 'cannot fetch ' + NOTES_REF + ': fatal: unable to access the remote: Could not resolve host' });
    const absent = readTrainNotes(f.git);
    expect([absent.error, absent.freeze, absent.evidence.bySha.size, absent.evidence.byTree.size]).toEqual([null, null, 0, 0]);

    const add = (record: string, on: string) => git(f.seed, 'notes', '--ref=' + NOTES_REF, 'add', '-f', '-m', record, on);
    add('not json {', f.shas['1.0.0']!);
    for (const junk of ['null', '[]', '"train"', '7', JSON.stringify({ kind: 'train', nonce: 'bad1', state: 'green', merged: 'x' }), JSON.stringify({ kind: 'train', nonce: 'bad2', state: 'green', merged: [null, 'y', { sha: 3, tree: ['t'] }, { sha: '', tree: '' }] }), JSON.stringify({ kind: 'train', nonce: 9, state: 'green', merged: [{ sha: f.shas['1.0.0'] }] })]) {
      add(junk, f.shas['1.0.0']!);
      git(f.seed, 'push', '-q', '-f', 'origin', NOTES_REF);
      const read = readTrainNotes(f.git);
      expect([junk, read.error, read.freeze, read.evidence.bySha.size, read.evidence.byTree.size]).toEqual([junk, null, null, 0, 0]);
    }
    add(JSON.stringify({ schema: 1, kind: 'train', state: 'merged', merged: [{ sha: f.shas['1.0.1'], tree: 't1' }] }), f.shas['1.0.1']!);
    add(JSON.stringify({ schema: 1, kind: 'train', nonce: 'ok1', state: 'green', merged: [{ pr: '2' }, { sha: f.shas['1.0.2'] }, { tree: 'tree-only' }] }), f.shas['1.0.2']!);
    add(JSON.stringify({ schema: 1, kind: 'freeze', train: 'ok1', reason: 'backstop red', cleared_at: null }), head);
    git(f.seed, 'push', '-q', '-f', 'origin', NOTES_REF);
    const mixed = readTrainNotes(f.git);
    expect(mixed.error).toBeNull();
    expect(mixed.freeze).toBe('queue frozen since train ok1: backstop red');
    expect([...mixed.evidence.bySha]).toEqual([[f.shas['1.0.2']!, 'ok1']]);
    expect([...mixed.evidence.byTree]).toEqual([['tree-only', 'ok1']]);
    f.state.checks[f.shas['1.0.2']!] = backstop('completed', 'neutral');
    const frozen = planRelease({ repo: f.repo, ref: f.shas['1.0.2'], git: f.git, gh: f.gh });
    expect(frozen).toEqual({ ok: false, code: 'REFUSED', message: 'queue frozen since train ok1: backstop red' });
    add(JSON.stringify({ schema: 1, kind: 'freeze', train: 'ok1', reason: 'backstop red', cleared_at: 'y' }), head);
    git(f.seed, 'push', '-q', '-f', 'origin', NOTES_REF);
    const thawed = planRelease({ repo: f.repo, ref: f.shas['1.0.2'], git: f.git, gh: f.gh });
    expect(thawed.ok, JSON.stringify(thawed)).toBe(true);
    if (thawed.ok) expect(thawed.plan.via).toBe('train ok1');
  });
});

describe('release-cut: train evidence gates a commit whose backstop never settled', () => {
  const train = (nonce: string, state: string, merged: Array<{ sha: string; tree: string }>) =>
    ({ schema: 1, kind: 'train', nonce, state, merged: merged.map(m => ({ pr: '1', at: 'x', ...m })), updated_at: 'x' });
  const note = (f: ReturnType<typeof fixture>, record: unknown, on: string, ref = NOTES_REF) => {
    git(f.seed, 'notes', '--ref=' + ref, 'add', '-f', '-m', JSON.stringify(record), on);
    git(f.seed, 'push', '-q', '-f', 'origin', ref);
  };
  const treeOf = (f: ReturnType<typeof fixture>, sha: string) => git(f.seed, 'rev-parse', sha + '^{tree}');

  // Value: protects=a main commit whose main-backstop check run is neutral (superseded) or absent is released when a green, merging or merged train record's
  // merged[] names its sha or its tree, and the CANDIDATE line says which train gated it; fails_when=the gate still needs a successful backstop run on
  // every commit (the weekly cut returns NO_GREEN_COMMIT for a week of train-merged commits), evidence is matched on sha only, or the plan hides what gated
  // the commit; why_new=the planning tests know only the backstop check run as evidence; seam=none; no_claim=real refs/notes/gstack-trains content (a
  // fixture record shaped like lib/ship-queue-train-record.ts TrainRecord)
  test('a neutral backstop plus a train record naming the sha, or only the tree, is a candidate gated by that train', () => {
    const f = fixture();
    const head = f.shas['1.0.3']!;
    f.state.checks[head] = backstop('completed', 'neutral');
    note(f, train('t1', 'merged', [{ sha: head, tree: treeOf(f, head) }]), head);
    const bySha = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(bySha.ok, JSON.stringify(bySha)).toBe(true);
    if (!bySha.ok) return;
    expect(bySha.plan.sha).toBe(head);
    expect(bySha.plan.via).toBe('train t1');
    expect(describePlan(bySha.plan, true)[0]).toBe('CANDIDATE: ' + head + ' (' + bySha.plan.date + ') gated by train t1');

    const byTree = fixture();
    const head2 = byTree.shas['1.0.3']!;
    delete byTree.state.checks[head2];
    byTree.state.checks[head2] = GREEN.filter(c => c.name !== BACKSTOP_CHECK);
    note(byTree, train('t2', 'green', [{ sha: 'f'.repeat(40), tree: treeOf(byTree, head2) }]), head2);
    const r = planRelease({ repo: byTree.repo, git: byTree.git, gh: byTree.gh });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) { expect(r.plan.sha).toBe(head2); expect(r.plan.via).toBe('train t2'); }

    const plain = planRelease({ repo: f.repo, ref: f.shas['1.0.2'], git: f.git, gh: f.gh });
    expect(plain.ok).toBe(true);
    if (plain.ok) { expect(plain.plan.via).toBe(BACKSTOP_CHECK); expect(describePlan(plain.plan, false)[0]).toBe('CANDIDATE: ' + f.shas['1.0.2'] + ' (' + plain.plan.date + ') [hotfix: --ref] gated by ' + BACKSTOP_CHECK); }
  });

  // Value: protects=train evidence never relaxes the rest of the gate: a covered commit still needs a successful required check run (also when
  // --required-check and --backstop-check name the same check, where evidence substitutes for nothing), no red check run (a red backstop included),
  // nothing still running, and only a green, merging or merged record counts; fails_when=a covered commit with a failed free-tests run, a red windows lane
  // or a red backstop is released, a running check is not waited for, a red or superseded train record is read as evidence, or equal check names let a
  // covered commit with zero check runs through; why_new=the first train test covers the accepting path only; seam=none; no_claim=none beyond protects
  test('a covered commit is still refused by a red check run, a red backstop, a missing or failed required run, a running run, or a red/superseded record', () => {
    const f = fixture();
    const head = f.shas['1.0.3']!;
    const tree = treeOf(f, head);
    note(f, train('t1', 'merging', [{ sha: head, tree }]), head);
    const gate = (checks: CheckRun[]) => { f.state.checks[head] = checks; const v = planRelease({ repo: f.repo, ref: head, git: f.git, gh: f.gh }); return v.ok ? 'green' : v.message; };
    expect(gate([...backstop('completed', 'neutral'), { name: 'windows-free-tests', status: 'completed', conclusion: 'failure' }])).toBe('--ref ' + head.slice(0, 12) + ' is not green: red check runs: windows-free-tests');
    expect(gate(backstop('completed', 'failure'))).toBe('--ref ' + head.slice(0, 12) + ' is not green: red check runs: ' + BACKSTOP_CHECK);
    expect(gate([{ name: BACKSTOP_CHECK, status: 'completed', conclusion: 'neutral' }])).toBe('--ref ' + head.slice(0, 12) + ' is not green: no ' + REQUIRED_CHECK + ' check run');
    expect(gate([{ name: REQUIRED_CHECK, status: 'completed', conclusion: 'failure' }, { name: BACKSTOP_CHECK, status: 'completed', conclusion: 'neutral' }])).toBe('--ref ' + head.slice(0, 12) + ' is not green: ' + REQUIRED_CHECK + ' concluded failure');
    expect(gate(backstop('in_progress', null))).toBe('--ref ' + head.slice(0, 12) + ' is not green: ' + BACKSTOP_CHECK + ' is still running');
    expect(gate([...backstop('completed', 'neutral'), { name: 'slices-report', status: 'queued', conclusion: null }])).toBe('--ref ' + head.slice(0, 12) + ' is not green: check runs still going: slices-report');
    expect(gate(backstop('completed', 'neutral'))).toBe('green');
    f.state.checks[head] = [];
    const same = planRelease({ repo: f.repo, ref: head, git: f.git, gh: f.gh, requiredCheck: 'ci', backstopCheck: 'ci' });
    expect(same.ok ? 'green' : same.message).toBe('--ref ' + head.slice(0, 12) + ' is not green: no ci check run');
    f.state.checks[head] = [{ name: 'ci', status: 'completed', conclusion: 'success' }];
    const sameGreen = planRelease({ repo: f.repo, ref: head, git: f.git, gh: f.gh, requiredCheck: 'ci', backstopCheck: 'ci' });
    expect(sameGreen.ok ? sameGreen.plan.via : sameGreen.message).toBe('ci');

    for (const state of ['red', 'superseded', 'incomplete', 'free-green']) {
      note(f, train('t1', state, [{ sha: head, tree }]), head);
      expect([state, gate(backstop('completed', 'neutral'))]).toEqual([state, '--ref ' + head.slice(0, 12) + ' is not green: ' + BACKSTOP_CHECK + ' concluded neutral']);
    }

    for (const sha of Object.values(f.shas)) f.state.checks[sha] = backstop('completed', 'neutral');
    const none = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(none.ok).toBe(false);
    if (none.ok) return;
    expect(none.code).toBe('NO_GREEN_COMMIT');
    expect(none.message).toBe('no green commit among 4 on origin/main; see the skipped list');
    expect(none.skipped).toEqual(Object.values(f.shas).reverse().map(s => s.slice(0, 12) + ': ' + BACKSTOP_CHECK + ' concluded neutral'));
    note(f, train('other', 'merged', [{ sha: f.shas['1.0.1']!, tree: treeOf(f, f.shas['1.0.1']!) }]), head);
    const older = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(older.ok, JSON.stringify(older)).toBe(true);
    if (!older.ok) return;
    expect(older.plan.sha).toBe(f.shas['1.0.1']);
    expect(older.plan.via).toBe('train other');
    expect(older.plan.skipped).toEqual([head.slice(0, 12) + ': ' + BACKSTOP_CHECK + ' concluded neutral', f.shas['1.0.2']!.slice(0, 12) + ': ' + BACKSTOP_CHECK + ' concluded neutral']);
  });

  // Value: protects=--required-check, --backstop-check and --notes-ref rename what the gate reads so another repository can run the script, and the
  // defaults stay free-tests, main-backstop and refs/notes/gstack-trains for weekly-release.yml; fails_when=a renamed check is still looked up under the
  // default name, the train notes are read from the default ref only, or a flag is misread by the CLI; why_new=every other test runs under the defaults;
  // seam=none; no_claim=none beyond protects
  test('--required-check, --backstop-check and --notes-ref rename what the gate reads, through planRelease and the CLI', () => {
    const f = fixture();
    const head = f.shas['1.0.3']!;
    const renamed: CheckRun[] = [{ name: 'ci', status: 'completed', conclusion: 'success' }, { name: 'nightly-backstop', status: 'completed', conclusion: 'success' }];
    for (const sha of Object.values(f.shas)) f.state.checks[sha] = renamed;
    const defaults = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(defaults.ok).toBe(false);
    if (!defaults.ok) expect(defaults.skipped![0]).toBe(head.slice(0, 12) + ': no ' + REQUIRED_CHECK + ' check run');
    const flagged = planRelease({ repo: f.repo, git: f.git, gh: f.gh, requiredCheck: 'ci', backstopCheck: 'nightly-backstop' });
    expect(flagged.ok, JSON.stringify(flagged)).toBe(true);
    if (flagged.ok) { expect(flagged.plan.sha).toBe(head); expect(flagged.plan.via).toBe('nightly-backstop'); }

    f.state.checks[head] = [{ name: 'ci', status: 'completed', conclusion: 'success' }, { name: 'nightly-backstop', status: 'completed', conclusion: 'neutral' }];
    note(f, train('t9', 'merged', [{ sha: head, tree: treeOf(f, head) }]), head, 'refs/notes/other-trains');
    const defaultRef = planRelease({ repo: f.repo, ref: head, git: f.git, gh: f.gh, requiredCheck: 'ci', backstopCheck: 'nightly-backstop' });
    expect(defaultRef.ok).toBe(false);
    if (!defaultRef.ok) expect(defaultRef.message).toBe('--ref ' + head.slice(0, 12) + ' is not green: nightly-backstop concluded neutral');
    const otherRef = planRelease({ repo: f.repo, ref: head, git: f.git, gh: f.gh, requiredCheck: 'ci', backstopCheck: 'nightly-backstop', notesRef: 'refs/notes/other-trains' });
    expect(otherRef.ok, JSON.stringify(otherRef)).toBe(true);
    if (otherRef.ok) expect(otherRef.plan.via).toBe('train t9');

    if (process.platform === 'win32') return;
    const shim = path.join(f.base, 'shim');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'gh'), '#!/usr/bin/env bash\ncase "$*" in\n  *check-runs*) echo \'' + JSON.stringify([{ check_runs: f.state.checks[head] }]) + '\' ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
    const run = (...args: string[]) => spawnSync(process.execPath, [...bunIsolationArgs(), 'run', path.join(path.resolve(import.meta.dir, '..'), 'scripts', 'release-cut.ts'), ...args],
      { cwd: f.work, encoding: 'utf8', timeout: 60_000, env: cliEnv(shim) });
    const cli = run('--repo', f.repo, '--dry-run', '--ref', head, '--required-check', 'ci', '--backstop-check', 'nightly-backstop', '--notes-ref', 'refs/notes/other-trains');
    expect(cli.status, cli.stdout + cli.stderr).toBe(0);
    expect(cli.stdout.split('\n')[0]).toBe('CANDIDATE: ' + head + ' (' + git(f.seed, 'show', '-s', '--format=%cs', head) + ') [hotfix: --ref] gated by train t9');
    const unnamed = run('--repo', f.repo, '--dry-run', '--ref', head, '--required-check', 'ci', '--backstop-check', 'nightly-backstop');
    expect(unnamed.status).toBe(1);
    expect(unnamed.stdout.split('\n')[0]).toBe('REFUSED: --ref ' + head.slice(0, 12) + ' is not green: nightly-backstop concluded neutral');
  });
});

describe('release-cut: cutting, hotfixes and the forward-only stable', () => {
  test('a cut tags, moves stable and publishes; re-running reports nothing new; a hotfix ref promotes a later main commit with a compare link', () => {
    const f = fixture();
    const first = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.plan.sha).toBe(f.shas['1.0.3']);
    const cut = cutRelease(first.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base });
    expect(cut.ok, cut.lines.join('\n')).toBe(true);
    expect(cut.lines).toEqual(['TAG: v1.0.3 -> ' + f.shas['1.0.3']!.slice(0, 12) + ' pushed', 'STABLE: none -> ' + f.shas['1.0.3']!.slice(0, 12), 'RELEASE: v1.0.3 published https://github.com/o/r/releases/tag/v1.0.3']);
    expect(git(f.origin, 'rev-parse', 'refs/heads/stable')).toBe(f.shas['1.0.3']);
    expect(git(f.origin, 'rev-parse', 'v1.0.3^{commit}')).toBe(f.shas['1.0.3']);
    expect(git(f.origin, 'cat-file', '-t', 'v1.0.3')).toBe('tag');
    const create = f.state.calls.find(c => c[0] === 'release' && c[1] === 'create')!;
    expect(create).toContain('--verify-tag');
    expect(fs.readFileSync(create[create.indexOf('--notes-file') + 1]!, 'utf8')).toContain('Fourth trims the preamble.');

    f.refresh();
    const again = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('NOTHING_NEW');

    const hot = f.release('1.0.4', 'Hotfix: the lease never blocks.');
    f.refresh();
    const promo = planRelease({ repo: f.repo, ref: hot, git: f.git, gh: f.gh, now: pastFloor });
    expect(promo.ok, JSON.stringify(promo)).toBe(true);
    if (!promo.ok) return;
    expect(promo.plan.hotfix).toBe(true);
    expect(promo.plan.prevStable).toBe(f.shas['1.0.3']);
    expect(promo.plan.prevTag).toBe('v1.0.3');
    expect(promo.plan.notes).toContain('## gstack v1.0.4 (hotfix release)');
    expect(promo.plan.notes).toContain('1 version since v1.0.3');
    expect(promo.plan.notes).toContain('compare/v1.0.3...v1.0.4');
    expect(promo.plan.notes).toContain('- **1.0.4**');
    expect(promo.plan.notes).not.toContain('- **1.0.3**');
    const cut2 = cutRelease(promo.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base });
    expect(cut2.ok, cut2.lines.join('\n')).toBe(true);
    expect(git(f.origin, 'rev-parse', 'refs/heads/stable')).toBe(hot);
    f.refresh();
    const redo = cutRelease(promo.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base });
    expect(redo.lines).toEqual(['TAG: v1.0.4 already names ' + hot.slice(0, 12), 'STABLE: ' + f.shas['1.0.3']!.slice(0, 12) + ' -> ' + hot.slice(0, 12), 'RELEASE: v1.0.4 already published']);
  });

  // Value: protects=a cut that pushed the tag and stable but failed to create the release is finished by the next run (same commit, notes against the release
  // before, release created) instead of being refused as 'already stable' forever; fails_when=planRelease drops stable itself from the candidates, the notes
  // compare the commit with itself, or a finished cut is cut again; why_new=the cut test re-runs only a completed cut (NOTHING_NEW); seam=none; no_claim=none beyond protects
  test('a cut that stopped after pushing the tag and stable is finished by the next run, by window or by --ref', () => {
    const f = fixture();
    f.state.createFails = 'v1.0.3';
    const first = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const half = cutRelease(first.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base });
    expect(half.ok).toBe(false);
    expect(half.lines.at(-1)).toContain('RELEASE: create failed: HTTP 502');
    expect(git(f.origin, 'rev-parse', 'refs/heads/stable')).toBe(f.shas['1.0.3']);
    delete f.state.createFails;

    f.refresh();
    let resumed = first.plan;
    for (const ref of [undefined, f.shas['1.0.3']]) {
      const again = planRelease({ repo: f.repo, ref, git: f.git, gh: f.gh });
      expect(again.ok, JSON.stringify(again)).toBe(true);
      if (!again.ok) return;
      resumed = again.plan;
      expect(again.plan.sha).toBe(f.shas['1.0.3']);
      expect(again.plan.stableAt).toBe(true);
      expect(again.plan.tagExists).toBe('same');
      expect(again.plan.prevVersion).toBeNull();
      expect(again.plan.notes).toContain('First tagged release: the 4 versions, one line each');
      expect(describePlan(again.plan, true)[2]).toBe('STABLE: already at ' + f.shas['1.0.3']!.slice(0, 12) + ' (finishing an earlier cut)');
    }
    const done = cutRelease(resumed, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base });
    expect(done.ok, done.lines.join('\n')).toBe(true);
    expect(done.lines).toEqual(['TAG: v1.0.3 already names ' + f.shas['1.0.3']!.slice(0, 12), 'STABLE: already at ' + f.shas['1.0.3']!.slice(0, 12), 'RELEASE: v1.0.3 published https://github.com/o/r/releases/tag/v1.0.3']);

    // A later half-done cut reads its notes against the release before it.
    f.state.createFails = 'v1.0.4';
    const hot = f.release('1.0.4', 'Hotfix: the lease never blocks.');
    f.refresh();
    const promo = planRelease({ repo: f.repo, ref: hot, git: f.git, gh: f.gh, now: pastFloor });
    expect(promo.ok).toBe(true);
    if (!promo.ok) return;
    expect(cutRelease(promo.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base }).ok).toBe(false);
    delete f.state.createFails;
    f.refresh();
    const finish = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(finish.ok, JSON.stringify(finish)).toBe(true);
    if (!finish.ok) return;
    expect(finish.plan.sha).toBe(hot);
    expect(finish.plan.prevTag).toBe('v1.0.3');
    expect(finish.plan.notes).toContain('1 version since v1.0.3');
    expect(finish.plan.notes).toContain('compare/v1.0.3...v1.0.4');
    expect(finish.plan.notes).not.toContain('- **1.0.3**');
    const once = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(cutRelease(finish.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base }).ok).toBe(true);
    expect(once.ok).toBe(true);
    f.refresh();
    const nothing = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(nothing.ok).toBe(false);
    if (!nothing.ok) expect(nothing.message).toBe('origin/main ' + hot.slice(0, 12) + ' is already released as v1.0.4; nothing newer is green');
  });

  test('stable never moves backwards, a side-branch ref is refused, and a tag naming another commit is refused', () => {
    const f = fixture();
    git(f.seed, 'push', '-q', 'origin', f.shas['1.0.2'] + ':refs/heads/stable');
    f.refresh();
    const back = planRelease({ repo: f.repo, ref: f.shas['1.0.1'], git: f.git, gh: f.gh });
    expect(back.ok).toBe(false);
    if (!back.ok) { expect(back.code).toBe('REFUSED'); expect(back.message).toContain('non-fast-forward'); }

    // Value: protects=a hotfix --ref that is not green or not a commit is REFUSED (exit 1 in the workflow), never promoted; fails_when=--ref skips the gate or an unknown
    // ref falls through to the window; why_new=the hotfix test promotes a green ref only and the side-branch case covers first-parent, not the gate; seam=none;
    // no_claim=none beyond protects
    f.state.checks[f.shas['1.0.3']!] = backstop('completed', 'failure');
    const red = planRelease({ repo: f.repo, ref: f.shas['1.0.3'], git: f.git, gh: f.gh });
    expect(red.ok).toBe(false);
    if (!red.ok) { expect(red.code).toBe('REFUSED'); expect(red.message).toBe('--ref ' + f.shas['1.0.3']!.slice(0, 12) + ' is not green: ' + BACKSTOP_CHECK + ' concluded failure'); }
    const unknown = planRelease({ repo: f.repo, ref: 'f'.repeat(40), git: f.git, gh: f.gh });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) { expect(unknown.code).toBe('REFUSED'); expect(unknown.message).toContain('is not a commit here'); }
    delete f.state.checks[f.shas['1.0.3']!];

    git(f.seed, 'checkout', '-q', '-b', 'side', f.shas['1.0.3']!);
    fs.writeFileSync(path.join(f.seed, 'side.txt'), 'x');
    git(f.seed, 'add', '-A'); git(f.seed, 'commit', '-q', '-m', 'side');
    const side = git(f.seed, 'rev-parse', 'HEAD');
    git(f.seed, 'push', '-q', 'origin', 'side');
    f.refresh();
    const off = planRelease({ repo: f.repo, ref: side, git: f.git, gh: f.gh });
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.message).toContain("not on main's first-parent history");

    git(f.seed, 'tag', 'v1.0.3', f.shas['1.0.0']!);
    git(f.seed, 'push', '-q', 'origin', 'refs/tags/v1.0.3');
    f.refresh();
    const clash = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.message).toContain('tag v1.0.3 already names');
  });
});

describe.skipIf(process.platform === 'win32')('release-cut: the workflow entry point', () => {
  // Value: protects=the CLI weekly-release.yml runs: --dry-run plans, prints CANDIDATE/DRY_RUN lines, appends the plan and notes to --summary and pushes nothing,
  // exits 0 on NOTHING_NEW, 1 on REFUSED and 2 without --repo; fails_when=an argument is misread, an exit code flips so the workflow goes red on a quiet week or
  // green on a refusal, or a dry run pushes; why_new=every other test calls the exported functions, never the argv/exit/summary boundary the workflow uses; seam=none;
  // no_claim=GitHub's API or a real gh (a gh shim answers from PATH; the git side is a real bare origin)
  test('--dry-run plans and pushes nothing, the summary carries the plan and notes, and the exit codes are the workflow contract', () => {
    const f = fixture();
    const shim = path.join(f.base, 'shim');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'gh'), '#!/usr/bin/env bash\necho "gh $*" >> "' + path.join(f.base, 'gh.log') + '"\ncase "$*" in\n  *check-runs*) echo \'' + JSON.stringify([{ check_runs: GREEN }]) + '\' ;;\n  "release view v1.0.3 "*) echo \'{\"tagName\":\"v1.0.3\"}\' ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
    const run = (...args: string[]) => spawnSync(process.execPath, [...bunIsolationArgs(), 'run', path.join(path.resolve(import.meta.dir, '..'), 'scripts', 'release-cut.ts'), ...args],
      { cwd: f.work, encoding: 'utf8', timeout: 60_000, env: cliEnv(shim) });

    const summary = path.join(f.base, 'summary.md');
    const dry = run('--repo', f.repo, '--dry-run', '--summary', summary);
    expect(dry.status, dry.stdout + dry.stderr).toBe(0);
    expect(dry.stdout).toContain('CANDIDATE: ' + f.shas['1.0.3'] + ' (');
    expect(dry.stdout).toContain('VERSION: 1.0.3 -> tag v1.0.3');
    expect(dry.stdout).toContain('DRY_RUN: nothing pushed, nothing created.');
    expect(dry.stdout).not.toContain('--- notes ---');
    const written = fs.readFileSync(summary, 'utf8');
    expect(written).toContain('- CANDIDATE: ' + f.shas['1.0.3']);
    expect(written).toContain('<details><summary>Release notes</summary>');
    expect(written).toContain('- **1.0.3** (2026-10-23): Fourth trims the preamble.');
    expect(execFileSync('git', ['ls-remote', f.origin, 'refs/heads/stable', 'refs/tags/v1.0.3'], { encoding: 'utf8', timeout: 30_000 }).trim()).toBe('');
    expect(fs.readFileSync(path.join(f.base, 'gh.log'), 'utf8')).not.toContain('gh release');

    const usage = run('--dry-run');
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('usage: release-cut.ts --repo owner/name');

    git(f.seed, 'tag', 'v1.0.3', f.shas['1.0.3']!);
    git(f.seed, 'push', '-q', 'origin', 'refs/tags/v1.0.3', f.shas['1.0.3'] + ':refs/heads/stable');
    f.refresh();
    const quiet = run('--repo', f.repo, '--dry-run');
    expect(quiet.status, quiet.stdout + quiet.stderr).toBe(0);
    expect(quiet.stdout.split('\n')[0]).toBe('NOTHING_NEW: origin/main ' + f.shas['1.0.3']!.slice(0, 12) + ' is already released as v1.0.3; nothing newer is green');

    const refused = run('--repo', f.repo, '--dry-run', '--ref', f.shas['1.0.1']!);
    expect(refused.status).toBe(1);
    expect(refused.stdout).toContain('REFUSED: non-fast-forward');

    // Nothing green: the real cut goes red (exit 1), a dry run has answered (exit 0) and names every skip.
    fs.writeFileSync(path.join(shim, 'gh'), '#!/usr/bin/env bash\ncase "$*" in\n  *check-runs*) echo \'' + JSON.stringify([{ check_runs: GREEN.filter(c => c.name !== BACKSTOP_CHECK) }]) + '\' ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
    git(f.seed, 'push', '-q', '--delete', 'origin', 'stable', 'refs/tags/v1.0.3');
    f.refresh(); git(f.work, 'tag', '-d', 'v1.0.3');
    const noneDry = run('--repo', f.repo, '--dry-run');
    expect(noneDry.status, noneDry.stdout + noneDry.stderr).toBe(0);
    expect(noneDry.stdout.split('\n')[0]).toContain('NO_GREEN_COMMIT: no green commit among 4 on origin/main');
    expect(noneDry.stdout).toContain('SKIPPED: ' + f.shas['1.0.3']!.slice(0, 12) + ': no ' + BACKSTOP_CHECK + ' check run');
    const noneCut = run('--repo', f.repo);
    expect(noneCut.status).toBe(1);
    expect(execFileSync('git', ['ls-remote', f.origin, 'refs/heads/stable', 'refs/tags/*'], { encoding: 'utf8', timeout: 30_000 }).trim()).toBe('');
  });
});

const H = 3_600_000;
const isoZ = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Cut 1.0.3 for real (an annotated tag dated now); returns the floor's anchor, the tag time. */
function cutFirst(f: ReturnType<typeof fixture>) {
  const first = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
  if (!first.ok) throw new Error(JSON.stringify(first));
  const cut = cutRelease(first.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base });
  if (!cut.ok) throw new Error(cut.lines.join('\n'));
  f.refresh();
  const moved = stableMovedAt(f.git, f.gh, f.repo, f.shas['1.0.3']!);
  if (moved.at === null) throw new Error(moved.why);
  return moved.at;
}

describe('release-cut: the 72-hour floor', () => {
  // Value: protects=Garry's rule that stable moves at most once per 72 h (2026-10-27), measured from the tag time of the release stable points at, with a 3 h
  // cron-jitter grace for scheduled runs only; fails_when=a hand cut lands before 72:00, a scheduled run before 69:00, the grace leaks to hand-run cuts, or a
  // refusal loses its code or NEXT_ALLOWED; why_new=no floor existed; seam=now is injected, the tag time is read back from the real annotated tag; no_claim=GitHub's cron timing
  test('a cut inside 72 h is REFUSED_FLOOR with both next-allowed times; 72:00 clears a hand cut, 69:00 a scheduled run, and the grace is schedule-only', () => {
    const f = fixture();
    const at = cutFirst(f);
    f.release('1.0.4', 'Later work.');
    f.refresh();
    const plan = (hours: number, scheduled = false) => planRelease({ repo: f.repo, git: f.git, gh: f.gh, scheduled, now: () => at + hours * H });

    const early = plan(FLOOR_HOURS - 1 / 3600);
    expect(early.ok).toBe(false);
    if (early.ok) return;
    expect(early.code).toBe('REFUSED_FLOOR');
    expect(early.message).toStartWith('stable moved to v1.0.3 at ' + isoZ(at) + ', 72.0 h ago; a hand-run cut needs 72 h;');
    expect(early.message).toContain('--security "<GHSA-…|CVE-…|#n>: why" --ref <fix sha>');
    expect(early.next).toBe(isoZ(at + 72 * H) + ' for a hand-run cut; ' + isoZ(at + 69 * H) + ' for a scheduled run');
    expect(early.plan!.sha).toBe(f.shas['1.0.4']);
    expect(early.plan!.floor.line).toBe('FLOOR: refused');

    const onTime = plan(FLOOR_HOURS);
    expect(onTime.ok, JSON.stringify(onTime)).toBe(true);
    if (onTime.ok) expect(onTime.plan.floor).toEqual({ verdict: 'clear', line: 'FLOOR: clear (stable moved to v1.0.3 at ' + isoZ(at) + ', 72.0 h ago; a hand-run cut needs 72 h)' });

    expect(SCHEDULED_GRACE_HOURS).toBe(3);
    const schedEarly = plan(FLOOR_HOURS - SCHEDULED_GRACE_HOURS - 1 / 3600, true);
    expect(schedEarly.ok).toBe(false);
    if (!schedEarly.ok) { expect(schedEarly.code).toBe('REFUSED_FLOOR'); expect(schedEarly.message).toContain('a scheduled run needs 69 h (72 h less 3 h cron grace)'); }
    const schedOk = plan(FLOOR_HOURS - SCHEDULED_GRACE_HOURS, true);
    expect(schedOk.ok, JSON.stringify(schedOk)).toBe(true);
    if (schedOk.ok) expect(schedOk.plan.notes).toContain('## gstack v1.0.4 (regular release)');
    const handInGrace = plan(70);
    expect(handInGrace.ok).toBe(false);
    if (!handInGrace.ok) expect(handInGrace.code).toBe('REFUSED_FLOOR');
  });

  // Value: protects=the floor's anchor is the annotated v<VERSION> tag on stable or its later release publish time, a stable it cannot date fails closed,
  // and the first cut and a finishing cut are not held; fails_when=a lightweight tag, an extra tag or the commit date stands in for the move, a delayed
  // release is ignored, or FLOOR_UNKNOWN passes; why_new=no floor existed; seam=gh release view is faked; no_claim=none beyond protects
  test('stableMovedAt: annotated tags only, the later release publish time wins; an undatable stable is FLOOR_UNKNOWN; the first and a finishing cut skip the floor', () => {
    const f = fixture();
    git(f.seed, 'tag', 'v1.0.2', f.shas['1.0.2']!);
    git(f.seed, 'push', '-q', 'origin', 'refs/tags/v1.0.2', f.shas['1.0.2'] + ':refs/heads/stable');
    f.refresh();
    const unknown = planRelease({ repo: f.repo, git: f.git, gh: f.gh, now: pastFloor });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.code).toBe('FLOOR_UNKNOWN');
      expect(unknown.message).toBe('no annotated v1.0.2 tag points at stable ' + f.shas['1.0.2']!.slice(0, 12) + ', so its last move cannot be dated; only a --security cut can move it until one does');
      expect(unknown.next).toBe('none until an annotated v<VERSION> tag dates the release stable points at');
    }
    // Value: protects=FLOOR_UNKNOWN's promise that a verified --security cut still moves an undatable stable; fails_when=the unknown branch returns before
    // the security check, stranding a security fix until someone hand-tags stable; why_new=the security test always starts from a dated stable; seam=none;
    // no_claim=verifySecurity (floorStatus takes the verified flag)
    expect(floorStatus({ git: f.git, gh: f.gh, repo: f.repo, prevStable: f.shas['1.0.2']!, sha: f.shas['1.0.3']!, exception: 'security', scheduled: false, now: pastFloor() }))
      .toEqual({ verdict: 'security', line: 'FLOOR: bypassed by the security exception (no annotated v1.0.2 tag points at stable ' + f.shas['1.0.2']!.slice(0, 12) + ', so its last move cannot be dated)' });

    git(f.seed, 'push', '-q', '--delete', 'origin', 'refs/tags/v1.0.2');
    git(f.work, 'tag', '-d', 'v1.0.2');
    git(f.seed, 'tag', '-d', 'v1.0.2');
    execFileSync('git', ['tag', '-a', 'v1.0.2', f.shas['1.0.2']!, '-m', 'gstack v1.0.2'], { cwd: f.seed, timeout: 30_000, env: { ...process.env, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_COMMITTER_DATE: '2026-10-20T10:00:00Z' } });
    git(f.seed, 'push', '-q', 'origin', 'refs/tags/v1.0.2');
    f.refresh();
    expect(stableMovedAt(f.git, f.gh, f.repo, f.shas['1.0.2']!)).toEqual({ at: Date.parse('2026-10-20T10:00:00Z'), tag: 'v1.0.2', published: false });
    const late: Gh = (args) => args[0] === 'release' && args[1] === 'view' && args[2] === 'v1.0.2' ? { status: 0, stdout: '{"publishedAt":"2026-10-21T09:30:00Z"}', stderr: '' } : f.gh(args);
    expect(stableMovedAt(f.git, late, f.repo, f.shas['1.0.2']!)).toEqual({ at: Date.parse('2026-10-21T09:30:00Z'), tag: 'v1.0.2', published: true });
    const held = planRelease({ repo: f.repo, git: f.git, gh: late, now: () => Date.parse('2026-10-24T09:00:00Z') });
    expect(held.ok).toBe(false);
    if (!held.ok) expect(held.next).toStartWith('2026-10-24T09:30:00Z for a hand-run cut');

    const base = { git: f.git, gh: f.gh, repo: f.repo, exception: null, scheduled: false, now: Date.now() };
    expect(floorStatus({ ...base, prevStable: null, sha: f.shas['1.0.3']! }).verdict).toBe('first');
    expect(floorStatus({ ...base, prevStable: f.shas['1.0.2']!, sha: f.shas['1.0.2']! }).verdict).toBe('finishing');

    // A newer hand-made annotated tag on stable, with no release, neither dates the move nor pins later runs to stable (a silent NOTHING_NEW stall).
    execFileSync('git', ['tag', '-a', 'v1.0.2-rc', f.shas['1.0.2']!, '-m', 'again'], { cwd: f.seed, timeout: 30_000, env: { ...process.env, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_COMMITTER_DATE: '2026-10-22T08:00:00Z' } });
    git(f.seed, 'push', '-q', 'origin', 'refs/tags/v1.0.2-rc');
    f.refresh();
    expect(stableMovedAt(f.git, late, f.repo, f.shas['1.0.2']!)).toEqual({ at: Date.parse('2026-10-21T09:30:00Z'), tag: 'v1.0.2', published: true });
    const pastStray = planRelease({ repo: f.repo, git: f.git, gh: late, now: () => Date.parse('2026-10-25T10:00:00Z') });
    expect(pastStray.ok, JSON.stringify(pastStray)).toBe(true);
    if (pastStray.ok) expect(pastStray.plan.tag).toBe('v1.0.3');
  });

  // Value: protects=the stable push is conditioned on the stable the floor read, so two overlapping cuts cannot both move it; fails_when=the push is a plain
  // fast-forward that succeeds over a move made after planning; why_new=cuts never raced before the floor made the move time matter; seam=none (real bare origin);
  // no_claim=none beyond protects
  // Value: protects=a cut whose tag was pushed long before stable moved (a failed stable push, retried later) is still held by the floor and is dated by
  // its release, not by the old tag; fails_when=the old tag time lets the next cut through early or the retry skips the floor; why_new=the half-done tests
  // cover a missing release only; seam=gh release view is faked; no_claim=none beyond protects
  test('a tag pushed earlier without moving stable is held by the floor, and once promoted its release publish time dates the move', () => {
    const f = fixture();
    const at = cutFirst(f);
    const hot = f.release('1.0.4', 'Later work.');
    execFileSync('git', ['tag', '-a', 'v1.0.4', hot, '-m', 'gstack v1.0.4 (regular release)'], { cwd: f.seed, timeout: 30_000, env: { ...process.env, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } });
    git(f.seed, 'push', '-q', 'origin', 'refs/tags/v1.0.4');
    f.refresh();
    const held = planRelease({ repo: f.repo, ref: hot, git: f.git, gh: f.gh, now: () => at + 10 * H });
    expect(held.ok).toBe(false);
    if (!held.ok) { expect(held.code).toBe('REFUSED_FLOOR'); expect(held.plan!.tagExists).toBe('same'); }
    const promo = planRelease({ repo: f.repo, ref: hot, git: f.git, gh: f.gh, now: () => at + 72 * H });
    expect(promo.ok, JSON.stringify(promo)).toBe(true);
    if (!promo.ok) return;
    const cut = cutRelease(promo.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base });
    expect(cut.lines).toEqual(['TAG: v1.0.4 already names ' + hot.slice(0, 12), 'STABLE: ' + f.shas['1.0.3']!.slice(0, 12) + ' -> ' + hot.slice(0, 12), 'RELEASE: v1.0.4 published https://github.com/o/r/releases/tag/v1.0.4']);
    f.refresh();
    const published = isoZ(at + 72 * H);
    const viaRelease: Gh = (args) => args[0] === 'release' && args[1] === 'view' && args[2] === 'v1.0.4' ? { status: 0, stdout: JSON.stringify({ publishedAt: published }), stderr: '' } : f.gh(args);
    expect(stableMovedAt(f.git, viaRelease, f.repo, hot)).toEqual({ at: Date.parse(published), tag: 'v1.0.4', published: true });
    f.release('1.0.5', 'Even later.');
    f.refresh();
    const next = planRelease({ repo: f.repo, git: f.git, gh: viaRelease, now: () => at + 100 * H });
    expect(next.ok).toBe(false);
    if (!next.ok) { expect(next.code).toBe('REFUSED_FLOOR'); expect(next.message).toStartWith('stable moved to v1.0.4 at ' + published + ', 28.0 h ago'); }
  });

  // Value: protects=the floor fails closed when the move cannot be dated: a release that cannot be read is FLOOR_UNKNOWN, a stable whose release was never
  // published is finished before stable moves again, and a future-dated tag holds from now; fails_when=a transient gh failure or a half-done cut lets the
  // floor fall back to an old tag date; why_new=both adversarial reviews reproduced that bypass; seam=gh is faked; no_claim=none beyond protects
  test('an unreadable release is FLOOR_UNKNOWN; an unpublished stable release is finished first; a future-dated tag holds from now', () => {
    const f = fixture();
    const at = cutFirst(f);
    const hot = f.release('1.0.4', 'Later work.');
    f.refresh();
    const flaky: Gh = (args) => args[0] === 'release' && args[1] === 'view' ? { status: 1, stdout: '', stderr: 'HTTP 503: Service Unavailable' } : f.gh(args);
    const unread = planRelease({ repo: f.repo, git: f.git, gh: flaky, now: () => at + 100 * H });
    expect(unread.ok).toBe(false);
    if (!unread.ok) { expect(unread.code).toBe('FLOOR_UNKNOWN'); expect(unread.message).toStartWith('cannot read the release for v1.0.3 (HTTP 503: Service Unavailable), so its last move cannot be dated'); }

    // stable moved to 1.0.4 but its release failed: the next window run finishes 1.0.4 instead of moving on to 1.0.5.
    f.state.createFails = 'v1.0.4';
    const promo = planRelease({ repo: f.repo, ref: hot, git: f.git, gh: f.gh, now: () => at + 72 * H });
    expect(promo.ok).toBe(true);
    if (!promo.ok) return;
    expect(cutRelease(promo.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base }).ok).toBe(false);
    delete f.state.createFails;
    const newer = f.release('1.0.5', 'Even later.');
    f.refresh();
    const finish = planRelease({ repo: f.repo, git: f.git, gh: f.gh, now: () => at + 100 * H });
    expect(finish.ok, JSON.stringify(finish)).toBe(true);
    if (finish.ok) { expect(finish.plan.sha).toBe(hot); expect(finish.plan.floor.verdict).toBe('finishing'); }
    const past = planRelease({ repo: f.repo, ref: newer, git: f.git, gh: f.gh, now: () => at + 200 * H });
    expect(past.ok).toBe(false);
    if (!past.ok) { expect(past.code).toBe('FLOOR_UNKNOWN'); expect(past.message).toBe('stable moved to v1.0.4 but its release is not published, so the tag cannot date the move; finish that cut first (a run without --ref finishes it)'); }

    const future = floorStatus({ git: f.git, gh: (args) => args[0] === 'release' ? { status: 0, stdout: JSON.stringify({ publishedAt: '2099-01-01T00:00:00Z' }), stderr: '' } : f.gh(args), repo: f.repo, prevStable: hot, sha: newer, exception: null, scheduled: false, now: at });
    expect(future.verdict).toBe('refused');
    expect(future.next).toStartWith(isoZ(at + 72 * H) + ' for a hand-run cut');
  });

  test('cutRelease refuses to push a stable that the candidate does not descend from', () => {
    const f = fixture();
    git(f.seed, 'push', '-q', 'origin', f.shas['1.0.2'] + ':refs/heads/stable');
    f.refresh();
    const planned = planRelease({ repo: f.repo, ref: f.shas['1.0.3'], git: f.git, gh: f.gh, security: undefined });
    const plan = planned.ok ? planned.plan : planned.plan!;
    const cut = cutRelease({ ...plan, sha: f.shas['1.0.1']!, tag: 'v1.0.1', stableAt: false, prevStable: f.shas['1.0.2']! }, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base });
    expect(cut.ok).toBe(false);
    expect(cut.lines.at(-1)).toBe('STABLE: refused: ' + f.shas['1.0.1']!.slice(0, 12) + ' does not descend from stable ' + f.shas['1.0.2']!.slice(0, 12));
    expect(git(f.origin, 'rev-parse', 'refs/heads/stable')).toBe(f.shas['1.0.2']);
  });

  test('a stable that moved after planning fails the push with a lease error and stays where the other cut put it', () => {
    const f = fixture();
    const planned = planRelease({ repo: f.repo, git: f.git, gh: f.gh });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    git(f.seed, 'push', '-q', 'origin', f.shas['1.0.1'] + ':refs/heads/stable');
    const cut = cutRelease(planned.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base });
    expect(cut.ok).toBe(false);
    expect(cut.lines.at(-1)).toStartWith('STABLE: push failed (stable moved since this plan read it, or the push was rejected): ');
    expect(git(f.origin, 'rev-parse', 'refs/heads/stable')).toBe(f.shas['1.0.1']);
  });
});

describe('release-cut: the security exception', () => {
  // Value: protects=a security cut passes the floor only with --ref and a reason the tool ties to the released commits (a commit naming the GHSA/CVE, a
  // security-labelled #n a commit references, or an advisory whose package changes in package.json/bun.lock), its reason reaches the tag and the notes, a
  // retry recovers it from the tag, and the next regular cut lists the versions since it; fails_when=a free-text reason or one naming an unrelated id
  // bypasses the floor, a security cut runs without --ref, or the notes misstate either release; why_new=no exception existed; seam=gh advisories and
  // issues are faked; no_claim=that the change fixes the advisory (attested)
  test('verified reasons bypass the floor; unverifiable ones are REFUSED_SECURITY; the reason survives a retry; the next regular cut starts at the security release', () => {
    const f = fixture();
    const at = cutFirst(f);
    const fix = f.release('1.0.4', 'Hardens tar extraction.', { message: 'v1.0.4: harden tar paths (GHSA-2345-cfgh-jmpq)' });
    const labelled = f.release('1.0.5', 'Escapes the summary.', { message: 'v1.0.5 (#77)' });
    const bump = f.release('1.0.6', 'Bumps left-pad.', { message: 'chore(deps): bump left-pad', files: { 'package.json': '{\n  "dependencies": {\n    "left-pad": "1.3.0"\n  }\n}\n' } });
    f.refresh();
    const now = () => at + H;
    const sec = (ref: string | undefined, reason: string) => planRelease({ repo: f.repo, ref, git: f.git, gh: f.gh, now, security: reason });

    const noRef = sec(undefined, 'GHSA-2345-cfgh-jmpq: tar path traversal');
    expect(noRef.ok).toBe(false);
    if (!noRef.ok) expect(noRef).toMatchObject({ code: 'REFUSED_SECURITY', message: '--security needs --ref <the fix commit>: a security cut releases up to the fix, never whatever is newest' });
    const bare = sec(fix, 'urgent, trust me');
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare).toMatchObject({ code: 'REFUSED_SECURITY', message: 'the reason names no GHSA-…, CVE-… or #<n> to verify' });
    const unrelated = sec(fix, 'CVE-2026-12345 in tar');
    expect(unrelated.ok).toBe(false);
    if (!unrelated.ok) expect(unrelated.message).toBe('nothing in ' + f.shas['1.0.3']!.slice(0, 12) + '..' + fix.slice(0, 12) + ' ties the reason to the release: CVE-2026-12345: no commit names it and the advisory database has no entry for it');
    const unlabelled = sec(labelled, '#77: summary injection');
    expect(unlabelled.ok).toBe(false);
    if (!unlabelled.ok) expect(unlabelled.message).toEndWith('#77: cannot read it');
    const unreferenced = sec(fix, '#78');
    expect(unreferenced.ok).toBe(false);
    if (!unreferenced.ok) expect(unreferenced.message).toEndWith('#78: cannot read it, no commit in the span references it');

    f.state.api = {
      'repos/o/r/issues/77': { labels: [{ name: 'bug' }] },
      'repos/o/r/issues/79': { labels: [{ name: 'Security' }] },
      'advisories/GHSA-9999-xxxx-wwww': { vulnerabilities: [{ package: { name: 'left-pad', ecosystem: 'npm' } }] },
      'advisories?cve_id=CVE-2026-55555': [{ vulnerabilities: [{ package: { name: 'left-pad', ecosystem: 'npm' } }] }],
    };
    const noLabel = sec(labelled, '#77: summary injection');
    if (!noLabel.ok) expect(noLabel.message).toEndWith('#77: no security label');
    f.state.api['repos/o/r/issues/77'] = { labels: [{ name: 'Security' }] };
    const byLabel = sec(labelled, '#77: summary injection');
    expect(byLabel.ok, JSON.stringify(byLabel)).toBe(true);
    if (byLabel.ok) { expect(byLabel.plan.exception!.evidence).toBe('#77 carries the security label and commit ' + labelled.slice(0, 12) + ' references it'); expect(byLabel.plan.ridingAlong).toBe(1); }
    const labelOnly = sec(labelled, '#79');
    if (!labelOnly.ok) expect(labelOnly.message).toEndWith('#79: no commit in the span references it');
    for (const id of ['GHSA-9999-xxxx-wwww', 'CVE-2026-55555']) {
      const byAdvisory = sec(bump, id);
      expect(byAdvisory.ok, JSON.stringify(byAdvisory)).toBe(true);
      if (byAdvisory.ok) expect(byAdvisory.plan.exception!.evidence).toBe('advisory ' + id + ' lists left-pad, which changes in package.json/bun.lock');
    }

    const verified = sec(fix, 'ghsa-2345-CFGH-jmpq: tar\npath traversal \`x\`');
    expect(verified.ok, JSON.stringify(verified)).toBe(true);
    if (!verified.ok) return;
    const reason = 'ghsa-2345-CFGH-jmpq: tar path traversal ' + "'x'";
    expect(verified.plan.exception).toEqual({ kind: 'security', reason, evidence: 'commit ' + fix.slice(0, 12) + ' names GHSA-2345-cfgh-jmpq' });
    expect(verified.plan.floor.verdict).toBe('security');
    expect(verified.plan.ridingAlong).toBe(0);
    expect(verified.plan.notes).toContain('## gstack v1.0.4 (security release)\n\n**Security release:** \`' + reason + '\` (verified: commit ' + fix.slice(0, 12) + ' names GHSA-2345-cfgh-jmpq).');
    expect(describePlan(verified.plan, false)).toEqual(expect.arrayContaining(['SECURITY: `' + reason + '` (verified: commit ' + fix.slice(0, 12) + ' names GHSA-2345-cfgh-jmpq)', 'RIDING_ALONG: 0 other versions ship with the fix']));

    // The release step fails; a scheduled retry with no --security finishes it with the same reason, read back from the tag.
    f.state.createFails = 'v1.0.4';
    expect(cutRelease(verified.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base }).ok).toBe(false);
    delete f.state.createFails;
    expect(git(f.origin, 'cat-file', '-p', 'v1.0.4')).toContain('gstack v1.0.4 (security release)\n\nSecurity: ' + reason + '\nVerified: commit ' + fix.slice(0, 12));
    f.refresh();
    const retry = planRelease({ repo: f.repo, ref: fix, git: f.git, gh: f.gh, now, scheduled: true });
    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    if (!retry.ok) return;
    expect(retry.plan.stableAt).toBe(true);
    expect(retry.plan.exception!.reason).toBe(reason);
    expect(retry.plan.notes).toBe(verified.plan.notes);
    expect(cutRelease(retry.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base }).ok).toBe(true);
    f.refresh();

    // The floor now counts from the security release; the next regular cut lists only what came after it.
    const moved = stableMovedAt(f.git, f.gh, f.repo, fix);
    if (moved.at === null) throw new Error(moved.why);
    const movedAt = moved.at;
    const held = planRelease({ repo: f.repo, git: f.git, gh: f.gh, scheduled: true, now: () => movedAt + 68 * H });
    expect(held.ok).toBe(false);
    if (!held.ok) { expect(held.code).toBe('REFUSED_FLOOR'); expect(held.message).toStartWith('stable moved to v1.0.4 at '); }
    const next = planRelease({ repo: f.repo, git: f.git, gh: f.gh, scheduled: true, now: () => movedAt + 69 * H });
    expect(next.ok, JSON.stringify(next)).toBe(true);
    if (!next.ok) return;
    expect(next.plan.exception).toBeNull();
    expect(next.plan.prevTag).toBe('v1.0.4');
    expect(next.plan.notes).toContain('## gstack v1.0.6 (regular release)');
    expect(next.plan.notes).toContain('2 versions since v1.0.4');
    expect(next.plan.notes).not.toContain('- **1.0.4**');
    expect(next.plan.notes).not.toContain('Security release');
  });

  // Value: protects=a finishing security cut keeps its tag's recorded evidence (no live re-check that a removed label or a gh failure can break), a tag that
  // recorded a security cut but never moved stable cannot pass the floor without an explicit verified --security, and the advisory path counts only npm
  // packages whose own entry changed; fails_when=a forged or stale tag bypasses the floor, finishing is blocked, or a transitive name verifies; why_new=adversarial findings
  // 1, 4 and 5; seam=gh is faked; no_claim=none beyond protects
  test('recorded evidence finishes a security cut; an unmoved security tag needs --security again; advisories match only npm packages whose own entry changed', () => {
    const f = fixture();
    const at = cutFirst(f);
    const fix = f.release('1.0.4', 'Escapes the summary.', { message: 'v1.0.4 (#77)' });
    f.refresh();
    f.state.api = { 'repos/o/r/issues/77': { labels: [{ name: 'security' }] } };
    const sec = planRelease({ repo: f.repo, ref: fix, git: f.git, gh: f.gh, now: () => at + H, security: '#77: summary injection' });
    expect(sec.ok, JSON.stringify(sec)).toBe(true);
    if (!sec.ok) return;
    f.state.createFails = 'v1.0.4';
    expect(cutRelease(sec.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base }).ok).toBe(false);
    delete f.state.createFails;
    f.refresh();
    f.state.api = {};
    const finish = planRelease({ repo: f.repo, git: f.git, gh: f.gh, now: () => at + 2 * H, scheduled: true });
    expect(finish.ok, JSON.stringify(finish)).toBe(true);
    if (finish.ok) expect(finish.plan.exception).toEqual(sec.plan.exception);

    // A security-recorded tag at a commit stable never reached.
    const later = f.release('1.0.5', 'Later.', { message: 'v1.0.5 (#78)' });
    execFileSync('git', ['tag', '-a', 'v1.0.5', later, '-m', 'gstack v1.0.5 (security release)\n\nSecurity: #78: forged\nVerified: nothing'], { cwd: f.seed, timeout: 30_000, env: { ...process.env, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
    git(f.seed, 'push', '-q', 'origin', 'refs/tags/v1.0.5');
    f.refresh();
    const forged = planRelease({ repo: f.repo, ref: later, git: f.git, gh: f.gh, now: () => at + 3 * H, scheduled: true });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged).toMatchObject({ code: 'REFUSED_SECURITY', message: 'tag v1.0.5 records a security cut that has not moved stable; run it again with --security and --ref ' + later.slice(0, 12) + ' so the reason is verified' });

    const lock = '{\n  "packages": {\n    "app": ["app@1.0.0", "", { "dependencies": { "zod": "^3" } }, "sha512-x"],\n  }\n}\n';
    const bump = f.release('1.0.6', 'Bumps app.', { message: 'chore(deps): bump app', files: { 'bun.lock': lock } });
    f.refresh();
    const verify = (api: Record<string, unknown>, reason: string) => { f.state.api = api; return verifySecurity({ reason, git: f.git, gh: f.gh, repo: f.repo, from: later, to: bump }); };
    expect(verify({ 'advisories/GHSA-2222-3333-4444': { vulnerabilities: [{ package: { name: 'zod', ecosystem: 'npm' } }] } }, 'GHSA-2222-3333-4444').ok).toBe(false);
    expect(verify({ 'advisories/GHSA-2222-3333-4444': { vulnerabilities: [{ package: { name: 'app', ecosystem: 'pip' } }] } }, 'GHSA-2222-3333-4444').ok).toBe(false);
    expect(verify({ 'advisories/GHSA-2222-3333-4444': { vulnerabilities: [{ package: { name: 'app', ecosystem: 'npm' } }] } }, 'GHSA-2222-3333-4444'))
      .toEqual({ ok: true, evidence: 'advisory GHSA-2222-3333-4444 lists app, which changes in package.json/bun.lock' });
  });

  test('sanitizeReason keeps one public line: no control characters or backticks, at most 300 characters; #12a and &#13; are not issue numbers', () => {
    expect(sanitizeReason('  CVE-2026-1234:\r\n a\tb \`c\`  ')).toBe("CVE-2026-1234: a b 'c'");
    expect(sanitizeReason('#1 ' + 'x'.repeat(400)).length).toBe(300);
    expect(verifySecurity({ reason: 'see #12a and &#13;', git: () => ({ ok: true, out: '' }), gh: () => ({ status: 1, stdout: '', stderr: '' }), repo: 'o/r', from: null, to: 'f'.repeat(40) }))
      .toEqual({ ok: false, why: 'the reason names no GHSA-…, CVE-… or #<n> to verify' });
  });
});

describe('release-cut: the regression exception', () => {
  // Value: protects=Garry's "Regression" (2026-10-28): a fix for behavior that worked in an earlier stable release passes the floor only with --ref, a
  // regression-labelled #n a released commit references, and exactly one annotated v<X> strictly behind the current stable; it is recorded in the tag and
  // notes like a security cut, a retry recovers it, labels do not cross kinds, and the floor restarts from it; fails_when=a free-text claim, a main-only
  // break (v<X> == stable), an unknown or lightweight tag, a security label or an unreferenced #n bypasses the floor, or the record is lost; why_new=no
  // regression exception existed; seam=gh issues are faked; no_claim=that the behavior really worked in v<X> (attested by the label and the reason)
  test('verified regression reasons bypass a dated floor; every unverifiable claim is REFUSED_REGRESSION; the record survives a retry and restarts the floor', () => {
    const f = fixture();
    const first = cutFirst(f);
    f.release('1.0.4', 'Regular work.');
    f.refresh();
    const second = planRelease({ repo: f.repo, git: f.git, gh: f.gh, now: () => first + 73 * H });
    expect(second.ok, JSON.stringify(second)).toBe(true);
    if (!second.ok) return;
    expect(cutRelease(second.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base }).ok).toBe(true);
    f.refresh();
    const moved = stableMovedAt(f.git, f.gh, f.repo, f.shas['1.0.4']!);
    if (moved.at === null) throw new Error(moved.why);
    const fix = f.release('1.0.5', 'Restores the update check.', { message: 'v1.0.5: restore the update check (#91)' });
    git(f.seed, 'tag', 'v1.0.1', f.shas['1.0.1']!);
    execFileSync('git', ['tag', '-a', 'v1.0.2', f.shas['1.0.2']!, '-m', 'gstack v1.0.2 (regular release)'], { cwd: f.seed, timeout: 30_000, env: { ...process.env, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
    git(f.seed, 'push', '-q', 'origin', 'refs/tags/v1.0.1', 'refs/tags/v1.0.2');
    f.refresh();
    const now = () => moved.at + H;
    const reg = (ref: string | undefined, reason: string, extra: { security?: string } = {}) => planRelease({ repo: f.repo, ref, git: f.git, gh: f.gh, now, regression: reason, ...extra });
    const reason = '#91: the update check stopped running; it worked in v1.0.3.';
    const refused = (r: ReturnType<typeof reg>) => { expect(r.ok).toBe(false); return r.ok ? '' : (expect(r.code).toBe('REFUSED_REGRESSION'), r.message); };

    expect(refused(reg(undefined, reason))).toBe('--regression needs --ref <the fix commit>: a regression cut releases up to the fix, never whatever is newest');
    expect(refused(reg(fix, reason, { security: 'CVE-2026-1: x' }))).toBe('--security and --regression together: a cut carries one exception, so its notes make one claim');
    expect(refused(reg(fix, '#91: the update check broke'))).toBe('the reason must name exactly one earlier stable release v<X> the behavior worked in and the regression-labelled #<n> it fixes (named 0 releases and 1 #<n>)');
    expect(refused(reg(fix, '#91: worked in v1.0.3 and v1.0.2'))).toContain('(named 2 releases and 1 #<n>)');
    expect(refused(reg(fix, 'worked in v1.0.3'))).toContain('(named 1 release and 0 #<n>)');
    expect(refused(reg(fix, '#91: worked in v1.0.4'))).toBe('v1.0.4 is not an earlier stable release: it must sit strictly behind the current stable ' + f.shas['1.0.4']!.slice(0, 12) + ', since a fix for something the current stable still does right needs no exception');
    expect(refused(reg(fix, '#91: worked in v9.9.9'))).toBe('v9.9.9 is not an annotated release tag here, so it cannot be the earlier stable release the behavior worked in');
    expect(refused(reg(fix, '#91: worked in v1.0.1'))).toBe('v1.0.1 is not an annotated release tag here, so it cannot be the earlier stable release the behavior worked in');
    // An annotated tag a half-done cut left behind, with no published release, never ran as stable.
    expect(refused(reg(fix, '#91: worked in v1.0.2'))).toBe('v1.0.2 has no published release, so team installs never ran it as stable');
    f.state.api = { 'repos/o/r/issues/91': { labels: [{ name: 'security' }] }, 'repos/o/r/issues/92': { labels: [{ name: 'regression' }] } };
    expect(refused(reg(fix, reason))).toEndWith('#91: no regression label');
    expect(refused(reg(fix, '#92: worked in v1.0.3'))).toEndWith('#92: no commit in the span references it');
    f.state.api['repos/o/r/issues/91'] = { labels: [{ name: 'Regression' }] };
    const crossed = planRelease({ repo: f.repo, ref: fix, git: f.git, gh: f.gh, now, security: '#91: x' });
    expect(crossed.ok).toBe(false);
    if (!crossed.ok) { expect(crossed.code).toBe('REFUSED_SECURITY'); expect(crossed.message).toEndWith('#91: no security label'); }

    const verified = reg(fix, reason);
    expect(verified.ok, JSON.stringify(verified)).toBe(true);
    if (!verified.ok) return;
    const evidence = '#91 carries the regression label and commit ' + fix.slice(0, 12) + ' references it; v1.0.3 (' + f.shas['1.0.3']!.slice(0, 12) + ') is an earlier stable release';
    expect(verified.plan.exception).toEqual({ kind: 'regression', reason, evidence });
    expect(verified.plan.floor).toEqual({ verdict: 'regression', line: 'FLOOR: bypassed by the regression exception (stable moved to v1.0.4 at ' + isoZ(moved.at) + ', 1.0 h ago)' });
    expect(verified.plan.notes).toContain('## gstack v1.0.5 (regression release)\n\n**Regression release:** \`' + reason + '\` (verified: ' + evidence + ').');
    expect(describePlan(verified.plan, false)).toContain('REGRESSION: \`' + reason + '\` (verified: ' + evidence + ')');

    // The release step fails; a scheduled retry with no flag finishes it with the record read back from the tag.
    f.state.createFails = 'v1.0.5';
    expect(cutRelease(verified.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base }).ok).toBe(false);
    delete f.state.createFails;
    expect(git(f.origin, 'cat-file', '-p', 'v1.0.5')).toContain('gstack v1.0.5 (regression release)\n\nRegression: ' + reason + '\nVerified: ' + evidence);
    f.refresh();
    f.state.api = {};
    const retry = planRelease({ repo: f.repo, git: f.git, gh: f.gh, now: () => moved.at + 2 * H, scheduled: true });
    expect(retry.ok, JSON.stringify(retry)).toBe(true);
    if (!retry.ok) return;
    expect(retry.plan.exception).toEqual(verified.plan.exception);
    expect(cutRelease(retry.plan, { repo: f.repo, git: f.git, gh: f.gh, notesDir: f.base }).ok).toBe(true);
    f.refresh();

    // The floor restarts from the regression release: the next scheduled cut 30 h later is held.
    const later = f.release('1.0.6', 'Later.', { message: 'v1.0.6 (#93)' });
    f.refresh();
    const held = planRelease({ repo: f.repo, git: f.git, gh: f.gh, now: () => moved.at + 32 * H, scheduled: true });
    expect(held.ok).toBe(false);
    if (!held.ok) { expect(held.code).toBe('REFUSED_FLOOR'); expect(held.message).toStartWith('stable moved to v1.0.5 at '); }

    // A regression-recorded tag stable never reached cannot pass with the other flag.
    execFileSync('git', ['tag', '-a', 'v1.0.6', later, '-m', 'gstack v1.0.6 (regression release)\n\nRegression: #93: forged\nVerified: nothing'], { cwd: f.seed, timeout: 30_000, env: { ...process.env, GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } });
    git(f.seed, 'push', '-q', 'origin', 'refs/tags/v1.0.6');
    f.refresh();
    const forged = planRelease({ repo: f.repo, ref: later, git: f.git, gh: f.gh, now: () => moved.at + 3 * H, security: 'CVE-2026-2: x' });
    expect(forged.ok).toBe(false);
    if (!forged.ok) expect(forged).toMatchObject({ code: 'REFUSED_REGRESSION', message: 'tag v1.0.6 records a regression cut that has not moved stable; run it again with --regression and --ref ' + later.slice(0, 12) + ' so the reason is verified' });
    // A different reason than the tag recorded would publish notes the tag (and a later retry) contradicts.
    const other = planRelease({ repo: f.repo, ref: later, git: f.git, gh: f.gh, now: () => moved.at + 3 * H, regression: '#93: worked in v1.0.4: other' });
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other).toMatchObject({ code: 'REFUSED_REGRESSION', message: 'tag v1.0.6 records the regression reason "#93: forged"; run it again with that same reason so the tag and the notes agree' });
  });

  // Value: protects=an undatable stable and the very first cut stay closed to a regression claim (FLOOR_UNKNOWN is security-only; nothing earlier worked
  // before stable existed); fails_when=a regression cut moves a stable whose last move cannot be dated, or anchors to no release; why_new=the security
  // exception alone passed FLOOR_UNKNOWN; seam=none; no_claim=none beyond protects
  test('a regression cut does not pass FLOOR_UNKNOWN, and with no stable yet nothing earlier can have worked', () => {
    const f = fixture();
    git(f.seed, 'push', '-q', 'origin', f.shas['1.0.2'] + ':refs/heads/stable');
    f.refresh();
    expect(floorStatus({ git: f.git, gh: f.gh, repo: f.repo, prevStable: f.shas['1.0.2']!, sha: f.shas['1.0.3']!, exception: 'regression', scheduled: false, now: pastFloor() }).verdict).toBe('unknown');
    expect(verifyRegression({ reason: '#1: worked in v1.0.0', git: f.git, gh: f.gh, repo: f.repo, from: null, to: f.shas['1.0.3']!, stable: null }))
      .toEqual({ ok: false, why: 'there is no stable release yet, so nothing earlier can have worked' });
  });
});

describe.skipIf(process.platform === 'win32')('release-cut: refusals at the workflow entry point', () => {
  // Value: protects=the CLI contract for refusals: REFUSED_FLOOR then NEXT_ALLOWED on the first two lines, the plan after them, nothing pushed, exit 1 for a
  // hand cut and an ::error:: annotation, exit 0 with a ::notice:: on the schedule or a dry run, REFUSED_SECURITY and FLOOR_UNKNOWN red on every trigger,
  // and usage (exit 2) for an empty --security; fails_when=a refusal is silent, exits green on a hand cut, red on a scheduled hold, or pushes; why_new=no
  // refusal codes existed; seam=a gh shim on PATH; no_claim=GitHub's rendering of annotations
  test('refusal lines, annotations and exit codes for hand, scheduled and dry runs', () => {
    const f = fixture();
    const at = cutFirst(f);
    f.release('1.0.4', 'Later work.');
    f.refresh();
    const shim = path.join(f.base, 'shim');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'gh'), '#!/usr/bin/env bash\ncase "$*" in\n  *check-runs*) echo \'' + JSON.stringify([{ check_runs: GREEN }]) + '\' ;;\n  "release view v1.0.3 "*) echo \'{"publishedAt":"' + isoZ(at) + '"}\' ;;\n  *) echo "release not found" >&2; exit 1 ;;\nesac\n', { mode: 0o755 });
    const run = (env: Record<string, string>, ...args: string[]) => spawnSync(process.execPath, [...bunIsolationArgs(), 'run', path.join(path.resolve(import.meta.dir, '..'), 'scripts', 'release-cut.ts'), '--repo', f.repo, ...args],
      { cwd: f.work, encoding: 'utf8', timeout: 60_000, env: cliEnv(shim, env) });
    const stable = () => git(f.origin, 'rev-parse', 'refs/heads/stable');

    const hand = run({});
    expect(hand.status, hand.stdout + hand.stderr).toBe(1);
    const lines = hand.stdout.split('\n');
    expect(lines[0]).toStartWith('REFUSED_FLOOR: stable moved to v1.0.3 at ');
    expect(lines[1]).toMatch(/^NEXT_ALLOWED: \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ for a hand-run cut; \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ for a scheduled run$/);
    expect(lines).toContain('FLOOR: refused');
    expect(hand.stdout).not.toContain('::');
    expect(stable()).toBe(f.shas['1.0.3']);

    const annotated = run({ GITHUB_ACTIONS: 'true' });
    expect(annotated.status).toBe(1);
    expect(annotated.stdout).toContain('::error title=release-cut REFUSED_FLOOR::REFUSED_FLOOR: stable moved to v1.0.3');
    const scheduled = run({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule' });
    expect(scheduled.status, scheduled.stdout).toBe(0);
    expect(scheduled.stdout).toContain('::notice title=release-cut REFUSED_FLOOR::');
    expect(scheduled.stdout).toContain('a scheduled run needs 69 h');
    expect(run({}, '--dry-run').status).toBe(0);
    expect(stable()).toBe(f.shas['1.0.3']);

    const noRef = run({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule' }, '--security', 'CVE-2026-1: x');
    expect(noRef.status).toBe(1);
    expect(noRef.stdout.split('\n')[0]).toBe('REFUSED_SECURITY: --security needs --ref <the fix commit>: a security cut releases up to the fix, never whatever is newest');
    expect(noRef.stdout).toContain('::error title=release-cut REFUSED_SECURITY::');
    // Value: protects=a refusal annotation stays one workflow command: % CR and LF in the message are escaped as %25 %0D %0A; fails_when=the escaping is
    // dropped, so caller-supplied text in --ref or a git error splits the ::error:: line and starts a new workflow command; why_new=every other annotation
    // message here is plain text; seam=none; no_claim=GitHub's rendering of the decoded annotation
    const escaped = run({ GITHUB_ACTIONS: 'true' }, '--ref', 'no%such\r\nref');
    expect(escaped.status).toBe(1);
    expect(escaped.stdout.split('\n').find(l => l.startsWith('::error'))).toStartWith('::error title=release-cut REFUSED::REFUSED: --ref no%25such%0D%0Aref is not a commit here: ');
    expect(run({}, '--security').status).toBe(2);
    expect(run({}, '--security', '--dry-run').status).toBe(2);
    expect(run({}, '--regression').status).toBe(2);
    const regNoRef = run({ GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule' }, '--regression', '#1: worked in v1.0.2');
    expect(regNoRef.status).toBe(1);
    expect(regNoRef.stdout.split('\n')[0]).toBe('REFUSED_REGRESSION: --regression needs --ref <the fix commit>: a regression cut releases up to the fix, never whatever is newest');
    expect(regNoRef.stdout).toContain('::error title=release-cut REFUSED_REGRESSION::');

    git(f.seed, 'push', '-q', 'origin', f.shas['1.0.4'] + ':refs/heads/stable');
    f.release('1.0.5', 'Even later.');
    f.refresh();
    const unknown = run({ GITHUB_EVENT_NAME: 'schedule' });
    expect(unknown.status).toBe(1);
    expect(unknown.stdout.split('\n')[0]).toStartWith('FLOOR_UNKNOWN: no annotated v1.0.4 tag points at stable ' + f.shas['1.0.4']!.slice(0, 12));
    expect(stable()).toBe(f.shas['1.0.4']);
  });
});

describe('release-cut: notes', () => {
  test('changelog headlines are the bold first line of each entry; versions order numerically', () => {
    const entries = changelogEntries('# Changelog\n\n## [1.91.221.0] - 2026-10-25\n\n**The updater no longer skips.** More.\n\n### Fixed\n- x\n\n## [1.91.99.0] - 2026-10-01\n\n| a | b |\n\n**Older.**\n');
    expect(entries).toEqual([{ version: '1.91.221.0', date: '2026-10-25', headline: 'The updater no longer skips.' }, { version: '1.91.99.0', date: '2026-10-01', headline: 'Older.' }]);
    expect(changelogEntries('## [1.0.0] - 2026-01-01\n\nPlain lead with **some** bold.\n')[0]!.headline).toBe('Plain lead with some bold.');
    expect(compareVersions('1.91.221.0', '1.91.99.0')).toBeGreaterThan(0);
    expect(compareVersions('1.91.9.0', '1.91.10.0')).toBeLessThan(0);
  });

  test('a span of a thousand versions stays under the notes cap and says how many were cut', () => {
    const entries = Array.from({ length: 1000 }, (_, i) => ({ version: '1.91.' + (i + 1) + '.0', date: '2026-10-20', headline: 'Headline number ' + i + ' with enough words to take some room in the body.' }));
    const notes = releaseNotes({ repo: 'o/r', version: '1.91.1000.0', date: '2026-10-26', prevVersion: '1.91.0.0', prevTag: null, entries, hotfix: false });
    expect(notes.length).toBeLessThanOrEqual(NOTES_CAP);
    expect(notes).toMatch(/- \.\.\.and \d+ more versions; see CHANGELOG\.md/);
    expect(notes).toContain('1000 versions since v1.91.0.0');
    expect(notes.split('\n')[0]).toBe('## gstack v1.91.1000.0 (regular release)');
  });
});
