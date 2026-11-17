/**
 * G2 (handoffs/fold-subagents-2026-11-17, handoffs/ship-conductor-cost-2026-11-16): ship/DRIVER.md's limits in tools.
 * Measured conductors made 121-308 calls against the driver's 9 to 12 and 10 of 12 ran past its 100-minute stop, so
 * a phase now runs as one gstack-ship-phase command (resumable from its journal), every note records its calls, the
 * receipt carries calls=, and the first note or phase past 100 minutes prints STOP: past 100 minutes with the run's
 * state on disk. All checks here are free: real bins on fixture repositories, and the Capy phase program on a fake host
 * whose shell is real.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { extractReceipt, orderReceipt, placeReceipt, receiptSummaryLine, validateReceipt } from '../lib/ship-receipt';
import { resultLines } from '../lib/ship-phase';
import { cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';

const ROOT = path.resolve(import.meta.dir, '..');
const BIN_DIR = path.join(ROOT, 'bin');
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-phase-')));
const repos: FixtureRepo[] = [];
afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); while (repos.length) cleanup(repos.pop()!); });

interface Box { root: string; repo: string; state: string; record: string; env: NodeJS.ProcessEnv }
let n = 0;
/** A git fixture with a feature branch, a state root and an invocation record whose Next steps names the next act. */
function box(): Box {
  const root = path.join(tmp, `box-${++n}`);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  const env = { ...process.env, GSTACK_STATE_ROOT: path.join(root, 'state'), GSTACK_CAPY: '1', GSTACK_SHIP_CALL_NESTED: '', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...a: string[]) => { const r = spawnSync('git', a, { cwd: repo, env, encoding: 'utf8', timeout: 30_000 }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout.trim(); };
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"fixture","scripts":{"test":"true"}}\n');
  git('add', '-A'); git('commit', '-qm', 'init');
  git('checkout', '-qb', 'feat');
  fs.writeFileSync(path.join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
  git('add', '-A'); git('commit', '-qm', 'feat: b');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  const record = path.join(root, 'record.md');
  fs.writeFileSync(record, '# /ship record\n\n## Checks\n## Decisions\n## Reviews\n## Release\n## Documentation\n## Next steps\n- Phase 3: audits and review\n');
  return { root, repo, state: path.join(root, 'state'), record, env };
}
const bin = (b: Box, name: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
  spawnSync(path.join(BIN_DIR, name), args, { cwd: b.repo, env: { ...b.env, ...extra }, encoding: 'utf8', timeout: 60_000 });
const phase = (b: Box, args: string[], cmds: string[], extra: NodeJS.ProcessEnv = {}) =>
  bin(b, 'gstack-ship-phase', ['run', '--dir', path.join(b.root, 'run'), ...args, '--', ...cmds], extra);
const ledgerOf = (b: Box) => /ledger=(\S+)/.exec(fs.readFileSync(b.record, 'utf8'))![1]!;
const backdate = (b: Box, minutes: number) => {
  const l = JSON.parse(fs.readFileSync(ledgerOf(b), 'utf8'));
  l.created_at = new Date(Date.now() - minutes * 60_000).toISOString();
  fs.writeFileSync(ledgerOf(b), JSON.stringify(l, null, 2));
};
const start = (b: Box, mode: 'observe' | 'admit' = 'observe') => {
  const r = bin(b, 'gstack-ship-budget', ['start', '--record', b.record, ...(mode === 'observe' ? ['--mode', 'observe'] : []), '--reading', '1000', '--credits', '1']);
  expect(r.status, r.stdout + r.stderr).toBe(0);
};

describe('gstack-ship-phase run', () => {
  // Value: protects=a phase is one command that prints only result lines and resumes from its journal: a rerun after a failure starts at the failed command, finished ones stay done, and a changed list reruns from the first change; fails_when=the runner reruns finished commands (a second budget start, a second preflight), prints whole logs into the parent, or keeps a stale result after the command text changed;
  //   why_new=G2: the one-call-per-phase rule was prose and conductors made 121-308 calls; seam=none; no_claim=how many calls a model makes
  test('result lines only, a failed command stops the phase, and the same command resumes at it', () => {
    const b = box();
    const count = path.join(b.root, 'count');
    const first = `echo noise; echo x >> ${count}; echo 'FIRST: ran'`;
    const second = `test -f ${b.root}/fixed || { echo 'BAD: not fixed yet'; echo detail; exit 1; }; echo 'SECOND: ok'`;
    const failed = phase(b, ['--phase', '7'], [first, second]);
    expect(failed.status).toBe(3);
    const out = failed.stdout.trim().split('\n');
    expect(out[0]).toBe('RAN: 1/2 exit=0');
    expect(out).toContain('FIRST: ran');
    expect(out).toContain('BAD: not fixed yet');
    expect(failed.stdout).not.toContain('noise');
    expect(failed.stdout).not.toContain('detail');
    expect(out.at(-1)).toBe('STOP: phase 7 command 2/2 exited 1; fix the cause, then rerun the same command (commands before 2 stay done)');
    fs.writeFileSync(path.join(b.root, 'fixed'), '');
    const again = phase(b, ['--phase', '7'], [first, second]);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    expect(again.stdout).toContain('RAN: 1/2 exit=0 (done earlier)\nFIRST: ran\nRAN: 2/2 exit=0\nSECOND: ok\nPHASE: 7 done commands=2');
    expect(fs.readFileSync(count, 'utf8')).toBe('x\n');
    const changed = phase(b, ['--phase', '7'], [first + ' # v2', second]);
    expect(changed.status).toBe(0);
    expect(changed.stdout).toStartWith('RAN: 1/2 exit=0\nFIRST: ran\nRAN: 2/2 exit=0\n');
    expect(fs.readFileSync(count, 'utf8')).toBe('x\nx\n');
  }, 60_000);

  // Value: protects=no phase call waits past its 200 s budget: a long command keeps running after the call returns NEXT: rerun, and the rerun attaches to the same process instead of starting it again; fails_when=the runner blocks until slow work ends (a cold cache re-bill per long wait), kills the command when it returns, or starts it a second time on the rerun;
  //   why_new=G2 waits; seam=none; no_claim=the host's own timeout
  test('a command past --wait-s keeps running, the call returns NEXT: rerun, and the rerun waits on the same process', async () => {
    const b = box();
    const count = path.join(b.root, 'starts');
    const slow = `echo s >> ${count}; sleep 3; echo 'SLOW: done'`;
    const first = phase(b, ['--phase', '2', '--wait-s', '1'], [slow]);
    expect(first.status).toBe(0);
    expect(first.stdout).toMatch(/^WAITING: 1\/1 pid=\d+ running=\d+s log=\S+\/phases\/2\/1\.log\nNEXT: rerun /);
    const done = phase(b, ['--phase', '2', '--wait-s', '30'], [slow]);
    expect(done.status, done.stdout + done.stderr).toBe(0);
    expect(done.stdout).toStartWith('RAN: 1/1 exit=0\nSLOW: done\nPHASE: 2 done');
    expect(fs.readFileSync(count, 'utf8')).toBe('s\n');
  }, 60_000);

  // Value: protects=a changed command list never credits the replaced command's exit status to its replacement: the replaced process is stopped before the new command starts on the same log; fails_when=the old process keeps running and writes exit 0 into the file the new command is judged by (a false pass);
  //   why_new=/ship outside-voice review of #4451 reproduced the false pass; seam=none; no_claim=a process that ignores SIGTERM (it stops the phase instead)
  test.skipIf(process.platform === 'win32')('a replaced command still running is stopped, so its exit never settles the new command', () => {
    const b = box();
    const first = phase(b, ['--phase', '5', '--wait-s', '1'], [`sleep 2; echo 'OLD: ok'`]);
    expect(first.stdout).toContain('NEXT: rerun');
    const changed = phase(b, ['--phase', '5', '--wait-s', '30'], [`sleep 4; echo 'NEW: failed'; exit 1`]);
    expect(changed.stdout).toMatch(/^REPLACED: 1\/1 pid=\d+ ran a command this list no longer names; stopping it/);
    expect(changed.status, changed.stdout + changed.stderr).toBe(3);
    expect(changed.stdout).toContain('RAN: 1/1 exit=1');
    expect(changed.stdout).toContain('NEW: failed');
    expect(changed.stdout).not.toContain('OLD: ok');
  }, 60_000);

  test('result lines keep CODE: lines and gstack refusals, and drop everything else', () => {
    expect(resultLines('noise\nBUDGET: used=1\n  INDENTED: no\ngstack-ship-receipt write: refused (X)\nGSTACK_RESULT: skill=ship\nlower: no\n'))
      .toEqual(['BUDGET: used=1', 'gstack-ship-receipt write: refused (X)', 'GSTACK_RESULT: skill=ship']);
  });

  test('usage errors exit 2 and run nothing', () => {
    const b = box();
    expect(bin(b, 'gstack-ship-phase', ['run', '--phase', '2', '--', 'true']).status).toBe(2);
    expect(bin(b, 'gstack-ship-phase', ['run', '--dir', b.root, '--phase', '2']).status).toBe(2);
    expect(bin(b, 'gstack-ship-phase', ['run', '--dir', b.root, '--phase', '../x', '--', 'true']).status).toBe(2);
    expect(bin(b, 'gstack-ship-phase', ['nope']).status).toBe(2);
    expect(fs.existsSync(path.join(b.root, 'phases'))).toBe(false);
  });
});

const PROGRAM = fs.readFileSync(path.join(ROOT, 'lib/capy-ship-phase.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...a: string[]) => (...v: unknown[]) => Promise<string>;
/** A fake Capy host whose shell is real: bash runs in the fixture with bin/ on PATH; the jam's counter grows 1,000 tokens a read. */
function host(b: Box, intercept: (cmd: string) => { exit_code: number; output: string } | null = () => null) {
  let tokens = 1000;
  const bashes: string[] = [];
  const tools = {
    capy: { bash: async ({ command, timeout }: { command: string; timeout?: number }) => {
      bashes.push(command);
      const hit = intercept(command);
      if (hit) return hit;
      const r = spawnSync('bash', ['-c', command], { cwd: b.repo, env: { ...b.env, PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH}` }, encoding: 'utf8', timeout: (timeout ?? 120) * 1000 });
      return { exit_code: r.status ?? 1, output: r.stdout + r.stderr };
    } },
    thread: { get: async () => { tokens += 1000; return { cost: { tokens, credits: tokens / 1000 } }; } },
  };
  return { tools, bashes, run: (input: Record<string, unknown>) => new AsyncFunction('tools', 'sleep', 'now', 'input', PROGRAM)(tools, async () => {}, async () => Date.now(), input) };
}

describe('the Capy phase program', () => {
  // Value: protects=the checked-in phase program drives a real DRIVER phase on a fixture in one call: the budget start takes this jam's reading through $GSTACK_SHIP_READING, preflight --audit runs, only result lines return, and the closing note records the phase's calls; the same call again reruns nothing; fails_when=the program loses the reading, returns whole logs, skips the note, or a rerun repeats the budget start or the preflight;
  //   why_new=G2 item 1 (a no-cost check that the runner drives a real phase); seam=tools.capy.bash and tools.thread.get (real shell, counter stub); no_claim=Capy's own execute limits
  test('Phase 2 on a fixture: budget start and preflight --audit through gstack-ship-phase, then the note, in one program', async () => {
    const b = box();
    const h = host(b);
    const run = path.join(b.root, 'run');
    const input = { dir: run, phase: 2, record: b.record, jam: 'jam_test', step: '6', label: 'preflight', cwd: b.repo, commands: [
      `gstack-ship-budget start --record ${b.record} --mode observe --reading "$GSTACK_SHIP_READING" --credits "$GSTACK_SHIP_CREDITS"`,
      `gstack-ship-preflight --audit --base main --out ${run}`] };
    const first = (await h.run(input)).split('\n');
    expect(first[0]).toBe('RAN: 1/2 exit=0');
    expect(first).toContain('RAN: 2/2 exit=0');
    expect(first.some(l => l.startsWith('CONTEXT: diff='))).toBe(true);
    expect(first.some(l => l.startsWith('READER: coverage='))).toBe(true);
    expect(first.some(l => l.startsWith('PHASE: 2 done commands=2'))).toBe(true);
    expect(first.find(l => l.startsWith('NOTE: 6:preflight '))).toMatch(/^NOTE: 6:preflight used=1000 credits=1 calls=\d+$/);
    expect(first.every(l => !l.startsWith('  ') && !l.includes('diff --git'))).toBe(true);
    const ledger = JSON.parse(fs.readFileSync(ledgerOf(b), 'utf8'));
    expect(ledger.meter.baseline).toBe(2000);
    const again = await h.run(input);
    expect(again).toContain('RAN: 1/2 exit=0 (done earlier)');
    expect(again).toContain('RAN: 2/2 exit=0 (done earlier)');
  });

  // Value: protects=a host whose thread.get reports cost.dollars and no cost.credits still gives the budget a credits reading (1,000 credits a dollar); fails_when=the program passes --credits undefined and the start or closing note refuses it;
  //   why_new=Capy's thread.get returned only cost.dollars on 2026-11-17, so every phase note failed parseCredits; seam=tools.thread.get stub; no_claim=Capy's own pricing
  test('a host that reports only cost.dollars still gets a credits reading', async () => {
    const b = box();
    const h = host(b);
    let tokens = 1000;
    h.tools.thread.get = async () => { tokens += 1000; return { cost: { tokens, dollars: `$${(tokens / 1000).toFixed(2)}` } } as never; };
    const run = path.join(b.root, 'run');
    const out = await h.run({ dir: run, phase: 2, record: b.record, jam: 'jam_test', step: '6', cwd: b.repo, commands: [
      `gstack-ship-budget start --record ${b.record} --mode observe --reading "$GSTACK_SHIP_READING" --credits "$GSTACK_SHIP_CREDITS"`] });
    expect(out).not.toContain('STOP:');
    expect(out.split('\n').find(l => l.startsWith('NOTE: 6 '))).toMatch(/^NOTE: 6 used=1000 credits=1000 calls=\d+$/);
  });

  // Value: protects=a review phase is the same one call: after its commands, the program hands the review pass program its pass input with the launch, checkout, record and jam, and returns that program's lines; a phase whose commands stop never dispatches; fails_when=the phase program dispatches after a failed command, or drops the record or jam the pass notes with;
  //   why_new=G2 (dispatches inside the phase call); seam=gstack-review-dispatch program, replaced by a stub that echoes its input; no_claim=the pass program's own behavior (test/review-pass.test.ts)
  test('with input.pass it runs the review pass program on that input, and never after a failed command', async () => {
    const b = box();
    const stub = 'return "PASS_INPUT: " + JSON.stringify({ pass: input.pass, out: input.out, record: input.record, jam: input.jam, cwd: input.cwd });';
    const h = host(b, cmd => (cmd.endsWith('gstack-review-dispatch program') ? { exit_code: 0, output: `PROGRAM: v9 sha256=x bytes=1\n${JSON.stringify(stub)}\n` } : null));
    const out = await h.run({ dir: path.join(b.root, 'run'), phase: 3, record: b.record, jam: 'jam_test', cwd: b.repo, commands: ['echo "AUDIT: ok"'], pass: { pass: 'r-p1', out: path.join(b.root, 'run', 'p1') } });
    expect(out).toContain('AUDIT: ok');
    expect(out).toContain('PROGRAM: v9 sha256=x bytes=1');
    expect(out).toContain(`PASS_INPUT: {"pass":"r-p1","out":"${path.join(b.root, 'run', 'p1')}","record":"${b.record}","jam":"jam_test","cwd":"${b.repo}"}`);
    const failed = await h.run({ dir: path.join(b.root, 'run2'), phase: 3, cwd: b.repo, commands: ['echo "BAD: no"; exit 1'], pass: { pass: 'r-p2' } });
    expect(failed).toContain('STOP: phase 3 command 1/1 exited 1');
    expect(failed).not.toContain('PASS_INPUT');
  });
});

describe('the 100-minute stop', () => {
  // Value: protects=the 100-minute stop is a printed STOP with the run's state on disk (head, review passes, next act), the run refuses to start another phase until a resume restarts the clock, and an admit-mode run (ship/SKILL.md) never stops on time; fails_when=a note past 100 minutes continues (10 of 12 measured runs ran past the prose stop), stop.json lacks the head or the next act, a stopped run still starts a phase, or resume leaves the clock where every later note stops again;
  //   why_new=G2 item 3; seam=the ledger's created_at, backdated instead of waiting 100 minutes; no_claim=what the next session does with the state
  test('a note past 100 minutes prints STOP: past 100 minutes, writes stop.json, blocks the next phase until resume restarts the clock', () => {
    const b = box();
    start(b);
    const early = bin(b, 'gstack-ship-budget', ['note', '--record', b.record, '--step', '2', '--reading', '2000', '--credits', '2']);
    expect(early.status, early.stdout + early.stderr).toBe(0);
    backdate(b, 101);
    const late = bin(b, 'gstack-ship-budget', ['note', '--record', b.record, '--step', '6', '--reading', '3000', '--credits', '3']);
    expect(late.status).toBe(3);
    const lines = late.stdout.trim().split('\n');
    expect(lines[0]).toMatch(/^NOTE: 6 used=2000 credits=2/);
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: b.repo, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
    const dir = path.dirname(ledgerOf(b));
    expect(lines[1]).toMatch(new RegExp(`^STOP: past 100 minutes \\(10[01] min since \\S+\\) head=${head.slice(0, 12)} rounds=0 calls=\\d+ next=Phase 3: audits and review state=${dir}/stop\\.json$`));
    expect(lines.at(-1)).toBe(`GSTACK_RESULT: skill=ship status=incomplete run=${dir}`);
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'stop.json'), 'utf8'));
    expect(state).toMatchObject({ kind: 'gstack-ship-stop', reason: 'past_100_minutes', head, rounds: 0, next: 'Phase 3: audits and review', step: '6', record: b.record });
    const marker = path.join(b.root, 'phase-ran');
    const blocked = phase(b, ['--phase', '3', '--record', b.record], [`touch ${marker}`]);
    expect(blocked.status).toBe(3);
    expect(blocked.stdout).toContain('STOP: run ');
    expect(blocked.stdout).toContain('stopped (past_100_minutes) at Step 6; nothing ran; resume first: gstack-ship-budget resume --record');
    expect(fs.existsSync(marker)).toBe(false);
    const resumed = bin(b, 'gstack-ship-budget', ['resume', '--record', b.record, '--reading', '3000', '--credits', '3']);
    expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain('RESUMED: from=Step 6 (past_100_minutes)');
    expect(resumed.stdout).toMatch(/^CLOCK: restarted at \S+ \(the 100-minute limit counts from here\)$/m);
    const ran = phase(b, ['--phase', '3', '--record', b.record], [`touch ${marker}`]);
    expect(ran.status, ran.stdout).toBe(0);
    expect(bin(b, 'gstack-ship-budget', ['note', '--record', b.record, '--step', '9', '--reading', '4000', '--credits', '4']).status).toBe(0);
  });

  test('a phase that starts past 100 minutes stops before its first command; an admit-mode run never stops on time', () => {
    const b = box();
    start(b);
    backdate(b, 120);
    const marker = path.join(b.root, 'phase-ran');
    const late = phase(b, ['--phase', '5', '--record', b.record], [`touch ${marker}`]);
    expect(late.status).toBe(3);
    expect(late.stdout).toMatch(/^STOP: past 100 minutes \(1[12]\d min since /);
    expect(late.stdout).toContain('next=Phase 3: audits and review');
    expect(fs.existsSync(marker)).toBe(false);
    const admit = box();
    start(admit, 'admit');
    backdate(admit, 300);
    const note = bin(admit, 'gstack-ship-budget', ['note', '--record', admit.record, '--step', '6', '--reading', '2000', '--credits', '2']);
    expect(note.stdout).not.toContain('past 100 minutes');
  });
});

describe('calls per phase and calls= in the receipt', () => {
  // Value: protects=every note records the calls since the previous one and the receipt carries the run's total, so a 200-call run shows at the receipt; receipts written before calls= still validate, print and carry; fails_when=note drops calls, two notes count the same call, the summary line omits calls=, the schema refuses an older receipt or accepts a negative count, or carry loses calls;
  //   why_new=G2 item 2; seam=none; no_claim=calls that run no gstack command (the call log cannot see them)
  test('notes record calls per phase and close prints them in the timeline', () => {
    const b = box();
    phase(b, ['--phase', '2', '--record', b.record], [`${BIN_DIR}/gstack-ship-budget start --record ${b.record} --mode observe --reading 1000 --credits 1`]);
    const n1 = bin(b, 'gstack-ship-budget', ['note', '--record', b.record, '--step', '2', '--reading', '2000', '--credits', '2']);
    expect(n1.stdout).toMatch(/^NOTE: 2 used=1000 credits=1 calls=1$/m);
    const n2 = bin(b, 'gstack-ship-budget', ['note', '--record', b.record, '--step', '6', '--reading', '3000', '--credits', '3']);
    expect(n2.stdout).toMatch(/^NOTE: 6 used=2000 credits=2 calls=1$/m);
    const close = bin(b, 'gstack-ship-budget', ['close', '--record', b.record, '--reading', '3500', '--credits', '3.5']);
    expect(close.stdout).toMatch(/^BUDGET_TIMELINE: 2 used=1000 credits=1 calls=1; 6 used=2000 credits=2 calls=1$/m);
  });

  test('receipt write takes --calls or the run total from --budget-record', () => {
    const repo = makeFixtureRepo({ prefix: 'ship-phase-write-' });
    repos.push(repo);
    const env = { GSTACK_STATE_ROOT: path.join(repo.root, 'state'), GSTACK_CAPY: '1', GSTACK_SHIP_CALL_NESTED: '' };
    const record = path.join(repo.root, 'record.md');
    fs.writeFileSync(record, '# record\n');
    expect(runBin(repo, 'gstack-ship-budget', ['start', '--record', record, '--mode', 'observe', '--reading', '1000', '--credits', '1'], env).status).toBe(0);
    expect(runBin(repo, 'gstack-ship-budget', ['note', '--record', record, '--step', '2', '--reading', '2000', '--credits', '2'], env).status).toBe(0);
    const write = (extra: string[]) => runBin(repo, 'gstack-ship-receipt', ['write', '--pr', '9', '--base', 'main', '--session-kind', 'unattended', ...extra], env);
    const counted = write(['--budget-record', record]);
    expect(counted.status, counted.err).toBe(0);
    expect(counted.err).toMatch(/^SHIP_RECEIPT: pr=9 .* calls=[1-9]\d*( |$)/m);
    expect(extractReceipt(counted.out).receipt!.calls).toBeGreaterThanOrEqual(1);
    const given = write(['--calls', '214']);
    expect(given.err).toMatch(/ calls=214( |$)/m);
    expect(write(['--calls', 'many']).status).toBe(2);
    expect(write([]).err).not.toContain('calls=');
  }, 60_000);

  test('the receipt field: optional, a whole number, printed as calls=, kept by placement and carry', () => {
    const old = { schema_version: 1, pr: 5, head: 'a'.repeat(40), base: 'main' };
    expect(validateReceipt(old)).toEqual([]);
    expect(receiptSummaryLine(old as any)).not.toContain('calls=');
    const withCalls = orderReceipt({ ...old, spend_usd: 1.5, session_kind: 'unattended', calls: 214 } as any);
    expect(Object.keys(withCalls)).toEqual(['schema_version', 'pr', 'head', 'base', 'spend_usd', 'calls', 'session_kind']);
    expect(validateReceipt(withCalls)).toEqual([]);
    expect(receiptSummaryLine(withCalls)).toBe(`SHIP_RECEIPT: pr=5 head=${'a'.repeat(12)} version=- base=main session_kind=unattended calls=214`);
    for (const bad of [-1, 1.5, '12']) expect(validateReceipt({ ...old, calls: bad }).length).toBeGreaterThan(0);
    expect(extractReceipt(placeReceipt('## Summary\n\nProse.\n', withCalls)).receipt!.calls).toBe(214);
  });

  test('carry moves a receipt with calls= and one without it to a test-only head', () => {
    for (const calls of [undefined, 37]) {
      const repo = makeFixtureRepo({ prefix: 'ship-phase-carry-' });
      repos.push(repo);
      fs.mkdirSync(path.join(repo.work, 'src'), { recursive: true });
      fs.mkdirSync(path.join(repo.work, 'test'), { recursive: true });
      fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 1;\n');
      fs.writeFileSync(path.join(repo.work, 'test', 'app.test.ts'), 'test a\n');
      repo.git('add', '.'); repo.git('commit', '-qm', 'seed'); repo.git('push', '-q', 'origin', 'main');
      repo.git('checkout', '-qb', 'feat');
      fs.writeFileSync(path.join(repo.work, 'src', 'app.ts'), 'export const a = 2;\n');
      repo.git('commit', '-qam', 'feat: a=2');
      const reviewed = repo.git('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(repo.work, 'test', 'app.test.ts'), 'test a=2\n');
      repo.git('commit', '-qam', 'test: fix expectation');
      const head = repo.git('rev-parse', 'HEAD');
      const body = path.join(repo.root, 'body.md');
      fs.writeFileSync(body, placeReceipt('## Summary\n\nProse.\n', { schema_version: 1, pr: 5, head: reviewed, base: 'main', ...(calls === undefined ? {} : { calls }) } as any));
      const carried = runBin(repo, 'gstack-ship-receipt', ['carry', '--body', body], { GSTACK_STATE_ROOT: path.join(repo.root, 'state'), GSTACK_SESSION_KIND: 'unattended' });
      expect(carried.status, carried.out + carried.err).toBe(0);
      const after = extractReceipt(fs.readFileSync(body, 'utf8'));
      expect(after.errors).toEqual([]);
      expect(after.receipt!.head).toBe(head);
      expect(after.receipt!.calls).toBe(calls);
      expect(carried.err.includes(`calls=${calls}`)).toBe(calls !== undefined);
    }
  }, 60_000);
});
