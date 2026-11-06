import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const BIN = path.join(import.meta.dir, '..', 'bin', 'gstack-review-plan');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function repo(files: Record<string, string>): { dir: string; state: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plan-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'review-plan-state-'));
  dirs.push(dir, state);
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n'); git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat');
  for (const [p, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), text); }
  git('add', '.'); git('commit', '-qm', 'feat');
  return { dir, state };
}
const run = (r: { dir: string; state: string }, args: string[]) => spawnSync(BIN, ['--base', 'main', '--gate-tagged', '0', ...args], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });

describe('gstack-review-plan', () => {
  test('a docs-only diff plans no dispatch and says why', () => {
    const r = run(repo({ 'docs/howto.md': '# How to\nStep one.\n' }), []);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('REVIEW_PLAN: class=docs pass=1 next=full dispatches=0 numbers=no');
    expect(r.stdout).toContain('SKIP: outside-voice (docs class, no numeric claims)');
  });
  // Value: protects=a stale local main does not stand in for the base: a docs-only branch that merged a newer origin/main
  //   plans as docs, not as the gate change origin/main already has (GST-462: #3597 was labeled gate code at full depth
  //   until --base origin/main); fails_when=gstack-gate-diff or gstack-diff-scope diff against the local branch;
  //   seam=a tracking ref moved with update-ref, as a fetch would; no_claim=nothing about a local main ahead of origin/main.
  test('a stale local main yields to origin/main: a docs-only branch that merged the newer origin/main plans as docs', () => {
    const r = repo({ 'docs/howto.md': '# How to\nStep one.\n' });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    const testFile = (skip: boolean) => `import { test, expect } from 'bun:test';\ntest${skip ? '.skip' : ''}('adds', () => {\n  expect(1 + 1).toBe(2);\n});\n`;
    git('checkout', '-q', 'main');
    fs.mkdirSync(path.join(r.dir, 'test'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'test', 'add.test.ts'), testFile(false));
    git('add', '.'); git('commit', '-qm', 'tests');
    git('checkout', '-q', 'feat'); git('merge', '-q', '--no-edit', 'main'); git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(r.dir, 'test', 'add.test.ts'), testFile(true));
    git('commit', '-qam', 'upstream skip');
    git('remote', 'add', 'origin', 'https://example.invalid/x.git');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('reset', '-q', '--hard', 'HEAD~1');
    git('checkout', '-q', 'feat'); git('merge', '-q', '--no-edit', 'origin/main');
    const plan = spawnSync(BIN, ['--base', 'main'], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(plan.status).toBe(0);
    expect(plan.stdout).toContain('REVIEW_PLAN: class=docs pass=1 next=full dispatches=0 numbers=no');
  });
  test('a docs diff that publishes numbers keeps the outside voice', () => {
    const r = run(repo({ 'docs/bench.md': 'Median latency fell 42% to 180 ms.\n' }), []);
    expect(r.stdout).toContain('DISPATCH: outside-voice outside-voice effort=host');
  });
  test('--json carries the class, the next step, every dispatch with its effort and the audit effort; --no-tiers renders specialists and audits at host effort', () => {
    const r = repo({ 'src/a.ts': Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n' });
    const plan = JSON.parse(run(r, ['--json', '--depth-floor', 'standard']).stdout);
    expect(plan).toMatchObject({ class: 'code', next: { step: 'full' }, pass: 0 });
    expect(plan.dispatches.filter((d: any) => d.role === 'specialist').map((d: any) => d.effort)).toEqual(expect.arrayContaining(['medium']));
    expect(plan.dispatches.filter((d: any) => d.role === 'specialist').every((d: any) => d.effort === 'medium')).toBe(true);
    expect(plan.dispatches.find((d: any) => d.role === 'adversarial-native').effort).toBe('full');
    expect(plan.audit_effort).toBe('light');
    expect(run(r, ['--depth-floor', 'standard']).stdout).toContain('DISPATCH: specialist batched effort=medium checklists=testing,security,state-machines');
    const host = JSON.parse(run(r, ['--json', '--no-tiers', '--depth-floor', 'standard']).stdout);
    expect(host.audit_effort).toBe('host');
    expect(host.dispatches.filter((d: any) => d.role === 'specialist').every((d: any) => d.effort === 'host')).toBe(true);
    expect(host.dispatches.find((d: any) => d.role === 'adversarial-native').effort).toBe('full');
    expect(run(r, ['--no-tiers', '--depth-floor', 'standard']).stdout).toContain('DISPATCH: specialist batched effort=host checklists=testing,security,state-machines');
  });
  test('a below-floor fix after pass 1 plans one fix-check', () => {
    const r = run(repo({ 'src/a.ts': 'export const a = 1;\n' }), ['--pass', '1', '--last', 'full', '--fixed-below']);
    expect(r.stdout).toContain('next=fix-check dispatches=1');
    expect(r.stdout).toContain('DISPATCH: fix-check fix-check effort=full');
  });
  // Value: protects=the CLI the ship loop calls after a fix-check prints NEXT: done when the fix-check was clean and only below-floor fixes came before it; fails_when=`--last fix-check --fixed-below` prints NEXT: stop with a blocking-finding reason (GSTA-167 replay 8G on #34);
  //   why_new=no CLI case covered --last fix-check; seam=bin/gstack-review-plan (lib/review-depth.ts stays at its no-loss pin); no_claim=the fix-check reviewer's verdict
  test('a clean fix-check after below-floor fixes prints NEXT: done', () => {
    const r = run(repo({ 'src/a.ts': 'export const a = 1;\n' }), ['--pass', '1', '--last', 'fix-check', '--fixed-below']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('NEXT: done');
    expect(r.stdout).not.toContain('NEXT: stop');
    expect(run(repo({ 'src/a.ts': 'export const a = 1;\n' }), ['--pass', '1', '--last', 'fix-check', '--fixed-below', '--blocking-open']).stdout).toContain('NEXT: stop');
  });
  // Value: protects=a grant the owner recorded with gstack-approvals is something the plan can use, once, in the invocation it answers: --grant <id> plans the one scoped fix-check after a round-2 full pass when the row names review_loop_grant and the stop head (at or after --range-base, at or before HEAD); the fix-check never earns another; an unrecorded id, an unrelated approval, a review_loop_exception acceptance row, or a grant for an earlier head is refused; fails_when=the CLI ignores the grant and prints NEXT: stop (C6-36 after-opus-grant), accepts any of those rows, or grants a second fix-check;
  //   why_new=GST-967 (round-2 red team: a grant from an earlier /ship on the branch could be reused); seam=bin/gstack-review-plan; no_claim=who may grant (the owner's words are the approval record's)
  test('GST-967: --grant <id> plans the one scoped fix-check for the stop head it names; any other row, or a grant for an earlier head, is refused', () => {
    const r = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const env: NodeJS.ProcessEnv = { ...process.env, GSTACK_STATE_ROOT: r.state, GSTACK_APPROVALS_MIRROR: '0' };
    delete env.GSTACK_APPROVALS_DIR;
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    const commit = (n: number) => { fs.appendFileSync(path.join(r.dir, 'src/a.ts'), `export const v${n} = ${n};\n`); git('commit', '-qam', `c${n}`); return git('rev-parse', 'HEAD'); };
    const stale = git('rev-parse', 'HEAD');
    const passHead = commit(1);
    const stopHead = commit(2);
    const add = (ask: string) => {
      const a = spawnSync(path.join(path.dirname(BIN), 'gstack-approvals'), ['add', '--ask', ask, '--words', 'do it', '--by', 'GStack Minder', '--scope', 'this /ship invocation', '--json'], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env });
      expect(a.status, a.stderr).toBe(0);
      return JSON.parse(a.stdout).added[0] as string;
    };
    const id = add(`Owner grant: one scoped fix-check after round 2 (review_loop_grant ${stopHead.slice(0, 12)})`);
    const refusedIds = [add(`Owner grant from an earlier run (review_loop_grant ${stale.slice(0, 12)})`), add('Owner grant: one scoped fix-check (review_loop_grant)'),
      add(`Owner accepts the stop after the fix-check (review_loop_exception ${stopHead.slice(0, 12)})`), add('Approve the plan for the README rewrite'), 'a-000000000000'];
    const plan = (a: string[]) => spawnSync(BIN, ['--base', 'main', '--gate-tagged', '0', ...a], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env });
    const capStop = ['--pass', '2', '--last', 'full', '--fixed-blocking', '--range-base', passHead];
    expect(plan(capStop).stdout).toContain('NEXT: stop');
    const granted = plan([...capStop, '--grant', id]);
    expect(granted.status, granted.stderr).toBe(0);
    expect(granted.stdout).toContain(`NEXT: fix-check (the owner's grant ${id}`);
    expect(granted.stdout).toContain('DISPATCH: fix-check fix-check effort=full');
    commit(3);
    expect(plan([...capStop, '--grant', id]).stdout).toContain(`NEXT: fix-check (the owner's grant ${id}`);
    expect(plan(['--pass', '2', '--last', 'fix-check', '--fixed-blocking', '--range-base', passHead, '--grant', id]).stdout).toContain('NEXT: stop');
    for (const other of refusedIds) {
      const refused = plan([...capStop, '--grant', other]);
      expect([other, refused.status, refused.stdout]).toEqual([other, 3, '']);
      expect(refused.stderr).toContain(`--grant ${other}`);
    }
    expect(plan([...capStop.slice(0, -2), '--grant', id]).status).toBe(2);
    expect(plan([...capStop, '--grant', '--json']).status).toBe(2);
  }, 30_000);
  // Value: protects=a granted fix-check chain after the review bound is planned, not hand-rendered: once a fix-check ran and /ship
  //   Step 16 finds later edits, --post-review --last fix-check with a new grant at a stop head after --range-base (the last
  //   fix-check's commit) plans one more fix-check; the last link's grant (naming its own commit, the new range_base) is refused,
  //   no grant or an open blocker stops, and outside --post-review a fix-check still never earns another;
  //   fails_when=the planner prints stop despite the new grant (GST-1676, founderstar#634) or lets the previous link's grant buy
  //   the next link; seam=bin/gstack-review-plan, nextStep; no_claim=finish's chain count (test/ship-finish-ruled-notes.test.ts)
  test('GST-1676: --post-review after a fix-check plans the next chained fix-check for a new grant, never for the last link\'s', () => {
    const r = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const env: NodeJS.ProcessEnv = { ...process.env, GSTACK_STATE_ROOT: r.state, GSTACK_APPROVALS_MIRROR: '0' };
    delete env.GSTACK_APPROVALS_DIR;
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    const commit = (n: number) => { fs.appendFileSync(path.join(r.dir, 'src/a.ts'), `export const v${n} = ${n};\n`); git('commit', '-qam', `c${n}`); return git('rev-parse', 'HEAD'); };
    const add = (stop: string, n: string) => {
      const a = spawnSync(path.join(path.dirname(BIN), 'gstack-approvals'), ['add', '--ask', `Owner grant: scoped fix-check ${n} (review_loop_grant ${stop.slice(0, 12)})`, '--words', 'do it', '--by', 'GStack Minder', '--scope', 'this /ship invocation', '--json'], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env });
      expect(a.status, a.stderr).toBe(0);
      return JSON.parse(a.stdout).added[0] as string;
    };
    commit(1);
    const link1 = commit(2);
    const g1 = add(link1, 'fc1');
    const link2 = commit(3);
    const g2 = add(link2, 'fc2');
    const plan = (a: string[]) => spawnSync(BIN, ['--base', 'main', '--gate-tagged', '0', '--pass', '2', '--last', 'fix-check', '--fix-checks', '2', '--range-base', link1, ...a], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env });
    const chained = plan(['--post-review', '--grant', g2]);
    expect(chained.status, chained.stderr).toBe(0);
    expect(chained.stdout).toContain(`NEXT: fix-check (edits after the review bound (Step 16 stage 2.1) plan as a fix to a gate-class path, never a note: the owner's grant ${g2} adds one scoped fix-check for the edits after the last fix-check, a new link of the fix-check chain`);
    expect(chained.stdout).toContain('DISPATCH: fix-check fix-check effort=full');
    expect(plan(['--post-review']).stdout).toContain('NEXT: stop');
    expect(plan(['--post-review', '--grant', g2, '--blocking-open']).stdout).toContain('NEXT: stop');
    expect(plan(['--fixed-blocking', '--grant', g2]).stdout).toContain('NEXT: stop');
    const reused = plan(['--post-review', '--grant', g1]);
    expect([reused.status, reused.stdout]).toEqual([3, '']);
    expect(reused.stderr).toContain(`--grant ${g1}: no approved row ${g1} naming review_loop_grant and this invocation's stop head (a commit after --range-base ${link1}, the last fix-check's commit`);
  }, 30_000);
  // Value: protects=a Captain's grant for a third fix round past a fix-check is planned, not hand-rendered: GEVA-363 (gstack-evals#254)
  //   ran pass 1 full, fc1 (round 2), fc2 under a grant at fc1's stop, then the owner granted a third round at fc2's stop head (its
  //   commit, the new --range-base); the in-loop Step 9 plans that one fix-check; the previous link's grant, a grant at another
  //   commit, no grant or an open blocker do not; GBRA-336's --post-review --last fix-check --fix-checks 2 --grant invocation plans
  //   with a grant after --range-base (GST-1676); fails_when=the planner prints stop despite the new grant (GEVA-363: the lane
  //   hand-ran fc3 on a fix-range token finish could not count) or lets fc2's grant buy fc3; seam=bin/gstack-review-plan, nextStep;
  //   no_claim=finish's chain count (test/ship-finish-ruled-notes.test.ts)
  test('GST-1681: in the loop, a new grant at the last fix-check\'s stop head plans one more fix-check, never for the previous grant', () => {
    const r = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const env: NodeJS.ProcessEnv = { ...process.env, GSTACK_STATE_ROOT: r.state, GSTACK_APPROVALS_MIRROR: '0' };
    delete env.GSTACK_APPROVALS_DIR;
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    const commit = (n: number) => { fs.appendFileSync(path.join(r.dir, 'src/a.ts'), `export const v${n} = ${n};\n`); git('commit', '-qam', `c${n}`); return git('rev-parse', 'HEAD'); };
    const add = (stop: string, n: string) => {
      const a = spawnSync(path.join(path.dirname(BIN), 'gstack-approvals'), ['add', '--ask', `Owner grant: scoped fix-check ${n} (review_loop_grant ${stop.slice(0, 12)})`, '--words', 'do it', '--by', 'GStack Minder', '--scope', 'this /ship invocation', '--json'], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env });
      expect(a.status, a.stderr).toBe(0);
      return JSON.parse(a.stdout).added[0] as string;
    };
    const fc1 = commit(1);
    const g1 = add(fc1, 'fc2');
    const fc2 = commit(2);
    const g2 = add(fc2, 'fc3');
    const later = commit(3);
    const g3 = add(later, 'at the fix');
    const plan = (a: string[]) => spawnSync(BIN, ['--base', 'main', '--gate-tagged', '0', '--pass', '1', '--last', 'fix-check', '--fix-checks', '2', '--range-base', fc2, ...a], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env });
    const third = plan(['--fixed-blocking', '--grant', g2]);
    expect(third.status, third.stderr).toBe(0);
    expect(third.stdout).toContain(`NEXT: fix-check (the owner's grant ${g2} adds one scoped fix-check at the last fix-check's stop, a new link of the fix-check chain`);
    expect(third.stdout).toContain('DISPATCH: fix-check fix-check effort=full');
    expect(plan(['--fixed-blocking']).stdout).toContain('NEXT: stop');
    expect(plan(['--fixed-blocking', '--grant', g2, '--blocking-open']).stdout).toContain('NEXT: stop');
    expect(plan(['--fixed-blocking', '--grant', g3]).stdout).toContain('NEXT: stop');
    const reused = plan(['--fixed-blocking', '--grant', g1]);
    expect([reused.status, reused.stdout]).toEqual([3, '']);
    expect(reused.stderr).toContain(`--grant ${g1}: no approved row ${g1} naming review_loop_grant and this invocation's stop head (a commit at or after --range-base ${fc2}`);
    const gbra336 = plan(['--post-review', '--grant', g3]);
    expect(gbra336.status, gbra336.stderr).toBe(0);
    expect(gbra336.stdout).toContain(`NEXT: fix-check (edits after the review bound (Step 16 stage 2.1) plan as a fix to a gate-class path, never a note: the owner's grant ${g3} adds one scoped fix-check for the edits after the last fix-check`);
    expect(plan(['--post-review', '--grant', g2]).status).toBe(3);
  }, 30_000);
  // Value: protects=one grant buys one link in the loop too: a grant recorded before a later logged fix-check already bought that
  //   fix-check (a post-review link's grant names the commit its fix-check read; a stale --range-base names an earlier link), so the
  //   in-loop replan refuses it, while a grant recorded after the newest fix-check plans; fails_when=a spent grant plans another
  //   paid fix-check that finish cannot count (the GST-1681 /ship review: red-team#1, specialist#1); seam=bin/gstack-review-plan;
  //   no_claim=finish's chain count (test/ship-finish-ruled-notes.test.ts)
  test('GST-1681: in the loop, a grant recorded before a later logged fix-check is spent and refused', () => {
    const r = repo({ 'src/a.ts': 'export const a = 1;\n' });
    const env: NodeJS.ProcessEnv = { ...process.env, GSTACK_STATE_ROOT: r.state, GSTACK_APPROVALS_MIRROR: '0' };
    delete env.GSTACK_APPROVALS_DIR;
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    const commit = (n: number) => { fs.appendFileSync(path.join(r.dir, 'src/a.ts'), `export const v${n} = ${n};\n`); git('commit', '-qam', `c${n}`); return git('rev-parse', 'HEAD'); };
    const add = (stop: string, n: string) => {
      const a = spawnSync(path.join(path.dirname(BIN), 'gstack-approvals'), ['add', '--ask', `Owner grant: scoped fix-check ${n} (review_loop_grant ${stop.slice(0, 12)})`, '--words', 'do it', '--by', 'GStack Minder', '--scope', 'this /ship invocation', '--json'], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env });
      expect(a.status, a.stderr).toBe(0);
      return JSON.parse(a.stdout).added[0] as string;
    };
    const logFixCheck = () => {
      const l = spawnSync(path.join(path.dirname(BIN), 'gstack-review-log'), [JSON.stringify({ skill: 'review-fix-check', timestamp: new Date().toISOString(), status: 'clean', via: 'ship', completed: true, converged: true })], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env });
      expect(l.status, l.stderr).toBe(0);
    };
    const fc1 = commit(1);
    logFixCheck();
    const g1 = add(fc1, 'fc2');
    commit(2);
    logFixCheck();
    const c = commit(3);
    const gc = add(c, 'post-review link at c');
    logFixCheck();
    commit(4);
    const plan = (rangeBase: string, grant: string) => spawnSync(BIN, ['--base', 'main', '--gate-tagged', '0', '--pass', '1', '--last', 'fix-check', '--fix-checks', '3', '--fixed-blocking', '--range-base', rangeBase, '--grant', grant], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env });
    for (const [rangeBase, grant] of [[c, gc], [fc1, g1]] as const) {
      const spent = plan(rangeBase, grant);
      expect([spent.status, spent.stdout]).toEqual([3, '']);
      expect(spent.stderr).toContain(`--grant ${grant}: a fix-check was logged after this grant was recorded, so the grant already bought a link of the fix-check chain`);
    }
    const fresh = add(c, 'fc5');
    const next = plan(c, fresh);
    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout).toContain(`NEXT: fix-check (the owner's grant ${fresh} adds one scoped fix-check at the last fix-check's stop`);
  }, 30_000);
  test('--fix-check-prompt renders the fix-check reviewer prompt from the parent\'s files and refuses a missing one', () => {
    const r = repo({ 'docs/howto.md': '# x\n' });
    const w = (n: string, t: string) => { const f = path.join(r.state, n); fs.writeFileSync(f, t); return f; };
    const files = ['--fix-list', w('fix.txt', 'lib/a.ts:3 guard now refuses unknown'), '--hunks', w('hunks.diff', '+if (s !== "MERGED") return false;'), '--tests', w('tests.txt', '12 pass 0 fail')];
    const ok = spawnSync(BIN, ['--fix-check-prompt', ...files], { cwd: r.dir, encoding: 'utf8', timeout: 60_000 });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('You are the fix-check reviewer');
    expect(ok.stdout).toContain('lib/a.ts:3 guard now refuses unknown');
    expect(ok.stdout).toContain('(none found)');
    const missing = spawnSync(BIN, ['--fix-check-prompt', '--fix-list', path.join(r.state, 'nope.txt'), '--hunks', files[3]!, '--tests', files[5]!], { cwd: r.dir, encoding: 'utf8', timeout: 60_000 });
    expect(missing.status).toBe(2);
  });
  test('untracked files count, a version-only package.json bump stays docs, and review_effort_tiers off renders audits at host effort', () => {
    const r = repo({ 'docs/a.md': '# a\n' });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(r.dir, 'package.json'), '{\n  "name": "x",\n  "version": "1.0.0"\n}\n');
    git('add', '.'); git('commit', '-qm', 'package');
    git('checkout', '-q', 'feat'); git('reset', '-q', '--hard', 'main');
    fs.writeFileSync(path.join(r.dir, 'package.json'), '{\n  "name": "x",\n  "version": "1.0.1"\n}\n');
    git('commit', '-qam', 'stamp');
    const stamp = JSON.parse(run(r, ['--json']).stdout);
    expect(stamp.stamp_only).toContain('package.json');
    expect(stamp.class).toBe('docs');
    fs.mkdirSync(path.join(r.dir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'lib', 'new.ts'), 'export const a = 1;\n');
    const withUntracked = JSON.parse(run(r, ['--json']).stdout);
    expect(withUntracked.paths).toContain('lib/new.ts');
    expect(withUntracked.class).toBe('code');
    const cfg = spawnSync(path.join(import.meta.dir, '..', 'bin', 'gstack-config'), ['set', 'review_effort_tiers', 'off'], { cwd: r.dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(cfg.status).toBe(0);
    expect(JSON.parse(run(r, ['--json']).stdout).audit_effort).toBe('host');
    const bad = spawnSync(path.join(import.meta.dir, '..', 'bin', 'gstack-config'), ['set', 'review_effort_tiers', 'maybe'], { cwd: r.dir, encoding: 'utf8', timeout: 30_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain("review_effort_tiers 'maybe' not recognized");
  });
  test('without --gate-tagged the plan runs the gate scan itself', () => {
    const r = repo({ 'lib/a.ts': 'export const a = 1;\n' });
    const res = spawnSync(BIN, ['--base', 'main', '--json'], { cwd: r.dir, encoding: 'utf8', timeout: 120_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(res.status, res.stderr).toBe(0);
    expect(typeof JSON.parse(res.stdout).gate_tagged).toBe('number');
  });
  test('usage errors exit 2', () => {
    expect(spawnSync(BIN, [], { encoding: 'utf8', timeout: 10_000 }).status).toBe(2);
    expect(run(repo({ 'a.md': 'x' }), ['--last', 'later']).status).toBe(2);
  });
  test('scratch under .gstack/tmp/ is ignored, a subdirectory run plans the whole repository, and --adversarial-ran drops the repeat adversarial pass', () => {
    const r = repo({ 'docs/a.md': '# a\n' });
    fs.mkdirSync(path.join(r.dir, '.gstack', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, '.gstack', 'tmp', 'fix-check-list.ts'), 'export const x = 1;\n');
    const plan = JSON.parse(run(r, ['--json']).stdout);
    expect(plan.class).toBe('docs');
    expect(plan.paths).toEqual(['docs/a.md']);
    const sub = spawnSync(BIN, ['--base', 'main', '--gate-tagged', '0', '--json'], { cwd: path.join(r.dir, 'docs'), encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(JSON.parse(sub.stdout).paths).toEqual(['docs/a.md']);
    const code = repo({ 'src/a.ts': Array.from({ length: 80 }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n' });
    const repeat = ['--pass', '1', '--last', 'full', '--fixed-blocking'];
    expect(run(code, repeat).stdout).toContain('DISPATCH: adversarial-native adversarial effort=full');
    const ran = run(code, [...repeat, '--adversarial-ran']).stdout;
    expect(ran).not.toContain('DISPATCH: adversarial-native');
    expect(ran).toContain('SKIP: adversarial-native and outside-voice (run once per invocation)');
  });
});

describe('gstack-review-plan: review depth', () => {
  const code = (n: number) => Array.from({ length: n }, (_, i) => `export const v${i} = ${i};`).join('\n') + '\n';
  test('prints REVIEW_DEPTH with runtime lines and the rules hash, and GATE_SCAN bound to the head', () => {
    const r = repo({ 'src/a.ts': code(10), 'test/a.test.ts': code(200) });
    const out = run(r, []).stdout;
    const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: r.dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
    expect(out).toMatch(/^REVIEW_DEPTH: light runtime_lines=10 rules=[0-9a-f]{16} reasons=runtime=10 codes=none$/m);
    expect(out).toContain(`GATE_SCAN: tagged=0 head=${head}`);
    expect(out).toContain('DISPATCH: specialist batched effort=full checklists=testing,security,state-machines,red-team');
    expect(out).toContain('DISPATCH: adversarial-native adversarial effort=full reason=backtest inconclusive (GSTA-147 D5)');
  });
  test('DIFF_CMD is shell-quoted per dispatch and excludes what the reviewer does not read; DIFF_EXCLUDE: none when empty', () => {
    const r = repo({ 'src/a.ts': code(80), 'docs/my notes*.md': '# n\n', 'test/a.test.ts': code(3) });
    const out = run(r, []).stdout;
    expect(out).toContain("DIFF_CMD: batched git diff <diff-base> -- . ':(exclude,literal)docs/my notes*.md'\n");
    expect(out).toContain('SKIP: maintainability, performance, simplification (lean ensemble: read only when forced)');
    expect(out).toContain('DIFF_CMD: adversarial git diff <diff-base>\nDIFF_EXCLUDE: adversarial none');
    const cmd = /^DIFF_CMD: batched (.*)$/m.exec(out)![1]!.replace('<diff-base>', 'main');
    const diff = spawnSync('bash', ['-c', cmd.replace('git diff main', 'git diff --name-only main')], { cwd: r.dir, encoding: 'utf8' });
    expect(diff.stdout.trim().split('\n')).toEqual(['src/a.ts', 'test/a.test.ts']);
  });
  test('--json carries depth, runtime_lines, rules, errors, gate_scan and every dispatch\'s exclude array', () => {
    const r = repo({ 'src/a.ts': code(80), 'README.md': '# y\n' });
    const plan = JSON.parse(run(r, ['--json', '--depth-floor', 'standard']).stdout);
    expect(plan).toMatchObject({ depth: 'standard', step_depth: 'standard', runtime_lines: 80, errors: [], codes: [], gate_scan: { tagged: 0 } });
    expect(plan.rules).toMatch(/^[0-9a-f]{16}$/);
    expect(plan.dispatches.find((d: any) => d.name === 'batched').exclude).toEqual([':(exclude)README.md']);
    expect(plan.dispatches.find((d: any) => d.role === 'outside-voice').exclude).toEqual([]);
  });
  test('--depth-floor full raises a light diff, never lowers a full one, and an invalid floor is a usage error', () => {
    const r = repo({ 'src/a.ts': code(5) });
    expect(run(r, ['--depth-floor', 'full']).stdout).toMatch(/^REVIEW_DEPTH: full runtime_lines=5 .*reasons=runtime=5,floor:full /m);
    const gate = repo({ 'src/a.ts': code(5), '.github/workflows/ci.yml': 'on: push\n' });
    expect(run(gate, ['--depth-floor', 'standard']).stdout).toMatch(/^REVIEW_DEPTH: full /m);
    expect(run(r, ['--depth-floor', 'light']).status).toBe(2);
  });
  test('a conservative full plan exits 0 with its errors; a plan that cannot be built exits 1', () => {
    const r = repo({ 'lib/x.wasm': '\u0000asm\u0000' });
    const res = run(r, ['--json']);
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({ depth: 'full', errors: expect.arrayContaining([expect.objectContaining({ code: 'binary_code_path', input: 'lib/x.wasm' })]) });
    expect(run(r, []).stdout).toContain('DEPTH_ERROR: binary_code_path input=lib/x.wasm');
    const none = spawnSync(BIN, ['--base', 'no-such-branch', '--gate-tagged', '0'], { cwd: r.dir, encoding: 'utf8', timeout: 60_000, env: { ...process.env, GSTACK_STATE_ROOT: r.state } });
    expect(none.status).toBe(1);
  });
});

describe('gstack-review-plan: the scoped second pass (GSTA-152 D6)', () => {
  const code = (n: number, tag = 'v') => Array.from({ length: n }, (_, i) => `export const ${tag}${i} = ${i};`).join('\n') + '\n';
  function fixed(lines: number): { r: { dir: string; state: string }; rangeBase: string } {
    const r = repo({ 'src/a.ts': code(80) });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    const rangeBase = git('rev-parse', 'HEAD').stdout.trim();
    fs.writeFileSync(path.join(r.dir, 'src', 'fix.ts'), code(lines, 'f'));
    git('add', '.'); git('commit', '-qm', 'fix: pre-landing review fixes');
    return { r, rangeBase };
  }
  const pass2 = ['--pass', '1', '--last', 'full', '--fixed-blocking', '--adversarial-ran', '--pass1-depth', 'standard'];
  const full1 = ['--pass', '1', '--last', 'full', '--fixed-blocking', '--adversarial-ran', '--pass1-depth', 'full'];
  test('--range-base with a small fix range plans NEXT: scoped with a fix-check and the Red Team, and counts it as pass 2', () => {
    const { r, rangeBase } = fixed(24);
    const out = run(r, [...pass2, '--range-base', rangeBase]).stdout;
    expect(out).toMatch(/^REVIEW_PLAN: class=code pass=2 next=scoped dispatches=3 /m);
    expect(out).toContain(`FIX_RANGE: runtime_lines=24 base=${rangeBase}`);
    expect(out).toMatch(/^NEXT: scoped \(a blocking finding was fixed on a light diff with 24 runtime lines in the fix range/m);
    expect(out).toContain('DISPATCH: fix-check fix-check effort=full');
    expect(out).toContain('DISPATCH: red-team red-team effort=full');
    expect(out).toContain('DISPATCH: adversarial-native adversarial effort=full');
    expect(out).not.toContain('DISPATCH: specialist');
    expect(JSON.parse(run(r, [...pass2, '--range-base', rangeBase, '--json']).stdout)).toMatchObject({ next: { step: 'scoped' }, fix_range: { base: rangeBase, runtime_lines: 24 } });
  });
  test('a 151-line range, no --range-base, an unknown range base and uncommitted fixes keep the full pass 2', () => {
    const big = fixed(151);
    expect(run(big.r, [...pass2, '--range-base', big.rangeBase]).stdout).toMatch(/^NEXT: full \(a blocking finding was fixed and the fix range has 151 runtime lines \(> 150\)/m);
    const { r, rangeBase } = fixed(10);
    expect(run(r, [...pass2.slice(0, -2), '--range-base', rangeBase]).stdout).toMatch(/^NEXT: full \(a blocking finding was fixed and pass 1 ran at full depth/m);
    expect(run(r, pass2).stdout).toMatch(/^NEXT: full \(a blocking finding was fixed and the fix range was not read/m);
    const unknown = run(r, [...pass2, '--range-base', 'f'.repeat(40)]).stdout;
    expect(unknown).toMatch(/^FIX_RANGE: unread \(.*\) base=f{40}$/m);
    expect(unknown).toMatch(/^NEXT: full /m);
    fs.writeFileSync(path.join(r.dir, 'src', 'fix.ts'), code(12, 'g'));
    const dirty = run(r, [...pass2, '--range-base', rangeBase]).stdout;
    expect(dirty).toMatch(/^FIX_RANGE: unread \(uncommitted or untracked edits.*\)/m);
    expect(dirty).toMatch(/^NEXT: full /m);
    expect(run(r, [...pass2, '--range-base']).status).toBe(2);
  }, 30_000);
  test('a fix range that touches a gate path keeps the full pass 2 without --touched-gate, and an empty range is unread', () => {
    const r = repo({ 'src/a.ts': code(80), '.github/workflows/ci.yml': 'on: push\n' });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    const rangeBase = git('rev-parse', 'HEAD').stdout.trim();
    expect(run(r, [...pass2, '--range-base', rangeBase]).stdout).toMatch(/^FIX_RANGE: unread \(the fix range is empty: .*\) base=/m);
    git('rm', '-q', '.github/workflows/ci.yml');
    fs.writeFileSync(path.join(r.dir, 'src', 'b.ts'), code(2, 'b'));
    git('add', '.'); git('commit', '-qm', 'fix: revert the workflow edit');
    const out = run(r, [...pass2, '--range-base', rangeBase]).stdout;
    expect(out).toMatch(/^REVIEW_DEPTH: light .* step=standard$/m);
    expect(out).toMatch(/^NEXT: full \(a blocking finding was fixed and a fix touched a gate-class path/m);
    expect(JSON.parse(run(r, [...pass2, '--range-base', rangeBase, '--json']).stdout)).toMatchObject({ next: { step: 'full' }, fix_range: { touched_gate: true } });
  }, 30_000);
  test.each([
    ['an auth revert', 'src/auth/login.ts', 'export const login = (u: string) => u.length > 0;\n'],
    ['a migration revert', 'db/migrate/001_a.sql', 'ALTER TABLE users ADD COLUMN email text;\n'],
  ])('%s on a full-depth PR plans the full pass 2', (_n, file, text) => {
    const r = repo({ 'src/a.ts': code(80) });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    const write = (body: string) => { fs.mkdirSync(path.dirname(path.join(r.dir, file)), { recursive: true }); fs.writeFileSync(path.join(r.dir, file), body); };
    git('checkout', '-q', 'main'); write(text); git('add', '.'); git('commit', '-qm', 'base file');
    git('checkout', '-q', 'feat'); git('merge', '-q', '--no-edit', 'main');
    write(text + '-- edited\n'); git('add', '.'); git('commit', '-qm', 'feat edit');
    const rangeBase = git('rev-parse', 'HEAD').stdout.trim();
    write(text);
    fs.writeFileSync(path.join(r.dir, 'src', 'b.ts'), code(2, 'b'));
    git('add', '.'); git('commit', '-qm', 'fix: revert the edit');
    const out = run(r, [...full1, '--range-base', rangeBase]).stdout;
    expect(out).not.toMatch(/^REVIEW_CLASS: gate/m);
    expect(out).toMatch(/^NEXT: full /m);
  }, 30_000);
  test('a fix that un-skips a gate tag added in an earlier pass-1 commit plans the full pass 2 on a full-depth PR', () => {
    const r = repo({ 'src/a.ts': code(80), 'test/a.test.ts': "test.skip('x', () => {});\n" });
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    fs.writeFileSync(path.join(r.dir, 'src', 'c.ts'), code(3, 'c')); git('add', '.'); git('commit', '-qm', 'later pass-1 commit');
    const rangeBase = git('rev-parse', 'HEAD').stdout.trim();
    fs.writeFileSync(path.join(r.dir, 'test', 'a.test.ts'), "test('x', () => {});\n");
    fs.writeFileSync(path.join(r.dir, 'src', 'y.ts'), code(1, 'y'));
    git('add', '.'); git('commit', '-qm', 'fix: un-skip');
    expect(run(r, [...full1, '--range-base', rangeBase]).stdout).toMatch(/^NEXT: full \(a blocking finding was fixed and pass 1 ran at full depth/m);
  }, 30_000);
  test('--depth-floor full opts out of the scoped pass', () => {
    const { r, rangeBase } = fixed(10);
    expect(run(r, [...pass2, '--range-base', rangeBase, '--depth-floor', 'full']).stdout).toMatch(/^NEXT: full \(a blocking finding was fixed and the diff is at full depth/m);
  });
});
