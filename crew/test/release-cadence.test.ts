/**
 * release-cadence (free): the daily stable check (docs/releases.md#the-daily-check, R74). decideDaily is
 * the decision table; importantChanges reads important: fragments from the commits that added them;
 * planDaily wires both to planRelease against a real git origin with gh faked.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bunIsolationArgs } from '../../lib/bun-isolation';
import { FLOOR_HOURS, FORCED_AFTER_HOURS, IMPORTANT_FLOOR_HOURS, SCHEDULED_GRACE_HOURS, decideDaily, importantChanges, type DailyInput, type ImportantChange } from '../scripts/release-cadence';
import { gitIn, planDaily, type Gh } from '../scripts/release-cut';

const H = 3_600_000;
// Tuesday 2026-11-10 14:00 UTC: not a regular day.
const TUESDAY = Date.parse('2026-11-10T14:00:00Z');
const MONDAY = Date.parse('2026-11-09T14:00:00Z');
const SEC: ImportantChange = { kind: 'security', path: 'changelog.d/fix.md', commit: 'a'.repeat(40), pr: '4101' };
const input = (o: Partial<DailyInput> & { hours?: number } = {}): DailyInput => {
  const now = o.now ?? TUESDAY;
  return { now, scheduled: false, candidate: 'b'.repeat(40), stableMovedAt: now - (o.hours ?? 30) * H, gatedChanges: true, mainAhead: true, important: [], ungated: [], releasePr: true, ...o };
};

describe('decideDaily', () => {
  // Value: protects=R74's cadence: an important gated change reaches stable once 24 h have passed since stable moved, never sooner, and a day with nothing
  // important is a logged no-op until the 7-day forced cut; fails_when=an important cut fires inside 24 h, waits past it, a quiet day cuts, a week-old stable
  // with gated changes does not, or an ungated change cuts; why_new=stable moved only Mon/Thu; seam=pure; no_claim=GitHub's cron timing
  test('important + 24 h cuts; important under 24 h waits with NEXT_ALLOWED; nothing important under 7 days is a no-op; 7 days + gated cuts; ungated is a no-op', () => {
    const cut = decideDaily(input({ important: [SEC], hours: IMPORTANT_FLOOR_HOURS }));
    expect(cut).toEqual({ action: 'cut', trigger: 'important', lines: ['DAILY: cut (important: security in #4101 (changelog.d/fix.md); stable moved 24.0 h ago, the important floor is 24 h)'] });

    const wait = decideDaily(input({ important: [SEC], hours: IMPORTANT_FLOOR_HOURS - 1 / 3600 }));
    expect(wait.action).toBe('wait');
    expect(wait.trigger).toBeNull();
    expect(wait.lines[0]).toStartWith('DAILY: wait: important: security in #4101');
    expect(wait.lines[1]).toBe('NEXT_ALLOWED: ' + new Date(TUESDAY - (IMPORTANT_FLOOR_HOURS - 1 / 3600) * H + IMPORTANT_FLOOR_HOURS * H).toISOString().replace(/\.\d{3}Z$/, 'Z') + ' (the first daily run after it cuts)');

    const quiet = decideDaily(input({ hours: FORCED_AFTER_HOURS - 1 }));
    expect(quiet.action).toBe('noop');
    expect(quiet.lines[0]).toStartWith('DAILY: no-op: nothing important since stable; stable moved 167.0 h ago;');

    const forced = decideDaily(input({ hours: FORCED_AFTER_HOURS }));
    expect(forced).toEqual({ action: 'cut', trigger: 'forced', lines: ['DAILY: cut (forced: stable moved 168.0 h ago, past the 7-day limit, and main has gated changes)'] });

    const ungated = decideDaily(input({ gatedChanges: false, mainAhead: false, ungated: [SEC], hours: FORCED_AFTER_HOURS + 24 }));
    expect(ungated.action).toBe('noop');
    expect(ungated.lines).toHaveLength(2);
    expect(ungated.lines[0]).toBe('DAILY: no-op: nothing gated since stable (stable moved 192.0 h ago)');
    expect(ungated.lines[1]).toStartWith('IMPORTANT_UNGATED: security in #4101 (changelog.d/fix.md) landed after the candidate');
    // An important change past the candidate never counts toward a cut, only toward the log.
    expect(decideDaily(input({ ungated: [SEC], hours: 30 })).action).toBe('noop');
  });

  // Value: protects=the twice-weekly cut inside the daily run, the 3 h cron grace on every floor for scheduled runs only, and the first cut; fails_when=Mon/Thu
  // stop cutting past 72 h, another day cuts as regular, the grace leaks to hand runs, or a repository with no stable never cuts; why_new=the daily run replaced
  // the Mon/Thu cron; seam=pure; no_claim=none beyond protects
  test('Monday past 72 h is a regular cut and under it a no-op; scheduled runs get 3 h on each floor, hand runs none; no stable yet cuts', () => {
    expect(decideDaily(input({ now: MONDAY, hours: FLOOR_HOURS }))).toMatchObject({ action: 'cut', trigger: 'regular', lines: ['DAILY: cut (regular: Monday, stable moved 72.0 h ago, the regular floor is 72 h)'] });
    expect(decideDaily(input({ now: MONDAY, hours: FLOOR_HOURS - 1 })).action).toBe('noop');
    // Monday at 30 h: the important floor, not the regular one, decides.
    expect(decideDaily(input({ now: MONDAY, hours: 30, important: [SEC] })).trigger).toBe('important');
    expect(decideDaily(input({ now: MONDAY, hours: 30 })).action).toBe('noop');
    expect(decideDaily(input({ hours: FLOOR_HOURS + 1 })).action).toBe('noop');
    expect(SCHEDULED_GRACE_HOURS).toBe(3);
    expect(decideDaily(input({ now: MONDAY, hours: FLOOR_HOURS - 3, scheduled: true })).trigger).toBe('regular');
    expect(decideDaily(input({ important: [SEC], hours: 21, scheduled: true })).trigger).toBe('important');
    expect(decideDaily(input({ important: [SEC], hours: 21 - 1 / 3600, scheduled: true })).action).toBe('wait');
    expect(decideDaily(input({ important: [SEC], hours: 21 })).action).toBe('wait');
    expect(decideDaily(input({ hours: FORCED_AFTER_HOURS - 3, scheduled: true })).trigger).toBe('forced');
    expect(decideDaily(input({ stableMovedAt: null })).trigger).toBe('forced');
    expect(decideDaily(input({ stableMovedAt: null, important: [SEC] })).trigger).toBe('important');
  });

  // Value: protects=the release-PR dependency: a due important or forced cut whose VERSION is already released reports "important change waiting, no release
  // PR" instead of cutting or failing silently; fails_when=the cut proceeds, the report loses its words or the trigger, or a cut that is not due reports it;
  // why_new=no daily path existed; seam=pure; no_claim=that the Captain reads it (crew/docs/captain.md says when to stamp)
  test('a due cut with no release PR is blocked and says which wait it is; an undue one is not', () => {
    const blocked = decideDaily(input({ important: [SEC], releasePr: false }));
    expect(blocked.action).toBe('blocked');
    expect(blocked.trigger).toBe('important');
    expect(blocked.lines[0]).toStartWith('NO_RELEASE_PR: important change waiting, no release PR: the VERSION at candidate bbbbbbbbbbbb is already released (important: security in #4101');
    expect(blocked.lines[0]).toEndWith('the Captain runs gstack-release-stamp open and lands the release PR, and the next daily run cuts');
    expect(decideDaily(input({ hours: FORCED_AFTER_HOURS, releasePr: false })).lines[0]).toStartWith('NO_RELEASE_PR: stable is 7 days old, no release PR:');
    expect(decideDaily(input({ now: MONDAY, hours: FLOOR_HOURS, releasePr: false }))).toMatchObject({ action: 'blocked', trigger: 'regular' });
    expect(decideDaily(input({ important: [SEC], hours: 2, releasePr: false })).action).toBe('wait');
    expect(decideDaily(input({ releasePr: false })).action).toBe('noop');
  });

  // Value: protects=the once-a-week bound's alarm (review d1): a week-old stable whose main moved but holds nothing newer green and gated is STABLE_STALE,
  // blocked, while a week-old stable with nothing new on main is a quiet no-op; fails_when=a stalled gate leaves stable weeks old in silence, or an idle repo
  // goes red; why_new=no daily path existed; seam=pure; no_claim=why the gate holds main
  test('stable 7 days old with main moved but nothing newer gated is STABLE_STALE; with nothing new on main it is a no-op', () => {
    const stale = decideDaily(input({ gatedChanges: false, hours: FORCED_AFTER_HOURS }));
    expect(stale).toMatchObject({ action: 'blocked', trigger: 'forced' });
    expect(stale.lines[0]).toStartWith('STABLE_STALE: stable is 7 days old (stable moved 168.0 h ago) and main has moved');
    expect(decideDaily(input({ gatedChanges: false, mainAhead: false, hours: FORCED_AFTER_HOURS + 100 })).action).toBe('noop');
    expect(decideDaily(input({ gatedChanges: false, hours: FORCED_AFTER_HOURS - 1 })).action).toBe('noop');
  });
});

const roots: string[] = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
const ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x', GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000, env: ENV }).trim();

/** origin.git with v1.0.0 released (an annotated tag dated tagAgeHours ago, stable), and seed to push more. */
function repo(tagAgeHours = 0) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-cadence-'));
  roots.push(root);
  const origin = path.join(root, 'origin.git'), seed = path.join(root, 'seed'), work = path.join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { timeout: 30_000, env: ENV });
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'remote', 'add', 'origin', origin);
  const commit = (message: string, files: Record<string, string | null>) => {
    for (const [file, text] of Object.entries(files)) {
      const at = path.join(seed, file);
      if (text === null) fs.rmSync(at); else { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, text); }
    }
    git(seed, 'add', '-A');
    git(seed, 'commit', '-q', '-m', message);
    git(seed, 'push', '-q', 'origin', 'main');
    return git(seed, 'rev-parse', 'HEAD');
  };
  const base = commit('v1.0.0', { VERSION: '1.0.0\n', 'CHANGELOG.md': '# Changelog\n\n## [1.0.0] - 2026-11-01\n\n**First.**\n', 'changelog.d/README.md': '# fragments\n' });
  execFileSync('git', ['tag', '-a', 'v1.0.0', '-m', 'gstack v1.0.0 (regular release)'], { cwd: seed, timeout: 30_000, env: { ...ENV, GIT_COMMITTER_DATE: new Date(Date.now() - tagAgeHours * H).toISOString() } });
  git(seed, 'push', '-q', 'origin', 'refs/tags/v1.0.0', base + ':refs/heads/stable');
  const refresh = () => {
    if (!fs.existsSync(work)) execFileSync('git', ['clone', '-q', origin, work], { timeout: 30_000, env: ENV });
    git(work, 'fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*');
    git(work, 'fetch', '-q', '--tags', 'origin');
  };
  return { root, origin, seed, work, base, commit, refresh };
}

