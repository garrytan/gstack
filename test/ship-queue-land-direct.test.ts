/**
 * gstack-ship-queue land --pr <n> --pin <sha> (docs/ship-policy.md#land-direct): B1's direct land over real fixture
 * repos (bare origin, lane clone) and a gh shim that answers pr view (with mergeable, mergeStateStatus and the merge
 * commit), check runs and a squash merge against the bare origin. Covers the happy path for an unstamped,
 * fragment-only head, a base that moved but still merges clean, a refusal for each condition, the post-merge tree
 * check, the land note, train build under merge: direct, and the policy key's validation.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { MERGE_KEY_VERSION, validatePolicy } from '../lib/ship-policy';
import { BASE_POLICY, cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';
import { shippedBody } from './helpers/ship-queue-train-fixture';
import { persist, repoIdentity } from '../lib/ship-queue-train-record';
import { rewriteStamps, tentativeMentions } from '../lib/restamp';
import { bumpVersion } from '../lib/version-gate-train';

const REQUIRED = ['free-tests', 'Check VERSION is not stale vs queue'];
const POLICY = { ...BASE_POLICY, release_tool: null, release_outputs: [], changelog_fragments: { dir: 'changelog.d', required_checks: REQUIRED }, merge: 'direct', min_gstack_version: MERGE_KEY_VERSION };
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

interface Fx { repo: FixtureRepo; env: Record<string, string>; write: (fn: (d: any) => void) => void; read: () => any }
function setup(policy: Record<string, unknown> = POLICY): Fx {
  const repo = makeFixtureRepo({ policy, prefix: 'gstack-land-direct-fx-' });
  repos.push(repo);
  const dir = path.join(repo.root, 'gh-shim');
  fs.mkdirSync(dir, { recursive: true });
  const data = path.join(dir, 'data.json');
  fs.writeFileSync(data, JSON.stringify({ prs: {}, checks: {}, defaultChecks: REQUIRED }));
  fs.writeFileSync(path.join(dir, 'gh'), [
    '#!/usr/bin/env node',
    "const fs=require('fs');const {execFileSync}=require('child_process');",
    'const D=process.env.LAND_SHIM_DATA, O=process.env.LAND_SHIM_ORIGIN;',
    "const d=JSON.parse(fs.readFileSync(D,'utf8'));const a=process.argv.slice(2);",
    "const g=(...x)=>execFileSync('git',['--git-dir',O,...x],{encoding:'utf8',timeout:30000}).trim();",
    "const save=()=>fs.writeFileSync(D,JSON.stringify(d));",
    "if(a[0]==='pr'&&a[1]==='view'){const p=d.prs[a[2]];if(!p){console.error('no pr');process.exit(1)}",
    "  let head='';try{head=g('rev-parse','refs/heads/'+p.headRefName)}catch{};",
    "  console.log(JSON.stringify({mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',...p,headRefOid:p.headRefOid??head,mergeCommit:p.mergeSha?{oid:p.mergeSha}:null}));process.exit(0)}",
    "if(a[0]==='api'){const m=/commits\\/([0-9a-f]+)\\/(check-runs|status)/.exec(a[1]);if(!m)process.exit(1);",
    "  if(m[2]==='status'){console.log(JSON.stringify({total_count:0,statuses:[]}));process.exit(0)}",
    "  const set=d.checks[m[1]]??Object.fromEntries(d.defaultChecks.map(n=>[n,'success']));",
    "  const runs=Object.entries(set).map(([name,c],i)=>({id:i+1,name,status:c==='pending'?'in_progress':'completed',conclusion:c==='pending'?null:c,completed_at:'2026-11-03T00:00:00Z',app:{id:1}}));",
    "  console.log(JSON.stringify({total_count:runs.length,check_runs:runs}));process.exit(0)}",
    "if(a[0]==='pr'&&a[1]==='merge'){const p=d.prs[a[2]];const want=a[a.indexOf('--match-head-commit')+1];const head=g('rev-parse','refs/heads/'+p.headRefName);",
    "  if(head!==want){console.error('Head branch was modified');process.exit(1)}",
    "  const main=g('rev-parse','refs/heads/main');let tree=g('merge-tree','--write-tree',main,want).split('\\n')[0];",
    "  if(d.strayOnMerge){tree=g('rev-parse',main+'^{tree}')}",
    "  const sq=g('commit-tree',tree,'-p',main,'-m','squash #'+a[2]);g('update-ref','refs/heads/main',sq);",
    "  d.mergeArgs=a.slice(2);p.state='MERGED';p.mergeSha=sq;save();process.exit(0)}",
    "console.error('gh shim: unsupported '+a.join(' '));process.exit(1);",
    '',
  ].join('\n'), { mode: 0o755 });
  const env = { PATH: dir + ':' + (process.env.PATH ?? ''), LAND_SHIM_DATA: data, LAND_SHIM_ORIGIN: repo.origin };
  const read = () => JSON.parse(fs.readFileSync(data, 'utf8'));
  return { repo, env, read, write: fn => { const d = read(); fn(d); fs.writeFileSync(data, JSON.stringify(d)); } };
}

/** The READY receipt gstack-ship-queue ready records (a note on origin refs/notes/gstack-trains), written from another state root. */
function markReady(fx: Fx, pr: string, head: string): void {
  const prior = process.env.GSTACK_STATE_ROOT;
  process.env.GSTACK_STATE_ROOT = path.join(fx.repo.root, 'ready-state');
  try {
    const now = new Date().toISOString();
    persist(fx.repo.work, [{ schema: 1, kind: 'ready', repo_key: repoIdentity(fx.repo.work).key, pr, head, base_sha: fx.repo.git('rev-parse', 'origin/main'), ready_at: now, screen: { choice: 'no-screen', policy: null, nonce: null, run: null, merge_sha: null }, updated_at: now }]);
  } finally { if (prior === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prior; }
}

/** A PR branch from origin/main with one product file and a fragment, pushed, shipped (receipt at its head) and READY. */
function openPr(fx: Fx, pr: string, opts: { edit?: (work: string) => void; shipped?: boolean; ready?: boolean; fork?: boolean } = {}): string {
  const { repo } = fx;
  repo.git('fetch', '-q', 'origin');
  repo.git('checkout', '-q', 'origin/main', '-B', 'pr-' + pr);
  fs.writeFileSync(path.join(repo.work, 'pr-' + pr + '.txt'), pr + '\n');
  fs.mkdirSync(path.join(repo.work, 'changelog.d'), { recursive: true });
  fs.writeFileSync(path.join(repo.work, 'changelog.d', 'pr-' + pr + '.md'), '- #' + pr + ' change\n');
  opts.edit?.(repo.work);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'pr ' + pr);
  repo.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/pr-' + pr);
  const head = repo.git('rev-parse', 'HEAD');
  fx.write(d => { d.prs[pr] = { state: 'OPEN', baseRefName: 'main', headRefName: 'pr-' + pr, isCrossRepository: !!opts.fork, title: 'PR ' + pr, body: opts.shipped === false ? '' : shippedBody(pr, head) }; });
  if (opts.ready !== false) markReady(fx, pr, head);
  repo.git('checkout', '-q', '--detach', 'origin/main');
  return head;
}
const land = (fx: Fx, pr: string, pin: string, extra: string[] = []) => runBin(fx.repo, 'gstack-ship-queue', ['land', '--pr', pr, '--pin', pin, '--base', 'main', ...extra], fx.env);
const remote = (fx: Fx, ref: string) => { fx.repo.git('fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*'); return fx.repo.git('rev-parse', 'origin/' + ref); };
const show = (fx: Fx, rev: string) => fx.repo.git('show', rev);
const landNotes = (fx: Fx) => {
  const notes = (...a: string[]) => fx.repo.git('--git-dir', fx.repo.origin, 'notes', '--ref=refs/notes/gstack-trains', ...a);
  let list = '';
  try { list = notes('list'); } catch { return []; }
  return list.split('\n').filter(Boolean).map(l => JSON.parse(notes('show', l.split(' ')[1]!))).filter(r => r.kind === 'land');
};
/** Whether a clone holds a commit. */
const spawnCheck = (dir: string, sha: string) => spawnSync('git', ['-C', dir, 'cat-file', '-e', `${sha}^{commit}`], { timeout: 30_000 }).status === 0;
/** Commit a file straight onto origin/main (another PR that landed first). */
function moveMain(fx: Fx, file: string, text: string): string {
  const { repo } = fx;
  repo.git('fetch', '-q', 'origin');
  repo.git('checkout', '-q', '--detach', 'origin/main');
  fs.writeFileSync(path.join(repo.work, file), text);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'other change on main');
  repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
  return repo.git('rev-parse', 'HEAD');
}

