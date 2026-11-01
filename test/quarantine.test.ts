/**
 * gstack-flaky quarantine (GSTA-158 P2): registry refusals, renew and release,
 * `check --base` against git fixtures, expiry, the quarantine attempt budget
 * under the runner's full green verdict (never a false green), missing ids,
 * the registry read from the base branch, and `report` over ledgers.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { addEntry, checkRegistry, emptyRegistry, entryProblems, liveQuarantine, readLedgers, readRegistry, registryProblems, releaseEntry, renewEntry, reportLines, suiteCap, writeRegistry, type AddInput, type Registry } from '../lib/quarantine';
import { renderResult, runFlaky } from '../lib/flaky-run';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-flaky');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-quarantine-'));
const tmp = () => fs.mkdtempSync(path.join(TMP, 't-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const NOW = new Date('2026-10-29T00:00:00Z');
const DAY = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * DAY);
const ids = (n: number, file = 'a.test.ts') => Array.from({ length: n }, (_, i) => `${file}::::t${i}`);
const add = (reg: Registry, id: string, over: Partial<AddInput> = {}, now = NOW) =>
  addEntry(reg, id, { owner: 'garry', ledger: 'https://ledger/1', failureClass: 'timing', reason: 'slow CI disk', evidence: ['https://run/1'], suiteIds: ids(100), ...over }, now);
const refusal = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return (e as Error).message; } };

describe('registry: add, renew, release', () => {
  test('add refuses more than 14 days, no evidence, product or infra class, an unknown id, a duplicate and the cap', () => {
    const reg = emptyRegistry();
    expect(refusal(() => add(reg, 'a.test.ts::::t0', { days: 15 }))).toContain('from 1 to 14');
    expect(refusal(() => add(reg, 'a.test.ts::::t0', { evidence: [] }))).toContain('no evidence');
    expect(refusal(() => add(reg, 'a.test.ts::::t0', { failureClass: 'product' }))).toContain('class product is refused');
    expect(refusal(() => add(reg, 'a.test.ts::::t0', { failureClass: 'infra' }))).toContain('class infra is refused');
    expect(refusal(() => add(reg, 'a.test.ts::::t0', { failureClass: 'flaky' }))).toContain('is not one of detector, harness, timing, model-latency');
    expect(refusal(() => add(reg, 'a.test.ts::::nope'))).toContain('is not a test in the --junit report');
    expect(refusal(() => add(reg, 'a.test.ts::::t0', { owner: ' ' }))).toContain('no owner');
    expect(Object.keys(reg.entries)).toEqual([]);
    const e = add(reg, 'a.test.ts::::t0');
    expect(e).toMatchObject({ enteredAt: NOW.toISOString(), expiresAt: at(7).toISOString(), renewals: [], suiteTests: 100 });
    expect(add(reg, 'a.test.ts::::t1', { days: 14 }).expiresAt).toBe(at(14).toISOString());
    expect(refusal(() => add(reg, 'a.test.ts::::t0'))).toContain('already has an entry');
    const small = emptyRegistry();
    for (let i = 0; i < 5; i++) add(small, `a.test.ts::::t${i}`, { suiteIds: ids(10) });
    expect(refusal(() => add(small, 'a.test.ts::::t5', { suiteIds: ids(10) }))).toContain('the cap for a 10-test suite is 5');
    expect(refusal(() => add(small, 'a.test.ts::::t5', { suiteIds: ids(10) }, at(8)))).toBe('ok');
  });

  test('the cap is 10% of the suite, at least 1, and 5 under 50 tests', () => {
    expect([1, 10, 49, 50, 99, 100, 1000].map(suiteCap)).toEqual([5, 5, 5, 5, 9, 10, 100]);
  });

  test('renew once, with new evidence and the owner named again; a second renewal is refused', () => {
    const reg = emptyRegistry();
    add(reg, 'a.test.ts::::t0');
    const id = 'a.test.ts::::t0';
    expect(refusal(() => renewEntry(reg, id, { evidence: ['https://run/2'] }, at(6)))).toContain('names the owner again');
    expect(refusal(() => renewEntry(reg, id, { owner: 'garry', evidence: ['https://run/1'] }, at(6)))).toContain('new evidence');
    expect(refusal(() => renewEntry(reg, id, { owner: 'garry', evidence: ['https://run/2'], days: 8 }, at(6)))).toContain('1 to 7 days');
    const e = renewEntry(reg, id, { owner: 'garry', evidence: ['https://run/2'] }, at(6));
    expect(e.expiresAt).toBe(at(14).toISOString());
    expect(entryProblems(id, e, at(6))).toEqual([]);
    expect(refusal(() => renewEntry(reg, id, { owner: 'garry', evidence: ['https://run/3'] }, at(13)))).toContain('a second renewal is refused');
    const expired = emptyRegistry();
    add(expired, id);
    expect(renewEntry(expired, id, { owner: 'sam', evidence: ['https://run/9'], days: 3 }, at(10)).expiresAt).toBe(at(13).toISOString());
    const twice = { ...e, renewals: [...e.renewals, { ...e.renewals[0]!, evidence: ['https://run/3'] }] };
    expect(entryProblems(id, twice, at(6)).join()).toContain('one renewal is allowed');
    const farFuture = { ...e, expiresAt: at(400).toISOString(), renewals: [{ ...e.renewals[0]!, renewedAt: at(393).toISOString(), expiresAt: at(400).toISOString() }] };
    expect(entryProblems(id, farFuture, at(6)).join()).toContain('a renewal is dated before the entry or in the future');
    expect(liveQuarantine({ schema: 1, entries: { [id]: farFuture }, released: [] }, at(6)).ids.size).toBe(0);
    expect(entryProblems(id, { ...e, renewals: [null as never] }, at(6)).join()).toContain('a renewal is not an object');
  });

  test('release moves the entry to released with its reason and PR', () => {
    const reg = emptyRegistry();
    add(reg, 'a.test.ts::::t0');
    expect(refusal(() => releaseEntry(reg, 'a.test.ts::::t0', { reason: 'fixed' }, at(2)))).toContain('--reason and --pr');
    const r = releaseEntry(reg, 'a.test.ts::::t0', { reason: 'fixed the wait', pr: 'https://github.com/o/r/pull/9' }, at(2));
    expect(reg.entries).toEqual({});
    expect(reg.released).toEqual([r]);
    expect(r).toMatchObject({ id: 'a.test.ts::::t0', owner: 'garry', reason: 'fixed the wait', releasedAt: at(2).toISOString(), enteredAt: NOW.toISOString() });
    expect(refusal(() => releaseEntry(reg, 'a.test.ts::::t0', { reason: 'x', pr: 'y' }, at(2)))).toContain('no entry to release');
  });

  test('expired and invalid entries are not quarantined; expiry prints the renew and release commands', () => {
    const reg = emptyRegistry();
    add(reg, 'a.test.ts::::t0');
    expect([...liveQuarantine(reg, at(6)).ids]).toEqual(['a.test.ts::::t0']);
    const later = liveQuarantine(reg, at(7));
    expect(later.ids.size).toBe(0);
    expect(later.notices[0]).toContain('FLAKY_QUARANTINE_EXPIRED: a.test.ts::::t0 expired 2026-11-05 and is not quarantined');
    expect(later.notices[0]).toContain("renew: gstack-flaky quarantine renew 'a.test.ts::::t0' --owner");
    expect(later.notices[0]).toContain("release: gstack-flaky quarantine release 'a.test.ts::::t0' --reason");
    reg.entries['a.test.ts::::t1'] = { ...reg.entries['a.test.ts::::t0']!, expiresAt: at(30).toISOString() };
    reg.entries['a.test.ts::::t2'] = { ...reg.entries['a.test.ts::::t0']!, failureClass: 'infra' as never };
    const live = liveQuarantine(reg, at(1));
    expect([...live.ids]).toEqual(['a.test.ts::::t0']);
    expect(live.notices.join('\n')).toContain('a.test.ts::::t1 is not quarantined: expires more than 14 days after it entered');
    expect(live.notices.join('\n')).toContain('a.test.ts::::t2 is not quarantined: class infra is refused');
  });

  test('check enforces the cap and the entry rules on the whole registry', () => {
    const reg = emptyRegistry();
    for (let i = 0; i < 5; i++) add(reg, `a.test.ts::::t${i}`, { suiteIds: ids(10) });
    expect(registryProblems(reg, NOW)).toEqual([]);
    reg.entries['a.test.ts::::t5'] = { ...reg.entries['a.test.ts::::t0']! };
    expect(registryProblems(reg, NOW)).toEqual(['6 live entries, over the cap of 5 for a 10-test suite']);
    expect(registryProblems(reg, NOW, 60)).toEqual([]);
    expect(registryProblems(reg, at(8))).toEqual([]);
  });
});

const git = (dir: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};

/** A repository whose main branch quarantines test/a.test.ts::::slow and has released test/a.test.ts::::old; HEAD is a change branch. */
function fixtureRepo(now = NOW) {
  const dir = tmp();
  git(dir, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'test', 'a.test.ts'), '// a\n');
  fs.writeFileSync(path.join(dir, 'test', 'b.test.ts'), '// b\n');
  const reg = emptyRegistry();
  const suiteIds = ['test/a.test.ts::::slow', 'test/a.test.ts::::old', 'test/b.test.ts::::other'];
  add(reg, 'test/a.test.ts::::old', { suiteIds }, now);
  releaseEntry(reg, 'test/a.test.ts::::old', { reason: 'fixed', pr: '#1' }, now);
  add(reg, 'test/a.test.ts::::slow', { suiteIds }, now);
  writeRegistry(dir, reg);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'seed');
  git(dir, 'checkout', '-qb', 'change');
  return { dir, reg, suiteIds };
}

