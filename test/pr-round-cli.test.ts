/**
 * GST-2673 CLI seams: gstack-review-plan --prior-rounds / --round-grant, gstack-approvals round-grant, and
 * gstack-ship-receipt history / stub over a PR body file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ShipReceipt } from '../lib/headless-artifacts';
import { placeRunEntry, prReviewHistory, reviewRoute, runStub } from '../lib/pr-review-history';
import { placeReceipt } from '../lib/ship-receipt';

const BIN = (n: string) => path.join(import.meta.dir, '..', 'bin', n);
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };

function repo() {
  const dir = tmp('pr-rounds-'), state = tmp('pr-rounds-state-');
  const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  git('init', '-q', '-b', 'main'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), '# x\n'); git('add', '.'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat');
  fs.mkdirSync(path.join(dir, 'src')); fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n'); git('add', '.'); git('commit', '-qm', 'feat');
  const env = { ...process.env, GSTACK_STATE_ROOT: state, GSTACK_APPROVALS_MIRROR: '0', GSTACK_CAPY: '' };
  const run = (bin: string, args: string[]) => spawnSync(BIN(bin), args, { cwd: dir, encoding: 'utf8', timeout: 60_000, env });
  return { dir, head: git('rev-parse', 'HEAD').stdout.trim(), run };
}

describe('gstack-review-plan with the PR round count', () => {
  test('two prior full rounds plan one read-only full review of HEAD; a grant at HEAD plans a round with its fix round', () => {
    const r = repo();
    const ro = r.run('gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--prior-rounds', '2', '--prior-full', '2', '--pr', '5']);
    expect(ro.status).toBe(0);
    expect(ro.stdout).toMatch(/REVIEW_PLAN: class=\S+ pass=1 pr_rounds=2 next=full /);
    expect(ro.stdout).toContain('read-only final review (R51)');
    expect(ro.stdout).not.toContain('for the owner');
    const granted = r.run('gstack-approvals', ['round-grant', '--pr', '5', '--head', r.head, '--kind', 'extra-round', '--reason', 'the design changed after round 2', '--by', 'captain:test']);
    expect(granted.status).toBe(0);
    const id = /APPROVAL_RECORDED: (a-[0-9a-f]{12})/.exec(granted.stdout)?.[1];
    expect(id).toBeDefined();
    const full = r.run('gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--prior-rounds', '2', '--prior-full', '2', '--pr', '5', '--round-grant', id!]);
    expect(full.stdout).toContain('next=full');
    expect(full.stdout).toContain('round 3 of 3');
    expect(r.run('gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--prior-rounds', '2', '--prior-full', '2', '--pr', '6', '--round-grant', id!]).status).toBe(3);
    expect(r.run('gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--prior-full', 'x']).status).toBe(2);
  });

  test('a grant still plans after the fix round commits on top of its head, and never for a head off the branch', () => {
    const r = repo();
    const id = /APPROVAL_RECORDED: (a-[0-9a-f]{12})/.exec(r.run('gstack-approvals', ['round-grant', '--pr', '5', '--head', r.head, '--kind', 'extra-round', '--reason', 'the design changed after round 2', '--by', 'captain:test']).stdout)?.[1];
    expect(id).toBeDefined();
    const git = (...a: string[]) => spawnSync('git', a, { cwd: r.dir, encoding: 'utf8', timeout: 10_000 });
    fs.writeFileSync(path.join(r.dir, 'src', 'a.ts'), 'export const a = 2;\n'); git('commit', '-qam', 'fix');
    const decide = r.run('gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--prior-rounds', '2', '--prior-full', '2', '--pr', '5', '--round-grant', id!, '--pass', '2', '--last', 'full', '--fixed-below', '--range-base', r.head]);
    expect(decide.status).toBe(0);
    git('checkout', '-q', 'main'); git('checkout', '-qb', 'other'); fs.writeFileSync(path.join(r.dir, 'b.ts'), 'export const b = 1;\n'); git('add', '.'); git('commit', '-qm', 'other');
    expect(r.run('gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--prior-rounds', '2', '--prior-full', '2', '--pr', '5', '--round-grant', id!]).status).toBe(3);
  });
});

describe('gstack-approvals round-grant', () => {
  test('gstack cannot grant itself a round, and add refuses the scope', () => {
    const r = repo();
    expect(r.run('gstack-approvals', ['round-grant', '--pr', '5', '--head', r.head, '--kind', 'extra-round', '--reason', 'x', '--by', 'gstack']).status).toBe(2);
    expect(r.run('gstack-approvals', ['round-grant', '--pr', '5', '--head', r.head, '--kind', 'more', '--reason', 'x', '--by', 'lane']).status).toBe(2);
    expect(r.run('gstack-approvals', ['add', '--ask', 'a', '--words', 'w', '--by', 'b', '--scope', `review_round_grant ${r.head} pr=5 kind=extra-round`]).status).toBe(2);
  });
});

describe('gstack-ship-receipt history and stub', () => {
  test('history prints the rounds, the flags Step 9 passes and the route; a stub counts until the run writes its receipt', () => {
    const r = repo();
    const loop = { passes: 1, blocking_found: 0, deferred: 0, rounds: 1 };
    const body = path.join(r.dir, 'body.md');
    fs.writeFileSync(body, '## Summary\nprose\n\n```gstack-ship-receipt\n' + JSON.stringify({ schema_version: 1, head: 'a'.repeat(40), run: 'r1', review_loop: loop }) + '\n```\n');
    const h = r.run('gstack-ship-receipt', ['history', '--body', body, '--pr', '5']);
    expect(h.status).toBe(0);
    expect(h.stdout).toMatch(/^PR_REVIEW_HISTORY: pr=#5 rounds=1 cap=2 full=1 /m);
    expect(h.stdout).toContain('PR_REVIEW_FLAGS: --prior-rounds 1 --prior-full 1\n');
    expect(h.stdout).toMatch(/^PR_REVIEW_ROUTE: final \(the PR had 1 full review round; this head gets a fresh full review/m);
    expect(h.stdout).not.toMatch(/drift|recheck_blocked/);
    const s = r.run('gstack-ship-receipt', ['stub', '--body', body, '--run', 'r2', '--review-loop', JSON.stringify({ ...loop, fix_checks: 1, rounds: 2 })]);
    expect(s.stdout).toContain('RUN_STUB: run=r2 status=started rounds=2');
    const after = r.run('gstack-ship-receipt', ['history', '--body', body, '--pr', '5']).stdout;
    expect(after).toContain('PR_REVIEW_FLAGS: --prior-rounds 3 --prior-full 2\n');
    expect(after).toMatch(/^PR_REVIEW_ROUTE: read-only \(.*no fix round/m);
    expect(fs.readFileSync(body, 'utf8').startsWith('## Summary\nprose\n')).toBe(true);
    expect(r.run('gstack-ship-receipt', ['stub', '--body', body]).status).toBe(2);
  });

  test('an unreadable PR body prints source=unavailable and its fix', () => {
    const r = repo();
    const h = r.run('gstack-ship-receipt', ['history', '--body', path.join(r.dir, 'missing.md')]);
    expect(h.status).toBe(1);
    expect(h.stdout).toContain('source=unavailable');
    expect(h.stderr).toContain('fix:');
  });
});

describe('a scoped re-check is advice only (G1)', () => {
  test('carry refuses --recheck: no re-check record carries a receipt', () => {
    const r = repo();
    const body = path.join(r.dir, 'body.md');
    fs.writeFileSync(body, '## Summary\n');
    const c = r.run('gstack-ship-receipt', ['carry', '--body', body, '--recheck', path.join(r.dir, 'r.json')]);
    expect(c.status).toBe(3);
    expect(c.stderr).toContain('--recheck is gone: a scoped re-check is advice only and never carries a receipt');
    expect(fs.readFileSync(body, 'utf8')).toBe('## Summary\n');
  });
});

describe('a round grant at the PR_ROUND_CAP stop head (GST-2968)', () => {
  const loop = { passes: 1, blocking_found: 0, deferred: 0, rounds: 1 };
  const flagsOf = (out: string) => /^PR_REVIEW_FLAGS: (.*)$/m.exec(out)?.[1] ?? '';
  const gitIn = (dir: string) => (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', timeout: 10_000 });
  // gstack#4272 at fa3e4a2: two full rounds on earlier heads, then the read-only review of this head stopped on a blocker.
  function atStop() {
    const r = repo();
    const body = path.join(r.dir, 'body.md');
    const runs = [{ head: 'a'.repeat(40), run: 'r1', review_loop: loop }, { head: 'b'.repeat(40), run: 'r2', review_loop: loop }];
    fs.writeFileSync(body, '## Summary\nprose\n\n```gstack-receipt-runs\n' + runs.map(x => JSON.stringify(x)).join('\n') + '\n```\n');
    const ro = r.run('gstack-ship-receipt', ['stub', '--body', body, '--pr', '5', '--base', 'main', '--run', 'r3', '--review-loop', JSON.stringify(loop)]);
    expect(ro.stdout).toContain('RUN_STUB: run=r3 status=started rounds=1 read_only=1');
    const history = () => r.run('gstack-ship-receipt', ['history', '--body', body, '--pr', '5', '--base', 'main']).stdout;
    const grant = (head = r.head) => /APPROVAL_RECORDED: (a-[0-9a-f]{12})/.exec(r.run('gstack-approvals', ['round-grant', '--pr', '5', '--head', head, '--kind', 'extra-round', '--reason', 'a blocker in the PR\'s own change', '--by', 'captain:test']).stdout)?.[1];
    return { ...r, body, history, grant };
  }

  // Value: protects=the grant PR_ROUND_CAP prints buys the round it names (gstack#4272 rounds=3 cap=2 full=3: two grants bought
  //   nothing); fails_when=history still passes the read-only pass in --prior-full, routes read-only, or the granted run's plan
  //   refuses its fix round; seam=gstack-ship-receipt stub/history + gstack-review-plan; no_claim=a grant on another head (next test)
  test('the grant opens one full round with its fix round at the stop head, and nothing more', () => {
    const s = atStop();
    const before = s.history();
    expect(before).toMatch(/^PR_REVIEW_HISTORY: pr=#5 rounds=3 cap=2 full=3 .* read_only=1 /m);
    expect(flagsOf(before)).toBe('--prior-rounds 3 --prior-full 3');
    expect(before).toMatch(/^PR_REVIEW_ROUTE: read-only /m);
    const id = s.grant();
    expect(id).toBeDefined();
    const granted = s.history();
    expect(flagsOf(granted)).toBe(`--prior-rounds 3 --prior-full 2 --round-grant ${id}`);
    expect(granted).toMatch(new RegExp(`^PR_REVIEW_ROUTE: final \\(.*round grant ${id} buys one more at this head, with its fix round`, 'm'));
    const plan = (...extra: string[]) => s.run('gstack-review-plan', ['--base', 'main', '--gate-tagged', '0', '--prior-rounds', '3', '--prior-full', '2', '--pr', '5', '--round-grant', id!, ...extra]);
    expect(plan().stdout).toContain('round 3 of 3');
    const fixRound = plan('--pass', '1', '--last', 'full', '--fixed-blocking', '--range-base', s.head);
    expect(fixRound.status).toBe(0);
    expect(fixRound.stdout).not.toContain('PR_ROUND_CAP');
    expect(fixRound.stdout).toContain("that round's fix round");
    const run4 = s.run('gstack-ship-receipt', ['stub', '--body', s.body, '--pr', '5', '--base', 'main', '--run', 'r4', '--review-loop', JSON.stringify({ ...loop, passes: 2, rounds: 2 })]);
    expect(run4.stdout).toContain('RUN_STUB: run=r4 status=started rounds=2 head=');
    const spent = s.history();
    expect(flagsOf(spent)).toBe(`--prior-rounds 5 --prior-full 4 --round-grant ${id}`);
    expect(spent).toMatch(new RegExp(`^PR_REVIEW_ROUTE: read-only \\(.*round grant ${id} at this head is already spent`, 'm'));
  });

  // Value: protects=ghome#17: preflight merged main first, so the reviewed head (e9ee170) was not the granted one (28b7968);
  //   a grant still applies across a merge that leaves the PR's own lines byte-identical, and never across a change to them;
  //   fails_when=the merge head loses the grant, or a head with new own lines keeps it; seam=gstack-ship-receipt history --base
  test('the grant survives a pure base merge of its head and never a change to the PR\'s own lines', () => {
    const s = atStop();
    const id = s.grant();
    const git = gitIn(s.dir);
    git('checkout', '-q', 'main'); fs.writeFileSync(path.join(s.dir, 'NOTES.md'), 'main moved\n'); git('add', '.'); git('commit', '-qm', 'main');
    git('checkout', '-q', 'feat'); git('merge', '-q', '--no-edit', 'main');
    const merged = s.history();
    expect(flagsOf(merged)).toBe(`--prior-rounds 3 --prior-full 2 --round-grant ${id}`);
    fs.writeFileSync(path.join(s.dir, 'src', 'a.ts'), 'export const a = 3;\n'); git('commit', '-qam', 'new own lines');
    const changed = s.history();
    expect(flagsOf(changed)).toBe('--prior-rounds 3 --prior-full 3');
    expect(changed).toMatch(/^PR_REVIEW_ROUTE: read-only /m);
  });

  // Value: protects=the granted run's own stub after its fix commit (Step 9 records the stub after the pass commits its fixes)
  //   stays a granted round, as the plan keeps the grant past HEAD; fails_when=the stub loses the grant at the fix head and marks
  //   the granted passes read_only, so a later grant would subtract them; seam=gstack-ship-receipt stub; no_claim=history's route
  test('the granted run\'s stub after its fix commit is not read-only', () => {
    const s = atStop();
    expect(s.grant()).toBeDefined();
    const git = gitIn(s.dir);
    fs.writeFileSync(path.join(s.dir, 'src', 'a.ts'), 'export const a = 2;\n'); git('commit', '-qam', 'fix round');
    const run4 = s.run('gstack-ship-receipt', ['stub', '--body', s.body, '--pr', '5', '--base', 'main', '--run', 'r4', '--review-loop', JSON.stringify({ ...loop, passes: 2, rounds: 2 })]);
    expect(run4.stdout).toMatch(/^RUN_STUB: run=r4 status=started rounds=2 head=/m);
    expect(s.history()).toMatch(/^PR_REVIEW_HISTORY: pr=#5 rounds=5 cap=2 full=5 .* read_only=1 /m);
  });

  // Value: protects=a read-only run that ends done and writes its receipt keeps its read-only mark, so a later read-only stop's
  //   grant still buys its round; fails_when=the receipt write drops the read_only stub and the grant routes read-only again;
  //   seam=placeReceipt + prReviewHistory; no_claim=the receipt schema
  test('a read-only run that writes its receipt stays read-only, and a later stop\'s grant still buys the round', () => {
    const h = (c: string) => c.repeat(40);
    const receipt = (head: string, run: string) => ({ head, run, review_loop: loop }) as ShipReceipt;
    let body = placeReceipt(placeReceipt('## Summary\n', receipt(h('a'), 'r1')), receipt(h('b'), 'r2'));
    body = placeRunEntry(body, runStub({ head: h('c'), run: 'r3', status: 'started', loop, readOnly: true }));
    body = placeReceipt(body, receipt(h('c'), 'r3'));
    expect(prReviewHistory(body)).toMatchObject({ full: 3, read_only: 1, runs: 3, stubs: 0 });
    body = placeRunEntry(body, runStub({ head: h('d'), run: 'r4', status: 'started', loop, readOnly: true }));
    const later = prReviewHistory(body);
    expect(later).toMatchObject({ full: 4, read_only: 2, stubs: 1 });
    expect(reviewRoute(later, { grant: 'a-000000000001' }).route).toBe('final');
    expect(reviewRoute(later).route).toBe('read-only');
  });

  test('a grant recorded on the merge head applies back at its pre-merge head, and a grant for another PR never does', () => {
    const s = atStop();
    const git = gitIn(s.dir);
    git('checkout', '-q', 'main'); fs.writeFileSync(path.join(s.dir, 'NOTES.md'), 'main moved\n'); git('add', '.'); git('commit', '-qm', 'main');
    git('checkout', '-q', 'feat'); git('merge', '-q', '--no-edit', 'main');
    const id = s.grant(git('rev-parse', 'HEAD').stdout.trim());
    expect(flagsOf(s.run('gstack-ship-receipt', ['history', '--body', s.body, '--pr', '5', '--base', 'main', '--head', s.head]).stdout)).toBe(`--prior-rounds 3 --prior-full 2 --round-grant ${id}`);
    expect(flagsOf(s.run('gstack-ship-receipt', ['history', '--body', s.body, '--pr', '6', '--base', 'main']).stdout)).toBe('--prior-rounds 3 --prior-full 3');
  });
});

