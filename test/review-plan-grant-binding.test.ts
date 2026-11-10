import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const BIN = path.join(import.meta.dir, '..', 'bin', 'gstack-review-plan');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

/**
 * gbrain #8839 (GST-2244) as a synthetic run with the same record trees: pass 1 read PASS_HEAD (0bb11a5c), a guard-only commit
 * (2dcac734, the tree Step 11's native record holds) landed while it ran, the finding-2 fix came after (d17f3c15, the tree the
 * granted fix-check read), and the owner's grant names the guard commit as its stop head.
 */
function run8839() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-grant-'));
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'review-grant-state-'));
  dirs.push(dir, state);
  const env: NodeJS.ProcessEnv = { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_APPROVALS_MIRROR: '0' };
  delete env.GSTACK_APPROVALS_DIR;
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n'); git('add', '.'); git('commit', '-qm', 'base');
  const stale = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'feat');
  const commit = (line: string) => { fs.mkdirSync(path.join(dir, 'src'), { recursive: true }); fs.appendFileSync(path.join(dir, 'src/lock.ts'), `${line}\n`); git('add', '.'); git('commit', '-qm', line); return git('rev-parse', 'HEAD'); };
  const passHead = commit('export const lock = 1;');
  const guard = commit('export const guard = 2;');
  const fix = commit('export const reclaim = 3;');
  const add = (ask: string, scope = 'this /ship invocation', outcome = 'approved') => {
    const a = spawnSync(path.join(path.dirname(BIN), 'gstack-approvals'), ['add', '--ask', ask, '--words', 'B-scoped', '--by', 'GBRA-108', '--scope', scope, '--outcome', outcome, '--json'], { cwd: dir, encoding: 'utf8', timeout: 60_000, env });
    expect(a.status, a.stderr).toBe(0);
    return JSON.parse(a.stdout).added[0] as string;
  };
  const logFixCheck = () => {
    const l = spawnSync(path.join(path.dirname(BIN), 'gstack-review-log'), [JSON.stringify({ skill: 'review-fix-check', timestamp: new Date(Date.now() + 1000).toISOString(), status: 'clean', via: 'ship', completed: true, converged: true })], { cwd: dir, encoding: 'utf8', timeout: 60_000, env });
    expect(l.status, l.stderr).toBe(0);
  };
  const plan = (a: string[], tagged = '0') => spawnSync(BIN, ['--base', 'main', '--gate-tagged', tagged, ...a], { cwd: dir, encoding: 'utf8', timeout: 60_000, env });
  return { stale, passHead, guard, fix, add, logFixCheck, plan };
}