describe('land --pin: direct merge at the PR\'s own green head', () => {
  test('happy path: an unstamped, fragment-only head merges with --squash --match-head-commit, main keeps its VERSION, and a land note is written', () => {
    const fx = setup();
    const base = remote(fx, 'main');
    const pin = openPr(fx, '7');
    const r = land(fx, '7', pin);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
    expect(fx.read().mergeArgs).toEqual(['7', '--squash', '--match-head-commit', pin]);
    const main = remote(fx, 'main');
    expect(fx.repo.git('rev-parse', main + '^1')).toBe(base);
    expect(r.out).toContain('MERGED: #7 as ' + main);
    expect(r.out).toMatch(/^LANDED: origin\/main tree [0-9a-f]+ equals the pin merged onto [0-9a-f]+$/m);
    expect(show(fx, main + ':VERSION')).toBe(show(fx, base + ':VERSION'));
    expect(show(fx, main + ':changelog.d/pr-7.md')).toBe('- #7 change');
    const notes = landNotes(fx);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: 'land', pr: '7', pin, merge_sha: main, base_sha: base });
  }, 90_000);

  test('the base moved and the PR still merges clean: it lands as it is, on the new base, with no restamp or extra CI round', () => {
    const fx = setup();
    const pin = openPr(fx, '8');
    const moved = moveMain(fx, 'other.txt', 'other\n');
    const r = land(fx, '8', pin);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
    const main = remote(fx, 'main');
    expect(fx.repo.git('rev-parse', main + '^1')).toBe(moved);
    expect(show(fx, main + ':other.txt')).toBe('other');
    expect(show(fx, main + ':pr-8.txt')).toBe('8');
    expect(fx.repo.git('rev-parse', 'origin/pr-8')).toBe(pin);
  }, 90_000);

  test('a rerun after GitHub merged the PR goes straight to the tree check and lands', () => {
    const fx = setup();
    const pin = openPr(fx, '9');
    expect(land(fx, '9', pin).status).toBe(EXIT.ok);
    const again = land(fx, '9', pin);
    expect(again.err).toBe('');
    expect(again.status).toBe(EXIT.ok);
    expect(again.out).toContain('already merged');
    expect(again.out).toMatch(/^LANDED: /m);
  }, 90_000);

  test('--dry-run checks everything and merges nothing', () => {
    const fx = setup();
    const base = remote(fx, 'main');
    const pin = openPr(fx, '10');
    const r = land(fx, '10', pin, ['--dry-run']);
    expect(r.err).toBe('');
    expect(r.out).toContain('DRY-RUN: nothing merged');
    expect(remote(fx, 'main')).toBe(base);
  }, 90_000);
});

