/**
 * gstack-flaky run (GSTA-158): the JUnit reader against reports captured from
 * Playwright 1.64 and bun 1.4 (test/fixtures/junit, paths rewritten to /repo),
 * the rerun-once rules, and the bin end to end with a fake runner.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, spawnSync } from 'child_process';
import { JunitError, parseJunit, readJunit, testId } from '../lib/junit';
import { appendLedger, incompleteRun, ledgerPath, renderResult, rerunSelection, runFlaky, safeExcerpt, stepSummary, unreportedFailures, workflowEscape } from '../lib/flaky-run';

const ROOT = path.resolve(import.meta.dir, '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'junit');
const fixture = (name: string) => fs.readFileSync(path.join(FIX, name), 'utf-8');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-flaky-'));
const tmp = () => fs.mkdtempSync(path.join(TMP, 't-'));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

describe('JUnit reader', () => {
  test('bun: nested describe path, skip, failure excerpt', () => {
    const r = parseJunit(fixture('bun.xml'));
    expect(r.runner).toBe('bun');
    expect(r.tests.map(t => [t.id, t.attempts.join(',')])).toEqual([
      ['a.test.ts::::outer > inner > passes', 'pass'],
      ['a.test.ts::::outer > inner > fails', 'fail'],
      ['a.test.ts::::outer > skipped', 'skip'],
      ['a.test.ts::::top level', 'pass'],
    ]);
    expect(r.tests[1]!.excerpt[0]).toContain('expect(received).toBe(expected)');
  });

  test('playwright: one id per project, retry-aware attempts', () => {
    const r = parseJunit(fixture('playwright-r2-inc.xml'));
    expect(r.runner).toBe('playwright');
    expect(r.retriesHidden).toBe(false);
    const byId = Object.fromEntries(r.tests.map(t => [t.id, t.attempts.join(',')]));
    expect(byId['a.spec.ts::alpha::group one > fails always']).toBe('fail,fail,fail');
    expect(byId['a.spec.ts::beta::group one > fails always']).toBe('fail,fail,fail');
    expect(byId['a.spec.ts::alpha::group one > flaky once']).toBe('fail,pass');
    expect(byId['a.spec.ts::alpha::group one > skipped']).toBe('skip');
    expect(byId['a.spec.ts::alpha::group one > title with $(rm -rf) [x] (y)? *']).toBe('pass');
  });

  test('playwright retries without retry data are detected, not read as one attempt', () => {
    expect(parseJunit(fixture('playwright-r2.xml')).retriesHidden).toBe(true);
    expect(parseJunit(fixture('playwright-r0.xml')).retriesHidden).toBe(false);
  });

  test('missing, empty, zero-testcase and malformed reports are errors, never green', () => {
    const dir = tmp();
    const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return (e as JunitError).code; } };
    expect(code(() => readJunit(path.join(dir, 'absent.xml')))).toBe('FLAKY_NO_RESULTS');
    fs.writeFileSync(path.join(dir, 'empty.xml'), '  \n');
    expect(code(() => readJunit(path.join(dir, 'empty.xml')))).toBe('FLAKY_NO_RESULTS');
    expect(code(() => parseJunit('<testsuites name="x"><testsuite name="s" tests="0"/></testsuites>'))).toBe('FLAKY_NO_RESULTS');
    expect(code(() => parseJunit('<testsuites><testsuite name="s"><testcase name="a"></testsuite></testsuites>'))).toBe('FLAKY_JUNIT_INVALID');
  });

  test('generic runners (jest, pytest): file from the testcase, entities decoded', () => {
    const r = parseJunit('<?xml version="1.0"?><testsuites><testsuite name="pytest"><testcase classname="tests.test_a" name="test_x[a&amp;b]" file="tests/test_a.py"><error message="boom"/></testcase></testsuite></testsuites>');
    expect(r.runner).toBe('generic');
    expect(r.tests[0]!.id).toBe('tests/test_a.py::::test_x[a&b]');
    expect(r.tests[0]!.attempts).toEqual(['fail']);
  });
});

describe('rerun selection', () => {
  const pw = parseJunit(fixture('playwright-r0.xml')).tests.find(t => t.path.at(-1)!.startsWith('title with') && t.project === 'beta')!;
  test('playwright: file and title regex-escaped, project kept, each one argv element', () => {
    expect(rerunSelection('playwright', pw)).toEqual([
      'a\\.spec\\.ts', '--grep', '(?:^|\\s)group one title with \\$\\(rm -rf\\) \\[x\\] \\(y\\)\\? \\*(?:\\s|$)', '--project', 'beta',
    ]);
  });
  test('bun: anchored space-joined path', () => {
    const t = parseJunit(fixture('bun.xml')).tests[1]!;
    expect(rerunSelection('bun', t)).toEqual(['a.test.ts', '--test-name-pattern', '^outer inner fails$']);
  });
});

describe('complete-run proof for a targeted rerun', () => {
  test('a complete run needs exit 1 and the runner summary without an early stop', () => {
    expect(incompleteRun('bun', ' 4 pass\n 1 fail\nRan 5 tests across 2 files. [9ms]\n', 1)).toBeNull();
    expect(incompleteRun('bun', 'Bailed out after 1 failure\nRan 1 test across 1 file.\n', 1)).toContain('--bail');
    expect(incompleteRun('bun', ' 1 fail\n', 1)).toContain('no run summary');
    expect(incompleteRun('bun', 'Ran 5 tests across 2 files.\n', 2)).toContain('exited 2');
    expect(incompleteRun('playwright', '  1 failed\n    [alpha] x\n  4 passed (1s)\n', 1)).toBeNull();
    expect(incompleteRun('playwright', 'Testing stopped early after 1 maximum allowed failures.\n  1 failed\n  2 did not run\n', 1)).toContain('2 did not run');
    expect(incompleteRun('playwright', '  1 failed\n  3 interrupted\n', 1)).toContain('3 interrupted');
    expect(incompleteRun('playwright', 'Timed out waiting 600s for the test suite to run\nTimed out waiting 600s for the entire test run\n  1 failed\n', 1)).toContain('stopped early');
    expect(incompleteRun('playwright', '', 1)).toContain('no summary');
    expect(incompleteRun('generic', 'Ran 5 tests', 1)).toContain('generic');
    expect(incompleteRun('bun', 'All files | % Funcs | % Lines |\nRan 5 tests across 2 files.\n', 1)).toContain('coverage');
    expect(incompleteRun('bun', 'Ran 5 tests across 2 files.\n', 1, ['bun', 'test', '--coverage'])).toContain('coverage');
    expect(incompleteRun('playwright', '  1 failed\n  1 flaky\n  4 passed\n', 1, [], 1)).toContain('fail-on-flaky');
  });
});

/** A fake runner: argv selection decides which canned report the attempt writes. */
const BUN_SUMMARY = 'Ran 2 tests across 1 file. [3ms]\n';

