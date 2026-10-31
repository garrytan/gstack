/**
 * The main backstop (scripts/train-backstop.ts, evals-main-backstop.yml; plan
 * GSTA-49 T1b): inert without a train block; a train's merges are covered by
 * the train's own green record (a five-PR train fires zero backstop gates); a
 * merge outside the queue is gated, and a red gate writes the freeze record
 * gstack-ship-queue reads. Fixture repos with a bare origin under os.tmpdir()
 * and a scripted gh; no network, no API spend.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { loadPolicyFromHead } from '../lib/ship-policy';
import { NOTES_REF, persist, repoIdentity } from '../lib/ship-queue-train-record';
import type { GhRunner } from '../scripts/recover-receipts';
import { runBackstop } from '../scripts/train-backstop';
import { gitIn, trainPrefixes, type TrainRecord } from '../scripts/train-gate';
import { E2E_TOUCHFILES } from './helpers/touchfiles-data';
import { BASE_POLICY, cleanup, makeFixtureRepo, type FixtureRepo } from './helpers/restamp-fixture';
import { TRAIN_BLOCK, TRAIN_POLICY } from './helpers/ship-queue-train-fixture';

const REPO = 'fixture/repo';
const TRAIN_NONCE = 'gate.train-' + 'a'.repeat(12) + '-' + 'b'.repeat(12) + '-abc123';
const RED_CASE = Object.keys(E2E_TOUCHFILES)[0]!;
const repos: FixtureRepo[] = [];
afterAll(() => { for (const repo of repos) cleanup(repo); });
const savedStateRoot = process.env.GSTACK_STATE_ROOT;
afterEach(() => { if (savedStateRoot === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = savedStateRoot; });

interface Fixture { repo: FixtureRepo; main0: string; prs: string[]; train: string[]; record: TrainRecord }

/** Five PR branches from main and the train T1..T5 gstack-ship-queue would build from them (lib/ship-queue-train.ts buildChain). */
function trainFixture(policy: Record<string, unknown> = TRAIN_POLICY): Fixture {
  const repo = makeFixtureRepo({ policy, prefix: 'train-backstop-fx-' });
  repos.push(repo);
  process.env.GSTACK_STATE_ROOT = path.join(repo.root, 'state');
  const main0 = repo.git('rev-parse', 'HEAD');
  const prs = [1, 2, 3, 4, 5].map(i => {
    repo.git('checkout', '-q', '-B', `pr${i}`, main0);
    fs.writeFileSync(path.join(repo.work, `pr${i}.txt`), `pr ${i}\n`);
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', `pr ${i}`);
    return repo.git('rev-parse', 'HEAD');
  });
  const train: string[] = [];
  let parent = main0;
  prs.forEach((head, i) => {
    const tree = repo.git('merge-tree', '--write-tree', parent, head);
    parent = repo.git('commit-tree', tree, '-p', parent, '-p', head, '-m', `train T${i + 1}: merge #${101 + i} at ${head.slice(0, 12)}`);
    train.push(parent);
  });
  repo.git('checkout', '-q', 'main');
  const prefixes = trainPrefixes(gitIn(repo.work), parent, repo.work, loadPolicyFromHead(repo.work).policy);
  if (!Array.isArray(prefixes)) throw new Error(prefixes.error);
  const record: TrainRecord = { schema: 1, kind: 'train-gate', nonce: TRAIN_NONCE, head_sha: parent, tree: repo.git('rev-parse', `${parent}^{tree}`), verdict: 'GREEN',
    census: { complete: true, planned: { rule: 108, judge: 24 }, executed: { rule: 108, judge: 24 }, unbound: 0, partial_shards: 0, cancelled_shards: 0, killed_before_upload: 0 },
    panels: [], run: { id: 900, attempt: 1, url: 'https://example.invalid/runs/900' }, prefixes };
  return { repo, main0, prs, train, record };
}