describe('land --pin: refusals (nothing merged)', () => {
  const refused = (fx: Fx, r: { status: number | null; err: string }, code: string) => {
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.err).toContain('(' + code + ')');
    expect(fx.read().mergeArgs).toBeUndefined();
  };

  test('QUEUE_LAND_STAMPED: a head that bumps VERSION names the one-command fix', () => {
    const fx = setup();
    const pin = openPr(fx, '11', { edit: w => fs.writeFileSync(path.join(w, 'VERSION'), '1.2.4.0\n') });
    const r = land(fx, '11', pin);
    refused(fx, r, 'QUEUE_LAND_STAMPED');
    expect(r.err).toContain('git checkout $(git merge-base origin/main HEAD) -- VERSION');
  }, 90_000);

  test('QUEUE_LAND_STAMPED: a head that edits the CHANGELOG or the package.json version', () => {
    const fx = setup();
    const pin = openPr(fx, '12', {
      edit: w => {
        fs.appendFileSync(path.join(w, 'CHANGELOG.md'), '\n- stray\n');
        const pkg = JSON.parse(fs.readFileSync(path.join(w, 'package.json'), 'utf8')); pkg.version = '9.9.9';
        fs.writeFileSync(path.join(w, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
      },
    });
    const r = land(fx, '12', pin);
    refused(fx, r, 'QUEUE_LAND_STAMPED');
    expect(r.err).toContain('CHANGELOG.md');
    expect(r.err).toContain('package.json version');
  }, 90_000);

  test('a package.json dependency edit is not a stamp', () => {
    const fx = setup();
    const pin = openPr(fx, '13', {
      edit: w => { const pkg = JSON.parse(fs.readFileSync(path.join(w, 'package.json'), 'utf8')); pkg.dependencies = { ...(pkg.dependencies ?? {}), 'left-pad': '1.3.0' }; fs.writeFileSync(path.join(w, 'package.json'), JSON.stringify(pkg, null, 2) + '\n'); },
    });
    const r = land(fx, '13', pin);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
  }, 90_000);

  test('QUEUE_LAND_PIN_MOVED: the PR head is not the pin', () => {
    const fx = setup();
    const pin = openPr(fx, '14');
    fx.write(d => { d.prs['14'].headRefOid = 'a'.repeat(40); });
    refused(fx, land(fx, '14', pin), 'QUEUE_LAND_PIN_MOVED');
  }, 90_000);

  test('QUEUE_RECEIPT_MISSING: no /ship receipt in the PR body', () => {
    const fx = setup();
    const pin = openPr(fx, '15', { shipped: false });
    refused(fx, land(fx, '15', pin), 'QUEUE_RECEIPT_MISSING');
  }, 90_000);

  test('QUEUE_NOT_READY: no READY note at the pin', () => {
    const fx = setup();
    const pin = openPr(fx, '16', { ready: false });
    const r = land(fx, '16', pin);
    refused(fx, r, 'QUEUE_NOT_READY');
    expect(r.err).toContain('gstack-ship-queue ready --pr 16');
  }, 90_000);

  test('QUEUE_LAND_CHECKS: a red check, a pending check, and a required check GitHub never scheduled', () => {
    const fx = setup();
    const pin = openPr(fx, '17');
    fx.write(d => { d.checks[pin] = { 'free-tests': 'success', 'Check VERSION is not stale vs queue': 'success', other: 'failure' }; });
    expect(land(fx, '17', pin).err).toMatch(/red at .*\(QUEUE_LAND_CHECKS\)/);
    fx.write(d => { d.checks[pin] = { 'free-tests': 'pending', 'Check VERSION is not stale vs queue': 'success' }; });
    expect(land(fx, '17', pin).err).toMatch(/pending at .*\(QUEUE_LAND_CHECKS\)/);
    fx.write(d => { d.checks[pin] = { 'free-tests': 'success' }; });
    const missing = land(fx, '17', pin);
    refused(fx, missing, 'QUEUE_LAND_CHECKS');
    expect(missing.err).toContain('Check VERSION is not stale vs queue');
  }, 90_000);

  test('QUEUE_LAND_NOT_CLEAN: GitHub does not report the PR mergeable and clean', () => {
    const fx = setup();
    const pin = openPr(fx, '18');
    fx.write(d => { d.prs['18'].mergeable = 'CONFLICTING'; d.prs['18'].mergeStateStatus = 'DIRTY'; });
    const r = land(fx, '18', pin);
    refused(fx, r, 'QUEUE_LAND_NOT_CLEAN');
    expect(r.err).toContain('DIRTY');
  }, 90_000);

  test('QUEUE_TRAIN_UNTRUSTED: a fork head', () => {
    const fx = setup();
    const pin = openPr(fx, '19', { fork: true });
    refused(fx, land(fx, '19', pin), 'QUEUE_TRAIN_UNTRUSTED');
  }, 90_000);

  test('QUEUE_NOT_READY: the base policy merges through trains', () => {
    const fx = setup({ ...POLICY, merge: 'train' });
    const pin = openPr(fx, '20');
    const r = land(fx, '20', pin);
    refused(fx, r, 'QUEUE_NOT_READY');
    expect(r.err).toContain('merge: train');
  }, 90_000);

  test('QUEUE_LAND_UNVERIFIED: main\'s tree after the merge is not the pin merged onto its parent', () => {
    const fx = setup();
    const pin = openPr(fx, '21');
    fx.write(d => { d.strayOnMerge = true; });
    const r = land(fx, '21', pin);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.err).toContain('(QUEUE_LAND_UNVERIFIED)');
    expect(landNotes(fx)).toHaveLength(0);
  }, 90_000);
});