const GREEN = [{ name: 'free-tests', status: 'completed', conclusion: 'success' }, { name: 'main-backstop', status: 'completed', conclusion: 'success' }];
function fakeGh(pending: Set<string> = new Set()): Gh {
  return (args) => {
    const api = args[0] === 'api' ? args[args.length - 1]! : '';
    const m = /commits\/([0-9a-f]+)\/check-runs/.exec(api);
    if (m) return { status: 0, stdout: JSON.stringify([{ check_runs: pending.has(m[1]!) ? [{ name: 'main-backstop', status: 'in_progress', conclusion: null }] : GREEN }]), stderr: '' };
    if (args[0] === 'release' && args[1] === 'view' && args[2] === 'v1.0.0') return { status: 0, stdout: '{}', stderr: '' };
    return { status: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
  };
}

describe('importantChanges', () => {
  // Value: protects=the marker surviving the release stamp: the daily check reads each fragment at the commit that added it, so the release PR folding and
  // deleting the file does not hide an important change; fails_when=a folded fragment is missed, a fragment before stable counts, an unmarked, invalid or
  // nested file counts, or the PR number is lost; why_new=nothing read fragment history; seam=real git; no_claim=none beyond protects
  test('reads fragments added in the span from history after the release stamp deleted them; skips unmarked, invalid, nested and out-of-span files', () => {
    const r = repo();
    const before = r.commit('older (#1)', { 'changelog.d/old.md': '---\nimportant: blocker\n---\n- old\n' });
    const from = r.commit('stamp 1.0.1 (#2)', { VERSION: '1.0.1\n', 'changelog.d/old.md': null });
    const fix = r.commit('fix the tar path (#4101)', { 'changelog.d/fix.md': '---\nimportant: security\n---\n- tar\n', 'changelog.d/plain.md': '- plain\n', 'changelog.d/bad.md': '---\nimportant: urgent\n---\n- x\n', 'changelog.d/sub/n.md': '---\nimportant: blocker\n---\n- n\n' });
    const to = r.commit('stamp 1.0.2', { VERSION: '1.0.2\n', 'changelog.d/fix.md': null, 'changelog.d/plain.md': null, 'changelog.d/bad.md': null });
    r.refresh();
    const g = gitIn(r.work);
    expect(importantChanges(g, from, to)).toEqual([{ kind: 'security', path: 'changelog.d/fix.md', commit: fix, pr: '4101' }]);
    expect(importantChanges(g, before, from)).toEqual([]);
    expect(importantChanges(g, r.base, from).map(c => c.kind)).toEqual(['blocker']);
    expect(importantChanges(g, to, to)).toEqual([]);
    expect(importantChanges(g, null, to).map(c => c.path).sort()).toEqual(['changelog.d/fix.md', 'changelog.d/old.md']);
  });
});

describe('planDaily', () => {
  // Value: protects=the daily path end to end against real refs: an important fragment plus a landed release PR cuts at 24 h with a plan release-cut can
  // execute, waits under it, reports NO_RELEASE_PR when VERSION is still the released one, and a gated change still pending is IMPORTANT_UNGATED; fails_when=
  // the 72 h floor still binds an important cut, a cut decision comes without a plan, the release-PR test misreads the tag, or a pending commit counts;
  // why_new=no daily path existed; seam=gh faked (check runs, release view), git real; no_claim=GitHub's API shapes beyond what release-cut already reads
  test('important + release PR cuts at 24 h and waits under it; no release PR is blocked; a pending important change is ungated', () => {
    const r = repo();
    r.commit('fix the tar path (#4101)', { 'changelog.d/fix.md': '---\nimportant: security\n---\n- tar\n' });
    r.refresh();
    const g = gitIn(r.work);
    const day = (hours: number, gh = fakeGh()) => planDaily({ repo: 'o/r', git: g, gh, now: () => Date.now() + hours * H });

    const blocked = day(25);
    expect(blocked.planned).toMatchObject({ ok: false, code: 'NO_RELEASE_PR' });
    expect(blocked.decision?.action).toBe('blocked');
    expect(blocked.decision?.lines[0]).toStartWith('NO_RELEASE_PR: important change waiting, no release PR');
    expect(blocked.planned.ok).toBe(false);

    const stamped = r.commit('release 1.0.1', { VERSION: '1.0.1\n', 'changelog.d/fix.md': null });
    r.refresh();
    const cut = day(25);
    expect(cut.decision).toMatchObject({ action: 'cut', trigger: 'important' });
    expect(cut.planned.ok).toBe(true);
    if (cut.planned.ok) { expect(cut.planned.plan.sha).toBe(stamped); expect(cut.planned.plan.tag).toBe('v1.0.1'); }
    expect(day(20).decision).toMatchObject({ action: 'wait' });

    const later = r.commit('lose no data (#4102)', { 'changelog.d/data.md': '---\nimportant: data-loss\n---\n- d\n' });
    r.refresh();
    const pending = day(25, fakeGh(new Set([later])));
    expect(pending.decision?.action).toBe('cut');
    expect(pending.decision?.lines[1]).toStartWith('IMPORTANT_UNGATED: data-loss in #4102');
    if (pending.planned.ok) expect(pending.planned.plan.sha).toBe(stamped);

    // A tag on a commit off the candidate's line is a version stamped twice: REFUSED, which the daily check does not absorb.
    git(r.seed, 'checkout', '-q', '-b', 'side', r.base);
    fs.writeFileSync(path.join(r.seed, 'side.txt'), 'x\n');
    git(r.seed, 'add', '-A'); git(r.seed, 'commit', '-q', '-m', 'side');
    git(r.seed, 'tag', 'v1.0.1');
    git(r.seed, 'push', '-q', 'origin', 'refs/tags/v1.0.1');
    r.refresh();
    const clash = day(25);
    expect(clash.planned).toMatchObject({ ok: false, code: 'REFUSED' });
    expect(clash.decision).toBeNull();
  });

  // Value: protects=the daily check failing closed when its own read of stable's move fails after planRelease cleared the 24 h floor; fails_when=a cleared
  // plan comes back with a null decision, which the CLI would cut on any day with no trigger; why_new=planDaily dates stable separately from planRelease;
  // seam=gh faked (only the last release view fails), git real; no_claim=which gh errors are transient
  test('a plan that clears while the daily check cannot date stable is FLOOR_UNKNOWN, never a cuttable plan with no decision', () => {
    const r = repo();
    r.commit('release 1.0.1', { VERSION: '1.0.1\n' });
    r.refresh();
    const g = gitIn(r.work);
    const green = fakeGh();
    let views = 0, failAt = 0;
    const gh: Gh = (args) => {
      if (args[0] === 'release' && args[1] === 'view' && args[2] === 'v1.0.0' && ++views === failAt) return { status: 1, stdout: '', stderr: 'HTTP 502: Bad Gateway' };
      return green(args);
    };
    const day = () => planDaily({ repo: 'o/r', git: g, gh, now: () => Date.now() + 30 * H });
    const control = day();
    expect(control.planned.ok).toBe(true);
    expect(control.decision).not.toBeNull();
    [failAt, views] = [views, 0];
    const held = day();
    expect(held.planned).toMatchObject({ ok: false, code: 'FLOOR_UNKNOWN' });
    if (!held.planned.ok) expect(held.planned.message).toStartWith('cannot read the release for v1.0.0 (HTTP 502: Bad Gateway)');
    expect(held.decision).toBeNull();
  });
});

describe.skipIf(process.platform === 'win32')('release-cut --daily (the workflow entry point)', () => {
  // Value: protects=the exit-code contract the daily schedule depends on: a quiet day and a wait exit 0 with a notice (no red run every day), an important
  // change waiting on a release PR goes red (a dry run warns and exits 0), a due cut plans and, as a dry run, pushes nothing, and --daily refuses a hand-picked
  // ref; fails_when=a quiet day goes red, NO_RELEASE_PR is silent, a dry run pushes, or --daily accepts --ref; why_new=no daily entry point existed; seam=gh shim on PATH, real bare
  // origin, the stable tag back-dated through GIT_COMMITTER_DATE; no_claim=GitHub's API or a real gh
  test('quiet and waiting days exit 0 with a notice; NO_RELEASE_PR is red (a dry run warns, exit 0); a due cut plans; --daily refuses --ref', () => {
    const r = repo(30);
    const shim = path.join(r.root, 'shim');
    fs.mkdirSync(shim);
    fs.writeFileSync(path.join(shim, 'gh'), '#!/usr/bin/env bash\ncase "$*" in\n  *check-runs*) echo \'' + JSON.stringify([{ check_runs: GREEN }]) + '\' ;;\n  "release view v1.0.0 "*) echo \'{}\' ;;\n  *) exit 1 ;;\nesac\n', { mode: 0o755 });
    const env: Record<string, string | undefined> = { ...process.env, PATH: shim + path.delimiter + process.env.PATH, GITHUB_ACTIONS: 'true' };
    for (const k of ['GITHUB_EVENT_NAME', 'GITHUB_STEP_SUMMARY']) delete env[k];
    const run = (...args: string[]) => spawnSync(process.execPath, [...bunIsolationArgs(), 'run', path.join(path.resolve(import.meta.dir, '..', '..'), 'crew', 'scripts', 'release-cut.ts'), '--repo', 'o/r', ...args],
      { cwd: r.work, encoding: 'utf8', timeout: 60_000, env });

    r.commit('docs (#4100)', { 'changelog.d/docs.md': '- docs\n' });
    r.refresh();
    const quiet = run('--daily');
    expect(quiet.status, quiet.stdout + quiet.stderr).toBe(0);
    expect(quiet.stdout.split('\n')[0]).toStartWith('DAILY: no-op: nothing important since stable; stable moved 30.0 h ago');
    expect(quiet.stdout).toContain('::notice title=release-cut daily::DAILY: no-op');

    r.commit('fix the tar path (#4101)', { 'changelog.d/fix.md': '---\nimportant: security\n---\n- tar\n' });
    r.refresh();
    const blocked = run('--daily');
    expect(blocked.status, blocked.stdout + blocked.stderr).toBe(1);
    expect(blocked.stdout.split('\n')[0]).toStartWith('NO_RELEASE_PR: important change waiting, no release PR');
    expect(blocked.stdout).toContain('::error title=release-cut NO_RELEASE_PR::NO_RELEASE_PR: important change waiting');
    const blockedDry = run('--daily', '--dry-run');
    expect(blockedDry.status, blockedDry.stdout + blockedDry.stderr).toBe(0);
    expect(blockedDry.stdout).toContain('::warning title=release-cut NO_RELEASE_PR::');
    // The plain cut reports the same state as NO_RELEASE_PR: red for a real run, a warning and exit 0 for a dry run (the pull-request dry run against main).
    const plainDry = run('--dry-run');
    expect(plainDry.status, plainDry.stdout + plainDry.stderr).toBe(0);
    expect(plainDry.stdout.split('\n')[0]).toStartWith('NO_RELEASE_PR: tag v1.0.0 already names ' + r.base.slice(0, 12) + ', an earlier commit');
    expect(plainDry.stdout).toContain('::warning title=release-cut NO_RELEASE_PR::');
    const plainCut = run();
    expect(plainCut.status).toBe(1);
    expect(plainCut.stdout).toContain('::error title=release-cut NO_RELEASE_PR::');

    const stamped = r.commit('release 1.0.1', { VERSION: '1.0.1\n', 'changelog.d/fix.md': null, 'changelog.d/docs.md': null });
    r.refresh();
    const due = run('--daily', '--dry-run');
    expect(due.status, due.stdout + due.stderr).toBe(0);
    expect(due.stdout.split('\n')[0]).toStartWith('DAILY: cut (important: security in #4101 (changelog.d/fix.md); stable moved 30.0 h ago');
    expect(due.stdout).toContain('CANDIDATE: ' + stamped + ' (');
    expect(due.stdout).toContain('DRY_RUN: nothing pushed, nothing created.');
    expect(execFileSync('git', ['ls-remote', r.origin, 'refs/tags/v1.0.1'], { encoding: 'utf8', timeout: 30_000 }).trim()).toBe('');

    const fresh = repo(1);
    fresh.commit('fix the tar path (#4101)', { 'changelog.d/fix.md': '---\nimportant: security\n---\n- tar\n' });
    fresh.refresh();
    const wait = spawnSync(process.execPath, [...bunIsolationArgs(), 'run', path.join(path.resolve(import.meta.dir, '..', '..'), 'crew', 'scripts', 'release-cut.ts'), '--repo', 'o/r', '--daily'], { cwd: fresh.work, encoding: 'utf8', timeout: 60_000, env });
    expect(wait.status, wait.stdout + wait.stderr).toBe(0);
    expect(wait.stdout.split('\n')[0]).toStartWith('DAILY: wait: important: security in #4101');
    expect(wait.stdout.split('\n')[1]).toStartWith('NEXT_ALLOWED: ');

    const ref = run('--daily', '--ref', stamped);
    expect(ref.status).toBe(2);
    expect(ref.stderr).toContain('--daily picks its own candidate');
  });
});