/** The coordinator's squash merge of PR i onto main, stamped at merge (VERSION, package.json, the release output). */
function squashMerge(repo: FixtureRepo, i: number, extra: Record<string, string> = {}): string {
  repo.git('checkout', '-q', 'main');
  const version = `1.2.${3 + i}.0`;
  const files: Record<string, string> = { [`pr${i}.txt`]: `pr ${i}\n`, VERSION: version + '\n', 'generated/digest.md': `# digest v${version}\nbody\n`, ...extra };
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(repo.work, rel), text);
  const pkg = JSON.parse(fs.readFileSync(path.join(repo.work, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(repo.work, 'package.json'), JSON.stringify({ ...pkg, version: version.split('.').slice(0, 3).join('.') }, null, 2) + '\n');
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', `#${100 + i} (squash, stamped ${version})`);
  repo.git('push', '-q', 'origin', 'main');
  return repo.git('rev-parse', 'HEAD');
}

/** gh: the train's green run, its record artifact and check run, a gate dispatch whose run concludes as scripted, and an issue. */
function fakeGh(fx: Fixture, o: { record?: TrainRecord | null; check?: string; gate?: string } = {}) {
  const calls: string[][] = [];
  let dispatched = '';
  const ok = (body: unknown) => ({ status: 0, stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr: '' });
  const gh: GhRunner = (args) => {
    calls.push(args);
    const joined = args.join(' ');
    if (args[0] === 'api' && joined.includes('/actions/workflows/evals.yml/runs') && joined.includes('status=success')) {
      return ok({ workflow_runs: o.record === null ? [] : [{ id: 900, status: 'completed', conclusion: 'success', head_sha: fx.record.head_sha, display_title: `E2E Evals [eval-bg ${TRAIN_NONCE}]` }] });
    }
    if (args[0] === 'api' && joined.includes('/actions/workflows/evals.yml/runs')) {
      return ok({ workflow_runs: dispatched ? [{ id: 901, status: 'queued', conclusion: null, head_sha: '', display_title: `E2E Evals [eval-bg ${dispatched}]`, html_url: 'https://example.invalid/runs/901' }] : [] });
    }
    if (args[0] === 'run' && args[1] === 'download') {
      const dir = args[args.indexOf('-D') + 1]!;
      const name = args[args.indexOf('-n') + 1];
      fs.mkdirSync(dir, { recursive: true });
      if (name === TRAIN_BLOCK.record_artifact) fs.writeFileSync(path.join(dir, 'record.json'), JSON.stringify(o.record ?? fx.record));
      if (name === 'trial-outcomes-pr-a1') fs.writeFileSync(path.join(dir, 'trial-outcomes.jsonl'), JSON.stringify({ case: RED_CASE, attempt: 1, outcome: 'failed' }) + '\n');
      return ok('');
    }
    if (args[0] === 'api' && /\/commits\/[0-9a-f]{40}\/check-runs/.test(joined)) return ok({ check_runs: [{ name: TRAIN_BLOCK.full_gate_check, conclusion: o.check ?? 'success' }] });
    if (args[0] === 'workflow' && args[1] === 'run') {
      dispatched = args.find(a => a.startsWith('nonce='))!.slice('nonce='.length);
      return ok('');
    }
    if (args[0] === 'api' && /actions\/runs\/901$/.test(joined)) return ok({ id: 901, status: 'completed', conclusion: o.gate ?? 'failure', head_sha: '', html_url: 'https://example.invalid/runs/901' });
    if (args[0] === 'issue' && args[1] === 'create') return ok('https://github.com/fixture/repo/issues/7\n');
    return { status: 1, stdout: '', stderr: `unexpected gh ${joined}` };
  };
  return { gh, calls, dispatches: () => calls.filter(c => c[0] === 'workflow' && c[1] === 'run') };
}

const backstop = (fx: Fixture, sha: string, gh: GhRunner, over: Partial<Parameters<typeof runBackstop>[0]> = {}) =>
  runBackstop({ repo: REPO, branch: 'main', sha, repoRoot: fx.repo.work, gh, sleep: () => {}, pollMs: 1, random: 'abc123', ...over });

function originNotes(fx: Fixture): Array<Record<string, unknown>> {
  const list = fx.repo.git('--git-dir', fx.repo.origin, 'notes', `--ref=${NOTES_REF}`, 'list');
  return list.split('\n').filter(Boolean).map(line => JSON.parse(fx.repo.git('--git-dir', fx.repo.origin, 'cat-file', 'blob', line.split(' ')[0]!)));
}

describe('backstop: inert without a train block', () => {
  test('a push to main under a policy with no train block runs nothing and calls no gh', () => {
    const fx = trainFixture(BASE_POLICY);
    const { gh, calls } = fakeGh(fx);
    const out = backstop(fx, squashMerge(fx.repo, 1), gh);
    expect(out.action).toBe('inert');
    expect(out.lines[0]).toContain('declares no train block');
    expect(calls).toEqual([]);
  });

  // evals-main-backstop.yml reads this step output and publishes the
  // main-backstop check run the weekly release gates on (scripts/release-cut.ts).
  test.skipIf(process.platform === 'win32')('the CLI appends action=<action> to --outputs and exits 0 when inert', () => {
    const fx = trainFixture(BASE_POLICY);
    const sha = squashMerge(fx.repo, 1);
    const outputs = path.join(fx.repo.root, 'outputs.txt');
    const summary = path.join(fx.repo.root, 'summary.md');
    const r = spawnSync(process.execPath, [...bunIsolationArgs(), 'run', path.join(import.meta.dir, '..', 'scripts', 'train-backstop.ts'), 'run', '--repo', REPO, '--branch', 'main', '--sha', sha, '--summary', summary, '--outputs', outputs],
      { cwd: fx.repo.work, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: path.join(fx.repo.root, 'state') } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain('BACKSTOP: inert');
    expect(fs.readFileSync(outputs, 'utf8')).toBe('action=inert\n');
    expect(fs.readFileSync(summary, 'utf8')).toContain('- BACKSTOP: inert');
  });
});

describe("backstop: a train's merges are covered by the train's own green record", () => {
  test('a five-PR train fires zero backstop gates', () => {
    const fx = trainFixture();
    const { gh, dispatches } = fakeGh(fx);
    for (let i = 1; i <= 5; i++) {
      const out = backstop(fx, squashMerge(fx.repo, i), gh);
      expect(out.action, out.lines.join('\n')).toBe('covered');
      expect(out.lines.at(-1)).toContain(`is T${i} of green train ${TRAIN_NONCE} (run 900`);
    }
    expect(dispatches()).toEqual([]);
  });

  test('a superseded push hands main to the newer push without a gh call', () => {
    const fx = trainFixture();
    const first = squashMerge(fx.repo, 1);
    squashMerge(fx.repo, 2);
    const { gh, calls } = fakeGh(fx);
    expect(backstop(fx, first, gh).action).toBe('superseded');
    expect(calls).toEqual([]);
  });

  test('a record without a successful check run, or not GREEN, covers nothing: the backstop gates main', () => {
    const fx = trainFixture();
    const sha = squashMerge(fx.repo, 1);
    for (const o of [{ check: 'failure' }, { record: { ...fx.record, verdict: 'RED' as const } }, { record: { ...fx.record, census: { ...fx.record.census, complete: false } } }]) {
      const { gh, dispatches } = fakeGh(fx, { ...o, gate: 'success' });
      const out = backstop(fx, sha, gh);
      expect(out.action, JSON.stringify(o)).toBe('gated');
      expect(dispatches()).toHaveLength(1);
      expect(dispatches()[0]).toEqual(expect.arrayContaining(['evals.yml', '--ref', 'main', 'evals_all=true', `expected_sha=${sha}`]));
    }
  });
});

describe('backstop: a merge outside the queue', () => {
  test('is gated; a red gate writes the freeze record with its red cases, inputs, run and issue; the next run on that commit defers to it', () => {
    const fx = trainFixture();
    squashMerge(fx.repo, 1);
    const outside = squashMerge(fx.repo, 6, { 'outside.txt': 'merged outside the queue\n' });
    const { gh, dispatches } = fakeGh(fx);
    const out = backstop(fx, outside, gh);
    expect(out.action, out.lines.join('\n')).toBe('frozen');
    expect(dispatches()).toHaveLength(1);
    const nonce = dispatches()[0]!.find(a => a.startsWith('nonce='))!.slice('nonce='.length);
    expect(nonce).toStartWith(`gate.backstop-${outside.slice(0, 12)}-${outside.slice(0, 12)}-`);
    const freeze = originNotes(fx).find(r => r.kind === 'freeze')!;
    expect(freeze).toMatchObject({ schema: 1, kind: 'freeze', repo_key: repoIdentity(fx.repo.work).key, train: 'backstop', cleared_at: null,
      main: { sha: outside }, backstop: { nonce, run: 901, state: 'completed/failure' }, issue: 'https://github.com/fixture/repo/issues/7',
      red_cases: [{ id: RED_CASE, inputs: E2E_TOUCHFILES[RED_CASE] }] });
    expect(String(freeze.reason)).toContain(`${RED_CASE} (inputs `);
    expect(String(freeze.reason)).toContain('fix: land the revert or fix-forward');
    const again = fakeGh(fx);
    expect(backstop(fx, outside, again.gh).action).toBe('deferred');
    expect(again.dispatches()).toEqual([]);
  });

  test('a green gate on main writes nothing', () => {
    const fx = trainFixture();
    const outside = squashMerge(fx.repo, 6, { 'outside.txt': 'merged outside the queue\n' });
    const { gh, dispatches } = fakeGh(fx, { record: null, gate: 'success' });
    expect(backstop(fx, outside, gh).action).toBe('gated');
    expect(dispatches()).toHaveLength(1);
    expect(originNotes(fx)).toEqual([]);
  });
});

describe('backstop: debounce while a train merges', () => {
  let fx: Fixture;
  beforeEach(() => { fx = trainFixture(); });
  test('waits while a train is merging, then decides once the settle window ends', () => {
    const at = new Date().toISOString();
    persist(fx.repo.work, [{ schema: 1, kind: 'train', nonce: TRAIN_NONCE, repo_key: repoIdentity(fx.repo.work).key, state: 'merging', updated_at: at } as never]);
    const sha = squashMerge(fx.repo, 1);
    let clock = 0;
    const { gh, dispatches } = fakeGh(fx);
    const out = backstop(fx, sha, gh, { now: () => (clock += 20 * 60_000), settleMs: 60 * 60_000 });
    expect(out.lines.some(line => line.includes(`waiting for train(s) ${TRAIN_NONCE} to finish merging`))).toBe(true);
    expect(out.lines.some(line => line.includes('still merging after the settle window'))).toBe(true);
    expect(out.action).toBe('covered');
    expect(dispatches()).toEqual([]);
  });
});

describe('backstop: a stamped train (changelog_fragments) covers only exact trees', () => {
  test('main equal to S1 is covered as S1; the same tree with another VERSION is gated', () => {
    const fx = trainFixture();
    const { repo, main0, prs } = fx;
    let parent = main0;
    const stamped = prs.slice(0, 2).map((head, i) => {
      repo.git('checkout', '-q', '-f', '--detach', parent);
      repo.git('merge', '-q', '--no-ff', '--no-commit', head);
      fs.writeFileSync(path.join(repo.work, 'VERSION'), `1.2.${4 + i}.0\n`);
      repo.git('add', '-A');
      parent = repo.git('commit-tree', repo.git('write-tree'), '-p', parent, '-p', head, '-m', `train S${i + 1}: merge #${101 + i} at ${head.slice(0, 12)} v1.2.${4 + i}.0`);
      repo.git('merge', '--abort');
      return parent;
    });
    repo.git('checkout', '-q', '-f', 'main');
    const prefixes = trainPrefixes(gitIn(repo.work), parent, repo.work, loadPolicyFromHead(repo.work).policy);
    if (!Array.isArray(prefixes)) throw new Error(prefixes.error);
    expect(prefixes.map(p => [p.index, p.exact])).toEqual([[1, true], [2, true]]);
    const record = { ...fx.record, head_sha: parent, tree: repo.git('rev-parse', `${parent}^{tree}`), prefixes };
    const push = (tree: string) => {
      const sha = repo.git('commit-tree', tree, '-p', repo.git('rev-parse', 'main'), '-m', 'squash');
      repo.git('update-ref', 'refs/heads/main', sha);
      repo.git('push', '-q', 'origin', 'main');
      return sha;
    };
    const s1 = push(repo.git('rev-parse', `${stamped[0]}^{tree}`));
    const covered = backstop({ ...fx, record }, s1, fakeGh({ ...fx, record }, { record }).gh);
    expect(covered.action, covered.lines.join('\n')).toBe('covered');
    expect(covered.lines.at(-1)).toContain(`is S1 of green train ${TRAIN_NONCE} (run 900, exact tree`);
    repo.git('checkout', '-q', '-f', '--detach', stamped[0]!);
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '1.2.9.0\n');
    repo.git('add', '-A');
    const moduloStamps = push(repo.git('write-tree'));
    repo.git('checkout', '-q', '-f', 'main');
    const gated = backstop({ ...fx, record }, moduloStamps, fakeGh({ ...fx, record }, { record, gate: 'success' }).gh);
    expect(gated.lines.join('\n')).toContain("no green-train record lists main's tree");
    expect(gated.action).not.toBe('covered');
  });

  test('a chain that mixes stamped and plain prefixes is not a train head', () => {
    const fx = trainFixture();
    const { repo, train, prs } = fx;
    const s = repo.git('commit-tree', repo.git('rev-parse', `${train[0]}^{tree}`), '-p', train[0]!, '-p', prs[1]!, '-m', `train S2: merge #102 at ${prs[1]!.slice(0, 12)} v1.2.5.0`);
    expect(trainPrefixes(gitIn(repo.work), s, repo.work, loadPolicyFromHead(repo.work).policy)).toEqual({ error: `${train[0]!.slice(0, 12)} mixes stamped and plain prefixes` });
  });
});