describe('land --pin: fail closed and merge methods', () => {
  test('the old stamping land refuses under merge: direct, and a --pin with no sha is a usage error', () => {
    const fx = setup();
    const pin = openPr(fx, '23');
    const old = runBin(fx.repo, 'gstack-ship-queue', ['land', '--pr', '23', '--base', 'main', '--no-wait'], fx.env);
    expect(old.status).not.toBe(EXIT.ok);
    expect(old.err).toContain('merge: direct');
    expect(old.err).toContain('land --pr 23 --pin');
    expect(remote(fx, 'pr-23')).toBe(pin);
    const dangling = runBin(fx.repo, 'gstack-ship-queue', ['land', '--pr', '23', '--base', 'main', '--pin'], fx.env);
    expect(dangling.status).toBe(EXIT.usage);
    expect(fx.read().mergeArgs).toBeUndefined();
  }, 90_000);

  test('a pin with no merge base on the base branch refuses instead of skipping the release-file check', () => {
    const fx = setup();
    const { repo } = fx;
    repo.git('checkout', '-q', '--orphan', 'pr-24');
    fs.writeFileSync(path.join(repo.work, 'VERSION'), '9.9.9.9\n');
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'unrelated history');
    repo.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/pr-24');
    const pin = repo.git('rev-parse', 'HEAD');
    fx.write(d => { d.prs['24'] = { state: 'OPEN', baseRefName: 'main', headRefName: 'pr-24', isCrossRepository: false, title: 'PR 24', body: shippedBody('24', pin) }; });
    markReady(fx, '24', pin);
    repo.git('checkout', '-q', '--detach', 'origin/main');
    const r = land(fx, '24', pin);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.err).toContain('cannot compute the merge base');
    expect(fx.read().mergeArgs).toBeUndefined();
  }, 90_000);

  test('history: merge-only merges with --merge; a PR on another base refuses', () => {
    const fx = setup({ ...POLICY, history: 'merge-only' });
    const pin = openPr(fx, '25');
    fx.write(d => { d.prs['25'].baseRefName = 'dev'; });
    const other = land(fx, '25', pin);
    expect(other.err).toContain('targets dev, not main');
    expect(fx.read().mergeArgs).toBeUndefined();
    fx.write(d => { d.prs['25'].baseRefName = 'main'; });
    const r = land(fx, '25', pin);
    expect(r.err).toBe('');
    expect(fx.read().mergeArgs).toEqual(['25', '--merge', '--match-head-commit', pin]);
  }, 90_000);

  test('land reads the policy after fetching the base: a required check main added since the last fetch is enforced', () => {
    const fx = setup();
    const pin = openPr(fx, '27');
    const other = fx.repo.root + '/other';
    fx.repo.git('clone', '-q', fx.repo.origin, other);
    fs.writeFileSync(path.join(other, '.gstack', 'ship-policy.json'), JSON.stringify({ ...POLICY, changelog_fragments: { dir: 'changelog.d', required_checks: [...REQUIRED, 'security-scan'] } }, null, 2) + '\n');
    fx.repo.git('-C', other, 'commit', '-qam', 'require security-scan');
    fx.repo.git('-C', other, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    const r = land(fx, '27', pin, ['--dry-run']);
    expect(r.err).toContain('security-scan');
    expect(r.err).toContain('(QUEUE_LAND_CHECKS)');
  }, 90_000);

  test('a rerun from a fresh clone after the branch was deleted fetches the pin from refs/pull/<n>/head and lands', () => {
    const fx = setup();
    const pin = openPr(fx, '28');
    expect(land(fx, '28', pin).status).toBe(EXIT.ok);
    const g = (...a: string[]) => fx.repo.git('--git-dir', fx.repo.origin, ...a);
    g('update-ref', 'refs/pull/28/head', pin);
    fx.write(d => { d.prs['28'].headRefOid = pin; });
    g('update-ref', '-d', 'refs/heads/pr-28');
    const fresh = fx.repo.root + '/fresh';
    fx.repo.git('clone', '-q', '--no-local', '--single-branch', '--branch', 'main', fx.repo.origin, fresh);
    expect(spawnCheck(fresh, pin)).toBe(false);
    const r = runBin(fx.repo, 'gstack-ship-queue', ['land', '--pr', '28', '--pin', pin, '--base', 'main'], fx.env, fresh);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^LANDED: /m);
  }, 90_000);

  test('QUEUE_LAND_STAMPED: a head that repoints .gstack/version-path', () => {
    const fx = setup();
    const pin = openPr(fx, '29', { edit: w => { fs.mkdirSync(path.join(w, '.gstack'), { recursive: true }); fs.writeFileSync(path.join(w, 'OTHER_VERSION'), fs.readFileSync(path.join(w, 'VERSION'))); fs.writeFileSync(path.join(w, '.gstack', 'version-path'), 'OTHER_VERSION\n'); fs.writeFileSync(path.join(w, 'VERSION'), '9.9.9.9\n'); } });
    const r = land(fx, '29', pin);
    expect(r.err).toContain('(QUEUE_LAND_STAMPED)');
    expect(r.err).toContain('.gstack/version-path');
    expect(fx.read().mergeArgs).toBeUndefined();
  }, 90_000);

  test('merge: direct without changelog_fragments refuses with the key to add', () => {
    const fx = setup({ ...POLICY, changelog_fragments: null });
    const pin = openPr(fx, '26');
    const r = land(fx, '26', pin);
    expect(r.err).toContain('merge: direct needs changelog_fragments');
    expect(fx.read().mergeArgs).toBeUndefined();
  }, 90_000);
});

