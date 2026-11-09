/**
 * The direct-land fixture shared by test/ship-queue-land-direct.test.ts and the receipt-carry land tests: a fixture repo
 * with a gh shim for pr view, check runs and a squash merge, the READY note gstack-ship-queue ready records, and land.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MERGE_KEY_VERSION } from '../../lib/ship-policy';
import { persist, repoIdentity } from '../../crew/lib/ship-queue-train-record';
import { BASE_POLICY, cleanup, makeFixtureRepo, runBin, type FixtureRepo } from './restamp-fixture';

const repos: FixtureRepo[] = [];
/** Remove every fixture setupLandFixture made (call from afterEach). */
export function cleanupLandFixtures(): void { while (repos.length) cleanup(repos.pop()!); }

export const REQUIRED = ['free-tests', 'Check VERSION is not stale vs queue'];
/** merge: direct with changelog fragments and two required checks, as land --pin reads it from the base. */
export const POLICY = { ...BASE_POLICY, release_tool: null, release_outputs: [], changelog_fragments: { dir: 'changelog.d', required_checks: REQUIRED }, merge: 'direct', min_gstack_version: MERGE_KEY_VERSION };

export interface Fx { repo: FixtureRepo; env: Record<string, string>; write: (fn: (d: any) => void) => void; read: () => any }
/** A fixture repo (bare origin, lane clone) seeded with `policy`, and a gh shim on PATH (`env`) that answers pr view, check runs and a squash merge against the bare origin from `data.json` (`read`, `write`). */
export function setupLandFixture(policy: Record<string, unknown> = POLICY): Fx {
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
    "if(a[0]==='api'){const m=/commits\\/([0-9a-f]+)\\/(check-runs|status)/.exec(a[1]);if(!m)process.exit(1);",
    "  if(m[2]==='status'){console.log(JSON.stringify({total_count:0,statuses:[]}));process.exit(0)}",
    "  const set=d.checks[m[1]]??Object.fromEntries(d.defaultChecks.map(n=>[n,'success']));",
    "  const runs=Object.entries(set).map(([name,c],i)=>({id:i+1,name,status:c==='pending'?'in_progress':'completed',conclusion:c==='pending'?null:c,completed_at:'2026-11-03T00:00:00Z',app:{id:1}}));",
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
export function markReady(fx: Fx, pr: string, head: string): void {
  const prior = process.env.GSTACK_STATE_ROOT;
  process.env.GSTACK_STATE_ROOT = path.join(fx.repo.root, 'ready-state');
  try {
    const now = new Date().toISOString();
    persist(fx.repo.work, [{ schema: 1, kind: 'ready', repo_key: repoIdentity(fx.repo.work).key, pr, head, base_sha: fx.repo.git('rev-parse', 'origin/main'), ready_at: now, screen: { choice: 'no-screen', policy: null, nonce: null, run: null, merge_sha: null }, updated_at: now }]);
  } finally { if (prior === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prior; }
}

export const land = (fx: Fx, pr: string, pin: string, extra: string[] = []) => runBin(fx.repo, 'gstack-ship-queue', ['land', '--pr', pr, '--pin', pin, '--base', 'main', ...extra], fx.env);
export const remote = (fx: Fx, ref: string) => { fx.repo.git('fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*'); return fx.repo.git('rev-parse', 'origin/' + ref); };