function fakeRun(reports: (argv: string[], n: number) => string | null, exits: (argv: string[], n: number) => number, outputs: (argv: string[], n: number) => string = () => BUN_SUMMARY, signals: (n: number) => string | undefined = () => undefined) {
  const calls: string[][] = [];
  return {
    calls,
    spawn(junit: string) {
      return async (argv: string[], _env: NodeJS.ProcessEnv, cwd: string) => {
        calls.push(argv);
        const xml = reports(argv, calls.length);
        if (xml !== null) fs.writeFileSync(path.resolve(cwd, junit), xml);
        const signal = signals(calls.length);
        return { exit: exits(argv, calls.length), output: outputs(argv, calls.length), ...(signal ? { signal } : {}) };
      };
    },
  };
}

const suite = (cases: string) => `<testsuites name="bun test"><testsuite name="a.test.ts" file="a.test.ts">${cases}</testsuite></testsuites>`;
const pass = (name: string) => `<testcase name="${name}" classname="" file="a.test.ts"/>`;
const fail = (name: string, msg = 'boom') => `<testcase name="${name}" classname="" file="a.test.ts"><failure message="${msg}"/></testcase>`;

describe('runFlaky', () => {
  const base = (spawn: ReturnType<typeof fakeRun>, dir: string, extra: Partial<Parameters<typeof runFlaky>[0]> = {}) =>
    runFlaky({ command: ['bun', 'test'], junit: 'r.xml', maxReruns: 3, cwd: dir, spawn: spawn.spawn('r.xml'), env: {}, now: () => new Date('2026-10-29T00:00:00Z'), ...extra });

  test('a green run with no failures is green and reruns nothing', async () => {
    const dir = tmp();
    const f = fakeRun(() => suite(pass('a') + pass('b')), () => 0);
    expect(await base(f, dir)).toMatchObject({ exitCode: 0, reruns: 0, ledger: [] });
    expect(f.calls).toHaveLength(1);
  });

  test('a coverage failure beside a flaky test is not cleared by a narrowed rerun', async () => {
    const dir = tmp();
    const cov = () => '----|---------|---------|\nAll files | % Funcs | % Lines |\nRan 2 tests across 1 file.\n';
    const f = fakeRun((_a, n) => n === 1 ? suite(pass('a') + fail('b')) : suite(pass('a') + pass('b')), () => 1, cov);
    const r = await base(f, dir, { rerunScope: 'test' });
    expect(f.calls[1]).toEqual(['bun', 'test']);
    expect(r).toMatchObject({ exitCode: 1, wholeRerun: 'coverage is measured, and a narrowed rerun cannot reproduce a coverage failure' });
  });

  test('by default the rerun is the whole command and counts only on its full green verdict', async () => {
    const dir = tmp();
    const green = fakeRun((_a, n) => n === 1 ? suite(pass('a') + fail('b')) : suite(pass('a') + pass('b')), (_a, n) => n === 1 ? 1 : 0);
    const r = await base(green, dir);
    expect(green.calls).toEqual([['bun', 'test'], ['bun', 'test']]);
    expect(r).toMatchObject({ exitCode: 0, wholeRerun: 'the default; --rerun-scope test reruns the failed test alone' });
    expect(r.ledger[0]).toMatchObject({ kind: 'flaky-pass', rerun_scope: 'command' });
    const otherFails = fakeRun((_a, n) => n === 1 ? suite(pass('a') + fail('b')) : suite(fail('a') + pass('b')), (_a, n) => n === 1 ? 1 : 0);
    expect((await base(otherFails, dir)).outcomes[0]).toMatchObject({ status: 'rerun-fail', reason: 'rerun: 1 test(s) failed in the whole-command rerun' });
  });

  test('a failed test that passes on rerun is a flaky pass and goes on the ledger', async () => {
    const dir = tmp();
    const f = fakeRun((argv, n) => n === 1 ? suite(pass('a') + fail('b')) : suite(pass('b')), (_a, n) => n === 1 ? 1 : 0);
    const r = await base(f, dir, { rerunScope: 'test' });
    expect(r.exitCode).toBe(0);
    expect(f.calls[1]).toEqual(['bun', 'test', 'a.test.ts', '--test-name-pattern', '^b$']);
    expect(r.outcomes.map(o => [o.status, o.attempts.join(',')])).toEqual([['flaky-pass', 'fail,pass']]);
    expect(r.ledger).toHaveLength(1);
    expect(r.ledger[0]).toMatchObject({ kind: 'flaky-pass', id: 'a.test.ts::::b', rerun_by: 'gstack-flaky', attempts: ['fail', 'pass'], excerpt: ['boom'] });
    expect(renderResult(r, '/l.jsonl').at(-1)).toBe('FLAKY_RESULT: tests=2 failed=0 flaky=1 reruns=1 command_exit=1 verdict=pass ledger=/l.jsonl');
    expect(stepSummary(r)).toContain('a.test.ts::::b');
  });

  test('a test that fails its rerun is red and is ledgered as rerun-fail', async () => {
    const dir = tmp();
    const f = fakeRun(() => suite(fail('b')), () => 1);
    const r = await base(f, dir);
    expect(r.exitCode).toBe(1);
    expect(r.outcomes[0]).toMatchObject({ status: 'rerun-fail', attempts: ['fail', 'fail'] });
    expect(r.ledger[0]!.kind).toBe('rerun-fail');
  });

  test('more failures than --max-reruns: a real red, nothing rerun', async () => {
    const dir = tmp();
    const f = fakeRun(() => suite(fail('a') + fail('b') + fail('c') + fail('d')), () => 1);
    const r = await base(f, dir);
    expect(r.exitCode).toBe(1);
    expect(f.calls).toHaveLength(1);
    expect(r.reruns).toBe(0);
    expect(r.outcomes.every(o => o.status === 'fail' && /more than --max-reruns 3/.test(o.reason!))).toBe(true);
    expect(r.ledger).toEqual([]);
  });

  test('runner retries stand: no second rerun, and a runner flaky pass is ledgered', async () => {
    const dir = tmp();
    const f = fakeRun(() => fixture('playwright-r2-inc.xml'), () => 1);
    const r = await base(f, dir);
    expect(f.calls).toHaveLength(1);
    expect(r.exitCode).toBe(1);
    expect(r.ledger.filter(l => l.kind === 'flaky-pass').map(l => [l.id, l.rerun_by])).toEqual([
      ['a.spec.ts::alpha::group one > flaky once', 'runner'], ['a.spec.ts::beta::group one > flaky once', 'runner'],
    ]);
    expect(r.outcomes.filter(o => o.status === 'fail').every(o => /already retried \(3 attempts\)/.test(o.reason!))).toBe(true);
  });

  test('hidden Playwright retries refuse with a code instead of a guess', async () => {
    const dir = tmp();
    const r = await base(fakeRun(() => fixture('playwright-r2.xml'), () => 1), dir);
    expect([r.exitCode, r.code]).toEqual([3, 'FLAKY_RETRIES_HIDDEN']);
  });

  test('no report, a stale report, and a crash with no failed test are never green', async () => {
    const dir = tmp();
    expect(await base(fakeRun(() => null, () => 0), dir)).toMatchObject({ exitCode: 3, code: 'FLAKY_NO_RESULTS' });
    fs.writeFileSync(path.join(dir, 'r.xml'), suite(pass('stale')));
    expect(await base(fakeRun(() => null, () => 0), dir)).toMatchObject({ exitCode: 3, code: 'FLAKY_NO_RESULTS' });
    expect(await base(fakeRun(() => suite(pass('a')), () => 2), dir)).toMatchObject({ exitCode: 3, code: 'FLAKY_COMMAND_FAILED', commandExit: 2 });
  });

  test('a rerun that does not report the targeted test fails it; other tests in the rerun are ignored', async () => {
    const dir = tmp();
    const f = fakeRun((_a, n) => n === 1 ? suite(fail('b')) : suite(pass('other')), (_a, n) => n === 1 ? 1 : 0);
    const r = await base(f, dir);
    expect(r.exitCode).toBe(1);
    expect(r.outcomes[0]).toMatchObject({ status: 'rerun-fail', reason: 'rerun: the report does not contain this test' });
  });

  test('a rerun whose command exits non-zero is not a flaky pass, even with a passing report', async () => {
    const dir = tmp();
    const f = fakeRun((_a, n) => n === 1 ? suite(fail('b')) : suite(pass('b')), () => 1);
    expect((await base(f, dir)).outcomes[0]).toMatchObject({ status: 'rerun-fail', reason: 'rerun: the command exited 1' });
  });

  test('a test reported twice with one failure is red and not rerun', async () => {
    const dir = tmp();
    const r = parseJunit(suite(pass('b') + fail('b')));
    expect(r.tests[0]).toMatchObject({ executions: 2, attempts: ['pass', 'fail'] });
    const f = fakeRun(() => suite(fail('b') + pass('b') + fail('c')), () => 1);
    const out = await base(f, dir, { rerunScope: 'test' });
    expect(out.outcomes.find(o => o.test.id.endsWith('::b'))).toMatchObject({ status: 'fail', reason: 'it ran 2 times in this report and one failed; not rerun' });
    expect(f.calls).toHaveLength(2);
  });

  test('a runner-caught flake is ledgered even when a duplicate execution of the test was skipped', async () => {
    const dir = tmp();
    const caught = '<testcase name="b" classname="" file="a.test.ts"><flakyFailure message="x"/></testcase>';
    const r = await base(fakeRun(() => suite(caught + '<testcase name="b" classname="" file="a.test.ts"><skipped/></testcase>'), () => 0), dir);
    expect(r.exitCode).toBe(0);
    expect(r.ledger.map(l => [l.kind, l.rerun_by])).toEqual([['flaky-pass', 'runner']]);
  });

  test('the Playwright environment flag reaches every attempt', async () => {
    const dir = tmp();
    const seen: string[] = [];
    await runFlaky({ command: ['x'], junit: 'r.xml', maxReruns: 3, cwd: dir, env: {}, spawn: async (_a, env, cwd) => {
      seen.push(env.PLAYWRIGHT_JUNIT_INCLUDE_RETRIES ?? '');
      fs.writeFileSync(path.join(cwd, 'r.xml'), suite(seen.length === 1 ? fail('b') : pass('b')));
      return { exit: seen.length === 1 ? 1 : 0, output: '' };
    } });
    expect(seen).toEqual(['1', '1']);
  });

  test('bun load errors the JUnit omits keep the run red and nothing is rerun', async () => {
    const dir = tmp();
    const f = fakeRun(() => suite(fail('b')), () => 1, () => '\n 0 pass\n 3 fail\n 2 errors\nRan 3 tests across 3 files.\n');
    const r = await base(f, dir);
    expect(r).toMatchObject({ exitCode: 1, code: 'FLAKY_UNREPORTED_FAILURES', reruns: 0 });
    expect(f.calls).toHaveLength(1);
  });

  test('runner summaries: Playwright errors outside tests and count mismatches are unreported failures', () => {
    expect(unreportedFailures('playwright', '  1 error was not a part of any test, see above for details\n  1 failed\n', 1)).toContain('outside any test');
    expect(unreportedFailures('playwright', '  2 failed\n  10 passed\n', 1)).toContain('counted 2 failed');
    expect(unreportedFailures('playwright', '  1 failed\n  [chromium] x\n  10 passed\n', 1)).toBeNull();
    expect(unreportedFailures('bun', ' 4 pass\n 1 fail\n', 1)).toBeNull();
    expect(unreportedFailures('generic', '5 failed', 0)).toBeNull();
  });

  test('a run that stopped early reruns the whole command, so tests it never reached must pass too', async () => {
    const dir = tmp();
    const bail = () => 'Bailed out after 1 failure\nRan 1 test across 1 file.\n';
    const green = fakeRun((_a, n) => n === 1 ? suite(fail('b')) : suite(pass('b') + pass('never-reached')), (_a, n) => n === 1 ? 1 : 0, bail);
    const r = await base(green, dir, { rerunScope: 'test' });
    expect(green.calls).toEqual([['bun', 'test'], ['bun', 'test']]);
    expect(r).toMatchObject({ exitCode: 0, wholeRerun: 'bun stopped early (--bail)' });
    expect(r.ledger[0]).toMatchObject({ kind: 'flaky-pass', rerun_scope: 'command' });
    expect(renderResult(r, '/l')).toContain('FLAKY_RERUN: scope=command (bun stopped early (--bail))');
    const red = fakeRun((_a, n) => n === 1 ? suite(fail('b')) : suite(pass('b') + fail('never-reached')), () => 1, bail);
    expect((await base(red, dir, { rerunScope: 'test' })).outcomes[0]).toMatchObject({ status: 'rerun-fail', reason: 'rerun: the command exited 1' });
  });

  test('generic runners rerun the whole command even when a targeted rerun is asked for', async () => {
    const dir = tmp();
    const f = fakeRun((_a, n) => n === 1 ? suite(fail('b')) : suite(pass('b')), (_a, n) => n === 1 ? 1 : 0);
    const r = await base(f, dir, { runner: 'generic', rerunScope: 'test' });
    expect(f.calls[1]).toEqual(['bun', 'test']);
    expect(r).toMatchObject({ exitCode: 0, wholeRerun: 'a generic runner cannot prove every test ran' });
  });

  test('a whole-command rerun clears nothing when any test fails in it, a first-run test is missing, it is killed or it retried', async () => {
    const dir = tmp();
    const generic = (second: string, exit = 0, signal?: string) => base(fakeRun((_a, n) => n === 1 ? suite(fail('a') + pass('b')) : second, () => exit && 1, undefined, n => n === 2 ? signal : undefined), dir, { runner: 'generic' });
    expect((await generic(suite(pass('a') + fail('b')))).outcomes[0]).toMatchObject({ status: 'rerun-fail', reason: 'rerun: 1 test(s) failed in the whole-command rerun' });
    expect((await generic(suite(pass('a')))).outcomes[0]).toMatchObject({ status: 'rerun-fail', reason: 'rerun: 1 test(s) of the first run are missing from the whole-command rerun' });
    expect((await generic(suite(pass('a') + pass('b')), 0, 'SIGTERM')).outcomes[0]).toMatchObject({ status: 'rerun-fail', reason: 'rerun: killed by SIGTERM' });
    const retried = await generic(suite('<testcase name="a" classname="" file="a.test.ts"><flakyFailure message="x"/></testcase>' + pass('b')));
    expect(retried.outcomes.find(o => o.status === 'rerun-fail')).toMatchObject({ attempts: ['fail', 'fail', 'pass'] });
    expect(retried.ledger.find(l => l.kind === 'rerun-fail')).toMatchObject({ rerun_scope: 'command' });
    expect(retried.exitCode).toBe(1);
  });

  test('an incomplete run that is already red is not rerun as a whole', async () => {
    const dir = tmp();
    const f = fakeRun(() => suite(fail('b') + pass('b') + fail('c')), () => 1, () => '');
    const r = await base(f, dir);
    expect(f.calls).toHaveLength(1);
    expect(r.outcomes.find(o => o.test.id.endsWith('::c'))!.reason).toContain('already red');
  });

  test('a rerun the runner retried again does not clear the test', async () => {
    const dir = tmp();
    const f = fakeRun((_a, n) => n === 1 ? suite(fail('b')) : suite('<testcase name="b" classname="" file="a.test.ts"><flakyFailure message="x"/></testcase>'), (_a, n) => n === 1 ? 1 : 0);
    expect((await base(f, dir)).outcomes[0]).toMatchObject({ status: 'rerun-fail', attempts: ['fail', 'fail', 'pass'] });
  });

  test('a killed runner is never green and stops further reruns', async () => {
    const dir = tmp();
    expect(await base(fakeRun(() => suite(fail('b')), () => 128, undefined, () => 'SIGTERM'), dir)).toMatchObject({ exitCode: 3, code: 'FLAKY_COMMAND_KILLED' });
    const f = fakeRun((_a, n) => n === 1 ? suite(fail('b') + fail('c')) : suite(pass('b') + pass('c')), (_a, n) => n === 1 ? 1 : 128, undefined, n => n === 2 ? 'SIGTERM' : undefined);
    const r = await base(f, dir, { rerunScope: 'test' });
    expect(f.calls).toHaveLength(2);
    expect(r.outcomes.map(o => o.reason)).toEqual(['rerun: killed by SIGTERM', 'not rerun: an earlier rerun was killed']);
    expect(r.exitCode).toBe(1);
  });

  test('the first report is restored at --junit and each rerun report is kept beside it', async () => {
    const dir = tmp();
    const firstXml = suite(pass('a') + fail('b'));
    await base(fakeRun((_a, n) => n === 1 ? firstXml : suite(pass('b')), (_a, n) => n === 1 ? 1 : 0), dir);
    expect(fs.readFileSync(path.join(dir, 'r.xml'), 'utf-8')).toBe(firstXml);
    expect(fs.readFileSync(path.join(dir, 'r.rerun-1.xml'), 'utf-8')).toBe(suite(pass('b')));
  });

  test('credentials in a test title never reach the ledger, the result lines or the step summary', async () => {
    const dir = tmp();
    const key = ['sk', 'ant', 'api03', 'B'.repeat(93) + 'AA'].join('-');
    const r = await base(fakeRun((_a, n) => n === 1 ? suite(fail(`login with ${key}`)) : suite(pass(`login with ${key}`)), (_a, n) => n === 1 ? 1 : 0), dir);
    expect(r.exitCode).toBe(0);
    expect(JSON.stringify(r.ledger)).not.toContain(key);
    expect(renderResult(r, '/l').join('\n')).not.toContain(key);
    expect(stepSummary(r)).not.toContain(key);
  });

  test('workflow commands escape a title that would end or start a command', () => {
    expect(workflowEscape('a%b\r\n::error::x')).toBe('a%25b%0D%0A::error::x');
  });

  test('ledger: a write error is a warning; the path comes from --ledger, then GSTACK_FLAKE_LEDGER_JUNIT, then the state root', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'file'), '');
    const warns: string[] = [];
    appendLedger([{ ts: 't', runner: 'junit', kind: 'flaky-pass', id: 'x', file: 'x', rerun_by: 'gstack-flaky', attempts: [], excerpt: [] }], path.join(dir, 'file', 'l.jsonl'), w => warns.push(w));
    expect(warns[0]).toContain('FLAKY_LEDGER_WRITE_FAILED');
    expect(ledgerPath('/flag', { GSTACK_FLAKE_LEDGER_JUNIT: '/env' })).toBe('/flag');
    expect(ledgerPath(undefined, { GSTACK_FLAKE_LEDGER_JUNIT: '/env', GSTACK_FLAKE_LEDGER: '/free' })).toBe('/env');
    expect(ledgerPath(undefined, { GSTACK_STATE_ROOT: dir, GSTACK_FLAKE_LEDGER: '/free' })).toBe(path.join(dir, 'flake-ledger-junit.jsonl'));
  });

  test('credentials in failure text never reach the ledger', () => {
    const key = ['sk', 'ant', 'api03', 'A'.repeat(93) + 'AA'].join('-');
    const out = safeExcerpt([`Error: request failed with key ${key}`]);
    expect(out.join('\n')).not.toContain(key);
  });
});