describe('merge: direct | train', () => {
  test('train build refuses under merge: direct and names land', () => {
    const fx = setup();
    const pin = openPr(fx, '22');
    const r = runBin(fx.repo, 'gstack-ship-queue', ['train', 'build', '--prs', '22@' + pin, '--base', 'main'], fx.env);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.err).toContain('merge: direct');
    expect(r.err).toContain('gstack-ship-queue land --pr <n> --pin <sha>');
  }, 90_000);

  test('the key validates its values and needs min_gstack_version', () => {
    const errs = (o: Record<string, unknown>) => validatePolicy(o).map(e => e.path + ': ' + e.message).join('\n');
    expect(errs({ merge: 'direct', min_gstack_version: MERGE_KEY_VERSION })).toBe('');
    expect(errs({ merge: 'train' })).toBe('');
    expect(errs({ merge: 'sideways', min_gstack_version: MERGE_KEY_VERSION })).toContain('merge: must be one of direct | train');
    expect(errs({ merge: 'direct' })).toContain('introduced in gstack ' + MERGE_KEY_VERSION);
  });

  test('the key floor follows the stamp: the train restamp moves MERGE_KEY_VERSION to the stamped 1.x.N, an N install reads a policy with min N, an N-1 install gets the upgrade message', () => {
    const root = path.resolve(import.meta.dir, '..');
    const fork = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
    const stamped = bumpVersion(fork, 'patch')!;
    const tentative = bumpVersion(fork, 'minor')!;
    const policy = JSON.parse(fs.readFileSync(path.join(root, '.gstack', 'ship-policy.json'), 'utf8'));
    const templates: string[] = policy.stamp_patterns;
    expect(policy.stamp_paths).toContain('lib/ship-policy.ts');
    expect(templates).toContain("_KEY_VERSION = '{version}'");
    expect(fs.readFileSync(path.join(root, 'lib', 'ship-policy.ts'), 'utf8')).toContain(`export const MERGE_KEY_VERSION = '${MERGE_KEY_VERSION}';`);
    const line = `export const MERGE_KEY_VERSION = '${tentative}';`;
    expect(tentativeMentions(new Map([['lib/ship-policy.ts', new Set([line])]]), fork, stamped, templates)).toEqual([tentative]);
    const out = rewriteStamps(line, tentative, stamped, templates);
    expect(out.count).toBe(1);
    expect(out.text).toBe(`export const MERGE_KEY_VERSION = '${stamped}';`);
    const errs = (min: string, running: string) => validatePolicy({ merge: 'direct', min_gstack_version: min }, { gstackVersion: running });
    expect(errs(MERGE_KEY_VERSION, MERGE_KEY_VERSION)).toEqual([]);
    const parts = MERGE_KEY_VERSION.split('.').map(Number);
    const at = parts.findLastIndex(n => n > 0);
    parts[at] = parts[at]! - 1;
    const older = parts.join('.');
    const tooOld = errs(MERGE_KEY_VERSION, older);
    expect(tooOld.map(e => e.code)).toContain('POLICY_GSTACK_TOO_OLD');
    expect(tooOld.map(e => e.message).join('\n')).toContain(`this policy needs gstack ${MERGE_KEY_VERSION} or later; this gstack is ${older}`);
  });

  test("gstack's own policy does not set merge before the key's release exists (min_gstack_version must name a published version)", () => {
    const raw = JSON.parse(fs.readFileSync(path.resolve(import.meta.dir, '..', '.gstack', 'ship-policy.json'), 'utf8'));
    const fork = fs.readFileSync(path.resolve(import.meta.dir, '..', 'VERSION'), 'utf8').trim();
    if ('merge' in raw) expect(validatePolicy(raw, { gstackVersion: fork })).toEqual([]);
  });
});