describe('gstack-review-plan --grant after round 1 (GST-2244)', () => {
  // Value: protects=the owner's scoped grant after round 1 (gbrain #8839: "one scoped fix-check ... no rerun of Steps 9 to 11.5",
  //   approval a-472814d4dee7) plans that fix-check in place of round 2's full pass; fails_when=the planner prints NEXT: full with
  //   the grant bound (GBRA-399 hand-ran the reviewer and 11.5 refused) or lets the same grant buy a second fix-check after it;
  //   seam=bin/gstack-review-plan, nextStep; no_claim=who may grant (the approval record's words)
  test('gbrain #8839: a grant naming the guard commit replaces round 2 with one scoped fix-check, once', () => {
    const r = run8839();
    const g = r.add(`review_loop_grant: one scoped fix-check for PR #8839 at stop head ${r.guard} (range ${r.passHead.slice(0, 8)}..${r.fix.slice(0, 8)})`,
      `review_loop_grant at stop head ${r.guard}: one scoped fix-check over ${r.guard.slice(0, 8)} and ${r.fix.slice(0, 8)}; no rerun of Steps 9 to 11.5`);
    const round1 = ['--pass', '1', '--last', 'full', '--fixed-blocking', '--adversarial-ran', '--range-base', r.passHead];
    expect(r.plan(round1).stdout).toContain('NEXT: full (a blocking finding was fixed and pass 1 ran at full depth: full pass on the range)');
    const granted = r.plan([...round1, '--grant', g]);
    expect(granted.status, granted.stderr).toBe(0);
    expect(granted.stdout).toContain(`NEXT: fix-check (the owner's grant ${g} replaces round 2's full pass with one scoped fix-check on the fix range`);
    expect(granted.stdout).toContain('DISPATCH: fix-check fix-check effort=full');
    expect(granted.stdout).not.toContain('DISPATCH: red-team');
    expect(r.plan([...round1, '--grant', g, '--blocking-open']).stdout).toContain('NEXT: stop');
    const gate = r.plan([...round1.filter(a => a !== '--adversarial-ran'), '--grant', g], '1');
    expect(gate.stdout).toContain(`NEXT: fix-check (the owner's grant ${g}`);
    r.logFixCheck();
    const respent = r.plan([...round1, '--grant', g]);
    expect(respent.status, respent.stderr).toBe(0);
    expect(respent.stdout).toContain('NEXT: full (a blocking finding was fixed and pass 1 ran at full depth: full pass on the range)');
    expect(respent.stderr).toContain(`--grant ${g}: a fix-check was logged after this grant was recorded, so it already bought that fix-check and buys no other`);
    const after = ['--pass', '1', '--last', 'fix-check', '--fix-checks', '1', '--range-base', r.passHead, '--grant', g];
    const clean = r.plan(after);
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stdout).toContain('NEXT: done');
    const stopped = r.plan([...after, '--fixed-blocking']);
    expect(stopped.status, stopped.stderr).toBe(0);
    expect(stopped.stdout).toContain('NEXT: stop');
    expect(stopped.stderr).toContain(`--grant ${g}: a fix-check was logged after this grant was recorded, so it already bought that fix-check and buys no other (a stop now needs a new grant)`);
  }, 30_000);

  // Value: protects=a hand-written grant row binds in the forms owners write (a short or full sha, `review_loop_grant <sha> on #<n>`
  //   in the scope) or is refused naming the one field to fix: the Captain's a-b7f47c6bef36 named review_loop_exception, and a
  //   wrong head now names the stop head the tool expected; fails_when=a valid row is refused, or a refusal lumps every cause into
  //   one sentence (#4243: lanes had to ask for the exact head string); seam=lib/review-grant.ts through the CLI
  test('a hand-written grant row binds by short or full sha, or the refusal names the field to fix', () => {
    const r = run8839();
    const round1 = ['--pass', '1', '--last', 'full', '--fixed-blocking', '--adversarial-ran', '--range-base', r.passHead];
    for (const sha of [r.fix.slice(0, 7), r.fix]) {
      const g = r.add(`Captain grant on #8839 at ${sha}`, `review_loop_grant ${sha} on #8839`);
      const ok = r.plan([...round1, '--grant', g]);
      expect([sha, ok.status, ok.stderr]).toEqual([sha, 0, '']);
      expect(ok.stdout).toContain(`NEXT: fix-check (the owner's grant ${g}`);
    }
    const refused = (g: string) => { const p = r.plan([...round1, '--grant', g]); expect([p.status, p.stdout]).toEqual([3, '']); return p.stderr; };
    expect(refused(r.add('Round-2 cap on #8839: exception', `review_loop_exception ${r.fix.slice(0, 7)} on #8839`)))
      .toContain('names review_loop_exception, the receipt\'s field, not review_loop_grant: record a new row whose ask or scope reads review_loop_grant <stop head sha> on #<n>');
    expect(refused(r.add('Captain grant on #8839: stale head', `review_loop_grant ${r.stale.slice(0, 12)} on #8839`)))
      .toContain(`names ${r.stale.slice(0, 12)}, which is not the stop head: expected ${r.fix} (HEAD), or any commit at or after --range-base ${r.passHead.slice(0, 12)} and at or before HEAD`);
    expect(refused(r.add('Captain grant on #8839: unknown sha', 'review_loop_grant 0123456789abcdef on #8839'))).toContain('names 0123456789abcdef, which is not a commit in this clone');
    expect(refused(r.add('Captain grant on #8839: no sha', 'review_loop_grant on #8839'))).toContain(`names no commit sha: name the stop head, review_loop_grant ${r.fix.slice(0, 12)} on #<n>`);
    expect(refused(r.add(`one scoped fix-check at ${r.fix.slice(0, 7)}`))).toContain(`names no review_loop_grant: record a new row whose ask or scope reads review_loop_grant ${r.fix.slice(0, 12)} on #<n>`);
    const ok = r.add('Captain grant on #8839', `review_loop_grant ${r.fix.slice(0, 7)} on #8839`);
    const badBase = r.plan(['--pass', '1', '--last', 'full', '--fixed-blocking', '--range-base', 'deadbeefdeadbeef', '--grant', ok]);
    expect([badBase.status, badBase.stdout]).toEqual([3, '']);
    expect(badBase.stderr).toContain('--range-base deadbeefdeadbeef is not a commit in this clone, so no stop head can be checked against it');
    expect(refused('a-000000000000')).toContain('no row a-000000000000 in the approval record for branch feat (');
    expect(refused(r.add('Captain grant on #8839: rejected', `review_loop_grant ${r.fix.slice(0, 7)} on #8839`, 'rejected'))).toContain('has outcome rejected, not approved');
  }, 30_000);

  test('Step 11.5 binds a fix-check the plan dispatched under the owner\'s grant at its own tree', () => {
    const tmpl = fs.readFileSync(path.join(import.meta.dir, '..', 'ship', 'SKILL.md.tmpl'), 'utf8');
    const step = tmpl.slice(tmpl.indexOf('## Step 11.5'), tmpl.indexOf('## Step 12'));
    expect(step.replace(/\s+/g, ' ')).toContain('A granted fix-check binds at its own tree (3.5)');
    expect(step).toContain('Review records missing or mismatched');
  });
});
