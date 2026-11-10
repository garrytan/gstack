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
import * as os from 'node:os';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { LAND_KEY_VERSION, MERGE_KEY_VERSION, RELEASE_GATE_KEY_VERSION, validatePolicy } from '../lib/ship-policy';
import { BASE_POLICY, cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './helpers/restamp-fixture';
import { shippedBody } from './helpers/ship-queue-train-fixture';
import { persist, repoIdentity } from '../crew/lib/ship-queue-train-record';
import { rewriteStamps, tentativeMentions } from '../lib/restamp';
import { bumpVersion } from '../crew/lib/version-gate-train';
import { openRelease } from '../lib/release-stamp';
import type { MergedRun } from '../lib/land-merged-checks';
import { bunIsolationArgs } from '../lib/bun-isolation';
import { readLock, writeLock } from '../crew/lib/ship-queue-land-lock';
import { flakyGit } from './helpers/flaky-git';
import { runBackstop } from '../crew/scripts/train-backstop';
import { readTrainNotes } from '../crew/scripts/release-cut';
import { gitIn } from '../crew/scripts/train-gate';
import type { GhRunner } from '../crew/scripts/recover-receipts';
import { TRAIN_BLOCK } from './helpers/ship-queue-train-fixture';
import { CHECK_IDS } from '../lib/pregate/index';

const REQUIRED = ['free-tests', 'Check VERSION is not stale vs queue'];
const POLICY = { ...BASE_POLICY, release_tool: null, release_outputs: [], changelog_fragments: { dir: 'changelog.d', required_checks: REQUIRED }, merge: 'direct', min_gstack_version: MERGE_KEY_VERSION };
const FULL_CHECKS = CHECK_IDS.map(id => ({ id, status: 'pass' }));
/** The base policy with land.merged_checks: the first proves the checks see the merged tree, the second stands in for a budget cap a stale base can break (#3886). */
const CHECKED = { ...POLICY, land: { merged_checks: ['test -e other.txt && ls pr-*.txt >/dev/null', "test ! -e budget.md || test ! -e other.txt || { echo 'budget.md over its cap' >&2; exit 1; }"] }, min_gstack_version: LAND_KEY_VERSION };
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
    "  if(d.mainOnView){g('update-ref','refs/heads/main',d.mainOnView);delete d.mainOnView;save()}",
    "  let head='';try{head=g('rev-parse','refs/heads/'+p.headRefName)}catch{};",
    "  console.log(JSON.stringify({mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',...p,headRefOid:p.headRefOid??head,mergeCommit:p.mergeSha?{oid:p.mergeSha}:null}));process.exit(0)}",
    "if(a[0]==='api'&&/actions\\/runs\\?head_sha=/.test(a[1])){console.log(JSON.stringify({total_count:0,workflow_runs:[]}));process.exit(0)}",
    "if(a[0]==='api'){const m=/commits\\/([0-9a-f]+)\\/(check-runs|status)/.exec(a[1]);if(!m)process.exit(1);",
    "  if(m[2]==='status'){console.log(JSON.stringify({total_count:0,statuses:[]}));process.exit(0)}",
    "  const set=d.checks[m[1]]??Object.fromEntries(d.defaultChecks.map(n=>[n,'success']));",
    "  const all=/[?&]filter=all(&|$)/.test(a[1]);",
    "  const runs=Array.isArray(set)?set.filter(r=>all||!r.earlier_attempt):Object.entries(set).filter(([,v])=>all||!v.earlierAttempt).map(([name,v],i)=>{const c=typeof v==='string'?v:v.conclusion;return {id:i+1,name,status:c==='pending'?'in_progress':'completed',conclusion:c==='pending'?null:c,completed_at:'2026-11-03T00:00:00Z',app:{id:1}}});",
    "  console.log(JSON.stringify({total_count:runs.length,check_runs:runs}));process.exit(0)}",
    "if(a[0]==='pr'&&a[1]==='merge'){const p=d.prs[a[2]];const want=a[a.indexOf('--match-head-commit')+1];const head=g('rev-parse','refs/heads/'+p.headRefName);",
    "  if(head!==want){console.error('Head branch was modified');process.exit(1)}",
    "  try{d.lockAtMerge=JSON.parse(g('show','refs/notes/gstack-land:lock.json'))}catch{}",
    "  let main=g('rev-parse','refs/heads/main');if(d.raceMain){main=g('commit-tree',g('rev-parse',main+'^{tree}'),'-p',main,'-m','landed during the check');g('update-ref','refs/heads/main',main)}",
    "  let tree=g('merge-tree','--write-tree',main,want).split('\\n')[0];",
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
/** runMergedChecks in a child Bun: on Linux it makes its caller a non-dumpable child subreaper for good, and a test runner that is one never reaps the orphans later test files leave, which hung test/ubicloud-runner-recovery.test.ts in the same process (GST-1613). */
function runMergedChecks(root: string, base: string, pin: string, checks: string[], ms?: number): MergedRun {
  const lib = JSON.stringify(path.join(import.meta.dir, '..', 'lib', 'land-merged-checks.ts'));
  const r = spawnSync(process.execPath, [...bunIsolationArgs(), '-e', `const { runMergedChecks } = await import(${lib}); const [root, base, pin, checks, ms] = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify(runMergedChecks(root, base, pin, checks, ms ?? undefined)));`], { input: JSON.stringify([root, base, pin, checks, ms ?? null]), encoding: 'utf8', timeout: 60_000 });
  if (r.status !== 0) throw new Error(`runMergedChecks child exited ${r.status ?? r.signal}: ${r.stderr}`);
  return JSON.parse(r.stdout) as MergedRun;
}
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
    expect(fx.read().mergeArgs).toEqual(['7', '--squash', '--match-head-commit', pin, '--subject', 'PR 7 (#7)']);
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

  test('GST-1316: the base moved after the pin\'s CI, so land runs land.merged_checks on the pin merged onto main: a failure refuses with QUEUE_LAND_MERGED_CHECKS and merges nothing, a pass lands and names the merged tree, and a rerun checks again', () => {
    const fx = setup(CHECKED);
    const red = openPr(fx, '8', { edit: w => fs.writeFileSync(path.join(w, 'budget.md'), 'pr line\n') });
    const green = openPr(fx, '82');
    const moved = moveMain(fx, 'other.txt', 'other\n');
    const r = land(fx, '8', red, ['--allow-repo-commands']);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.err).toContain('(QUEUE_LAND_MERGED_CHECKS)');
    expect(r.err).toContain(moved.slice(0, 12));
    expect(r.err).toContain('budget.md over its cap');
    expect(fx.read().mergeArgs).toBeUndefined();
    expect(remote(fx, 'main')).toBe(moved);

    const want = fx.repo.git('merge-tree', '--write-tree', moved, green);
    const ok = land(fx, '82', green, ['--allow-repo-commands']);
    expect(ok.err).toBe('');
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toContain(`MERGED_CHECKS: pass tree=${want} base=${moved} pin=${green.slice(0, 12)} checks: test -e other.txt && ls pr-*.txt >/dev/null; `);
    const main = remote(fx, 'main');
    expect(fx.repo.git('rev-parse', main + '^1')).toBe(moved);
    expect(fx.repo.git('rev-parse', main + '^{tree}')).toBe(want);
    expect(landNotes(fx)).toHaveLength(1);
    const again = land(fx, '82', green, ['--allow-repo-commands']);
    expect(again.err).toBe('');
    expect(again.status).toBe(EXIT.ok);
    expect(again.out).toContain(`MERGED_CHECKS: pass tree=${want} base=${moved} (after the merge`);
  }, 90_000);

  test('no land key: a stale base lands untested as before, with a STALE_BASE: warn line naming the missing land.merged_checks', () => {
    const fx = setup();
    const pin = openPr(fx, '84');
    const moved = moveMain(fx, 'other.txt', 'other\n');
    const r = land(fx, '84', pin);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain(`STALE_BASE: warn origin/main moved to ${moved.slice(0, 12)}`);
    expect(r.out).toContain('no land.merged_checks configured');
    expect(r.out).not.toContain('MERGED_CHECKS:');
    const main = remote(fx, 'main');
    expect(fx.repo.git('rev-parse', main + '^1')).toBe(moved);
    expect(fx.repo.git('rev-parse', main + '^{tree}')).toBe(fx.repo.git('merge-tree', '--write-tree', moved, pin));
    expect(landNotes(fx)).toHaveLength(1);
    const again = land(fx, '84', pin);
    expect(again.err).toBe('');
    expect(again.status).toBe(EXIT.ok);
    expect(again.out).toContain('already merged');
    expect(again.out).toContain('no land.merged_checks configured, so the rerun checks the tree only');
    expect(again.out).toMatch(/^LANDED: /m);
  }, 90_000);

  test('land.merged_checks are repo commands: refused without --allow-repo-commands, skipped under --dry-run, not run when GitHub is not clean, and run with a scrubbed environment under the land lock', () => {
    const marker = path.join(os.tmpdir(), `gstack-land-marker-${process.pid}-${Date.now()}`);
    const fx = setup({ ...POLICY, land: { merged_checks: [`echo "${'$'}HOME|${'$'}{GH_TOKEN-}|${'$'}{LAND_SHIM_DATA-}" > ${marker}`] }, min_gstack_version: LAND_KEY_VERSION });
    try {
      const pin = openPr(fx, '87');
      moveMain(fx, 'other.txt', 'other\n');
      fx.env.GH_TOKEN = 'placeholder';
      const no = land(fx, '87', pin);
      expect(no.status).not.toBe(EXIT.ok);
      expect(no.err).toContain('(REPO_COMMANDS_NOT_ALLOWED)');
      expect(fs.existsSync(marker)).toBe(false);
      expect(fx.read().mergeArgs).toBeUndefined();

      const dry = land(fx, '87', pin, ['--dry-run', '--allow-repo-commands']);
      expect(dry.err).toBe('');
      expect(dry.status).toBe(EXIT.ok);
      expect(dry.out).toContain('DRY-RUN: land.merged_checks not run');
      expect(fs.existsSync(marker)).toBe(false);

      fx.write(d => { d.prs['87'].mergeStateStatus = 'BLOCKED'; });
      const blocked = land(fx, '87', pin, ['--allow-repo-commands']);
      expect(blocked.err).toContain('(QUEUE_LAND_NOT_CLEAN)');
      expect(fs.existsSync(marker)).toBe(false);
      fx.write(d => { d.prs['87'].mergeStateStatus = 'CLEAN'; });

      const ok = land(fx, '87', pin, ['--allow-repo-commands']);
      expect(ok.err).toBe('');
      expect(ok.status).toBe(EXIT.ok);
      const [home, token, shim] = fs.readFileSync(marker, 'utf8').trim().split('|');
      expect(home).not.toBe(process.env.HOME);
      expect(home).not.toBe('');
      expect(token).toBe('');
      expect(shim).toBe('');
      expect(fx.read().lockAtMerge).toMatchObject({ pr: '87', phase: 'merging' });
      expect(JSON.parse(fx.repo.git('--git-dir', fx.repo.origin, 'show', 'refs/notes/gstack-land:lock.json'))).toMatchObject({ released: true });
    } finally { fs.rmSync(marker, { force: true }); }
  }, 90_000);

  test.skipIf(process.platform !== 'linux')('GST-1421: a merged check that walks its ancestors\' /proc/<pid>/environ and scans every /proc/*/environ finds no secret from land\'s environment, and land still merges', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-land-environ-'));
    const marker = path.join(scratch, 'found'), probe = path.join(scratch, 'probe.sh');
    const secret = `land-secret-${process.pid}-${Date.now()}`;
    fs.writeFileSync(probe, [
      'p=$PPID',
      'while [ "${p:-0}" -gt 1 ]; do',
      '  if cat /proc/$p/environ >/dev/null 2>&1; then echo "ancestor $p readable"; else echo "ancestor $p denied"; fi',
      '  tr "\\0" "\\n" < /proc/$p/environ 2>/dev/null | grep "^GSTACK_LAND_SENTINEL=" | sed "s/^/ancestor $p /"',
      '  p=$(sed -n "s/^PPid:[[:space:]]*//p" /proc/$p/status 2>/dev/null)',
      'done',
      'for f in /proc/[0-9]*/environ; do tr "\\0" "\\n" < "$f" 2>/dev/null | grep "^GSTACK_LAND_SENTINEL=" | sed "s|^|scan $f |"; done',
      'cat /proc/self/environ >/dev/null 2>&1 && echo "self readable"',
      '',
    ].join('\n'));
    const fx = setup({ ...POLICY, land: { merged_checks: [`sh ${probe} > ${marker}`] }, min_gstack_version: LAND_KEY_VERSION });
    try {
      const pin = openPr(fx, '88');
      moveMain(fx, 'other.txt', 'other\n');
      fx.env.GSTACK_LAND_SENTINEL = secret;
      const ok = land(fx, '88', pin, ['--allow-repo-commands']);
      expect(ok.err).toBe('');
      expect(ok.status).toBe(EXIT.ok);
      const found = fs.readFileSync(marker, 'utf8');
      expect(found).toContain('self readable');
      expect(found).toMatch(/^ancestor \d+ denied$/m);
      expect(found).not.toContain(secret);
      expect(fx.read().mergeArgs).toBeDefined();
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }, 90_000);

  test.skipIf(process.platform !== 'linux')('GST-1421: a merged check that leaves its process group with setsid, to read the environment of the git and gh processes land starts next, is killed before land starts them', () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-land-stray-'));
    const marker = path.join(scratch, 'found'), pidFile = path.join(scratch, 'pid'), scan = path.join(scratch, 'scan.sh');
    const secret = `land-secret-${process.pid}-${Date.now()}`;
    fs.writeFileSync(scan, [
      `echo $$ > ${pidFile}`,
      'i=0',
      'while [ $i -lt 400 ]; do',
      `  for f in /proc/[0-9]*/environ; do tr "\\0" "\\n" < "$f" 2>/dev/null | grep "^GSTACK_LAND_SENTINEL=" >> ${marker}; done`,
      '  i=$((i+1)); sleep 0.05',
      'done',
      '',
    ].join('\n'));
    const fx = setup({ ...POLICY, land: { merged_checks: [`setsid sh ${scan} </dev/null >/dev/null 2>&1 & while [ ! -s ${pidFile} ]; do sleep 0.05; done`] }, min_gstack_version: LAND_KEY_VERSION });
    let stray = 0;
    try {
      const pin = openPr(fx, '89');
      moveMain(fx, 'other.txt', 'other\n');
      fx.env.GSTACK_LAND_SENTINEL = secret;
      const ok = land(fx, '89', pin, ['--allow-repo-commands']);
      expect(ok.err).toBe('');
      expect(ok.status).toBe(EXIT.ok);
      stray = Number(fs.readFileSync(pidFile, 'utf8').trim());
      expect(stray).toBeGreaterThan(1);
      expect(() => process.kill(stray, 0)).toThrow();
      expect(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '').not.toContain(secret);
    } finally {
      if (stray > 1) try { process.kill(stray, 'SIGKILL'); } catch {}
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }, 90_000);

  test('QUEUE_LAND_NOT_CLEAN: on a stale base the pin conflicts with main, so no merged check runs and nothing merges', () => {
    const fx = setup(CHECKED);
    const pin = openPr(fx, '83', { edit: w => fs.writeFileSync(path.join(w, 'other.txt'), 'pr\n') });
    const moved = moveMain(fx, 'other.txt', 'main\n');
    const r = land(fx, '83', pin, ['--allow-repo-commands']);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.err).toContain('(QUEUE_LAND_NOT_CLEAN)');
    expect(r.err).toContain('conflicts with ' + moved.slice(0, 12) + ' in other.txt');
    expect(fx.read().mergeArgs).toBeUndefined();
  }, 90_000);

  test('main moved between the stale-base check and GitHub\'s merge: land reports QUEUE_LAND_UNVERIFIED and writes no land note; with no land.merged_checks a rerun cannot tell which base land checked, so it checks the tree only', () => {
    const fx = setup();
    const pin = openPr(fx, '81');
    fx.write(d => { d.raceMain = true; });
    const r = land(fx, '81', pin);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.err).toContain('(QUEUE_LAND_UNVERIFIED)');
    expect(r.err).toContain('does not contain');
    expect(landNotes(fx)).toEqual([]);
    const again = land(fx, '81', pin);
    expect(again.out).toContain('already merged');
    expect(again.out).toContain('so the rerun checks the tree only');
    expect(again.status).toBe(EXIT.ok);
  }, 90_000);

  test('the land lock: a lock an interrupted run left for the same PR is taken over; another PR\'s lock refuses, --break-lock cannot break it mid-merge but breaks a stale one; a lock left after the merge is released by the rerun; a dry rerun verifies nothing', () => {
    const fx = setup();
    const hold = (pr: string, journal: string, minutesAgo: number) => {
      const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
      expect(writeLock(fx.repo.work, readLock(fx.repo.work).sha, { pr, holder: 'gone:1', started_at: at, phase_at: at, phase: 'merging', journal }).ok).toBe(true);
    };
    const pin = openPr(fx, '88');
    hold('88', 'land-pin:' + '0'.repeat(40), 0);
    const took = land(fx, '88', pin);
    expect(took.err).toBe('');
    expect(took.out).toContain("LOCK: taking over #88's land lock");
    expect(readLock(fx.repo.work).state).toBe('released');

    const other = openPr(fx, '89');
    hold('90', 'land-pin:' + '1'.repeat(40), 0);
    expect(land(fx, '89', other).err).toContain('(QUEUE_LAND_LOCKED)');
    expect(land(fx, '89', other, ['--break-lock']).err).toContain('mid-merge');
    expect(fx.read().prs['89'].state).toBe('OPEN');
    hold('90', 'land-pin:' + '1'.repeat(40), 11);
    const broke = land(fx, '89', other, ['--break-lock']);
    expect(broke.err).toBe('');
    expect(broke.out).toContain("LOCK: broke #90's lock");

    hold('89', 'land-pin:' + other, 0);
    const again = land(fx, '89', other);
    expect(again.err).toBe('');
    expect(again.out).toContain('LOCK: released the land lock an earlier run of this land left');
    expect(readLock(fx.repo.work).state).toBe('released');
    const dry = land(fx, '89', other, ['--dry-run']);
    expect(dry.out).toContain('DRY-RUN: nothing verified');
  }, 120_000);

  describe('GST-1344: a lock push GitHub applied but answered with an HTTP 502', () => {
    const lockAt = (fx: Fx) => JSON.parse(fx.repo.git('--git-dir', fx.repo.origin, 'show', 'refs/notes/gstack-land:lock.json'));
    const flaky = (fx: Fx) => { const g = flakyGit(fx.repo.root); return { g, run: (pr: string, pin: string, extra: string[] = []) => runBin(fx.repo, 'gstack-ship-queue', ['land', '--pr', pr, '--pin', pin, '--base', 'main', ...extra], { ...fx.env, ...g.env, PATH: `${g.dir}:${fx.env.PATH}` }) }; };

    test('the merging push lands but reports failure while lock fetches fail: land reads origin, sees its own commit, merges and releases', () => {
      const fx = setup();
      const { g, run } = flaky(fx);
      const pin = openPr(fx, '95');
      g.pushLandsThenFails(2);
      g.fetchFails(true);
      const r = run('95', pin);
      expect(r.err).toBe('');
      expect(r.status).toBe(EXIT.ok);
      expect(r.out).toContain('MERGED: #95 as ');
      expect(fx.read().lockAtMerge).toMatchObject({ pr: '95', phase: 'merging', journal: 'land-pin:' + pin });
      expect(lockAt(fx)).toMatchObject({ released: true });
    }, 120_000);

    test('origin cannot be read after the push either: the run refuses, and the rerun takes its lease from origin (ls-remote) while fetches still fail, then merges and releases', () => {
      const fx = setup();
      const { g, run } = flaky(fx);
      const pin = openPr(fx, '96');
      g.pushLandsThenFails(2);
      g.fetchFails(true);
      g.lsRemoteFails(99);
      const first = run('96', pin);
      expect(first.status).toBe(EXIT.refused);
      expect(first.err).toContain('(QUEUE_NOT_READY)');
      expect(first.err).not.toContain('the lock there is unchanged');
      expect(fx.read().prs['96'].state).toBe('OPEN');
      expect(lockAt(fx)).toMatchObject({ pr: '96', phase: 'merging', journal: 'land-pin:' + pin });
      g.reset();
      g.fetchFails(true);
      const again = run('96', pin);
      expect(again.err).toBe('');
      expect(again.status).toBe(EXIT.ok);
      expect(again.out).toContain('MERGED: #96 as ');
      expect(lockAt(fx)).toMatchObject({ released: true });
    }, 120_000);

    test('never left in merging: the merging push lands and origin stays unreadable through the lock read, the post-push check and the re-read (three ls-remotes), so the run refuses, yet its release re-reads origin, finds its own lock and releases it; a rerun lands', () => {
      const fx = setup();
      const { g, run } = flaky(fx);
      const pin = openPr(fx, '97');
      g.pushLandsThenFails(2);
      g.lsRemoteFails(3);
      g.fetchFails(true);
      const first = run('97', pin);
      expect(first.status).toBe(EXIT.refused);
      expect(first.err).toContain('(QUEUE_NOT_READY)');
      expect(first.out).not.toContain('LOCK: warn');
      expect(fx.read().prs['97'].state).toBe('OPEN');
      expect(lockAt(fx)).toMatchObject({ released: true });
      g.reset();
      const again = run('97', pin);
      expect(again.err).toBe('');
      expect(again.out).toContain('MERGED: #97 as ');
    }, 120_000);
  });

  test('main moved during the merge with land.merged_checks: they run on the landed tree; a rerun without --allow-repo-commands refuses with REPO_COMMANDS_NOT_ALLOWED and runs nothing', () => {
    const fx = setup(CHECKED);
    const pin = openPr(fx, '91');
    moveMain(fx, 'other.txt', 'other\n');
    fx.write(d => { d.raceMain = true; });
    const r = land(fx, '91', pin, ['--allow-repo-commands']);
    expect(r.err).toBe('');
    expect(r.out).toContain('(after the merge, on the base GitHub merged onto)');
    const again = land(fx, '91', pin);
    expect(again.err).toContain('(REPO_COMMANDS_NOT_ALLOWED)');
    expect(again.out).not.toContain('MERGED_CHECKS:');
  }, 90_000);

  test('land re-reads the base policy after the locked fetch: a main that adds land.merged_checks while land runs gets them run on the stale base', () => {
    const fx = setup();
    const pin = openPr(fx, '93');
    const { repo } = fx;
    repo.git('fetch', '-q', 'origin');
    repo.git('checkout', '-q', '--detach', 'origin/main');
    fs.writeFileSync(path.join(repo.work, '.gstack', 'ship-policy.json'), JSON.stringify({ ...POLICY, land: { merged_checks: ['echo merged check ran >&2; exit 1'] }, min_gstack_version: LAND_KEY_VERSION }, null, 2) + '\n');
    repo.git('commit', '-qam', 'main adds land.merged_checks');
    repo.git('push', '-q', 'origin', 'HEAD:refs/heads/next-main');
    const next = repo.git('rev-parse', 'HEAD');
    repo.git('checkout', '-q', '--detach', 'origin/main');
    fx.write(d => { d.mainOnView = next; });
    const r = land(fx, '93', pin, ['--allow-repo-commands']);
    expect(r.err).toContain('(QUEUE_LAND_MERGED_CHECKS)');
    expect(r.err).toContain('merged check ran');
    expect(fx.read().mergeArgs).toBeUndefined();
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

describe('land --pin and ready under merge: direct (GSTA-461 items 7 and 19)', () => {
  const run = (id: number, name: string, conclusion: string, completed_at: string, suite: number) => ({ id, name, status: 'completed', conclusion, completed_at, app: { id: 1 }, check_suite: { id: suite } });

  // Value: protects=land --pin names each red run that a newer run from another check suite replaced, right after its CI line, and still lands;
  // fails_when=land prints plain green and merges with no word when free-tests failed in suite 1 and a branch-only run passed in suite 3;
  // why_new=reports/GSTA-461.md item 7; seam=the gh shim's raw check-run list; no_claim=the same-suite rule that would refuse (after the freeze)
  test('a red check replaced by a pass from another check suite lands with a CI_SUPERSEDED line', () => {
    const fx = setup();
    const pin = openPr(fx, '9');
    fx.write(d => { d.checks[pin] = [run(1, 'free-tests', 'failure', '2026-11-09T10:00:00Z', 1), run(2, 'Check VERSION is not stale vs queue', 'success', '2026-11-09T10:02:00Z', 2), run(3, 'free-tests', 'success', '2026-11-09T10:20:00Z', 3)]; });
    const r = land(fx, '9', pin);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
    const lines = r.out.split('\n');
    const ci = lines.findIndex(l => l.startsWith('CI: green at '));
    expect(ci).toBeGreaterThanOrEqual(0);
    expect(lines[ci + 1]).toBe('CI_SUPERSEDED: free-tests red run 1 replaced by 3 (suite 1 → 3)');
    expect(r.out).toContain('MERGED: #9 as ');
  }, 90_000);

  // Value: protects=ready without a train block refuses when origin never receives its READY note, and a rerun after the fix pushes the kept note
  // that land --pin then reads from origin; fails_when=ready prints a READY_RECEIPT line and exits 0 while origin lacks the note (our own land on
  // 11-09 refused QUEUE_NOT_READY this way); why_new=#4254 covers only the train path; seam=a pre-receive hook in the fixture's bare origin, and a
  // separate state root for ready so land can only find the note on origin; no_claim=GitHub's own rejection messages
  test('origin rejects refs/notes/*: ready refuses QUEUE_READY_NOTE_UNPUSHED; once origin accepts, a rerun pushes the note and land merges', () => {
    const fx = setup();
    const head = openPr(fx, '31', { ready: false });
    fx.repo.git('checkout', '-q', 'pr-31');
    const pregate = path.join(fx.repo.root, 'pregate.json');
    fs.writeFileSync(pregate, JSON.stringify({ schema_version: 1, tree: runBin(fx.repo, 'gstack-wtree', []).out.trim(), head, verdict: 'pass', checks: FULL_CHECKS }));
    const env = { ...fx.env, GSTACK_STATE_ROOT: path.join(fx.repo.root, 'ready-state') };
    const ready = () => runBin(fx.repo, 'gstack-ship-queue', ['ready', '--pr', '31', '--pregate', pregate, '--base', 'main'], env);
    const hook = path.join(fx.repo.origin, 'hooks', 'pre-receive');
    const remoteNotes = () => fx.repo.git('ls-remote', 'origin', 'refs/notes/gstack-trains').split(/\s+/)[0] ?? '';
    fs.writeFileSync(hook, '#!/bin/sh\nwhile read old new ref; do case "$ref" in refs/notes/*) echo "notes refused by fixture" >&2; exit 1;; esac; done; exit 0\n', { mode: 0o755 });
    const refused = ready();
    expect(refused.status).toBe(EXIT.refused);
    expect(refused.err).toContain('(QUEUE_READY_NOTE_UNPUSHED)');
    expect(refused.err).toContain('gstack-ship-queue ready --pr 31');
    expect(refused.out).not.toContain('notes pushed');
    expect(refused.out).toMatch(/^GSTACK_RESULT: .*status=refused/m);
    expect(remoteNotes()).toBe('');
    fs.rmSync(hook);
    const again = ready();
    expect(again.err).toBe('');
    expect(again.status).toBe(EXIT.ok);
    expect(again.out).toMatch(/^READY_RECEIPT: .* \(notes pushed to origin refs\/notes\/gstack-trains\)$/m);
    expect(remoteNotes()).not.toBe('');
    fx.repo.git('checkout', '-q', '--detach', 'origin/main');
    const r = land(fx, '31', head);
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('MERGED: #31 as ');
  }, 120_000);
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

  test('QUEUE_RECEIPT_BASE_MISMATCH: a #3570 child retargeted to main while its parent is open lands nothing; a GST-1199 child reviewed against main still lands', () => {
    const fx = setup();
    const { repo } = fx;
    openPr(fx, '17');
    const child = (pr: string, base: string): string => {
      repo.git('checkout', '-q', 'origin/pr-17', '-B', 'pr-' + pr);
      fs.writeFileSync(path.join(repo.work, 'pr-' + pr + '.txt'), pr + '\n');
      fs.writeFileSync(path.join(repo.work, 'changelog.d', 'pr-' + pr + '.md'), '- #' + pr + ' change\n');
      repo.git('add', '-A');
      repo.git('commit', '-q', '-m', 'pr ' + pr);
      repo.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/pr-' + pr);
      const head = repo.git('rev-parse', 'HEAD');
      fx.write(d => { d.prs[pr] = { state: 'OPEN', baseRefName: 'main', headRefName: 'pr-' + pr, isCrossRepository: false, title: 'PR ' + pr, body: shippedBody(pr, head, { base }) }; });
      markReady(fx, pr, head);
      repo.git('checkout', '-q', '--detach', 'origin/main');
      return head;
    };
    const before = remote(fx, 'main');
    const retargeted = child('171', 'pr-17');
    const r = land(fx, '171', retargeted);
    refused(fx, r, 'QUEUE_RECEIPT_BASE_MISMATCH');
    expect(r.err).toContain("PR #171's ship receipt was reviewed against pr-17, not main");
    expect(remote(fx, 'main')).toBe(before);
    const reviewedOnMain = child('172', 'origin/main');
    const ok = land(fx, '172', reviewedOnMain);
    expect(ok.err).toBe('');
    expect(ok.status).toBe(EXIT.ok);
  }, 90_000);

  test('QUEUE_NOT_READY: no READY note at the pin', () => {
    const fx = setup();
    const pin = openPr(fx, '16', { ready: false });
    const r = land(fx, '16', pin);
    refused(fx, r, 'QUEUE_NOT_READY');
    expect(r.err).toContain('gstack-ship-queue ready --pr 16');
  }, 90_000);

  // Value: protects=under GSTACK_PLAN_RECORD=require land refuses a READY note with no plan or another line than the PR body, lands a matching one, and a merged rerun skips the check; fails_when=landPlan's wiring in landDirect is dropped or runs after the merge; why_new=plan-record.test.ts covers landPlan only; seam=none; no_claim=ready's resolution (the note is written directly)
  test('QUEUE_PLAN_MISMATCH under GSTACK_PLAN_RECORD=require: no plan on the READY note or a stale line refuses and merges nothing; a matching note lands; a merged rerun skips the check', () => {
    const fx = setup();
    const pin = openPr(fx, '26');
    const body = shippedBody('26', pin) + '\nPlan: exempt: bug fix\n';
    fx.write(d => { d.prs['26'].body = body; });
    const req = (extra: string[] = []) => runBin(fx.repo, 'gstack-ship-queue', ['land', '--pr', '26', '--pin', pin, '--base', 'main', ...extra], { ...fx.env, GSTACK_PLAN_RECORD: 'require' });
    const bare = req();
    refused(fx, bare, 'QUEUE_PLAN_MISMATCH');
    expect(bare.err).toContain('carries no plan record');
    const notePlan = (line: string) => {
      const prior = process.env.GSTACK_STATE_ROOT;
      process.env.GSTACK_STATE_ROOT = path.join(fx.repo.root, 'ready-state');
      try {
        const now = new Date().toISOString();
        persist(fx.repo.work, [{ schema: 1, kind: 'ready', repo_key: repoIdentity(fx.repo.work).key, pr: '26', head: pin, base_sha: fx.repo.git('rev-parse', 'origin/main'), ready_at: now, screen: { choice: 'no-screen', policy: null, nonce: null, run: null, merge_sha: null }, updated_at: now, plan: { line, state: 'exempt', reason: line.replace('Plan: exempt: ', ''), resolver: 1 } } as any]);
      } finally { if (prior === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prior; }
    };
    notePlan('Plan: exempt: docs only');
    const stale = req();
    refused(fx, stale, 'QUEUE_PLAN_MISMATCH');
    expect(stale.err).toContain('but the PR body now says "Plan: exempt: bug fix"');
    notePlan('Plan: exempt: bug fix');
    const ok = req();
    expect(ok.status).toBe(EXIT.ok);
    expect(ok.out).toContain('PLAN: exempt bug fix (from the READY note)');
    fx.write(d => { d.prs['26'].body = shippedBody('26', pin); });
    const again = req();
    expect(again.status).toBe(EXIT.ok);
    expect(again.out).toContain('already merged');
    expect(again.out).not.toContain('QUEUE_PLAN_MISMATCH');
  }, 120_000);

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
    expect(missing.out + missing.err).toContain('cannot be dispatched, so edit the PR title or body to rerun it');
  }, 90_000);

  // Value: protects=land never merges a pin whose failed check run sits in an earlier workflow-run attempt that GitHub's default filter=latest hides
  // (gstack-evals#303: the rerun attempt listed no jobs); fails_when=land reads only the latest attempt and merges; seam=ciAtHead through the shim's
  // filter=latest/all split; no_claim=a workflow run that never created a job
  test('QUEUE_LAND_CHECKS: a failed check from an earlier attempt whose rerun listed no jobs is red (gstack-evals#303)', () => {
    const fx = setup();
    const pin = openPr(fx, '27');
    fx.write(d => { d.checks[pin] = { 'free-tests': 'success', 'Check VERSION is not stale vs queue': 'success', checks: { conclusion: 'failure', earlierAttempt: true } }; });
    const r = land(fx, '27', pin);
    refused(fx, r, 'QUEUE_LAND_CHECKS');
    expect(r.err).toMatch(/red at [0-9a-f]{12} \(passed=2 failed=1 pending=0 skipped=0\)/);
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
    expect(fx.read().mergeArgs).toEqual(['25', '--merge', '--match-head-commit', pin, '--subject', 'PR 25 (#25)']);
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

  test('runMergedChecks: HEAD is the merged commit, no hook from the merged tree runs, a passing check that leaves a child behind passes at once; a check that times out (even one exiting 0 on SIGTERM) or that rewrites a tracked file fails', () => {
    const fx = setup(CHECKED);
    const hookMark = path.join(fx.repo.root, 'hook-ran');
    const pin = openPr(fx, '86');
    const moved = moveMain(fx, 'other.txt', 'other\n');
    fs.mkdirSync(path.join(fx.repo.work, '.hooks'));
    fs.writeFileSync(path.join(fx.repo.work, '.hooks', 'post-checkout'), `#!/bin/sh\ntouch ${hookMark}\n`, { mode: 0o755 });
    fx.repo.git('config', 'core.hooksPath', '.hooks');
    const run = (checks: string[], ms?: number) => runMergedChecks(fx.repo.work, moved, pin, checks, ms);
    const head = run(['git show HEAD:pr-86.txt && git show HEAD:other.txt && test "$(git rev-parse HEAD^1)" = ' + moved]);
    expect(head.ok).toBe(true);
    expect(fs.existsSync(hookMark)).toBe(false);
    const started = Date.now();
    expect(run(['sleep 30 & exit 0'], 20_000).ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(10_000);
    const slow = run(["trap 'exit 0' TERM; sleep 5; exit 1"], 500);
    expect(slow.ok).toBe(false);
    if (!slow.ok) expect(slow.detail).toContain('did not finish');
    const pidFile = path.join(fx.repo.root, 'grandchild.pid');
    const orphan = run([`sleep 30 & echo $! > ${pidFile}; wait`], 500);
    expect(orphan.ok).toBe(false);
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    expect(alive(Number(fs.readFileSync(pidFile, 'utf8').trim()))).toBe(false);
    const stubborn = Date.now();
    expect(run(["trap '' TERM; sleep 5"], 300).ok).toBe(false);
    expect(Date.now() - stubborn).toBeLessThan(3_000);
    const moved2 = run(['git checkout -q HEAD^1']);
    expect(moved2.ok).toBe(false);
    if (!moved2.ok) expect(moved2.detail).toContain('moved HEAD');
    const depPin = openPr(fx, '92', { edit: w => { const p = JSON.parse(fs.readFileSync(path.join(w, 'package.json'), 'utf8')); p.dependencies['is-odd'] = '3.0.1'; fs.writeFileSync(path.join(w, 'package.json'), JSON.stringify(p, null, 2) + '\n'); } });
    const dep = runMergedChecks(fx.repo.work, moved, depPin, ['true']);
    expect(dep.ok).toBe(false);
    if (!dep.ok) { expect(dep.setup).toBe(true); expect(dep.detail).toContain('package.json dependencies differ'); }
    const rewrite = run(['echo fixed > pr-86.txt', 'test "$(cat pr-86.txt)" = fixed']);
    expect(rewrite.ok).toBe(false);
    if (!rewrite.ok) expect(rewrite.detail).toContain('changed tracked files');
    expect(fx.repo.git('worktree', 'list').split('\n')).toHaveLength(1);
  }, 90_000);

  test('land.merged_checks validates its commands and needs min_gstack_version', () => {
    const errs = (o: Record<string, unknown>) => validatePolicy(o).map(e => e.path + ': ' + e.message).join('\n');
    expect(errs({ land: { merged_checks: ['bun run typecheck'] }, min_gstack_version: LAND_KEY_VERSION })).toBe('');
    expect(errs({ land: null })).toBe('');
    expect(errs({ land: { merged_checks: ['bun run typecheck'] } })).toContain('introduced in gstack ' + LAND_KEY_VERSION);
    const bad = (land: unknown) => errs({ land, min_gstack_version: LAND_KEY_VERSION });
    expect(bad({ merged_checks: [] })).toContain('land.merged_checks: must list 1 to 16 commands');
    expect(bad({ merged_checks: ['a'], timeout: 5 })).toBe('');
    expect(bad({ merged_checks: ['a\nb', ' '] })).toBe('land.merged_checks[0]: must be one line of at most 512 characters\nland.merged_checks[1]: must be a non-empty command');
    expect(bad(['a'])).toContain('land: must be { merged_checks } or null');
  });

  test('the key floor follows the stamp: the train restamp moves MERGE_KEY_VERSION to the stamped 1.x.N, an N install reads a policy with min N, an N-1 install gets the upgrade message', () => {
    const root = path.resolve(import.meta.dir, '..');
    const fork = fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
    const stamped = bumpVersion(fork, 'patch')!;
    const tentative = bumpVersion(fork, 'minor')!;
    const policy = JSON.parse(fs.readFileSync(path.join(root, '.gstack', 'ship-policy.json'), 'utf8'));
    const templates: string[] = policy.stamp_patterns;
    expect(policy.stamp_paths).toContain('lib/ship-policy-keys.ts');
    expect(templates).toContain("_KEY_VERSION = '{version}'");
    expect(fs.readFileSync(path.join(root, 'lib', 'ship-policy-keys.ts'), 'utf8')).toContain(`export const MERGE_KEY_VERSION = '${MERGE_KEY_VERSION}';`);
    const line = `export const MERGE_KEY_VERSION = '${tentative}';`;
    expect(tentativeMentions(new Map([['lib/ship-policy-keys.ts', new Set([line])]]), fork, stamped, templates)).toEqual([tentative]);
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

describe('land --pin: the release PR (docs/ship-policy.md#release-stamp)', () => {
  /** Land PR 7 (a fragment), then open the release PR from origin/main with gstack-release-stamp open's code path. */
  function release(fx: Fx, tamper?: (work: string) => void): { pin: string; base: string } {
    expect(land(fx, '7', openPr(fx, '7')).status).toBe(EXIT.ok);
    const base = remote(fx, 'main');
    const r = openRelease({ repoRoot: fx.repo.work, base: 'main', gh: () => ({ ok: true, out: 'https://github.com/o/r/pull/50\n', err: '' }) });
    if (!r.ok) throw new Error(r.message);
    let pin = r.head!;
    if (tamper) {
      fx.repo.git('fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*');
      fx.repo.git('checkout', '-q', '--detach', pin);
      tamper(fx.repo.work);
      fx.repo.git('add', '-A');
      fx.repo.git('commit', '-q', '-m', 'hand edit');
      fx.repo.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/' + r.branch);
      pin = fx.repo.git('rev-parse', 'HEAD');
      fx.repo.git('checkout', '-q', '--detach', 'origin/main');
    }
    fx.write(d => { d.prs['50'] = { state: 'OPEN', baseRefName: 'main', headRefName: r.branch, isCrossRepository: false, title: 'v' + r.version + ' release', body: '' }; });
    return { pin, base };
  }

  test('a release/<version> head that is exactly the release stamp lands with no /ship receipt or READY note, and main moves to the new version', () => {
    const fx = setup();
    const { pin, base } = release(fx);
    const next = bumpVersion(show(fx, base + ':VERSION'), 'patch')!;
    const r = land(fx, '50', pin);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('RELEASE: v' + next + ' folds 1 fragment(s)');
    const main = remote(fx, 'main');
    expect(show(fx, main + ':VERSION')).toBe(next);
    expect(show(fx, main + ':CHANGELOG.md')).toContain('- #7 change');
    expect(spawnSync('git', ['-C', fx.repo.work, 'cat-file', '-e', main + ':changelog.d/pr-7.md'], { timeout: 30_000 }).status).not.toBe(0);
  }, 120_000);

  test('a release/<version> head with a hand edit beyond the stamp is refused with RELEASE_STAMP_INVALID and nothing merges', () => {
    const fx = setup();
    const { pin, base } = release(fx, work => fs.writeFileSync(path.join(work, 'pr-7.txt'), 'changed in the release\n'));
    const r = land(fx, '50', pin);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.err).toContain('RELEASE_STAMP_INVALID');
    expect(r.err).toContain('pr-7.txt');
    expect(remote(fx, 'main')).toBe(base);
  }, 120_000);

  test('a release head on a branch naming another version is refused with RELEASE_STAMP_INVALID', () => {
    const fx = setup();
    const { pin, base } = release(fx);
    fx.repo.git('push', '-q', 'origin', pin + ':refs/heads/release/9.9.9.9');
    fx.write(d => { d.prs['50'].headRefName = 'release/9.9.9.9'; });
    const r = land(fx, '50', pin);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.err).toContain('not the version its branch names');
    expect(remote(fx, 'main')).toBe(base);
  }, 120_000);

  test('a rerun after the release merged, from a fresh clone without the pin, fetches it and lands against the main it was stamped on', () => {
    const fx = setup();
    const { pin, base } = release(fx);
    expect(land(fx, '50', pin).status).toBe(EXIT.ok);
    const branch = fx.read().prs['50'].headRefName as string;
    const g = (...a: string[]) => fx.repo.git('--git-dir', fx.repo.origin, ...a);
    g('update-ref', 'refs/pull/50/head', pin);
    fx.write(d => { d.prs['50'].headRefOid = pin; });
    g('update-ref', '-d', 'refs/heads/' + branch);
    const fresh = fx.repo.root + '/fresh';
    fx.repo.git('clone', '-q', '--no-local', '--single-branch', '--branch', 'main', fx.repo.origin, fresh);
    expect(spawnCheck(fresh, pin)).toBe(false);
    const r = runBin(fx.repo, 'gstack-ship-queue', ['land', '--pr', '50', '--pin', pin, '--base', 'main'], fx.env, fresh);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('already merged');
    expect(r.out).toMatch(/^LANDED: .* equals the pin merged onto /m);
    expect(r.out).toContain(base);
  }, 120_000);

  test('a release head stamped on an older main is refused: PRs that landed since would ship under its version', () => {
    const fx = setup();
    const { pin } = release(fx);
    const moved = moveMain(fx, 'later.txt', 'landed after the stamp\n');
    const r = land(fx, '50', pin);
    expect(r.status).not.toBe(EXIT.ok);
    expect(r.err).toContain('RELEASE_STAMP_INVALID');
    expect(r.err).toContain('moved to ' + moved.slice(0, 12));
    expect(remote(fx, 'main')).toBe(moved);
  }, 120_000);
});

/** A backstop freeze on origin's notes (what crew/scripts/train-backstop.ts writes on a red gate), written from another state root. */
function freezeMain(fx: Fx, over: Record<string, unknown> = {}): string {
  const main = remote(fx, 'main');
  const prior = process.env.GSTACK_STATE_ROOT;
  process.env.GSTACK_STATE_ROOT = path.join(fx.repo.root, 'freeze-state');
  try {
    const at = new Date().toISOString();
    persist(fx.repo.work, [{ schema: 1, kind: 'freeze', repo_key: repoIdentity(fx.repo.work).key, train: 'backstop', merged: [], unmerged: [], main: { sha: main, tree: fx.repo.git('rev-parse', main + '^{tree}') },
      reason: `backstop red on main ${main.slice(0, 12)}: no red case recorded; run 41817566885 (completed/failure)`, backstop: { nonce: 'gate.backstop-x', run: 41817566885, state: 'completed/failure' },
      repair: null, created_at: at, cleared_at: null, cleared_by: null, updated_at: at, ...over } as any]);
  } finally { if (prior === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prior; }
  return main;
}
const originRecords = (fx: Fx, kind: string): any[] => {
  const notes = (...a: string[]) => fx.repo.git('--git-dir', fx.repo.origin, 'notes', '--ref=refs/notes/gstack-trains', ...a);
  let list = '';
  try { list = notes('list'); } catch { return []; }
  return list.split('\n').filter(Boolean).map(l => JSON.parse(notes('show', l.split(' ')[1]!))).filter(r => r.kind === kind);
};
const freezeOf = (fx: Fx) => { const all = originRecords(fx, 'freeze'); expect(all).toHaveLength(1); return all[0]; };

/**
 * crew/scripts/train-backstop.ts on main's head from its own clone (the CI runner's checkout) with a scripted gh: no green
 * train covers it, and the gate run concludes as asked; `during` runs while the gate runs (a land meanwhile).
 */
function backstopOn(fx: Fx, gate: 'success' | 'failure' | 'cancelled', run: number, during?: () => void) {
  const sha = remote(fx, 'main');
  const runner = path.join(fx.repo.root, 'runner');
  const rg = (...a: string[]) => { const r = spawnSync('git', ['-C', runner, ...a], { encoding: 'utf8', timeout: 30_000 }); if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); };
  if (!fs.existsSync(runner)) { const c = spawnSync('git', ['clone', '-q', fx.repo.origin, runner], { encoding: 'utf8', timeout: 30_000 }); if (c.status !== 0) throw new Error(c.stderr); }
  rg('fetch', '-q', 'origin');
  rg('checkout', '-q', '--detach', sha);
  let dispatched = '';
  const ok = (body: unknown) => ({ status: 0, stdout: typeof body === 'string' ? body : JSON.stringify(body), stderr: '' });
  const gh: GhRunner = (args) => {
    const joined = args.join(' ');
    if (args[0] === 'api' && joined.includes('/actions/workflows/') && joined.includes('status=success')) return ok({ workflow_runs: [] });
    if (args[0] === 'workflow' && args[1] === 'run') { dispatched = args.find(a => a.startsWith('nonce='))!.slice('nonce='.length); return ok(''); }
    if (args[0] === 'api' && joined.includes('/actions/workflows/')) return ok({ workflow_runs: dispatched ? [{ id: run, status: 'queued', conclusion: null, head_sha: sha, display_title: `E2E Evals [eval-bg ${dispatched}]` }] : [] });
    if (args[0] === 'api' && joined.endsWith(`actions/runs/${run}`)) { during?.(); during = undefined; return ok({ id: run, status: 'completed', conclusion: gate, head_sha: sha, html_url: `https://example.invalid/runs/${run}` }); }
    if (args[0] === 'run' && args[1] === 'download') { const dir = args[args.indexOf('-D') + 1]!; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'trial-outcomes.jsonl'), JSON.stringify({ case: 'red-case', attempt: 1, outcome: 'failed' }) + '\n'); return ok(''); }
    if (args[0] === 'issue' && args[1] === 'create') return ok('https://github.com/fixture/repo/issues/3992\n');
    return { status: 1, stdout: '', stderr: `unexpected gh ${joined}` };
  };
  const prior = process.env.GSTACK_STATE_ROOT;
  process.env.GSTACK_STATE_ROOT = path.join(fx.repo.root, 'backstop-state');
  try { return { sha, ...runBackstop({ repo: 'fixture/repo', branch: 'main', sha, repoRoot: runner, gh, sleep: () => {}, pollMs: 1, random: 'abc123' }) }; }
  finally { if (prior === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prior; }
}
/** gstack's own shape: merge: direct with the train block still set, so the backstop gates every push to main. */
const DIRECT_TRAIN = { ...POLICY, train: TRAIN_BLOCK };

describe('land --pin --repair: the one way through a backstop freeze under merge: direct (GST-1354)', () => {
  test('GST-1133: with release_gate on the base the backstop stands down, so a backstop freeze left from before adoption warns instead of refusing: a plain land merges and the record is left as it was', () => {
    const fx = setup({ ...DIRECT_TRAIN, release_gate: { cadence_hours: 8, gate_workflow: 'evals.yml', branch: 'main', stable_ref: 'stable', check_name: 'main-backstop', on_red: 'hold-release', bisect_spend_cap_usd: 40 }, min_gstack_version: RELEASE_GATE_KEY_VERSION });
    freezeMain(fx);
    const pin = openPr(fx, '7');
    const r = land(fx, '7', pin);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toMatch(/^FREEZE: warn only: train backstop froze main \(backstop red on main [0-9a-f]{12}: .*\); the base policy declares release_gate/m);
    expect(fx.read().mergeArgs).toEqual(['7', '--squash', '--match-head-commit', pin, '--subject', 'PR 7 (#7)']);
    expect(freezeOf(fx)).toMatchObject({ train: 'backstop', repair: null, cleared_at: null });
  }, 90_000);

  test('a freeze refuses a plain land and names --repair; --repair with no freeze refuses; nothing merges', () => {
    const fx = setup();
    const pin8 = openPr(fx, '8');
    const early = land(fx, '8', pin8, ['--repair']);
    expect(early.status).toBe(EXIT.refused);
    expect(early.err).toContain('no freeze is active');
    expect(early.err).toContain('(QUEUE_NOT_READY)');
    freezeMain(fx);
    const pin7 = openPr(fx, '7');
    const plain = land(fx, '7', pin7);
    expect(plain.status).toBe(EXIT.refused);
    expect(plain.err).toContain('(QUEUE_TRAIN_FROZEN)');
    expect(plain.err).toContain(`land --pr <repair-pr> --pin <sha> --repair`);
    expect(fx.read().mergeArgs).toBeUndefined();
    expect(freezeOf(fx)).toMatchObject({ repair: null, cleared_at: null });
  }, 90_000);

  test('--repair admits exactly one PR: the normal pin checks run first, the repair is recorded under the land lock, it lands, and the freeze stays active; a second repair and a plain land stay refused', () => {
    const fx = setup();
    freezeMain(fx);
    const pin7 = openPr(fx, '7');
    const pin8 = openPr(fx, '8');
    fx.write(d => { d.checks[pin7] = { 'free-tests': 'failure', 'Check VERSION is not stale vs queue': 'success' }; });
    const red = land(fx, '7', pin7, ['--repair']);
    expect(red.err).toContain('(QUEUE_LAND_CHECKS)');
    expect(freezeOf(fx).repair).toBeNull();
    fx.write(d => { delete d.checks[pin7]; });
    const r = land(fx, '7', pin7, ['--repair']);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain(`REPAIR: #7@${pin7.slice(0, 12)} admitted under the land lock`);
    expect(fx.read().mergeArgs).toEqual(['7', '--squash', '--match-head-commit', pin7, '--subject', 'PR 7 (#7)']);
    expect(fx.read().lockAtMerge).toMatchObject({ pr: '7', journal: 'land-pin:' + pin7 });
    expect(freezeOf(fx)).toMatchObject({ train: 'backstop', repair: { pr: '7', head: pin7, train: null }, cleared_at: null, cleared_by: null });
    expect(landNotes(fx)).toEqual([expect.objectContaining({ pr: '7', pin: pin7, merge_sha: remote(fx, 'main') })]);
    const second = land(fx, '8', pin8, ['--repair']);
    expect(second.err).toContain('(QUEUE_TRAIN_FROZEN)');
    expect(second.err).toContain(`repair #7@${pin7.slice(0, 12)}`);
    expect(land(fx, '8', pin8).err).toContain('(QUEUE_TRAIN_FROZEN)');
    expect(fx.read().mergeArgs).toEqual(['7', '--squash', '--match-head-commit', pin7, '--subject', 'PR 7 (#7)']);
  }, 120_000);

  test('a recorded repair that never merged at its pin gives way to the next --repair; a repair train holding the freeze does not', () => {
    const fx = setup();
    const stale = 'a'.repeat(40);
    fx.write(d => { d.prs['5'] = { state: 'MERGED', baseRefName: 'main', headRefName: 'pr-5', headRefOid: 'c'.repeat(40), isCrossRepository: false, body: '' }; });
    freezeMain(fx, { repair: { pr: '5', head: stale, train: null } });
    const pin7 = openPr(fx, '7');
    const r = land(fx, '7', pin7, ['--repair']);
    expect(r.err).toBe('');
    expect(freezeOf(fx).repair).toEqual({ pr: '7', head: pin7, train: null });
    const fy = setup();
    freezeMain(fy, { repair: { pr: '5', head: stale, train: 'gate.train-x' } });
    const pin9 = openPr(fy, '9');
    const t = land(fy, '9', pin9, ['--repair']);
    expect(t.err).toContain('repair train gate.train-x');
    expect(t.err).toContain('(QUEUE_TRAIN_FROZEN)');
    expect(fy.read().mergeArgs).toBeUndefined();
  }, 120_000);

  test("the Captain's sequence: red backstop freezes; a hand merge's backstop, green or red, clears nothing; land --pin --repair lands the repair; the green backstop on that main clears the freeze, and release-cut and land run again", () => {
    const fx = setup(DIRECT_TRAIN);
    const red0 = backstopOn(fx, 'failure', 41817566885);
    expect(red0.action).toBe('frozen');
    const m0 = red0.sha;
    expect(freezeOf(fx)).toMatchObject({ train: 'backstop', main: { sha: m0 }, cleared_at: null, repair: null });
    expect(readTrainNotes(gitIn(fx.repo.work)).freeze).toContain('queue frozen since train backstop');
    moveMain(fx, 'tooling-fix.txt', 'the hand-merged tooling fix\n');
    const green1 = backstopOn(fx, 'success', 41817566887);
    expect(green1.action).toBe('gated');
    expect(green1.lines.join('\n')).toContain('the freeze stands: no repair was admitted');
    expect(freezeOf(fx)).toMatchObject({ main: { sha: m0 }, cleared_at: null, repair: null });
    const pin = openPr(fx, '3996');
    let landed: ReturnType<typeof land> | undefined;
    const red1 = backstopOn(fx, 'failure', 41817566886, () => { landed = land(fx, '3996', pin, ['--repair']); });
    expect(landed!.err).toBe('');
    expect(landed!.status).toBe(EXIT.ok);
    expect(red1.action).toBe('frozen');
    expect(red1.lines.join('\n')).toContain('the freeze stands with its reason updated');
    expect(freezeOf(fx)).toMatchObject({ main: { sha: m0 }, cleared_at: null, repair: { pr: '3996', head: pin, train: null } });
    expect(freezeOf(fx).reason).toContain(`backstop red on main ${red1.sha.slice(0, 12)}`);
    expect(freezeOf(fx).reason).not.toContain('did not turn main green');
    const green2 = backstopOn(fx, 'success', 41817566888);
    expect(green2.action).toBe('gated');
    const cleared = freezeOf(fx);
    expect(cleared.cleared_by).toBe(`repair #3996; backstop 41817566888 green on ${green2.sha}`);
    expect(Date.parse(cleared.cleared_at)).not.toBeNaN();
    expect(green2.lines).toContain(`BACKSTOP: freeze cleared (${cleared.cleared_by})`);
    expect(readTrainNotes(gitIn(fx.repo.work)).freeze).toBeNull();
    const pin11 = openPr(fx, '11');
    const after = land(fx, '11', pin11);
    expect(after.err).toBe('');
    expect(after.status).toBe(EXIT.ok);
    expect(land(fx, '11', pin11, ['--repair']).status).toBe(EXIT.ok);
  }, 180_000);

  test('a red backstop on a main that contains the repair keeps the freeze, updates its reason and frees the slot for the next repair, whose green backstop clears it; a cancelled gate judges nothing and keeps the slot', () => {
    const fx = setup(DIRECT_TRAIN);
    expect(backstopOn(fx, 'failure', 501).action).toBe('frozen');
    const pin7 = openPr(fx, '7');
    expect(land(fx, '7', pin7, ['--repair']).status).toBe(EXIT.ok);
    const unjudged = backstopOn(fx, 'cancelled', 5015);
    expect(unjudged.action).toBe('frozen');
    expect(freezeOf(fx)).toMatchObject({ cleared_at: null, repair: { pr: '7', head: pin7, train: null } });
    expect(freezeOf(fx).reason).toContain('repair #7 was not judged');
    const red = backstopOn(fx, 'failure', 502);
    expect(red.action).toBe('frozen');
    const kept = freezeOf(fx);
    expect(kept).toMatchObject({ cleared_at: null, repair: null });
    expect(kept.reason).toContain(`backstop red on main ${red.sha.slice(0, 12)}`);
    expect(kept.reason).toContain('repair #7 did not turn main green');
    const pin8 = openPr(fx, '8');
    expect(land(fx, '8', pin8, ['--repair']).status).toBe(EXIT.ok);
    const green = backstopOn(fx, 'success', 503);
    expect(freezeOf(fx).cleared_by).toBe(`repair #8; backstop 503 green on ${green.sha}`);
  }, 180_000);

  test('no clear without the evidence: a green gate on a main that is not at or after the freeze main, or with the repair\'s land note missing, leaves the freeze active; a train freeze takes no land repair and no backstop clear', () => {
    const fx = setup(DIRECT_TRAIN);
    const orphan = fx.repo.git('commit-tree', fx.repo.git('rev-parse', 'origin/main^{tree}'), '-m', 'a main this history never had');
    freezeMain(fx, { main: { sha: orphan, tree: fx.repo.git('rev-parse', orphan + '^{tree}') } });
    const pin7 = openPr(fx, '7');
    expect(land(fx, '7', pin7, ['--repair']).status).toBe(EXIT.ok);
    const green = backstopOn(fx, 'success', 601);
    expect(green.action).toBe('gated');
    expect(green.lines.join('\n')).toContain(`is not at or after the freeze main ${orphan.slice(0, 12)}`);
    expect(freezeOf(fx).cleared_at).toBeNull();
    const fy = setup(DIRECT_TRAIN);
    freezeMain(fy, { repair: { pr: '9', head: 'b'.repeat(40), train: null } });
    moveMain(fy, 'hand.txt', 'merged without land\n');
    const g2 = backstopOn(fy, 'success', 602);
    expect(g2.lines.join('\n')).toContain('repair #9 has no land note');
    expect(g2.lines.join('\n')).toContain('gate this main again with gh run rerun <this backstop run> -R fixture/repo');
    expect(freezeOf(fy).cleared_at).toBeNull();
    const fz = setup(DIRECT_TRAIN);
    freezeMain(fz, { train: 'gate.train-old', backstop: null });
    const pin3 = openPr(fz, '3');
    const t3 = land(fz, '3', pin3, ['--repair']);
    expect(t3.err).toContain('admits a repair only into a main backstop freeze');
    expect(t3.err).toContain('(QUEUE_TRAIN_FROZEN)');
    expect(fz.read().mergeArgs).toBeUndefined();
    moveMain(fz, 'hand.txt', 'merged without land\n');
    const g3 = backstopOn(fz, 'success', 604);
    expect(g3.lines.join('\n')).toContain("train gate.train-old froze the queue, and its repair train's verify clears it");
    expect(freezeOf(fz)).toMatchObject({ train: 'gate.train-old', cleared_at: null });
  }, 180_000);
});

describe('the backstop rewrites a freeze by compare-and-swap (GST-1354)', () => {
  test("a runner whose local notes hold a stale copy of the freeze never overwrites the repair land recorded on origin", () => {
    const fx = setup(DIRECT_TRAIN);
    expect(backstopOn(fx, 'failure', 701).action).toBe('frozen');
    const stale = freezeOf(fx);
    const runner = path.join(fx.repo.root, 'runner');
    const prior = process.env.GSTACK_STATE_ROOT;
    process.env.GSTACK_STATE_ROOT = path.join(fx.repo.root, 'backstop-state');
    try { persist(runner, [{ ...stale, reason: 'a stale local rewrite', updated_at: new Date(Date.now() + 60_000).toISOString() }], { push: false }); }
    finally { if (prior === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prior; }
    const pin = openPr(fx, '7');
    expect(land(fx, '7', pin, ['--repair']).status).toBe(EXIT.ok);
    const red = backstopOn(fx, 'cancelled', 702);
    expect(red.action).toBe('frozen');
    expect(freezeOf(fx)).toMatchObject({ repair: { pr: '7', head: pin, train: null }, cleared_at: null });
    expect(freezeOf(fx).reason).toContain('repair #7 was not judged');
    const green = backstopOn(fx, 'success', 703);
    expect(freezeOf(fx).cleared_by).toBe(`repair #7; backstop 703 green on ${green.sha}`);
  }, 180_000);
});
