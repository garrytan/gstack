/**
 * gstack-ship-queue land (docs/ship-policy.md#land): the merge step over real fixture repos (bare origin,
 * lane clone) and a gh shim that answers pr view, check runs, statuses and a squash merge against the
 * bare origin. Covers the fold-and-merge happy path, two PRs from one base landing without a collision,
 * release-field-only conflict resolution that keeps a clean dependency edit, product-conflict refusal,
 * the lock, the base moving during CI (restamp under the last-pushed lease), a foreign push, a missing
 * receipt and drift after the merge.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { BASE_POLICY, cleanup, makeFixtureRepo, readFile, runBin, type FixtureRepo } from './helpers/restamp-fixture';
import { shippedBody } from './helpers/ship-queue-train-fixture';
import { resolveReleaseConflicts } from '../lib/ship-queue-land';
import { mergePolicy } from '../lib/ship-policy';
import { persist, repoIdentity } from '../lib/ship-queue-train-record';

const POLICY = { ...BASE_POLICY, release_tool: null, release_outputs: [], changelog_fragments: { dir: 'changelog.d' }, min_gstack_version: '1.91.336.0' };
const repos: FixtureRepo[] = [];
afterEach(() => { while (repos.length) cleanup(repos.pop()!); });

interface Fx { repo: FixtureRepo; data: string; env: Record<string, string>; write: (fn: (d: any) => void) => void }
function setup(policy: Record<string, unknown> = POLICY): Fx {
  const repo = makeFixtureRepo({ policy, prefix: 'gstack-land-fx-' });
  repos.push(repo);
  const dir = path.join(repo.root, 'gh-shim');
  fs.mkdirSync(dir, { recursive: true });
  const data = path.join(dir, 'data.json');
  fs.writeFileSync(data, JSON.stringify({ prs: {}, red: [], driftOnMerge: false }));
  fs.writeFileSync(path.join(dir, 'gh'), [
    '#!/usr/bin/env node',
    "const fs=require('fs');const {execFileSync}=require('child_process');",
    'const D=process.env.LAND_SHIM_DATA, O=process.env.LAND_SHIM_ORIGIN;',
    "const d=JSON.parse(fs.readFileSync(D,'utf8'));const a=process.argv.slice(2);",
    "const g=(...x)=>execFileSync('git',['--git-dir',O,...x],{encoding:'utf8',timeout:30000}).trim();",
    "const save=()=>fs.writeFileSync(D,JSON.stringify(d));",
    "if(a[0]==='pr'&&a[1]==='view'){const p=d.prs[a[2]];if(!p){console.error('no pr');process.exit(1)}",
    "  let head='';try{head=g('rev-parse','refs/heads/'+p.headRefName)}catch{};",
    "  console.log(JSON.stringify({...p,headRefOid:head}));process.exit(0)}",
    "if(a[0]==='pr'&&a[1]==='list'){console.log(JSON.stringify(Object.entries(d.prs).filter(([,p])=>p.state==='OPEN').map(([n,p])=>({number:Number(n),headRefOid:g('rev-parse','refs/heads/'+p.headRefName),isCrossRepository:!!p.isCrossRepository}))));process.exit(0)}",
    "if(a[0]==='api'){const m=/commits\\/([0-9a-f]+)\\/(check-runs|status)/.exec(a[1]);if(!m)process.exit(1);",
    "  if(m[2]==='status'){console.log(JSON.stringify({total_count:0,statuses:[]}));process.exit(0)}",
    "  const red=d.red.includes(m[1]);console.log(JSON.stringify({total_count:1,check_runs:[{id:1,name:'free-tests',status:'completed',conclusion:red?'failure':'success',completed_at:'2026-10-29T00:00:00Z',app:{id:1}}]}));process.exit(0)}",
    "if(a[0]==='pr'&&a[1]==='merge'){const p=d.prs[a[2]];const want=a[a.indexOf('--match-head-commit')+1];const head=g('rev-parse','refs/heads/'+p.headRefName);",
    "  if(head!==want){console.error('Head branch was modified');process.exit(1)}",
    "  if(d.mergeRefuse){console.error('Pull request is not mergeable: the base branch policy prohibits the merge');process.exit(1)}",
    "  if(d.driftOnMerge){const m=g('rev-parse','refs/heads/main');const t=g('rev-parse',m+'^{tree}');g('update-ref','refs/heads/main',g('commit-tree',t,'-p',m,'-m','outside merge'));d.driftOnMerge=false}",
    "  const main=g('rev-parse','refs/heads/main');const sq=g('commit-tree',g('rev-parse',want+'^{tree}'),'-p',main,'-m','squash #'+a[2]);g('update-ref','refs/heads/main',sq);if(d.outsideAfter){g('update-ref','refs/heads/main',g('commit-tree',g('rev-parse',sq+'^{tree}'),'-p',sq,'-m','outside after'));d.outsideAfter=false}d.mergeArgs=a.slice(3);p.state='MERGED';save();if(d.mergeErrorAfter){d.mergeErrorAfter=false;save();console.error('HTTP 502: Bad Gateway');process.exit(1)}process.exit(0)}",
    "if(a[0]==='pr'&&a[1]==='create'&&d.createFail){d.createFail=false;save();console.error('timeout');process.exit(1)}",
    "if(a[0]==='pr'&&a[1]==='create'){const h=a[a.indexOf('--head')+1];const had=Object.entries(d.prs).find(([,p])=>p.headRefName===h&&p.state==='OPEN');if(had){console.error('a pull request for branch \"'+h+'\" into branch \"main\" already exists:\\nhttps://github.com/o/r/pull/'+had[0]);process.exit(1)}}",
    "if(a[0]==='pr'&&a[1]==='create'){const n=String(Math.max(0,...Object.keys(d.prs).map(Number))+1);d.prs[n]={state:'OPEN',headRefName:a[a.indexOf('--head')+1],isCrossRepository:false,title:a[a.indexOf('--title')+1],body:''};save();console.log('https://github.com/o/r/pull/'+n);process.exit(0)}",
    "console.error('gh shim: unsupported '+a.join(' '));process.exit(1);",
    '',
  ].join('\n'), { mode: 0o755 });
  const env = { PATH: dir + ':' + (process.env.PATH ?? ''), LAND_SHIM_DATA: data, LAND_SHIM_ORIGIN: repo.origin };
  return { repo, data, env, write: fn => { const d = JSON.parse(fs.readFileSync(data, 'utf8')); fn(d); fs.writeFileSync(data, JSON.stringify(d)); } };
}

/** A PR branch from origin/main, pushed, with a fragment (or none), and a /ship receipt for its head in the shim. */
/** The READY receipt `gstack-ship-queue ready` records (a note on origin refs/notes/gstack-trains), written into the fixture's own state root. */
function markReady(fx: Fx, pr: string, head: string): void {
  const prior = process.env.GSTACK_STATE_ROOT;
  process.env.GSTACK_STATE_ROOT = path.join(fx.repo.root, 'ready-state');
  try {
    const now = new Date().toISOString();
    persist(fx.repo.work, [{ schema: 1, kind: 'ready', repo_key: repoIdentity(fx.repo.work).key, pr, head, base_sha: fx.repo.git('rev-parse', 'origin/main'), ready_at: now, screen: { choice: 'no-screen', policy: null, nonce: null, run: null, merge_sha: null }, updated_at: now }]);
  } finally { if (prior === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = prior; }
}

function openPr(fx: Fx, pr: string, opts: { fragment?: string | null; edit?: (work: string) => void; shipped?: boolean; ready?: boolean } = {}): string {
  const { repo } = fx;
  repo.git('checkout', '-q', 'origin/main', '-B', 'pr-' + pr);
  fs.writeFileSync(path.join(repo.work, 'pr-' + pr + '.txt'), pr + '\n');
  if (opts.fragment !== null) {
    fs.mkdirSync(path.join(repo.work, 'changelog.d'), { recursive: true });
    fs.writeFileSync(path.join(repo.work, 'changelog.d', 'pr-' + pr + '.md'), opts.fragment ?? '- #' + pr + ' change\n');
  }
  opts.edit?.(repo.work);
  repo.git('add', '-A');
  repo.git('commit', '-q', '-m', 'pr ' + pr);
  repo.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/pr-' + pr);
  const head = repo.git('rev-parse', 'HEAD');
  fx.write(d => { d.prs[pr] = { state: 'OPEN', headRefName: 'pr-' + pr, isCrossRepository: false, title: 'PR ' + pr + ' title', body: opts.shipped === false ? '' : shippedBody(pr, head) }; });
  if (opts.ready !== false) markReady(fx, pr, head);
  repo.git('checkout', '-q', '--detach', 'origin/main');
  return head;
}
const land = (fx: Fx, args: string[]) => runBin(fx.repo, 'gstack-ship-queue', ['land', ...args, '--base', 'main', '--no-wait', '--allow-repo-commands'], fx.env);
const remote = (fx: Fx, ref: string) => { fx.repo.git('fetch', '-q', 'origin', '+refs/heads/*:refs/remotes/origin/*'); return fx.repo.git('rev-parse', 'origin/' + ref); };
const show = (fx: Fx, rev: string) => fx.repo.git('show', rev);

describe('land: fold, push, merge', () => {
  test('happy path: a stamp commit with parents [pin, main] and the folded tree, then a squash whose tree is that tree', () => {
    const fx = setup();
    const base = remote(fx, 'main');
    const pin = openPr(fx, '7', { fragment: '---\nbump: minor\n---\n- **Fragments.** #7\n' });
    const first = land(fx, ['--pr', '7']);
    expect(first.err).toBe('');
    expect(first.status).toBe(EXIT.ok);
    expect(first.out).toContain('STAMP_VERSION: 1.3.0.0');
    expect(first.out).toMatch(/^NEXT: gstack-pr-wait 7 --until green && gstack-ship-queue land --pr 7$/m);
    const stamp = remote(fx, 'pr-7');
    expect(fx.repo.git('rev-list', '--parents', '-n', '1', stamp).split(' ').slice(1)).toEqual([pin, base]);
    expect(show(fx, stamp + ':VERSION')).toBe('1.3.0.0');
    expect(fx.repo.git('ls-tree', '--name-only', stamp, 'changelog.d/')).toBe('');
    expect(show(fx, stamp + ':CHANGELOG.md')).toMatch(/^# Changelog\n\n## \[1\.3\.0\.0\] - \d{4}-\d{2}-\d{2}\n\n- \*\*Fragments\.\*\* #7\n\n## \[1\.2\.3\.0\]/);
    const second = land(fx, ['--pr', '7']);
    expect(second.err).toBe('');
    expect(second.out).toContain('MERGED: #7');
    expect(second.out).toMatch(/^LANDED: origin\/main tree [0-9a-f]+ equals the stamped tree$/m);
    expect(second.out).toContain('LOCK: released');
    const main = remote(fx, 'main');
    expect(fx.repo.git('rev-parse', main + '^{tree}')).toBe(fx.repo.git('rev-parse', stamp + '^{tree}'));
  }, 90_000);

  test('two PRs from one base land one after the other with no collision and no lane round trip', () => {
    const fx = setup();
    openPr(fx, '1');
    openPr(fx, '2');
    for (const pr of ['1', '2']) { expect(land(fx, ['--pr', pr]).status).toBe(EXIT.ok); expect(land(fx, ['--pr', pr]).out).toContain('LANDED:'); }
    const main = remote(fx, 'main');
    expect(show(fx, main + ':VERSION')).toBe('1.2.5.0');
    const cl = show(fx, main + ':CHANGELOG.md');
    expect(cl.indexOf('## [1.2.5.0]')).toBeLessThan(cl.indexOf('- #2 change'));
    expect(cl.indexOf('- #2 change')).toBeLessThan(cl.indexOf('## [1.2.4.0]'));
    expect(cl.indexOf('## [1.2.4.0]')).toBeLessThan(cl.indexOf('- #1 change'));
  }, 90_000);

  test('a legacy PR with its own VERSION bump and a clean dependency edit: release fields resolve to main, the dependency edit survives', () => {
    const fx = setup();
    openPr(fx, '1');
    expect(land(fx, ['--pr', '1']).status).toBe(EXIT.ok); land(fx, ['--pr', '1']);
    fx.repo.git('fetch', '-q', 'origin');
    fx.repo.git('checkout', '-q', '-B', 'pr-3', fx.repo.git('rev-parse', 'origin/main') + '~1');
    const pkg = JSON.parse(readFile(fx.repo, 'package.json'));
    pkg.version = '1.2.9'; pkg.dependencies['right-pad'] = '2.0.0';
    fs.writeFileSync(path.join(fx.repo.work, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    fs.writeFileSync(path.join(fx.repo.work, 'VERSION'), '1.2.9.0\n');
    fs.writeFileSync(path.join(fx.repo.work, 'CHANGELOG.md'), readFile(fx.repo, 'CHANGELOG.md').replace('# Changelog\n', '# Changelog\n\n## [1.2.9.0] - 2026-10-28\n\n- legacy #3\n'));
    fx.repo.git('add', '-A'); fx.repo.git('commit', '-q', '-m', 'legacy stamped pr');
    fx.repo.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/pr-3');
    const head = fx.repo.git('rev-parse', 'HEAD');
    fx.write(d => { d.prs['3'] = { state: 'OPEN', headRefName: 'pr-3', isCrossRepository: false, title: 'legacy', body: shippedBody('3', head) }; });
    markReady(fx, '3', head);
    const r = land(fx, ['--pr', '3']);
    expect(r.err).toBe('');
    expect(r.out).toMatch(/^legacy: the pin stamped 1\.2\.9\.0 itself/m);
    expect(r.out).toMatch(/^resolved: .*CHANGELOG\.md/m);
    const stamp = remote(fx, 'pr-3');
    expect(show(fx, stamp + ':VERSION')).toBe('1.2.5.0');
    const merged = JSON.parse(show(fx, stamp + ':package.json'));
    expect(merged.dependencies).toEqual({ 'left-pad': '1.2.3', 'right-pad': '2.0.0' });
    expect(show(fx, stamp + ':CHANGELOG.md')).toMatch(/## \[1\.2\.5\.0\][^\n]*\n\n- legacy #3\n\n## \[1\.2\.4\.0\][^\n]*\n\n- #1 change/);
  }, 90_000);

  test('a PR with no entry gets one from its title; a product conflict refuses with nothing pushed', () => {
    const fx = setup();
    openPr(fx, '4', { fragment: null, edit: w => fs.writeFileSync(path.join(w, 'shared.txt'), 'four\n') });
    openPr(fx, '5', { edit: w => fs.writeFileSync(path.join(w, 'shared.txt'), 'five\n') });
    const r = land(fx, ['--pr', '4']);
    expect(r.out).toContain('entry: none in the PR, so land wrote changelog.d/land-4.md from the title');
    expect(show(fx, remote(fx, 'pr-4') + ':CHANGELOG.md')).toContain('- PR 4 title (#4)');
    land(fx, ['--pr', '4']);
    const pin5 = remote(fx, 'pr-5');
    const c = land(fx, ['--pr', '5']);
    expect(c.status).toBe(EXIT.refused);
    expect(c.err).toMatch(/#5 conflicts with origin\/main in shared\.txt.*\(QUEUE_LAND_CONFLICT\)/);
    expect(remote(fx, 'pr-5')).toBe(pin5);
  }, 90_000);
});

describe('land: lock, races and refusals', () => {
  test('a held lock refuses; --break-lock takes over a lock that is not mid-push', () => {
    const fx = setup();
    openPr(fx, '1'); openPr(fx, '2');
    expect(land(fx, ['--pr', '1']).status).toBe(EXIT.ok);
    const held = land(fx, ['--pr', '2']);
    expect(held.err).toMatch(/#1 holds the land lock .*phase waiting.*\(QUEUE_LAND_LOCKED\)/);
    const broke = land(fx, ['--pr', '2', '--break-lock']);
    expect(broke.out).toContain("LOCK: broke #1's lock");
  }, 90_000);

  test('the base moving during CI restamps and pushes under the last-pushed lease; a third move stops', () => {
    const fx = setup();
    openPr(fx, '1'); openPr(fx, '2');
    const pin1 = remote(fx, 'pr-1');
    expect(land(fx, ['--pr', '1']).status).toBe(EXIT.ok);
    const firstStamp = remote(fx, 'pr-1');
    const bump = (n: number) => { fx.repo.git('fetch', '-q', 'origin'); fx.repo.git('checkout', '-q', '--detach', 'origin/main'); fs.writeFileSync(path.join(fx.repo.work, 'outside-' + n + '.txt'), 'x\n'); fx.repo.git('add', '-A'); fx.repo.git('commit', '-q', '-m', 'outside ' + n); fx.repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main'); };
    bump(1);
    const again = land(fx, ['--pr', '1']);
    expect(again.err).toBe('');
    expect(again.out).toMatch(/^BASE_MOVED: /m);
    const secondStamp = remote(fx, 'pr-1');
    expect(secondStamp).not.toBe(firstStamp);
    expect(fx.repo.git('rev-list', '--parents', '-n', '1', secondStamp).split(' ')[1]).toBe(pin1);
    bump(2); expect(land(fx, ['--pr', '1']).status).toBe(EXIT.ok);
    bump(3);
    expect(land(fx, ['--pr', '1']).err).toContain('(QUEUE_LAND_BASE_BUSY)');
    fx.repo.git('fetch', '-q', 'origin', '+refs/notes/gstack-land:refs/notes/gstack-land');
    expect(show(fx, 'refs/notes/gstack-land:lock.json')).toContain('"released": true');
    const later = land(fx, ['--pr', '1']);
    expect(later.err).toBe('');
    expect(later.out).toMatch(/^BASE_MOVED: /m);
  }, 90_000);

  test('a missing receipt refuses before the lock; a foreign push after the stamp is never overwritten', () => {
    const fx = setup();
    openPr(fx, '6', { shipped: false });
    expect(land(fx, ['--pr', '6']).err).toContain('(QUEUE_RECEIPT_MISSING)');
    openPr(fx, '8');
    expect(land(fx, ['--pr', '8']).status).toBe(EXIT.ok);
    fx.repo.git('fetch', '-q', 'origin');
    fx.repo.git('checkout', '-q', '--detach', 'origin/pr-8');
    fs.writeFileSync(path.join(fx.repo.work, 'late.txt'), 'late\n'); fx.repo.git('add', '-A'); fx.repo.git('commit', '-q', '-m', 'late');
    fx.repo.git('push', '-q', 'origin', 'HEAD:refs/heads/pr-8');
    const late = fx.repo.git('rev-parse', 'HEAD');
    const r = land(fx, ['--pr', '8', '--break-lock']);
    expect(r.err).toMatch(/QUEUE_RECEIPT_STALE/);
    expect(remote(fx, 'pr-8')).toBe(late);
  }, 90_000);

  test('the receipt check is the depth-checked one READY uses: a receipt whose writer records depth but which records none refuses', () => {
    const fx = setup();
    const head = openPr(fx, '31');
    fx.write(d => { d.prs['31'].body = shippedBody('31', head, { gstack_version: '1.91.307.0' }); });
    const r = land(fx, ['--pr', '31']);
    expect(r.err).toContain('(QUEUE_RECEIPT_DEPTH_RAISED)');
    expect(r.out).toMatch(/^REVIEW_DEPTH: receipt=none required=/m);
    expect(remote(fx, 'pr-31')).toBe(head);
  }, 60_000);

  test('drift: a merge outside land between the check and the squash fails loudly and keeps the lock', () => {
    const fx = setup();
    openPr(fx, '9');
    expect(land(fx, ['--pr', '9']).status).toBe(EXIT.ok);
    fx.write(d => { d.driftOnMerge = true; });
    const r = land(fx, ['--pr', '9']);
    expect(r.err).toContain('(QUEUE_LAND_DRIFT)');
    openPr(fx, '10');
    expect(land(fx, ['--pr', '10']).err).toMatch(/#9 holds the land lock .*phase drift.*\(QUEUE_LAND_LOCKED\)/);
    expect(land(fx, ['--pr', '10', '--break-lock']).err).toMatch(/#9 holds a drift lock; --break-lock never breaks it.*\(QUEUE_LAND_DRIFT\)/);
    const rep = land(fx, ['--pr', '9', '--repair']);
    expect(rep.status).toBe(EXIT.ok);
    expect(rep.out).toContain('entry: changelog.d/repair-9.md names 1 outside commit(s)');
    const n = /REPAIR_PR: #(\d+) gstack-land-repair\/9 ([0-9a-f]{40})/.exec(rep.out)!;
    expect(show(fx, n[2] + ':changelog.d/repair-9.md')).toBe('- Changes merged outside land beside #9: outside merge');
    expect(land(fx, ['--pr', n[1]!]).err).toContain('(QUEUE_RECEIPT_MISSING)');
    fx.write(d => { d.prs[n[1]!].body = shippedBody(n[1]!, n[2]!); });
    markReady(fx, n[1]!, n[2]!);
    const pushed = land(fx, ['--pr', n[1]!]);
    expect(pushed.out).toContain("LOCK: taking over #9's drift lock for its repair");
    const merged = land(fx, ['--pr', n[1]!]);
    expect(merged.status).toBe(EXIT.ok);
    expect(merged.out).toContain('LOCK: released');
    expect(fx.repo.git('ls-tree', '-r', '--name-only', 'origin/main', '--', 'changelog.d')).not.toContain('repair-9');
    expect(show(fx, 'origin/main:CHANGELOG.md')).toContain('- Changes merged outside land beside #9: outside merge');
    expect(land(fx, ['--pr', '10']).status).toBe(EXIT.ok);
  }, 120_000);

  test('census lists what land would do, writing nothing', () => {
    const fx = setup();
    openPr(fx, '1'); openPr(fx, '2', { fragment: null });
    const c = runBin(fx.repo, 'gstack-ship-queue', ['land', '--census', '--base', 'main'], fx.env);
    expect(c.status).toBe(EXIT.ok);
    expect(c.out).toMatch(/^#1 [0-9a-f]{12}: fold pr-1\.md$/m);
    expect(c.out).toMatch(/^#2 [0-9a-f]{12}: no entry \(land writes one from the title\)$/m);
  }, 90_000);
});

describe('land: the base\'s manifest part count', () => {
  test('a repo whose base holds a four-part package.json listed in stamp_files lands four parts (gbrain#7878 wrote three)', () => {
    const fx = setup({ ...POLICY, stamp_files: ['VERSION', 'package.json', 'CHANGELOG.md', 'changelog.d/*.md'], stamp_patterns: ['"version": "{version}"'] });
    const { repo } = fx;
    repo.git('checkout', '-q', 'main');
    const pkg = JSON.parse(readFile(repo, 'package.json'));
    fs.writeFileSync(path.join(repo.work, 'package.json'), JSON.stringify({ ...pkg, version: '1.2.3.0' }, null, 2) + '\n');
    fs.rmSync(path.join(repo.work, 'package-lock.json'));
    repo.git('add', '-A'); repo.git('commit', '-q', '-m', 'four-part manifest'); repo.git('push', '-q', 'origin', 'main');
    openPr(fx, '21');
    expect(land(fx, ['--pr', '21']).status).toBe(EXIT.ok);
    const merged = land(fx, ['--pr', '21']);
    expect(merged.status, merged.err).toBe(EXIT.ok);
    expect(JSON.parse(show(fx, 'origin/main:package.json')).version).toBe('1.2.4.0');
    expect(show(fx, 'origin/main:VERSION')).toBe('1.2.4.0');
  }, 90_000);

  test('control: gstack\'s shape (a three-part manifest outside stamp_files) stays three parts', () => {
    const fx = setup();
    openPr(fx, '22');
    land(fx, ['--pr', '22']);
    expect(land(fx, ['--pr', '22']).status).toBe(EXIT.ok);
    expect(JSON.parse(show(fx, 'origin/main:package.json')).version).toBe('1.2.4');
  }, 90_000);
});

describe('resolveReleaseConflicts', () => {
  test('a manifest whose version conflicts keeps the clean dependency edit and takes the base version; a real dependency conflict stays a conflict', () => {
    const fx = setup();
    const { repo } = fx;
    const write = (v: string, deps: Record<string, string>) => fs.writeFileSync(path.join(repo.work, 'package.json'), JSON.stringify({ name: 'fixture', version: v, dependencies: deps }, null, 2) + '\n');
    repo.git('checkout', '-q', '-B', 'base-x', 'origin/main');
    write('1.2.3', { a: '1' }); repo.git('commit', '-qam', 'base');
    repo.git('checkout', '-q', '-B', 'ours-x'); write('1.2.9', { a: '1', b: '2' }); repo.git('commit', '-qam', 'ours');
    repo.git('checkout', '-q', '-B', 'theirs-x', 'base-x'); write('1.2.4', { a: '1' }); repo.git('commit', '-qam', 'theirs');
    repo.git('checkout', '-q', 'ours-x');
    try { repo.git('merge', '--no-commit', 'theirs-x'); } catch {}
    const policy = mergePolicy(POLICY, 'test').policy;
    expect(resolveReleaseConflicts(repo.work, ['package.json'], policy, 'VERSION')).toEqual([]);
    expect(JSON.parse(readFile(repo, 'package.json'))).toEqual({ name: 'fixture', version: '1.2.4', dependencies: { a: '1', b: '2' } });
    repo.git('merge', '--abort');
    repo.git('checkout', '-q', 'theirs-x'); write('1.2.4', { a: '3' }); repo.git('commit', '-qam', 'theirs dep');
    repo.git('checkout', '-q', 'ours-x'); write('1.2.9', { a: '2', b: '2' }); repo.git('commit', '-qam', 'ours dep');
    try { repo.git('merge', '--no-commit', 'theirs-x'); } catch {}
    expect(resolveReleaseConflicts(repo.work, ['package.json'], policy, 'VERSION')).toEqual(['package.json']);
  }, 90_000);
});

// Generated by /ship Step 7 coverage audit (GSTA-154 PR A, pass 1).
describe('land: dry run and refusals before the lock', () => {
  const lockRef = (fx: Fx) => fx.repo.git('ls-remote', 'origin', 'refs/notes/gstack-land');
  const journal = (fx: Fx, pr: string) => path.join(fx.repo.work, '.gstack', 'tmp', 'ship-queue', 'land', pr + '.json');

  // Value: protects=land --dry-run prints the stamp it would make and writes nothing: no lock ref, no push, no journal;
  // fails_when=dry-run falls through to the lock/push path or saves a journal; why_new=no land test passes --dry-run;
  // seam=none; no_claim=gh shim stands in for GitHub (fixture repos only)
  test('--dry-run prints the stamp version and tree but takes no lock, pushes nothing and saves no journal', () => {
    const fx = setup();
    const pin = openPr(fx, '11', { fragment: '---\nbump: minor\n---\n- dry #11\n' });
    const r = land(fx, ['--pr', '11', '--dry-run']);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('STAMP_VERSION: 1.3.0.0');
    expect(r.out).toMatch(/^STAMP_TREE: [0-9a-f]{40}$/m);
    expect(r.out).toContain('DRY-RUN: nothing locked, pushed or merged');
    expect(remote(fx, 'pr-11')).toBe(pin);
    expect(lockRef(fx)).toBe('');
    expect(fs.existsSync(journal(fx, '11'))).toBe(false);
  }, 90_000);

  // Value: protects=land refuses a red pin, a fork head and a closed PR before it locks or pushes anything;
  // fails_when=the pin CI check, the isCrossRepository guard or the OPEN-state guard is dropped or moved after the lock;
  // why_new=existing land tests only use green, open, same-repo PRs; seam=none; no_claim=GitHub check semantics (gh shim)
  test('a red pin, a fork head and a closed PR refuse with no lock taken and the branch untouched', () => {
    const fx = setup();
    const pin = openPr(fx, '12');
    fx.write(d => { d.red = [pin]; });
    const red = land(fx, ['--pr', '12']);
    expect(red.err).toMatch(/required checks are not green at the pin .*\(QUEUE_NOT_READY\)/);
    fx.write(d => { d.red = []; d.prs['12'].isCrossRepository = true; });
    expect(land(fx, ['--pr', '12']).err).toContain('(QUEUE_TRAIN_UNTRUSTED)');
    fx.write(d => { d.prs['12'].isCrossRepository = false; d.prs['12'].state = 'CLOSED'; });
    expect(land(fx, ['--pr', '12']).err).toMatch(/#12 is CLOSED.*\(QUEUE_NOT_READY\)/);
    expect(remote(fx, 'pr-12')).toBe(pin);
    expect(lockRef(fx)).toBe('');
  }, 90_000);

  // Value: protects=--break-lock is refused while another holder's lock is in phase pushing and under 10 minutes old,
  // and allowed once that push lock is stale; fails_when=the PUSH_STALE_MS guard is removed or inverted;
  // why_new=the existing break-lock test only breaks a waiting lock; seam=none; no_claim=a real concurrent lander (lock ref crafted)
  test('--break-lock refuses a fresh mid-push lock and breaks a stale one', () => {
    const fx = setup();
    const pin = openPr(fx, '13');
    const pushLock = (startedAt: string) => {
      const sh = (args: string[], input?: string) => {
        const r = spawnSync('git', args, { cwd: fx.repo.work, input, encoding: 'utf8', timeout: 30_000 });
        expect(r.status, r.stderr).toBe(0);
        return r.stdout.trim();
      };
      const blob = sh(['hash-object', '-w', '--stdin'], JSON.stringify({ pr: '99', holder: 'other:1', started_at: startedAt, phase: 'pushing', journal: '.gstack/tmp/ship-queue/land/99.json' }));
      const tree = sh(['mktree'], '100644 blob ' + blob + '\tlock.json\n');
      const commit = sh(['commit-tree', tree, '-m', 'land lock #99 pushing']);
      sh(['push', '-q', '-f', 'origin', commit + ':refs/notes/gstack-land']);
    };
    pushLock(new Date().toISOString());
    const fresh = land(fx, ['--pr', '13', '--break-lock']);
    expect(fresh.err).toMatch(/#99's holder is mid-push .*--break-lock refused.*\(QUEUE_LAND_LOCKED\)/);
    expect(remote(fx, 'pr-13')).toBe(pin);
    pushLock(new Date(Date.now() - 60 * 60_000).toISOString());
    const stale = land(fx, ['--pr', '13', '--break-lock']);
    expect(stale.err).toBe('');
    expect(stale.out).toContain("LOCK: broke #99's lock (other:1, phase pushing)");
    expect(remote(fx, 'pr-13')).not.toBe(pin);
  }, 90_000);
});

// Generated by /ship Step 7 coverage audit (GSTA-154 PR A, pass 2).
describe('land: failures after the push, repair branches and census rows', () => {
  const journal = (fx: Fx, pr: string) => JSON.parse(fs.readFileSync(path.join(fx.repo.work, '.gstack', 'tmp', 'ship-queue', 'land', pr + '.json'), 'utf8'));
  const pushMain = (fx: Fx, msg: string, edit: (work: string) => void) => {
    fx.repo.git('fetch', '-q', 'origin'); fx.repo.git('checkout', '-q', '--detach', 'origin/main');
    edit(fx.repo.work);
    fx.repo.git('add', '-A'); fx.repo.git('commit', '-q', '-m', msg); fx.repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
  };

  // Value: protects=a red stamp commit stops land with QUEUE_NOT_READY and a refused gh pr merge stops it too, both keeping
  // the journal at phase pushed so a rerun resumes and lands; fails_when=land merges on red, or a failure resets or loses the journal;
  // why_new=the shim never reds a stamp commit or refuses a merge; seam=none; no_claim=GitHub check and merge semantics (gh shim)
  test('a red stamp commit and a refused merge both stop with the journal at pushed, and a rerun lands; a non-numeric --pr is a usage error', () => {
    const fx = setup();
    openPr(fx, '14');
    expect(land(fx, ['--pr', '14']).status).toBe(EXIT.ok);
    const stamp = remote(fx, 'pr-14');
    fx.write(d => { d.red = [stamp]; });
    const red = land(fx, ['--pr', '14']);
    expect(red.err).toMatch(/a check failed on the stamp commit .*\(QUEUE_NOT_READY\)/);
    expect(red.out).toMatch(/^CI: red at /m);
    expect(journal(fx, '14')).toMatchObject({ phase: 'pushed', stamp_commit: stamp });
    fx.write(d => { d.red = []; d.mergeRefuse = true; });
    const refused = land(fx, ['--pr', '14']);
    expect(refused.err).toMatch(/gh pr merge refused: Pull request is not mergeable.*\(QUEUE_NOT_READY\)/);
    expect(journal(fx, '14')).toMatchObject({ phase: 'pushed', stamp_commit: stamp });
    expect(remote(fx, 'pr-14')).toBe(stamp);
    fx.write(d => { d.mergeRefuse = false; });
    const done = land(fx, ['--pr', '14']);
    expect(done.err).toBe('');
    expect(done.out).toContain('MERGED: #14');
    expect(journal(fx, '14').phase).toBe('landed');
    const usage = runBin(fx.repo, 'gstack-ship-queue', ['land', '--pr', 'x14', '--base', 'main'], fx.env);
    expect(usage.status).toBe(EXIT.usage);
    expect(usage.err).toContain('land needs --pr <number> (or --census)');
  }, 90_000);

  // Value: protects=--repair refuses without a drift record and with fragments off, moves fragments the outside merge left
  // on the base to repair-<n>-<name>.md, and a second --repair reports the open PR instead of opening another; fails_when=repair
  // opens duplicate PRs, drops a stray fragment, or runs without a drift record; why_new=the drift test covers only the no-stray path;
  // seam=none; no_claim=gh pr create (gh shim)
  test('--repair: no drift record and fragments off refuse; stray base fragments move; a second run reports the open PR', () => {
    const fx = setup();
    openPr(fx, '15');
    expect(land(fx, ['--pr', '15', '--repair']).err).toMatch(/has no drift record; --repair runs only after QUEUE_LAND_DRIFT.*\(QUEUE_NOT_READY\)/);
    expect(land(fx, ['--pr', '15']).status).toBe(EXIT.ok);
    fx.write(d => { d.driftOnMerge = true; });
    expect(land(fx, ['--pr', '15']).err).toContain('(QUEUE_LAND_DRIFT)');
    pushMain(fx, 'fragments off', w => fs.writeFileSync(path.join(w, '.gstack', 'ship-policy.json'), JSON.stringify({ ...POLICY, changelog_fragments: null }, null, 2) + '\n'));
    expect(land(fx, ['--pr', '15', '--repair']).err).toMatch(/changelog_fragments is off.*\(QUEUE_NOT_READY\)/);
    pushMain(fx, 'fragments on, outside fragment', w => {
      fs.writeFileSync(path.join(w, '.gstack', 'ship-policy.json'), JSON.stringify(POLICY, null, 2) + '\n');
      fs.mkdirSync(path.join(w, 'changelog.d'), { recursive: true });
      fs.writeFileSync(path.join(w, 'changelog.d', 'stray.md'), '- outside stray\n');
    });
    const rep = land(fx, ['--pr', '15', '--repair']);
    expect(rep.err).toBe('');
    expect(rep.out).toContain('moved: changelog.d/stray.md (left unfolded by the outside merge)');
    expect(rep.out).not.toContain('entry: changelog.d/repair-15.md');
    const m = /REPAIR_PR: #(\d+) gstack-land-repair\/15 ([0-9a-f]{40})/.exec(rep.out)!;
    expect(fx.repo.git('ls-tree', '-r', '--name-only', m[2]!, '--', 'changelog.d')).toBe('changelog.d/repair-15-stray.md');
    expect(show(fx, m[2] + ':changelog.d/repair-15-stray.md')).toBe('- outside stray');
    const again = land(fx, ['--pr', '15', '--repair']);
    expect(again.out).toContain('REPAIR_PR: #' + m[1] + ' (already open)');
    expect(Object.keys(JSON.parse(fs.readFileSync(fx.data, 'utf8')).prs)).toEqual(['15', m[1]]);
  }, 90_000);

  // Value: protects=census reports a fork, a product conflict, an invalid fragment and a legacy [Unreleased] PR with a tentative
  // version as distinct rows and writes nothing; fails_when=a row is misclassified (e.g. a product conflict shown as foldable);
  // why_new=the census test covers only fold and no-entry rows; seam=none; no_claim=gh pr list (gh shim)
  test('census rows: fork refused, product conflict refused, invalid fragment, legacy entry with a tentative version', () => {
    const fx = setup();
    openPr(fx, '1');
    fx.write(d => { d.prs['1'].isCrossRepository = true; });
    openPr(fx, '2', { edit: w => fs.writeFileSync(path.join(w, 'shared.txt'), 'two\n') });
    openPr(fx, '3', { fragment: '## [9.9.9.9]\n- bad\n' });
    openPr(fx, '4', { fragment: null, edit: w => {
      fs.writeFileSync(path.join(w, 'VERSION'), '1.2.9.0\n');
      fs.writeFileSync(path.join(w, 'CHANGELOG.md'), fs.readFileSync(path.join(w, 'CHANGELOG.md'), 'utf8').replace('# Changelog\n', '# Changelog\n\n## [Unreleased]\n\n- legacy #4\n'));
    } });
    pushMain(fx, 'main edits shared', w => fs.writeFileSync(path.join(w, 'shared.txt'), 'main\n'));
    const mainBefore = remote(fx, 'main');
    const c = runBin(fx.repo, 'gstack-ship-queue', ['land', '--census', '--base', 'main'], fx.env);
    expect(c.status, c.err).toBe(EXIT.ok);
    expect(c.out).toMatch(/^CENSUS: 4 open PR\(s\) against origin\/main@[0-9a-f]{12} \(fragments: changelog\.d\)$/m);
    expect(c.out).toMatch(/^#1 fork: refused \(QUEUE_TRAIN_UNTRUSTED\)$/m);
    expect(c.out).toMatch(/^#2 [0-9a-f]{12}: refuse \(product conflict: shared\.txt\)$/m);
    expect(c.out).toMatch(/^#3 [0-9a-f]{12}: invalid fragment changelog\.d\/pr-3\.md$/m);
    expect(c.out).toMatch(/^#4 [0-9a-f]{12}: re-head legacy \[Unreleased\]; rewrite its tentative 1\.2\.9\.0 through restamp$/m);
    expect(remote(fx, 'main')).toBe(mainBefore);
    expect(fx.repo.git('ls-remote', 'origin', 'refs/notes/gstack-land')).toBe('');
  }, 90_000);
});

// /ship pre-landing review fixes (GSTA-154 PR A, pass 1): each case below failed or was unreachable before its fix.
describe('land: one pass, base, lock and history', () => {
  // Value: protects=land without --no-wait pushes, waits and merges in one run; fails_when=the pushed phase compares a pre-push head; why_new=every other case passes --no-wait; seam=none; no_claim=GitHub check scheduling latency (gh shim reports green at once)
  test('without --no-wait one run pushes the stamp, sees its checks green and merges', () => {
    const fx = setup();
    openPr(fx, '7');
    const r = runBin(fx.repo, 'gstack-ship-queue', ['land', '--pr', '7', '--base', 'main', '--allow-repo-commands'], fx.env);
    expect(r.err).toBe('');
    expect(r.status).toBe(EXIT.ok);
    expect(r.out).toContain('PUSHED: ');
    expect(r.out).toContain('MERGED: #7');
    expect(r.out).toContain('LOCK: released');
  }, 90_000);

  // Value: protects=land refuses a PR whose base is not the base it stamps; fails_when=a stacked PR gets main merged and squashed into its parent branch; why_new=no case set baseRefName; seam=none; no_claim=gh pr view field names (shim)
  test('a PR that targets another branch refuses before the lock, with nothing pushed', () => {
    const fx = setup();
    const pin = openPr(fx, '8');
    fx.write(d => { d.prs['8'].baseRefName = 'feature'; });
    const r = land(fx, ['--pr', '8']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/#8 targets feature, not main.*\(QUEUE_NOT_READY\)/);
    expect(remote(fx, 'pr-8')).toBe(pin);
    expect(fx.repo.git('ls-remote', 'origin', 'refs/notes/gstack-land')).toBe('');
  }, 90_000);

  // Value: protects=a stamp that fails before any push releases the land lock; fails_when=one conflicting PR blocks every other land until --break-lock; why_new=the conflict case checks only the branch; seam=none; no_claim=none beyond protects
  test('a product conflict releases the lock, so the next PR lands without --break-lock', () => {
    const fx = setup();
    openPr(fx, '4', { edit: w => fs.writeFileSync(path.join(w, 'shared.txt'), 'four\n') });
    openPr(fx, '5', { edit: w => fs.writeFileSync(path.join(w, 'shared.txt'), 'five\n') });
    openPr(fx, '6');
    land(fx, ['--pr', '4']); land(fx, ['--pr', '4']);
    expect(land(fx, ['--pr', '5']).err).toContain('(QUEUE_LAND_CONFLICT)');
    fx.repo.git('fetch', '-q', 'origin', '+refs/notes/gstack-land:refs/notes/gstack-land');
    expect(show(fx, 'refs/notes/gstack-land:lock.json')).toContain('"released": true');
    expect(land(fx, ['--pr', '6']).status).toBe(EXIT.ok);
  }, 90_000);

  // Value: protects=a landed PR's fragment carried in by a stacked branch is refused, not folded twice; fails_when=the child PR's stamp repeats the parent's entry and bump; why_new=no case stacks a PR on an unlanded pin; seam=none; no_claim=exact-text match only (a reworded copy is not caught)
  test('a fragment already released on the base (stacked history) refuses instead of folding twice', () => {
    const fx = setup();
    const pin1 = openPr(fx, '1', { fragment: '- #1 the parent change\n' });
    land(fx, ['--pr', '1']); land(fx, ['--pr', '1']);
    fx.repo.git('checkout', '-q', '-B', 'pr-11', pin1);
    fs.writeFileSync(path.join(fx.repo.work, 'changelog.d', 'pr-11.md'), '- #11 child change\n');
    fx.repo.git('add', '-A'); fx.repo.git('commit', '-q', '-m', 'child');
    fx.repo.git('push', '-q', '-f', 'origin', 'HEAD:refs/heads/pr-11');
    const head = fx.repo.git('rev-parse', 'HEAD');
    fx.write(d => { d.prs['11'] = { state: 'OPEN', headRefName: 'pr-11', isCrossRepository: false, title: 'child', body: shippedBody('11', head) }; });
    markReady(fx, '11', head);
    fx.repo.git('checkout', '-q', '--detach', 'origin/main');
    const r = land(fx, ['--pr', '11']);
    expect(r.status).toBe(EXIT.refused);
    expect(r.err).toMatch(/changelog\.d\/pr-1\.md: its text is already released in CHANGELOG\.md.*\(CHANGELOG_FRAGMENT_INVALID\)/);
    expect(remote(fx, 'pr-11')).toBe(head);
  }, 90_000);

  // Value: protects=a lost local journal resumes from the stamp commit's pin; fails_when=the stamp commit is treated as the pin and the receipt refuses; why_new=resume cases keep the journal; seam=none; no_claim=none beyond protects
  test('with the local journal gone, a head that is land\'s stamp commit resumes from its pin', () => {
    const fx = setup();
    const pin = openPr(fx, '12');
    expect(land(fx, ['--pr', '12']).status).toBe(EXIT.ok);
    fs.rmSync(path.join(fx.repo.work, '.gstack', 'tmp', 'ship-queue', 'land', '12.json'));
    const again = land(fx, ['--pr', '12']);
    expect(again.err).toBe('');
    expect(again.out).toContain(`pin=${pin} (the head `);
    expect(again.out).toContain('PUSHED: ');
    expect(land(fx, ['--pr', '12']).out).toContain('MERGED: #12');
  }, 90_000);

  // Value: protects=history merge-only lands with a merge commit, and a merge after land's own is not drift; fails_when=land squashes under merge-only, or flags a later outside merge as drift; why_new=no case sets history or merges after the squash; seam=none; no_claim=GitHub's merge-commit shape (the shim records the flag)
  test('merge-only lands with --merge; an outside merge after the squash is not drift', () => {
    const fx = setup({ ...POLICY, history: 'merge-only' });
    openPr(fx, '13');
    land(fx, ['--pr', '13']);
    fx.write(d => { d.outsideAfter = true; });
    const r = land(fx, ['--pr', '13']);
    expect(r.err).toBe('');
    expect(r.out).toContain('LANDED: ');
    expect(JSON.parse(fs.readFileSync(fx.data, 'utf8')).mergeArgs).toContain('--merge');
  }, 90_000);
});

// /ship adversarial (Claude) and outside-voice (Codex) findings (GSTA-154 PR A): each case failed or was unreachable before its fix.
describe('land: merged-after-error, live locks, repair recovery, legacy release files', () => {
  // Value: protects=a merge GitHub completed but reported as failed reconciles on rerun; fails_when=the rerun refuses "is MERGED" and the lock stays held; why_new=no case merged with an error; seam=none; no_claim=GitHub's real error shapes
  test('gh pr merge errors after GitHub merged: the rerun verifies the tree and releases the lock', () => {
    const fx = setup();
    openPr(fx, '20');
    land(fx, ['--pr', '20']);
    fx.write(d => { d.mergeErrorAfter = true; });
    expect(land(fx, ['--pr', '20']).err).toContain('HTTP 502');
    const again = land(fx, ['--pr', '20']);
    expect(again.err).toBe('');
    expect(again.out).toContain('LANDED: ');
    expect(again.out).toContain('LOCK: released');
    openPr(fx, '24');
    expect(land(fx, ['--pr', '24']).status).toBe(EXIT.ok);
  }, 90_000);

  // Value: protects=--break-lock never breaks a holder that entered merging moments ago; fails_when=two landers squash the same version; why_new=only the push phase was guarded; seam=none; no_claim=none beyond protects
  test('--break-lock refuses a lock whose holder entered merging moments ago', () => {
    const fx = setup();
    openPr(fx, '21'); openPr(fx, '22');
    land(fx, ['--pr', '21']);
    fx.write(d => { d.mergeRefuse = true; });
    expect(land(fx, ['--pr', '21']).err).toContain('gh pr merge refused');
    expect(land(fx, ['--pr', '22', '--break-lock']).err).toMatch(/#21's holder is mid-merge \(\d+ s ago\); --break-lock refused.*\(QUEUE_LAND_LOCKED\)/);
  }, 90_000);

  // Value: protects=--repair resumes after its branch was pushed but PR creation failed, and the repair PR takes over from the lock alone; fails_when=every retry fails the branch lease, or a clean checkout cannot take over the drift lock; why_new=the drift case keeps the journal and creates the PR first time; seam=none; no_claim=gh's exact "already exists" wording
  test('--repair resumes after a failed PR create; the repair PR takes over the drift lock with no local journal', () => {
    const fx = setup();
    openPr(fx, '23');
    land(fx, ['--pr', '23']);
    fx.write(d => { d.driftOnMerge = true; });
    expect(land(fx, ['--pr', '23']).err).toContain('(QUEUE_LAND_DRIFT)');
    fx.write(d => { d.createFail = true; });
    expect(land(fx, ['--pr', '23', '--repair']).err).toContain('gh pr create failed');
    Bun.sleepSync(1100);
    const rep = land(fx, ['--pr', '23', '--repair']);
    expect(rep.err).toBe('');
    expect(rep.out).toContain('already on origin');
    const n = /REPAIR_PR: #(\d+) gstack-land-repair\/23/.exec(rep.out)!;
    const head = remote(fx, 'gstack-land-repair/23');
    fx.write(d => { d.prs[n[1]!].body = shippedBody(n[1]!, head); });
    markReady(fx, n[1]!, head);
    fs.rmSync(path.join(fx.repo.work, '.gstack', 'tmp', 'ship-queue', 'land', '23.json'));
    expect(land(fx, ['--pr', n[1]!]).out).toContain("LOCK: taking over #23's drift lock for its repair");
    const merged = land(fx, ['--pr', n[1]!]);
    expect(merged.status).toBe(EXIT.ok);
    expect(merged.out).toContain('LOCK: released');
  }, 120_000);

  // Value: protects=land never writes through a PR-controlled symlink while unstamping a legacy pin; fails_when=a VERSION link chain overwrites a file outside the checkout, even in --dry-run; why_new=only the title fragment was guarded; seam=none; no_claim=Windows symlink semantics
  test('a legacy pin whose VERSION is a symlink refuses in --dry-run and writes nothing outside', () => {
    const fx = setup();
    const outside = path.join(fx.repo.root, 'outside.txt');
    fs.writeFileSync(outside, 'keep\n');
    openPr(fx, '25', { edit: w => { fs.rmSync(path.join(w, 'VERSION')); fs.symlinkSync('1.2.9.0', path.join(w, 'VERSION')); fs.symlinkSync(outside, path.join(w, '1.2.9.0')); } });
    const r = land(fx, ['--pr', '25', '--dry-run']);
    expect(r.err).toMatch(/VERSION is a symlink at the pin.*\(QUEUE_LAND_CONFLICT\)/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('keep\n');
  }, 90_000);

  // Value: protects=restamp never folds fragments through a PR-controlled symlinked CHANGELOG; fails_when=the fold rewrites a file outside the checkout, even in --dry-run; why_new=the legacy guard runs only when the pin bumped VERSION; seam=none; no_claim=Windows symlink semantics
  test('a pin whose CHANGELOG is a symlink refuses before restamp and leaves the target untouched', () => {
    const fx = setup();
    const outside = path.join(fx.repo.root, 'outside-changelog.md');
    fs.writeFileSync(outside, '# Changelog\n\n## [1.2.3.0] - 2026-10-01\n\n- base release\n');
    openPr(fx, '27', { edit: w => { fs.rmSync(path.join(w, 'CHANGELOG.md')); fs.symlinkSync(outside, path.join(w, 'CHANGELOG.md')); } });
    const r = land(fx, ['--pr', '27', '--dry-run']);
    expect(r.err).toMatch(/CHANGELOG\.md is a symlink in the merged tree.*\(QUEUE_LAND_CONFLICT\)/);
    expect(fs.readFileSync(outside, 'utf8')).toBe('# Changelog\n\n## [1.2.3.0] - 2026-10-01\n\n- base release\n');
  }, 90_000);

  // Value: protects=a legacy pin in a repo whose version source is package.json keeps its dependency and script edits; fails_when=the whole manifest is reset to the merge base; why_new=every case used a VERSION file; seam=none; no_claim=lockfile shapes beyond package.json
  test('version source package.json: a legacy pin keeps its dependency and script edits', () => {
    const fx = setup();
    fx.repo.git('checkout', '-q', '-B', 'vp', 'origin/main');
    fs.mkdirSync(path.join(fx.repo.work, '.gstack'), { recursive: true });
    fs.writeFileSync(path.join(fx.repo.work, '.gstack', 'version-path'), 'package.json\n');
    const base = JSON.parse(readFile(fx.repo, 'package.json')); base.version = '1.2.3.0';
    fs.writeFileSync(path.join(fx.repo.work, 'package.json'), JSON.stringify(base, null, 2) + '\n');
    fx.repo.git('add', '-A'); fx.repo.git('commit', '-q', '-m', 'version from package.json'); fx.repo.git('push', '-q', 'origin', 'HEAD:refs/heads/main');
    fx.repo.git('fetch', '-q', 'origin');
    openPr(fx, '26', { edit: w => { const p = JSON.parse(fs.readFileSync(path.join(w, 'package.json'), 'utf8')); p.version = '1.2.9.0'; p.dependencies['right-pad'] = '2.0.0'; p.scripts = { ...p.scripts, build: 'node build.js' }; fs.writeFileSync(path.join(w, 'package.json'), JSON.stringify(p, null, 2) + '\n'); } });
    const r = land(fx, ['--pr', '26', '--dry-run']);
    expect(r.err).toBe('');
    expect(r.out).toMatch(/^legacy: the pin stamped 1\.2\.9\.0 itself/m);
    const tree = /^STAMP_TREE: ([0-9a-f]+)/m.exec(r.out)![1]!;
    const pkg = JSON.parse(show(fx, tree + ':package.json'));
    expect(pkg.dependencies['right-pad']).toBe('2.0.0');
    expect(pkg.scripts.build).toBe('node build.js');
    expect(pkg.version).toBe('1.2.4');
  }, 90_000);
});

// GStack Minder ruling (2026-10-29, GSTA-154): standalone land checks the evidence ready enforces.
describe('land: the READY receipt', () => {
  // Value: protects=land refuses a pin ready never accepted (pregate, full_e2e), before any lock or push; fails_when=land merges a head that skipped ready; why_new=every other case marks its PR ready; seam=none; no_claim=what ready itself checks (its own tests)
  test('a pin with a /ship receipt but no READY receipt refuses, naming the ready command; nothing is locked or pushed', () => {
    const fx = setup();
    const pin = openPr(fx, '28', { ready: false });
    for (const args of [['--pr', '28'], ['--pr', '28', '--dry-run']]) {
      const r = land(fx, args);
      expect(r.status).toBe(EXIT.refused);
      expect(r.err).toMatch(/no READY receipt for #28 at the pin [0-9a-f]{12}.*fix: run gstack-ship-queue ready --pr 28 \(QUEUE_NOT_READY\)/);
    }
    expect(remote(fx, 'pr-28')).toBe(pin);
    expect(fx.repo.git('ls-remote', 'origin', 'refs/notes/gstack-land')).toBe('');
    markReady(fx, '28', pin);
    expect(land(fx, ['--pr', '28']).out).toContain('PUSHED: ');
  }, 90_000);
});