const clone = (r: Registry): Registry => JSON.parse(JSON.stringify(r));

describe('check --base against a git fixture', () => {
  test('an unchanged registry and a proper release pass', () => {
    const { dir, reg } = fixtureRepo();
    expect(checkRegistry(dir, { base: 'main' }, NOW).problems).toEqual([]);
    const next = clone(reg);
    releaseEntry(next, 'test/a.test.ts::::slow', { reason: 'fixed', pr: '#2' }, at(1));
    writeRegistry(dir, next);
    expect(checkRegistry(dir, { base: 'main' }, at(1)).problems).toEqual([]);
  });

  test('a deleted entry, a removed release record and rewritten history are refused', () => {
    const { dir, reg } = fixtureRepo();
    const deleted = clone(reg);
    delete deleted.entries['test/a.test.ts::::slow'];
    writeRegistry(dir, deleted);
    expect(checkRegistry(dir, { base: 'main' }, NOW).problems.join('\n')).toContain('test/a.test.ts::::slow: removed without a release record');
    const unreleased = clone(reg);
    unreleased.released = [];
    writeRegistry(dir, unreleased);
    expect(checkRegistry(dir, { base: 'main' }, NOW).problems.join('\n')).toContain('test/a.test.ts::::old: its release record of');
    const restarted = clone(reg);
    restarted.entries['test/a.test.ts::::slow']!.enteredAt = at(1).toISOString();
    writeRegistry(dir, restarted);
    expect(checkRegistry(dir, { base: 'main' }, at(1)).problems.join('\n')).toContain('enteredAt changed');
  });

  test('an entry added in the same change that edits its test file is refused; without the edit it passes', () => {
    const { dir, reg, suiteIds } = fixtureRepo();
    const next = clone(reg);
    add(next, 'test/b.test.ts::::other', { suiteIds });
    writeRegistry(dir, next);
    expect(checkRegistry(dir, { base: 'main' }, NOW).problems).toEqual([]);
    fs.writeFileSync(path.join(dir, 'test', 'b.test.ts'), '// b, now broken\n');
    git(dir, 'commit', '-qam', 'break b and quarantine it');
    expect(checkRegistry(dir, { base: 'main' }, NOW).problems).toEqual([
      'test/b.test.ts::::other: added in the same change that edits test/b.test.ts; a change cannot quarantine the test it touches (land the entry on its own, or fix the test)',
    ]);
  });

  test('a non-ASCII test path is matched too (git would quote it by default)', () => {
    const { dir, reg } = fixtureRepo();
    fs.writeFileSync(path.join(dir, 'test', 'über.test.ts'), '// ü\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'add über');
    const next = clone(reg);
    add(next, 'test/über.test.ts::::t', { suiteIds: ['test/über.test.ts::::t', 'test/a.test.ts::::slow'] });
    writeRegistry(dir, next);
    expect(checkRegistry(dir, { base: 'main' }, NOW).problems.join('\n')).toContain('test/über.test.ts::::t: added in the same change that edits test/über.test.ts');
  });

  test('the bin: check exits 1 with QUARANTINE_REFUSED lines, and an unknown base exits 3', () => {
    const { dir, reg } = fixtureRepo(new Date());
    const deleted = clone(reg);
    delete deleted.entries['test/a.test.ts::::slow'];
    writeRegistry(dir, deleted);
    const r = spawnSync(BIN, ['quarantine', 'check', '--base', 'main'], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('QUARANTINE_REFUSED: test/a.test.ts::::slow: removed without a release record');
    expect(r.stdout).toContain('verdict=fail');
    const missing = spawnSync(BIN, ['quarantine', 'check', '--base', 'no-such-branch'], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
    expect([missing.status, missing.stderr.includes('(FLAKY_QUARANTINE_BASE)')]).toEqual([3, true]);
  });
});

/** A fake runner: the attempt number decides the report, exit status, output and signal. */
function fakeRun(reports: (n: number, argv: string[]) => string | null, exits: (n: number) => number, outputs: (n: number) => string = () => 'Ran 3 tests across 1 file. [3ms]\n', signals: (n: number) => string | undefined = () => undefined) {
  const calls: string[][] = [];
  const spawn = async (argv: string[], _env: NodeJS.ProcessEnv, cwd: string) => {
    calls.push(argv);
    const xml = reports(calls.length, argv);
    if (xml !== null) fs.writeFileSync(path.join(cwd, 'r.xml'), xml);
    const signal = signals(calls.length);
    return { exit: exits(calls.length), output: outputs(calls.length), ...(signal ? { signal } : {}) };
  };
  return { calls, spawn };
}

const suite = (cases: string, file = 'a.test.ts') => `<testsuites name="bun test"><testsuite name="${file}" file="${file}">${cases}</testsuite></testsuites>`;
const pass = (name: string) => `<testcase name="${name}" classname="" file="a.test.ts"/>`;
const fail = (name: string) => `<testcase name="${name}" classname="" file="a.test.ts"><failure message="boom"/></testcase>`;
const Q = new Set(['a.test.ts::::q']);
const run = (f: ReturnType<typeof fakeRun>, extra: Partial<Parameters<typeof runFlaky>[0]> = {}) =>
  runFlaky({ command: ['bun', 'test'], junit: 'r.xml', maxReruns: 3, cwd: tmp(), spawn: f.spawn, env: {}, now: () => NOW, quarantined: Q, ...extra });

describe('the quarantine attempt budget under the full green verdict', () => {
  test('a quarantined test that fails all 3 attempts is a hard break', async () => {
    const f = fakeRun(() => suite(pass('a') + fail('q')), () => 1);
    const r = await run(f);
    expect(f.calls).toHaveLength(3);
    expect(r.exitCode).toBe(1);
    expect(r.outcomes).toMatchObject([{ status: 'hard-break', attempts: ['fail', 'fail', 'fail'], reason: 'failed all 3 attempts: a hard break, not a flake' }]);
    expect(r.ledger.map(l => [l.kind, l.id, l.rerun_scope])).toEqual([['hard-break', 'a.test.ts::::q', 'command']]);
    expect(renderResult(r, '/l').at(-1)).toBe('FLAKY_RESULT: tests=2 failed=1 flaky=0 quarantined=1 reruns=2 command_exit=1 verdict=fail ledger=/l');
  });

  test('it passes on attempt 3 only on the runner\'s full green verdict, listed as quarantined and not as a pass', async () => {
    const f = fakeRun(n => suite(pass('a') + (n < 3 ? fail('q') : pass('q'))), n => n < 3 ? 1 : 0);
    const r = await run(f);
    expect(f.calls).toHaveLength(3);
    expect(r.exitCode).toBe(0);
    expect(r.outcomes).toMatchObject([{ status: 'quarantined-pass', attempts: ['fail', 'fail', 'pass'] }]);
    expect(r.ledger[0]).toMatchObject({ kind: 'quarantined-pass', attempts: ['fail', 'fail', 'pass'] });
    expect(renderResult(r, '/l')).toEqual(['FLAKY: quarantined-pass a.test.ts::::q attempts=fail,fail,pass', 'FLAKY_RERUN: scope=command (the default; --rerun-scope test reruns the failed test alone)',
      'FLAKY_RESULT: tests=2 failed=0 flaky=0 quarantined=1 reruns=2 command_exit=1 verdict=pass ledger=/l']);
  });

  test('false-green regression: exit 1 from outside the report never turns green because only a quarantined test failed', async () => {
    const greenReportLaterExit1 = fakeRun(n => suite(pass('a') + (n === 1 ? fail('q') : pass('q'))), () => 1);
    const a = await run(greenReportLaterExit1);
    expect(greenReportLaterExit1.calls).toHaveLength(2);
    expect(a.exitCode).toBe(1);
    expect(a.outcomes).toMatchObject([{ status: 'quarantined-fail', attempts: ['fail', 'pass'], reason: 'rerun: the command exited 1' }]);
    const alwaysExit1 = fakeRun(() => suite(pass('a') + fail('q')), () => 1, () => 'All files | % Funcs | % Lines |\nRan 2 tests across 1 file.\n');
    const b = await run(alwaysExit1, { rerunScope: 'test' });
    expect(alwaysExit1.calls.every(c => c.join(' ') === 'bun test')).toBe(true);
    expect([b.exitCode, b.outcomes[0]!.status]).toEqual([1, 'hard-break']);
  });

  test('the bin keeps a coverage-style exit 1 red while the only reported failure is quarantined', () => {
    const dir = tmp();
    git(dir, 'init', '-q', '-b', 'main');
    const reg = emptyRegistry();
    add(reg, 'a.test.ts::::q', { suiteIds: ['a.test.ts::::a', 'a.test.ts::::q'] }, new Date());
    writeRegistry(dir, reg);
    const runner = path.join(dir, 'runner.sh');
    fs.writeFileSync(runner, ['#!/usr/bin/env bash', 'echo x >> count', `printf '%s' '${suite(pass('a') + fail('q'))}' > r.xml`, 'exit 1'].join('\n'), { mode: 0o755 });
    const r = spawnSync(BIN, ['run', '--junit', 'r.xml', '--ledger', path.join(dir, 'l.jsonl'), '--', runner], { cwd: dir, encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' } });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FLAKY: hard-break a.test.ts::::q attempts=fail,fail,fail');
    expect(r.stdout).toContain('quarantined=1 reruns=2 command_exit=1 verdict=fail');
    expect(fs.readFileSync(path.join(dir, 'count'), 'utf-8').trim().split('\n')).toHaveLength(3);
  });

  test('non-quarantined failures keep one rerun; a new non-quarantined failure ends the budget', async () => {
    const both = fakeRun(n => suite((n === 1 ? fail('a') : fail('a')) + (n === 1 ? fail('q') : pass('q'))), () => 1);
    const r = await run(both);
    expect(both.calls).toHaveLength(2);
    expect(r.outcomes.map(o => [o.test.id, o.status])).toEqual([['a.test.ts::::a', 'rerun-fail'], ['a.test.ts::::q', 'quarantined-fail']]);
    const newFailure = fakeRun(n => suite((n === 1 ? pass('a') : fail('a')) + fail('q')), () => 1);
    const s = await run(newFailure);
    expect(newFailure.calls).toHaveLength(2);
    expect([s.exitCode, s.outcomes[0]!.status]).toEqual([1, 'quarantined-fail']);
  });

  test('a flaky test and a quarantined test both clear on the attempt that is fully green', async () => {
    const f = fakeRun(n => suite((n === 1 ? fail('a') : pass('a')) + (n < 3 ? fail('q') : pass('q'))), n => n < 3 ? 1 : 0);
    const r = await run(f);
    expect(f.calls).toHaveLength(3);
    expect(r.exitCode).toBe(0);
    expect(r.outcomes.map(o => [o.status, o.attempts.join(',')])).toEqual([['flaky-pass', 'fail,pass,pass'], ['quarantined-pass', 'fail,fail,pass']]);
  });

  test('a killed attempt or a missing first-run test ends the budget red', async () => {
    const killed = fakeRun(() => suite(pass('a') + fail('q')), n => n === 1 ? 1 : 128, undefined, n => n === 2 ? 'SIGTERM' : undefined);
    expect((await run(killed)).exitCode).toBe(1);
    expect(killed.calls).toHaveLength(2);
    const shrunk = fakeRun(n => n === 1 ? suite(pass('a') + fail('q')) : suite(fail('q')), () => 1);
    expect((await run(shrunk)).exitCode).toBe(1);
    expect(shrunk.calls).toHaveLength(2);
  });

  test('a quarantined test that passes is listed, ledgered for the exit rule, and the run is green', async () => {
    const r = await run(fakeRun(() => suite(pass('a') + pass('q')), () => 0));
    expect(r).toMatchObject({ exitCode: 0, reruns: 0, quarantined: 1 });
    expect(r.ledger.map(l => [l.kind, l.attempts])).toEqual([['quarantined-pass', ['pass']]]);
    expect(renderResult(r, '/l').at(-1)).toContain('failed=0 flaky=0 quarantined=1');
  });

  test('quarantined failures do not count against --max-reruns', async () => {
    const f = fakeRun(n => suite(pass('a') + (n === 1 ? fail('q') : pass('q'))), n => n === 1 ? 1 : 0);
    expect((await run(f, { maxReruns: 0 })).exitCode).toBe(0);
  });

  test('--rerun-scope test gives the quarantined test the same budget on the targeted path', async () => {
    const f = fakeRun((n, argv) => argv.length === 2 ? suite(pass('a') + fail('q')) : suite(n < 3 ? fail('q') : pass('q')), n => n < 3 ? 1 : 0);
    const r = await run(f, { rerunScope: 'test' });
    expect(f.calls.slice(1)).toEqual([['bun', 'test', 'a.test.ts', '--test-name-pattern', '^q$'], ['bun', 'test', 'a.test.ts', '--test-name-pattern', '^q$']]);
    expect(r.exitCode).toBe(0);
    expect(r.outcomes).toMatchObject([{ status: 'quarantined-pass', attempts: ['fail', 'fail', 'pass'] }]);
    const notQ = fakeRun((n, argv) => argv.length === 2 ? suite(pass('q') + fail('a')) : suite(fail('a')), () => 1);
    expect((await run(notQ, { rerunScope: 'test' })).exitCode).toBe(1);
    expect(notQ.calls).toHaveLength(2);
  });

  test('an expired entry gives no budget: one rerun, as for any test', async () => {
    const reg = emptyRegistry();
    add(reg, 'a.test.ts::::q', { suiteIds: ['a.test.ts::::q'] });
    const f = fakeRun(n => suite(pass('a') + (n < 3 ? fail('q') : pass('q'))), n => n < 3 ? 1 : 0);
    const r = await run(f, { quarantined: liveQuarantine(reg, at(8)).ids });
    expect(f.calls).toHaveLength(2);
    expect([r.exitCode, r.outcomes[0]!.status, r.quarantined]).toEqual([1, 'rerun-fail', 0]);
  });
});

describe('missing quarantined ids', () => {
  test('a quarantined id missing from a run that included its file blocks', async () => {
    const f = fakeRun(() => suite(pass('a') + pass('b')), () => 0);
    const r = await run(f, { quarantined: new Set(['a.test.ts::::gone']) });
    expect(f.calls).toHaveLength(1);
    expect(r.exitCode).toBe(1);
    expect(r.outcomes).toMatchObject([{ status: 'quarantined-fail', reason: 'quarantined, and missing from a run that included its file' }]);
    expect(r.ledger[0]).toMatchObject({ kind: 'quarantined-fail', id: 'a.test.ts::::gone' });
  });

  test('a run that did not include its file (a shard, a diff selection) does not block', async () => {
    const r = await run(fakeRun(() => suite(pass('a')), () => 0), { quarantined: new Set(['b.test.ts::::gone', 'a.test.ts:: chromium ::x']) });
    expect(r).toMatchObject({ exitCode: 0, outcomes: [], quarantined: 0 });
  });
});

describe('the registry read from the base branch', () => {
  test('readRegistry --base sees the base copy, not the change\'s own entry', () => {
    const { dir, reg, suiteIds } = fixtureRepo();
    const next = clone(reg);
    add(next, 'test/b.test.ts::::other', { suiteIds });
    writeRegistry(dir, next);
    expect(Object.keys(readRegistry(dir).entries).sort()).toEqual(['test/a.test.ts::::slow', 'test/b.test.ts::::other']);
    expect(Object.keys(readRegistry(dir, 'main').entries)).toEqual(['test/a.test.ts::::slow']);
  });

  test('the bin: a change that quarantines its own failing test gets no budget with --base', () => {
    const dir = tmp();
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'seed');
    git(dir, 'checkout', '-qb', 'change');
    fs.writeFileSync(path.join(dir, 'seed.xml'), suite(pass('a') + pass('b')));
    const addRun = spawnSync(BIN, ['quarantine', 'add', 'a.test.ts::::b', '--owner', 'garry', '--ledger', 'https://l/1', '--class', 'timing', '--reason', 'slow', '--evidence', 'https://run/1', '--junit', 'seed.xml'], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
    expect([addRun.status, addRun.stdout.startsWith('QUARANTINE_ADDED: a.test.ts::::b owner=garry class=timing')]).toEqual([0, true]);
    const runner = path.join(dir, 'runner.sh');
    fs.writeFileSync(runner, [
      '#!/usr/bin/env bash',
      'n=$(cat count 2>/dev/null || echo 0); echo $((n+1)) > count',
      `if [ "$n" -lt 2 ]; then printf '%s' '${suite(pass('a') + fail('b'))}' > r.xml; exit 1; fi`,
      `printf '%s' '${suite(pass('a') + pass('b'))}' > r.xml`,
    ].join('\n'), { mode: 0o755 });
    const flaky = (extra: string[]) => {
      fs.rmSync(path.join(dir, 'count'), { force: true });
      return spawnSync(BIN, ['run', '--junit', 'r.xml', '--ledger', path.join(dir, 'l.jsonl'), ...extra, '--', runner], { cwd: dir, encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' } });
    };
    const own = flaky([]);
    expect([own.status, own.stdout.includes('FLAKY: quarantined-pass a.test.ts::::b attempts=fail,fail,pass')]).toEqual([0, true]);
    const fromBase = flaky(['--base', 'main']);
    expect([fromBase.status, fromBase.stdout.includes('FLAKY: rerun-fail a.test.ts::::b')]).toEqual([1, true]);
    expect(fs.readFileSync(path.join(dir, 'count'), 'utf-8').trim()).toBe('2');
    const badBase = flaky(['--base', 'no-such-branch']);
    expect([badBase.status, badBase.stderr.includes('(FLAKY_QUARANTINE_BASE)')]).toEqual([3, true]);
  });
});

describe('quarantine CLI and report', () => {
  test('add, renew, release through the bin; refusals exit 1 and usage exits 2', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'seed.xml'), suite(pass('a') + pass('b')));
    const q = (...args: string[]) => spawnSync(BIN, ['quarantine', ...args], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
    const base = ['--owner', 'garry', '--ledger', 'https://l/1', '--reason', 'slow', '--evidence', 'https://run/1', '--junit', 'seed.xml'];
    const product = q('add', 'a.test.ts::::b', ...base, '--class', 'product');
    expect([product.status, product.stderr.includes('class product is refused'), product.stderr.includes('(FLAKY_QUARANTINE_REFUSED)')]).toEqual([1, true, true]);
    expect(q('add', 'a.test.ts::::b', ...base, '--class', 'harness').status).toBe(0);
    expect(q('renew', 'a.test.ts::::b', '--owner', 'garry', '--evidence', 'https://run/2').status).toBe(0);
    expect(q('renew', 'a.test.ts::::b', '--owner', 'garry', '--evidence', 'https://run/3').status).toBe(1);
    expect(q('check').stdout).toContain('QUARANTINE_CHECK: live=1 cap=5 base=none verdict=pass');
    expect(q('release', 'a.test.ts::::b', '--reason', 'fixed', '--pr', '#7').status).toBe(0);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, '.gstack', 'quarantine.json'), 'utf-8')) as Registry;
    expect([Object.keys(saved.entries), saved.released.map(r => [r.id, r.pr, r.renewals.length])]).toEqual([[], [['a.test.ts::::b', '#7', 1]]]);
    expect(q('add', 'a.test.ts::::b', '--bogus', 'x').status).toBe(2);
    expect(q('frobnicate').status).toBe(2);
  });

  test('report: expired first, then soonest-expiring; the exit rule needs 10 consecutive clean passes from the ledgers', () => {
    const reg = emptyRegistry();
    add(reg, 'a.test.ts::::t0', { days: 14 });
    add(reg, 'a.test.ts::::t1', { days: 2 });
    add(reg, 'a.test.ts::::t2', { days: 1 }, at(-5));
    const without = reportLines(reg, NOW);
    expect(without.map(l => l.split(' ').slice(0, 2).join(' '))).toEqual(['FLAKY_QUARANTINE_EXPIRED: a.test.ts::::t2', 'QUARANTINE: a.test.ts::::t1', 'QUARANTINE: a.test.ts::::t0', 'QUARANTINE_REPORT: live=2']);
    expect(without[1]).toContain('days_left=2');
    expect(without[1]).toContain("EXPIRING (renew: gstack-flaky quarantine renew 'a.test.ts::::t1'");
    expect(without.at(-1)).toBe('QUARANTINE_REPORT: live=2 expired=1 expiring=1 ready=unchecked exit_rule=not checked (no --ledger given)');
    const dir = tmp();
    fs.mkdirSync(path.join(dir, 'run-1', 'flaky-junit-ledger-e2e'), { recursive: true });
    const lineFor = (id: string, i: number, kind = 'quarantined-pass', attempts = ['pass']) => JSON.stringify({ ts: new Date(NOW.getTime() + i * 1000).toISOString(), kind, id, attempts });
    const t0 = [lineFor('a.test.ts::::t0', 0, 'hard-break', ['fail', 'fail', 'fail']), ...Array.from({ length: 10 }, (_, i) => lineFor('a.test.ts::::t0', i + 1))];
    const t1 = [...Array.from({ length: 9 }, (_, i) => lineFor('a.test.ts::::t1', i)), lineFor('a.test.ts::::t1', 9, 'quarantined-pass', ['fail', 'pass'])];
    fs.writeFileSync(path.join(dir, 'run-1', 'flaky-junit-ledger-e2e', 'flaky-junit-ledger.jsonl'), [...t0, ...t1, 'not json'].join('\n') + '\n');
    const ledgers = readLedgers([dir]);
    expect([ledgers.records.length, ledgers.skipped]).toEqual([21, 1]);
    const withLedger = reportLines(reg, NOW, ledgers.records);
    expect(withLedger.find(l => l.includes('t0 '))).toContain("recent=pass,pass,pass,pass,pass clean_streak=10 READY_TO_RELEASE: gstack-flaky quarantine release 'a.test.ts::::t0'");
    expect(withLedger.find(l => l.includes('t1 '))).toContain('recent=pass,pass,pass,pass,flaky clean_streak=0');
    expect(withLedger.at(-1)).toBe('QUARANTINE_REPORT: live=2 expired=1 expiring=1 ready=1 exit_rule=checked (10 consecutive clean passes)');
  });

  test('every FLAKY_QUARANTINE_ code is in the docs table, and the docs say the registries share no schema with CASE_QUARANTINE', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'flaky.md'), 'utf-8');
    const src = fs.readFileSync(path.join(ROOT, 'lib', 'quarantine.ts'), 'utf-8') + fs.readFileSync(path.join(ROOT, 'bin', 'gstack-flaky'), 'utf-8');
    const codes = [...new Set(src.match(/FLAKY_QUARANTINE_[A-Z_]+/g))];
    expect(codes.length).toBeGreaterThan(4);
    expect(codes.filter(c => !doc.includes(`| \`${c}\` |`))).toEqual([]);
    expect(doc).toContain('CASE_QUARANTINE');
  });
});
