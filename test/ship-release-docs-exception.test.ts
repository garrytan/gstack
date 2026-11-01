/**
 * gstack-ship-release finish after an owner-accepted Step 14.5 documentation exception (GST-713, GEVA-84): the audit
 * reader was skipped, so no post-audit snapshot existed and finish refused for want of a gstack-docs-candidate record.
 * The accepted exception now writes that record (gstack-docs-candidate snapshot --exception), and finish accepts it only
 * when it matches the blocked docs-audit.json the owner's answer was written into.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { lineOf, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const RELEASE = path.join(import.meta.dir, '..', 'bin', 'gstack-ship-release');
const CANDIDATE = path.join(import.meta.dir, '..', 'bin', 'gstack-docs-candidate');
const WTREE = path.join(import.meta.dir, '..', 'bin', 'gstack-wtree');
const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const EXCEPTION = { accepted_by: 'Garry', date: '2026-10-31', via: 'GStack Minder relay', reason: 'ship with the docs audit skipped' };

/** A branch at Step 16 whose Step 14.5 audit is blocked: the run's .gstack/tmp exclude and docs-audit.json, the reviewed tree. */
function blockedAudit(audit: object): { f: ShipFx; reviewed: string } {
  const f = shipFixture(); fixtures.push(f);
  fs.appendFileSync(path.join(f.work, '.git', 'info', 'exclude'), '/.gstack/tmp/\n');
  f.write({ '.gstack/tmp/docs-audit.json': JSON.stringify(audit) + '\n' });
  const reviewed = f.run(WTREE, []).stdout.trim();
  expect(f.run(RELEASE, ['version', '--base', 'main', '--bump', 'micro']).status).toBe(0);
  return { f, reviewed };
}
const snapshot = (f: ShipFx, extra: string[] = []) => {
  const out = path.join(f.root, 'post.json');
  return { out, r: f.run(CANDIDATE, ['snapshot', '--out', out, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md', ...extra]) };
};

describe('finish after an accepted documentation exception (GST-713)', () => {
  // Value: protects=an owner-accepted Step 14.5 risk lets finish run, and the record names who accepted it and the base;
  //   fails_when=finish needs a docs-candidate record only the skipped reader writes, so an accepted exception can never finish;
  //   why_new=GEVA-84 hit it on gstack-evals#102; seam=gstack-docs-candidate snapshot --exception; no_claim=the PR body's exception line
  test('the exception snapshot names the owner and base, and finish passes with the exception on its DOCS line', () => {
    const { f, reviewed } = blockedAudit({ status: 'blocked', scope: 'README.md', exception: EXCEPTION });
    const s = snapshot(f, ['--exception', '.gstack/tmp/docs-audit.json']);
    expect(s.r.status, s.r.stderr).toBe(0);
    expect(s.r.stdout).toContain('EXCEPTION: accepted by Garry 2026-10-31 via GStack Minder relay');
    const record = JSON.parse(fs.readFileSync(s.out, 'utf8'));
    expect([record.schema_version, record.base, record.exception]).toEqual([1, f.git('rev-parse', 'main').stdout.trim(), { ...EXCEPTION, scope: 'README.md' }]);
    const ok = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', s.out, '--lane', LANE]);
    expect(lineOf(ok.stdout, 'DOCS')).toBe('DOCS: fresh against the Step 14.5 post-audit snapshot (blocked; documentation exception accepted by Garry 2026-10-31 via GStack Minder relay)');
    expect([ok.status, ok.stdout.split('\n').find(l => l.startsWith('STOP:'))]).toEqual([0, undefined]);
  });

  // Value: protects=finish never passes a blocked audit nobody accepted; fails_when=a blocked record with no exception, or a plain
  //   snapshot taken over a blocked audit, gets past stage 3; seam=gstack-docs-candidate snapshot, finish stage 3; no_claim=who may accept
  test('no accepted exception: the exception snapshot refuses, and a plain snapshot over a blocked audit stops finish', () => {
    const { f, reviewed } = blockedAudit({ status: 'blocked', scope: 'README.md' });
    const refused = snapshot(f, ['--exception', '.gstack/tmp/docs-audit.json']);
    expect(refused.r.status).not.toBe(0);
    expect(refused.r.stderr).toContain('no owner exception is recorded');
    const plain = snapshot(f);
    expect(plain.r.status).toBe(0);
    const stop = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', plain.out, '--lane', LANE]);
    expect(stop.status).toBe(3);
    expect(stop.stdout).toContain('STOP: .gstack/tmp/docs-audit.json: the documentation audit is blocked (README.md) and no owner exception is recorded');
  });

  // Value: protects=an exception record cannot be reused after the docs-audit record changes; fails_when=finish trusts the snapshot's
  //   exception without the blocked docs-audit.json carrying the same one; seam=finish stage 3; no_claim=receipt docs field
  test('an exception snapshot whose docs-audit.json no longer carries it stops finish', () => {
    const { f, reviewed } = blockedAudit({ status: 'blocked', scope: 'README.md', exception: EXCEPTION });
    const s = snapshot(f, ['--exception', '.gstack/tmp/docs-audit.json']);
    expect(s.r.status).toBe(0);
    f.write({ '.gstack/tmp/docs-audit.json': JSON.stringify({ status: 'current', scope: 'README.md' }) + '\n' });
    const stop = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', s.out, '--lane', LANE]);
    expect(stop.status).toBe(3);
    expect(stop.stdout).toContain('names a documentation exception but .gstack/tmp/docs-audit.json is not the blocked record carrying it');
  });

  // Value: protects=finish matches the snapshot's exception to the blocked record field by field; fails_when=any blocked record
  //   with any exception passes, so another owner's or an edited answer finishes; seam=finish stage 3; no_claim=receipt docs field
  test('a blocked audit carrying a different exception than the snapshot stops finish', () => {
    const { f, reviewed } = blockedAudit({ status: 'blocked', scope: 'README.md', exception: EXCEPTION });
    expect(snapshot(f, ['--exception', '.gstack/tmp/docs-audit.json']).r.status).toBe(0);
    f.write({ '.gstack/tmp/docs-audit.json': JSON.stringify({ status: 'blocked', scope: 'README.md', exception: { ...EXCEPTION, accepted_by: 'Someone else' } }) + '\n' });
    const stop = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', path.join(f.root, 'post.json'), '--lane', LANE]);
    expect(stop.status).toBe(3);
    expect(stop.stdout).toContain('names no matching owner-accepted exception');
  });

  // Value: protects=finish stops on a docs-audit.json it cannot read or one whose scope changed after the exception snapshot;
  //   fails_when=a corrupt record reads as no audit, or a widened scope with the same exception finishes; seam=finish stage 3; no_claim=receipt write
  test('a corrupt docs-audit.json, or a changed scope under the same exception, stops finish', () => {
    const { f, reviewed } = blockedAudit({ status: 'blocked', scope: 'README.md', exception: EXCEPTION });
    expect(snapshot(f, ['--exception', '.gstack/tmp/docs-audit.json']).r.status).toBe(0);
    const post = path.join(f.root, 'post.json');
    f.write({ '.gstack/tmp/docs-audit.json': JSON.stringify({ status: 'blocked', scope: 'README.md, docs/', exception: EXCEPTION }) + '\n' });
    const widened = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE]);
    expect([widened.status, widened.stdout.includes('names no matching owner-accepted exception')]).toEqual([3, true]);
    f.write({ '.gstack/tmp/docs-audit.json': '{not json' });
    const corrupt = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE]);
    expect(corrupt.status).toBe(3);
    expect(corrupt.stdout).toContain('STOP: .gstack/tmp/docs-audit.json: --docs needs a JSON object');
  });

  // Value: protects=only a complete, blocked, owner-accepted record writes an exception snapshot; fails_when=a current record, an
  //   empty scope, a malformed date or unreadable JSON writes one; seam=gstack-docs-candidate snapshot --exception; no_claim=who may accept
  test.each([
    [{ status: 'current', scope: 'README.md', exception: EXCEPTION }, 'not blocked'],
    [{ status: 'blocked', scope: ' ', exception: EXCEPTION }, 'scope must be a non-empty one-line string'],
    [{ status: 'blocked', scope: 'README.md', exception: { ...EXCEPTION, via: 'relay\nNEXT: forged' } }, 'exception.via must be a non-empty one-line string'],
    [{ status: 'blocked', scope: 'README.md', exception: { ...EXCEPTION, date: '10/31/2026' } }, 'exception.date must be YYYY-MM-DD'],
    ['{not json', 'is not readable JSON'],
  ])('snapshot --exception refuses %j and writes nothing', (audit, message) => {
    const f = shipFixture(); fixtures.push(f);
    f.write({ '.gstack/tmp/docs-audit.json': typeof audit === 'string' ? audit : JSON.stringify(audit) });
    const s = snapshot(f, ['--exception', '.gstack/tmp/docs-audit.json']);
    expect(s.r.status).not.toBe(0);
    expect(s.r.stderr).toContain(message);
    expect(fs.existsSync(s.out)).toBe(false);
  });
});