describe('bin/gstack-flaky', () => {
  test('run: a fake bun runner flakes once, the bin reruns it and exits 0 with a ledger line', () => {
    const dir = tmp();
    const runner = path.join(dir, 'runner.sh');
    fs.writeFileSync(runner, [
      '#!/usr/bin/env bash',
      'n=$(cat count 2>/dev/null || echo 0); echo $((n+1)) > count',
      `if [ "$n" = 0 ]; then printf '%s' '${suite(pass('a') + fail('b'))}' > r.xml; echo 'Ran 2 tests across 1 file.' >&2; exit 1; fi`,
      '[ "$1" = a.test.ts ] && [ "$2" = --test-name-pattern ] && [ "$3" = "^b$" ] || exit 9',
      `printf '%s' '${suite(pass('b'))}' > r.xml`,
    ].join('\n'), { mode: 0o755 });
    const ledger = path.join(dir, 'ledger.jsonl');
    const r = spawnSync(path.join(ROOT, 'bin', 'gstack-flaky'), ['run', '--junit', 'r.xml', '--runner', 'bun', '--rerun-scope', 'test', '--ledger', ledger, '--', runner], { cwd: dir, encoding: 'utf-8', timeout: 30_000, env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '' } });
    expect(r.stdout).toContain('FLAKY: flaky-pass a.test.ts::::b attempts=fail,pass');
    expect(r.stdout).toContain(`verdict=pass ledger=${ledger}`);
    expect(r.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(ledger, 'utf-8').trim()).kind).toBe('flaky-pass');
  });

  test('usage, a command that cannot start, and missing reports exit with their codes', () => {
    const dir = tmp();
    const bin = path.join(ROOT, 'bin', 'gstack-flaky');
    expect(spawnSync(bin, ['run', '--', 'true'], { cwd: dir, encoding: 'utf-8', timeout: 30_000 }).status).toBe(2);
    fs.writeFileSync(path.join(dir, 'keep.ts'), 'x');
    expect(spawnSync(bin, ['run', '--junit', 'keep.ts', '--', 'true'], { cwd: dir, encoding: 'utf-8', timeout: 30_000 }).status).toBe(2);
    expect(fs.existsSync(path.join(dir, 'keep.ts'))).toBe(true);
    fs.writeFileSync(path.join(dir, 'pom.xml'), '<project><modelVersion>4.0.0</modelVersion></project>');
    expect(spawnSync(bin, ['run', '--junit', 'pom.xml', '--', 'true'], { cwd: dir, encoding: 'utf-8', timeout: 30_000 }).status).toBe(2);
    expect(fs.existsSync(path.join(dir, 'pom.xml'))).toBe(true);
    expect(spawnSync(bin, ['run', '--junit', 'r.xml', '--rerun-scope', 'file', '--', 'true'], { cwd: dir, encoding: 'utf-8', timeout: 30_000 }).status).toBe(2);
    fs.writeFileSync(path.join(dir, 'locked.xml'), '<testsuites/>', { mode: 0o000 });
    if (process.getuid?.() !== 0) {
      const locked = spawnSync(bin, ['run', '--junit', 'locked.xml', '--', 'true'], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
      expect([locked.status, locked.stderr.includes('cannot be read')]).toEqual([2, true]);
    }
    const missing = spawnSync(bin, ['run', '--junit', 'r.xml', '--', path.join(dir, 'no-such-runner')], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
    expect(missing.status).toBe(3);
    expect(missing.stderr).toContain('(FLAKY_COMMAND_NOT_STARTED)');
    const r = spawnSync(bin, ['run', '--junit', 'r.xml', '--', 'true'], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('(FLAKY_NO_RESULTS)');
    expect(r.stderr).toContain('fix: ');
  });

  test('a runner that dies by a signal exits 3 FLAKY_COMMAND_KILLED and is not rerun', () => {
    const dir = tmp();
    const runner = path.join(dir, 'runner.sh');
    fs.writeFileSync(runner, ['#!/usr/bin/env bash', 'echo x >> count', `printf '%s' '${suite(fail('b'))}' > r.xml`, 'kill -TERM $$'].join('\n'), { mode: 0o755 });
    const r = spawnSync(path.join(ROOT, 'bin', 'gstack-flaky'), ['run', '--junit', 'r.xml', '--runner', 'bun', '--ledger', path.join(dir, 'l.jsonl'), '--', runner], { cwd: dir, encoding: 'utf-8', timeout: 30_000 });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain('(FLAKY_COMMAND_KILLED)');
    expect(fs.readFileSync(path.join(dir, 'count'), 'utf-8').trim().split('\n')).toHaveLength(1);
  });

  test('cancelling gstack-flaky is latched even when the runner traps the signal and exits by code', async () => {
    const dir = tmp();
    const runner = path.join(dir, 'runner.sh');
    fs.writeFileSync(runner, [
      '#!/usr/bin/env bash',
      'echo x >> count',
      'trap "cp report.xml r.xml; exit 143" TERM',
      'touch ready',
      'for i in $(seq 1 300); do sleep 0.1; done',
    ].join('\n'), { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'report.xml'), suite(fail('b')));
    const child = spawn(path.join(ROOT, 'bin', 'gstack-flaky'), ['run', '--junit', 'r.xml', '--runner', 'generic', '--ledger', path.join(dir, 'l.jsonl'), '--', runner], { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    const done = new Promise<number | null>(resolve => child.on('close', code => resolve(code)));
    const deadline = Date.now() + 20_000;
    while (!fs.existsSync(path.join(dir, 'ready')) && Date.now() < deadline) await Bun.sleep(50);
    child.kill('SIGTERM');
    expect(await done).toBe(3);
    expect(stderr).toContain('(FLAKY_COMMAND_KILLED)');
    expect(fs.readFileSync(path.join(dir, 'count'), 'utf-8').trim().split('\n')).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'l.jsonl'))).toBe(false);
  }, 30_000);

  test('every FLAKY_ code the bin and the library emit is in the docs table', () => {
    const doc = fs.readFileSync(path.join(ROOT, 'docs', 'flaky.md'), 'utf-8');
    const src = fs.readFileSync(path.join(ROOT, 'bin', 'gstack-flaky'), 'utf-8') + fs.readFileSync(path.join(ROOT, 'lib', 'flaky-run.ts'), 'utf-8') + fs.readFileSync(path.join(ROOT, 'lib', 'junit.ts'), 'utf-8');
    const codes = [...new Set(src.match(/FLAKY_[A-Z_]+(?=['":])/g))].filter(c => c !== 'FLAKY_RESULT' && c !== 'FLAKY_RERUN');
    expect(codes.length).toBeGreaterThan(5);
    expect(codes.filter(c => !doc.includes(`| \`${c}\` |`))).toEqual([]);
  });

  test('ids prints one id per test', () => {
    const r = spawnSync(path.join(ROOT, 'bin', 'gstack-flaky'), ['ids', '--junit', path.join(FIX, 'bun.xml')], { encoding: 'utf-8', timeout: 30_000 });
    expect(r.stdout.trim().split('\n')).toEqual([testId('a.test.ts', '', ['outer', 'inner', 'passes']), 'a.test.ts::::outer > inner > fails', 'a.test.ts::::outer > skipped', 'a.test.ts::::top level']);
  });
});
