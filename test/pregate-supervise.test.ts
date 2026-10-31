/**
 * Lane C (GBRA-95: `gstack-pregate run` sat silent for 90 minutes in its test
 * stage on gbrain). The test tier now runs through lib/pregate/supervise.ts:
 * its own process group, output to a log file instead of pipes, live
 * progress on stderr, a stall timeout on log growth and a per-check deadline.
 * Fixtures: a test that blocks forever, a child that backgrounds and holds
 * stdout, a command that ignores SIGTERM, a quiet file and a printing one.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { buildContext, withFingerprint } from '../lib/pregate/context';
import { adapterFor, supervise, type SuperviseOptions } from '../lib/pregate/supervise';
import { BASE_PREGATE, BIN, cleanup, commit, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/pregate-fixture';

const dirs: string[] = [];
const repos: FixtureRepo[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); while (repos.length) cleanup(repos.pop()!); });

function scratch(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-supervise-')); dirs.push(d); return d; }
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function goneSoon(pid: number, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (!alive(pid)) return true; await Bun.sleep(50); }
  return !alive(pid);
}
async function pidFrom(file: string, ms = 5000): Promise<number> {
  const until = Date.now() + ms;
  while (Date.now() < until) { const t = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''; if (t) return Number(t); await Bun.sleep(25); }
  throw new Error(`no pid in ${file}`);
}

function run(dir: string, command: string, o: Partial<SuperviseOptions> = {}) {
  const lines: string[] = [];
  const log = path.join(dir, 'run.log');
  fs.writeFileSync(log, '');
  const started = Date.now();
  return supervise({ command, cwd: dir, env: process.env, log, deadline: Date.now() + 30_000, stallMs: 0, graceMs: 300, pollMs: 50, label: 'fixture', progress: l => lines.push(l), ...o })
    .then(r => ({ ...r, lines, wall: Date.now() - started, log: fs.readFileSync(log, 'utf8') }));
}

describe('supervise: process group, log file, stall and deadline', () => {
  test('a backgrounded child holding stdout does not keep the run waiting, and is killed with the group after the exit', async () => {
    const dir = scratch();
    const r = await run(dir, `sleep 1000 & echo $! > ${dir}/bg.pid; echo done`);
    expect(r.outcome).toBe('exited');
    expect(r.exit).toBe(0);
    expect(r.wall).toBeLessThan(5000);
    expect(r.log).toContain('done');
    expect(await goneSoon(await pidFrom(`${dir}/bg.pid`))).toBe(true);
  });

  test('a command that prints nothing for the stall timeout is killed as stalled; a long command that keeps printing is not', async () => {
    const dir = scratch();
    const quiet = await run(dir, `echo $$ > ${dir}/quiet.pid; echo starting; sleep 1000`, { stallMs: 700 });
    expect(quiet.outcome).toBe('stalled');
    expect(quiet.exit).toBeNull();
    expect(quiet.wall).toBeLessThan(5000);
    expect(await goneSoon(await pidFrom(`${dir}/quiet.pid`))).toBe(true);
    const printing = await run(dir, 'for i in 1 2 3 4 5 6 7 8; do echo tick $i; sleep 0.25; done', { stallMs: 700 });
    expect(printing.outcome).toBe('exited');
    expect(printing.exit).toBe(0);
    expect(printing.wall).toBeGreaterThan(1500);
  });

  test('a group that ignores SIGTERM is SIGKILLed after the grace period', async () => {
    const dir = scratch();
    const r = await run(dir, `trap '' TERM; echo $$ > ${dir}/stubborn.pid; while :; do sleep 0.1; done`, { stallMs: 500, graceMs: 400 });
    expect(r.outcome).toBe('stalled');
    expect(r.wall).toBeLessThan(5000);
    expect(await goneSoon(await pidFrom(`${dir}/stubborn.pid`))).toBe(true);
  });

  test('the deadline kills the group as timeout; a launch that cannot start is spawn-failed, never a pass', async () => {
    const dir = scratch();
    const slow = await run(dir, 'while :; do echo busy; sleep 0.1; done', { deadline: Date.now() + 600, stallMs: 0 });
    expect(slow.outcome).toBe('timeout');
    expect(slow.exit).toBeNull();
    const missing = await run(dir, 'true', { cwd: path.join(dir, 'does-not-exist') });
    expect(missing.outcome).toBe('spawn-failed');
    expect(missing.exit).toBeNull();
  });

  test('heartbeats arrive after each quiet interval without progress lines', async () => {
    const dir = scratch();
    const r = await run(dir, 'sleep 1.2; echo late', { heartbeatMs: 300 });
    expect(r.outcome).toBe('exited');
    expect(r.lines.filter(l => l.startsWith('PREGATE_HEARTBEAT: fixture running ')).length).toBeGreaterThanOrEqual(2);
    expect(r.lines.some(l => l.startsWith('PREGATE_TEST:'))).toBe(false);
  });

  // Value: protects=a remote gate's heartbeat says what the gate last printed (GST-431); fails_when=the heartbeat for a gate that
  //   reports its CI wait shows only "last file none reported"; why_new=a CI-waiting gate looked dead on qm (CAPY-1); seam=none; no_claim=none
  test('with lastLine, a heartbeat names the command\'s last output line', async () => {
    const dir = scratch();
    const r = await run(dir, 'echo "waiting on run 7 (in_progress)"; sleep 1.2; echo done', { heartbeatMs: 300, lastLine: true });
    expect(r.outcome).toBe('exited');
    expect(r.lines.some(l => l.startsWith('PREGATE_HEARTBEAT: fixture running ') && l.includes('last output: waiting on run 7 (in_progress)'))).toBe(true);
    const redraw = await run(dir, "printf 'run 7 queued\\r\\033[2Krun 7 in_progress\\n'; sleep 1.2", { heartbeatMs: 300, lastLine: true });
    expect(redraw.lines.some(l => l.endsWith('last output: run 7 in_progress'))).toBe(true);
    expect(redraw.lines.some(l => l.includes('\x1b') || l.includes('\r'))).toBe(false);
  });

  // Value: protects=reading the last line is best effort: a log that disappears mid-run never throws out of the supervisor's timer, which would
  //   abandon the gate's deadline and cleanup (GST-431 review); fails_when=lastLine sampling throws ENOENT; why_new=lastLine is new; seam=none; no_claim=none
  test('with lastLine, a log removed mid-run still ends in a normal outcome', async () => {
    const dir = scratch();
    const log = path.join(dir, 'run.log');
    fs.writeFileSync(log, '');
    const r = await supervise({ command: `echo hi; sleep 0.4; rm -f "${log}"; sleep 1.2; echo done`, cwd: dir, env: process.env, log, deadline: Date.now() + 30_000, stallMs: 0, graceMs: 300, pollMs: 50, heartbeatMs: 300, lastLine: true, label: 'fixture', progress: () => {} });
    expect(r.outcome).toBe('exited');
  });
});

describe('supervise: per-file progress adapters', () => {
  const bunTest = (body: string) => `import { test, expect } from 'bun:test';\n${body}\n`;

  test('bun test has an adapter: start and pass|fail per file from its headers; a runner without one reports nothing per file', async () => {
    expect(adapterFor('bun test {files}')).toBe('bun');
    expect(adapterFor('bun test --timeout=60000 {files}')).toBe('bun');
    expect(adapterFor('node --test {files}')).toBeNull();
    expect(adapterFor('npx vitest run {files}')).toBeNull();
    const dir = scratch();
    fs.writeFileSync(path.join(dir, 'a.test.ts'), bunTest("test('a', () => expect(1).toBe(1));"));
    fs.writeFileSync(path.join(dir, 'b.test.ts'), bunTest("test('b', () => expect(1).toBe(2));"));
    const files = ['a.test.ts', 'b.test.ts'];
    for (const ci of ['', 'true']) {
      const r = await run(dir, `GITHUB_ACTIONS=${ci} ${process.execPath} test ${files.join(' ')}`, { files, adapter: 'bun' });
      expect(r.exit).toBe(1);
      const events = r.lines.filter(l => l.startsWith('PREGATE_TEST:')).map(l => l.replace(/ \d+\.\d$/, ''));
      expect(events).toEqual(['PREGATE_TEST: 1/2 a.test.ts start', 'PREGATE_TEST: 1/2 a.test.ts pass', 'PREGATE_TEST: 2/2 b.test.ts start', 'PREGATE_TEST: 2/2 b.test.ts fail']);
    }
    const unsupported = await run(dir, 'echo "test a.test.ts ok"; echo "test b.test.ts ok"', { files, adapter: null });
    expect(unsupported.lines.some(l => l.startsWith('PREGATE_TEST:'))).toBe(false);
  });

  test('a one-file run reports its file from the launch for any runner; a bun test that blocks forever stalls naming that file', async () => {
    const dir = scratch();
    const one = await run(dir, 'echo ok', { files: ['test/x.test.js'], adapter: null, counter: { done: 4, total: 9 } });
    expect(one.lines.map(l => l.replace(/ \d+\.\d$/, ''))).toEqual(['PREGATE_TEST: 5/9 test/x.test.js start', 'PREGATE_TEST: 5/9 test/x.test.js pass']);
    fs.writeFileSync(path.join(dir, 'ok.test.ts'), bunTest("test('ok', () => expect(1).toBe(1));"));
    fs.writeFileSync(path.join(dir, 'hang.test.ts'), bunTest("test('blocks', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });"));
    const files = ['ok.test.ts', 'hang.test.ts'];
    const hung = await run(dir, `${process.execPath} test ${files.join(' ')}`, { files, adapter: 'bun', stallMs: 1500 });
    expect(hung.outcome).toBe('stalled');
    expect(hung.lastFile).toBe('hang.test.ts');
    expect(hung.lines.some(l => /^PREGATE_TEST: [12]\/2 hang\.test\.ts start$/.test(l))).toBe(true);
    expect(hung.lines.some(l => /^PREGATE_TEST: [12]\/2 hang\.test\.ts fail /.test(l))).toBe(true);
  });
});

describe('withFingerprint over async checks', () => {
  test('a rejected check promise is incomplete, never pass', async () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const loaded = buildContext({ repoRoot: repo.work, base: 'main', policyFrom: 'base', allowRepoCommands: false, env: { ...process.env, ...repo.env }, testBackend: 'local', cores: 16 });
    if (!('ctx' in loaded)) throw new Error('fixture context refused');
    const r = await withFingerprint(loaded.ctx, 'lanes', 'tests', async () => { throw new Error('runner vanished'); });
    expect(r).toMatchObject({ status: 'incomplete', code: 'PREGATE_INCOMPLETE', detail: 'threw: runner vanished' });
  });
});

describe('gstack-pregate: the test stage never hangs silently', () => {
  const NODE_HANG = "const test = require('node:test');\ntest('blocks', () => { require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', '..', 'hang.pid'), String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); });\n";
  const NODE_BACKGROUND = "const test = require('node:test');\nconst { spawn } = require('node:child_process');\ntest('backgrounds a child holding stdout', () => { const c = spawn('sleep', ['1000'], { stdio: 'inherit' }); require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', '..', 'bg.pid'), String(c.pid)); c.unref(); });\n";
  const pregate = (repo: FixtureRepo, args: string[]) => runBin(repo, 'gstack-pregate', ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', ...args]);
  const lanes = (repo: FixtureRepo) => JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/pregate.json'), 'utf8')).checks.find((c: any) => c.id === 'lanes');

  test('a test that blocks forever is killed at the stall timeout, named, and recorded incomplete; --json stdout stays one JSON document', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    commit(repo, { 'test/hang.test.js': NODE_HANG });
    const started = Date.now();
    const r = pregate(repo, ['--stall-timeout', '2', '--json']);
    expect(Date.now() - started).toBeLessThan(60_000);
    expect(r.status).toBe(EXIT.fail);
    const doc = JSON.parse(r.out);
    expect(doc.ok).toBe(false);
    const row = doc.checks.find((c: any) => c.id === 'lanes');
    expect(row).toMatchObject({ status: 'incomplete', code: 'PREGATE_STALLED' });
    expect(row.detail).toContain('last file started: test/hang.test.js');
    expect(r.err).toContain('PREGATE_TEST: 1/1 test/hang.test.js start');
    expect(r.err).toMatch(/^PREGATE: tests incomplete in \d+\.\ds — lanes: no test output for 2 s/m);
    expect(alive(Number(fs.readFileSync(path.join(repo.root, 'hang.pid'), 'utf8')))).toBe(false);
  }, 90_000);

  test('the base branch stall_timeout_s applies without the flag', () => {
    const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, stall_timeout_s: 2 } }); repos.push(repo);
    commit(repo, { 'test/hang.test.js': NODE_HANG });
    const r = pregate(repo, []);
    expect(r.status).toBe(EXIT.fail);
    expect(lanes(repo)).toMatchObject({ status: 'incomplete', code: 'PREGATE_STALLED' });
    expect(r.out).toMatch(/^tests {6}lanes {5}incomplete .*no test output for 2 s.*\(PREGATE_STALLED\)$/m);
    expect(r.err).toMatch(/^gstack-pregate: lanes stalled — .*; fix: .* \(PREGATE_STALLED; https:\/\/github\.com\/garrytan\/gstack\/blob\/main\/docs\/troubleshooting\.md#pregate-stalled\)$/m);
  }, 90_000);

  test('a test whose child backgrounds and holds stdout passes promptly instead of waiting out --timeout', () => {
    const repo = makeFixtureRepo({ pregate: { ...BASE_PREGATE, runner: 'node {files}' } }); repos.push(repo);
    commit(repo, { 'test/bg.test.js': NODE_BACKGROUND });
    const started = Date.now();
    const r = pregate(repo, ['--timeout', '90']);
    expect(Date.now() - started).toBeLessThan(45_000);
    expect(r.status).toBe(EXIT.ok);
    expect(lanes(repo).status).toBe('pass');
    expect(alive(Number(fs.readFileSync(path.join(repo.root, 'bg.pid'), 'utf8')))).toBe(false);
  }, 90_000);

  test('--timeout bounds each runner process: serial files that each fit run to a pass even when their total exceeds it; one that overruns is incomplete', () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    const slow = "const test = require('node:test');\ntest('slow', async () => { await new Promise(r => setTimeout(r, 1500)); });\n";
    commit(repo, { 'test/a.serial.test.js': slow, 'test/b.serial.test.js': slow, 'test/c.serial.test.js': slow });
    const r = pregate(repo, ['--timeout', '3']);
    expect(r.status).toBe(EXIT.ok);
    expect(lanes(repo)).toMatchObject({ status: 'pass' });
    expect(lanes(repo).detail).toContain('3 tests ran in 3 file(s) (3 serial), exit 0');
    commit(repo, { 'test/c.serial.test.js': "const test = require('node:test');\ntest('slower', async () => { await new Promise(r => setTimeout(r, 5000)); });\n" });
    expect(pregate(repo, ['--timeout', '3']).status).toBe(EXIT.fail);
    expect(lanes(repo)).toMatchObject({ status: 'incomplete', code: 'PREGATE_INCOMPLETE' });
    expect(lanes(repo).detail).toContain('a runner process timed out after 3000 ms (--timeout applies to each runner process; 3 files; last file started: test/c.serial.test.js)');
  }, 90_000);

  test('a late tree mutation by a test\'s child is caught while the check runs, and a leftover child cannot mutate the tree after it', async () => {
    const during = makeFixtureRepo(); repos.push(during);
    commit(during, { 'test/mutate.test.js': "const test = require('node:test');\nconst { spawn } = require('node:child_process');\ntest('mutates soon', async () => { spawn('sh', ['-c', 'sleep 0.3; echo changed >> README.md'], { stdio: 'ignore' }); await new Promise(r => setTimeout(r, 1500)); });\n" });
    expect(pregate(during, []).status).toBe(EXIT.fail);
    expect(lanes(during).detail).toContain('working tree changed during the check');
    const after = makeFixtureRepo(); repos.push(after);
    commit(after, { 'test/leftover.test.js': "const test = require('node:test');\nconst { spawn } = require('node:child_process');\ntest('leaves a child', () => { spawn('sh', ['-c', 'sleep 2; echo changed >> README.md'], { stdio: 'ignore' }).unref(); });\n" });
    expect(pregate(after, []).status).toBe(EXIT.ok);
    await Bun.sleep(2500);
    expect(fs.readFileSync(path.join(after.work, 'README.md'), 'utf8')).toBe('# fixture\n');
  }, 90_000);

  test('SIGTERM to pregate kills the running test process group, exits 143 and writes no pregate.json', async () => {
    const repo = makeFixtureRepo(); repos.push(repo);
    commit(repo, { 'test/hang.test.js': NODE_HANG });
    const child = spawn(BIN('gstack-pregate'), ['--base', 'main', '--allow-repo-commands', '--stage', 'tests', '--stall-timeout', '0'], { cwd: repo.work, env: { ...process.env, ...repo.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr!.on('data', d => { err += d; });
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    const testPid = await pidFrom(path.join(repo.root, 'hang.pid'), 30_000);
    child.kill('SIGTERM');
    expect(await exited).toBe(143);
    expect(err).toContain('gstack-pregate: cancelled by SIGTERM; killed 1 test process group(s); no pregate.json written');
    expect(await goneSoon(testPid)).toBe(true);
    expect(fs.existsSync(path.join(repo.work, '.gstack/tmp/pregate.json'))).toBe(false);
  }, 60_000);
});
