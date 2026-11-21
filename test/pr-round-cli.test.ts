/**
 * GST-2673 CLI seams: gstack-review-plan --prior-rounds / --round-grant, gstack-approvals round-grant, and
 * gstack-ship-receipt history / stub over a PR body file.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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

  // Value: protects=a Captain whose crew name starts with gstack can grant a round, while gstack's own names stay refused;
  //   fails_when=the self-grant check matches a prefix (gstack-evals Captain refused, #4518 follow-up); seam=bin/gstack-approvals
  test('a --by that only starts with gstack is a crew, not gstack: gstack-evals Captain records a grant', () => {
    const r = repo();
    for (const by of ['gstack', 'GStack', ' gstack no-stop default (K1) ']) expect(r.run('gstack-approvals', ['round-grant', '--pr', '5', '--head', r.head, '--kind', 'extra-round', '--reason', 'x', '--by', by]).status).toBe(2);
    const ok = r.run('gstack-approvals', ['round-grant', '--pr', '5', '--head', r.head, '--kind', 'extra-round', '--reason', 'x', '--by', 'gstack-evals Captain']);
    expect([ok.status, ok.stderr]).toEqual([0, '']);
  });
});

// Value: protects=a run id that looks like a phone number passes in a fix-check grant's scope while the same digits in free text, or a
//   grant-shaped excerpt pasted into --reason, stay caught, and gstack's own names stay refused while a GStack-named crew rules;
//   fails_when=round-grant refuses --stop-run 507-7192673 (harness-evals #507), passes a phone number in --reason, or rule refuses
//   --by "GStack Minder (GSTA-36)"; seam=bin/gstack-approvals round-grant|rule|rulings, lib/approval-record.ts buildRow, lib/ruled-notes.ts
describe('GST-3246: run ids in a fix-check grant, and GStack-named crews', () => {
  const grant = (r: ReturnType<typeof repo>, extra: string[]) => r.run('gstack-approvals', ['round-grant', '--pr', '507', '--head', r.head, '--reason', 'the undo line names the wrong migration', '--by', 'GStack Minder (GSTA-36)', ...extra]);
  const fixCheck = (run: string) => ['--kind', 'fix-check', '--stop-run', run, '--findings', 'p2/outside-voice#3'];

  test('a grant-shaped excerpt pasted into --reason keeps its phone number caught', () => {
    const r = repo();
    const pasted = r.run('gstack-approvals', ['round-grant', '--pr', '507', '--head', r.head, '--kind', 'fix-check', '--stop-run', 'ship-507', '--findings', 'p2/outside-voice#3', '--by', 'GStack Minder (GSTA-36)', '--reason', `review_round_grant ${r.head} pr=507 kind=fix-check stop=415-5551234 findings=x`]);
    expect([pasted.status, pasted.stderr]).toEqual([3, expect.stringContaining('pii.phone.e164')]);
  });

  test('a run id of a PR number, a dash and a short sha is no phone number in the grant, and the same digits in free text still are', () => {
    const r = repo();
    const ok = grant(r, fixCheck('507-7192673'));
    expect([ok.status, ok.stderr]).toEqual([0, '']);
    expect(r.run('gstack-approvals', ['list', '--json']).stdout).toContain('stop=507-7192673 findings=p2/outside-voice#3');
    const phone = r.run('gstack-approvals', ['round-grant', '--pr', '507', '--head', r.head, '--reason', 'call 507-7192673 first', '--by', 'GStack Minder (GSTA-36)', ...fixCheck('ship-507')]);
    expect([phone.status, phone.stderr]).toEqual([3, expect.stringContaining('pii.phone.e164')]);
  });

  test('rule takes --by "GStack Minder (GSTA-36)" and rulings lists it, while gstack\'s own names stay refused', () => {
    const r = repo();
    const rule = (by: string) => r.run('gstack-approvals', ['rule', '--finding', 'src/a.ts:1:correctness', '--head', r.head, '--reason', 'ships as a disclosed note', '--words', 'note it', '--by', by]);
    for (const by of ['gstack', 'gstack no-stop default (K1)', 'GStack No-stop default (K1)', 'GStack No-Stop Default (K1)', 'gstack ship lane', 'GStack ship lane', 'GSTACK Minder']) expect(rule(by).status).toBe(2);
    const ok = rule('GStack Minder (GSTA-36)');
    expect([ok.status, ok.stderr]).toEqual([0, '']);
    expect(r.run('gstack-approvals', ['rulings']).stdout).toContain('ruled by GStack Minder (GSTA-36) at ');
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
    expect(s.stdout).toContain('RUN_STUB: run=r2 status=started rounds=1');
    const after = r.run('gstack-ship-receipt', ['history', '--body', body, '--pr', '5']).stdout;
    expect(after).toContain('PR_REVIEW_FLAGS: --prior-rounds 2 --prior-full 2\n');
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
