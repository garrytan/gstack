/**
 * gstack-ship-receipt claim fails closed when it cannot record the claim in the run record (#4654 review note): the run
 * record's claim is what limits a stopped run to one self-granted fix round, so a claim the record never took must not
 * read as GRANT_CLAIMED with exit 0, or the run could stop and grant itself again.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PREFLIGHT, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const BIN = path.join(import.meta.dir, '..', 'bin');
const CHECKOUT = { GSTACK_LEASE_DIR: '', GSTACK_APPROVALS_MIRROR: '0' };
const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

const run = (f: ShipFx, bin: string, args: string[]) => f.run(path.join(BIN, bin), args, CHECKOUT);
const gitPath = (f: ShipFx, name: string) => path.resolve(f.work, f.git('rev-parse', '--git-path', name).stdout.trim());
const record = (f: ShipFx) => JSON.parse(fs.readFileSync(gitPath(f, 'gstack-ship-run'), 'utf8'));

/** A run ro that stopped on one blocker and granted itself the fix-check for its own stop: returns the grant id and the body file. */
function stoppedWithOwnGrant(f: ShipFx): { grant: string; body: string } {
  expect(f.run(PREFLIGHT, ['--base', 'main', '--run', 'ro'], CHECKOUT).status).toBe(0);
  const start = run(f, 'gstack-review-log', ['--start', 'review']);
  expect(start.status, start.stderr).toBe(0);
  const row = { skill: 'review', timestamp: new Date().toISOString(), via: 'ship', pass: 1, review_scope: 'frozen', completed: true, converged: false, status: 'issues_found', issues_found: 1, critical: 1, informational: 0, findings: [{ fingerprint: 'src/x.ts:1:outside-voice', severity: 'CRITICAL', action: 'open', blocking: true, ledger_id: 'p1/outside-voice#1', raised_by: 'outside-voice' }] };
  expect(run(f, 'gstack-review-log', [JSON.stringify(row), '--finish', start.stdout.trim()]).status).toBe(0);
  const body = path.join(f.root, 'body.md');
  fs.writeFileSync(body, 'Fixes a thing.\n');
  expect(run(f, 'gstack-ship-receipt', ['stop', '--body', body, '--pr', '7', '--run', 'ro', '--since', '2000-01-01T00:00:00Z']).status).toBe(0);
  const head = f.git('rev-parse', 'HEAD').stdout.trim();
  const granted = run(f, 'gstack-approvals', ['round-grant', '--pr', '7', '--head', head, '--kind', 'fix-check', '--stop-run', 'ro', '--findings', 'p1/outside-voice#1', '--reason', 'fixable blocker', '--by', 'Captain GStack Minder (GSTA-36)']);
  const grant = /APPROVAL_RECORDED: (a-[0-9a-f]{12})/.exec(granted.stdout)?.[1];
  expect(grant, granted.stderr).toBeDefined();
  return { grant: grant!, body };
}

describe('claim fails closed when the run record cannot take it (#4654)', () => {
  // Value: protects=the once-per-run self-grant limit, which reads the run record's claim; fails_when=claim prints
  //   GRANT_CLAIMED and exits 0 after the record write failed; seam=gstack-ship-receipt claim; no_claim=gh pr edit
  test('a claim whose run-record write fails exits non-zero and says not to dispatch', () => {
    const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n' });
    fixtures.push(f);
    const { grant, body } = stoppedWithOwnGrant(f);
    fs.mkdirSync(gitPath(f, 'gstack-gate-disposition.lock'));
    const claim = run(f, 'gstack-ship-receipt', ['claim', '--body', body, '--run', 'ro', '--grant', grant]);
    expect(claim.status).not.toBe(0);
    expect(claim.stdout).not.toContain('GRANT_CLAIMED');
    expect(claim.stderr).toContain('do not dispatch');
    expect(record(f).claim).toBeUndefined();
  });

  // Value: protects=a claim retried after the failure clears records the claim once (positive control); fails_when=the
  //   failed attempt's body marker blocks its own retry; seam=gstack-ship-receipt claim; no_claim=gh pr edit
  test('the same claim retried once the record is writable records it', () => {
    const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n' });
    fixtures.push(f);
    const { grant, body } = stoppedWithOwnGrant(f);
    const lock = gitPath(f, 'gstack-gate-disposition.lock');
    fs.mkdirSync(lock);
    expect(run(f, 'gstack-ship-receipt', ['claim', '--body', body, '--run', 'ro', '--grant', grant]).status).not.toBe(0);
    fs.rmSync(lock, { recursive: true, force: true });
    const again = run(f, 'gstack-ship-receipt', ['claim', '--body', body, '--run', 'ro', '--grant', grant]);
    expect(again.status, again.stderr).toBe(0);
    expect(again.stdout).toContain('GRANT_CLAIMED: grant=' + grant);
    expect(record(f)).toMatchObject({ run: 'ro', state: 'open', claim: { grant } });
  });
});
