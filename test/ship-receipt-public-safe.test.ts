/**
 * Public repositories (GST-1955, CAPY-1 qm#3938 and qm#3983): /ship's receipt, its Ruled note lines and abandon's runs-block
 * entry must not carry a home path or a Capy thread or message id. 20 of 60 merged public gstack receipts held
 * `"run": "/home/user/.capy/work/ship-<n>"` because write copied --run verbatim; a relayed ruling's `relayed from
 * <thread>:<message>` was required word for word in the public PR body; and abandon posted to a PR the checkout's branch did
 * not open (qm#3992 for qm#3983).
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT } from '../lib/headless-artifacts';
import { placeRunEntry, prReviewHistory, receiptedRun, runStub } from '../lib/pr-review-history';
import { extractReceipt, placeReceipt, publicReceiptLeaks, receiptRuns, runId, RUNS_FENCE, sameRun } from '../lib/ship-receipt';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(90_000);
const BIN = path.dirname(RELEASE);
const LANE = 'tests=printf " 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [5.00ms]\\n"';
const ships: ShipFx[] = [];
afterEach(() => { while (ships.length) ships.pop()!.cleanup(); });

const H = 'a'.repeat(40);
const HOME_RUN = '/home/user/.capy/work/ship-4590';
const REF = 'GBRA-108:2026-11-19T12:29:59Z';
const LOOP = { passes: 1, blocking_found: 0, deferred: 0 };
const runsBody = (...entries: object[]) => '<!-- gstack:agent-notes -->\n<details><summary>Agent notes</summary>\n\n\`\`\`' + RUNS_FENCE + '\n' + entries.map(e => JSON.stringify(e)).join('\n') + '\n\`\`\`\n\n</details>\n';

/** A fixture whose gh says the repository is PUBLIC, PRIVATE or cannot say (''), answers pr view with `view`, and logs every call. */
function fixture(visibility: 'PUBLIC' | 'PRIVATE' | '', view = '{"body":""}') {
  const f = shipFixture({ 'src/x.ts': 'export const x = 1;\n' }, { 'src/x.ts': 'export const x = 2;\n' });
  ships.push(f);
  setGh(f, visibility, view);
  return f;
}
const setGh = (f: ShipFx, visibility: string, view = '{"body":""}') => f.gh([
  `echo "$*" >> "${path.join(f.root, 'gh.log')}"`,
  `if [ "$1" = repo ]; then ${visibility ? `echo ${visibility}; exit 0` : 'exit 1'}; fi`,
  `if [ "$1" = pr ] && [ "$2" = view ]; then echo '${view}'; exit 0; fi`,
  'exit 0',
].join('\n'));
const ghLog = (f: ShipFx) => { const p = path.join(f.root, 'gh.log'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };
const bin = (f: ShipFx, name: string, args: string[]) => f.run(path.join(BIN, name), args, { GSTACK_APPROVALS_MIRROR: '0' });
const write = (f: ShipFx, body: string, extra: string[] = []) => bin(f, 'gstack-ship-receipt', ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body, ...extra]);
const bodyFile = (f: ShipFx, text = '## Summary\n\nA change.\n') => { const p = path.join(f.root, 'body.md'); fs.writeFileSync(p, text); return p; };
const relayedRule = (f: ShipFx, reason = 'ships as a disclosed note') => bin(f, 'gstack-approvals', ['rule', '--finding', 'src/x.ts:1:edit-share-race', '--head', f.git('rev-parse', 'HEAD').stdout.trim(), '--reason', reason, '--words', 'B, note it', '--by', 'GBrain Minder (GBRA-108)', '--owner-ref', REF]);

// Value: protects=one run id names one /ship run whether a record holds the run dir's path or its name; fails_when=write keeps the
//   path, or an older entry holding the path no longer matches its run's basename (a stub double-counted, a receipt not found);
//   seam=lib/ship-receipt.ts runId and the run comparisons in placeReceipt, placeRunEntry, prReviewHistory and receiptedRun
describe('run ids are the run dir name, on write and in every comparison (GST-1955)', () => {
  test('runId keeps the last path segment of a POSIX or Windows path and leaves a bare id alone', () => {
    expect([runId(HOME_RUN), runId('C:\\Users\\u\\work\\ship-9\\'), runId('ship-1'), runId('ship-2/')]).toEqual(['ship-4590', 'ship-9', 'ship-1', 'ship-2']);
    expect([sameRun(HOME_RUN, 'ship-4590'), sameRun('ship-4590', 'ship-4591'), sameRun(undefined, 'ship-4590')]).toEqual([true, false, false]);
  });

  test('an in-flight PR whose older entries hold the full path matches the run by its name', () => {
    const stub = runStub({ head: H, run: HOME_RUN, status: 'started', loop: LOOP });
    const placed = placeReceipt(runsBody(stub), { schema_version: 1, head: H, run: 'ship-4590', review_loop: LOOP } as any);
    expect(receiptRuns(placed)).toEqual([]);
    expect(prReviewHistory(placed)).toMatchObject({ rounds: 1, runs: 1, stubs: 0 });
    const both = runsBody(stub, { head: H, run: 'ship-4590', review_loop: LOOP });
    expect(prReviewHistory(both)).toMatchObject({ rounds: 1 });
    const restubbed = placeRunEntry(runsBody(stub), runStub({ head: H, run: 'ship-4590', status: 'voided', loop: LOOP }));
    expect(receiptRuns(restubbed)).toEqual([{ head: H, run: 'ship-4590', status: 'voided', review_loop: LOOP }]);
    expect(receiptedRun(runsBody({ head: H, run: HOME_RUN, review_loop: LOOP }), 'ship-4590')).toMatchObject({ head: H });
    expect(placed).not.toContain('/home/');
  });

  test('publicReceiptLeaks names each field that holds a home path or a Capy id, never its value, and passes ordinary fields', () => {
    expect(publicReceiptLeaks({ run: HOME_RUN, thread: 'jam_01abc', history: 'C:\\Users\\runner\\x', gate: { note: 'file:///Users/garry/x' }, ruled_notes: [{ relayed: REF }], policy: '/root/.gstack/x' })).toEqual([
      'run (a home path)', 'thread (a Capy thread or message id)', 'history (a home path)', 'gate.note (a home path)', 'ruled_notes[0].relayed (a Capy thread or message id)', 'policy (a home path)',
    ]);
    expect(publicReceiptLeaks({ run: 'ship-4590', policy: 'origin/main@0123456789ab:.gstack/ship-policy.json', ruled_notes: [{ by: 'GStack Minder (GSTA-36)', at: '2026-11-19T12:29:59Z', relayed: 'a private message' }], gate: { path: '/workspace/home/user/x' } })).toEqual([]);
  });

  test('write stores the run dir name when --run is the run dir path', () => {
    const f = fixture('');
    const body = bodyFile(f);
    const w = write(f, body, ['--run', HOME_RUN]);
    expect(w.status, w.stderr).toBe(EXIT.ok);
    expect(extractReceipt(w.stdout).receipt?.run).toBe('ship-4590');
    expect(fs.readFileSync(body, 'utf8')).not.toContain('/home/');
  });
});

// Value: protects=a receipt on a repository gh does not report private never carries a home path or a Capy id; fails_when=write
//   publishes --thread jam_… or a home path in any field on a public or unknown repository, or refuses one on a private repository;
//   seam=gstack-ship-receipt write's refusal after the schema check
describe('write refuses a public receipt that holds a home path or a Capy id (GST-1955)', () => {
  test('public and unknown visibility refuse naming the field, private keeps the value', () => {
    for (const vis of ['PUBLIC', ''] as const) {
      const f = fixture(vis);
      const body = bodyFile(f);
      for (const extra of [['--thread', 'jam_01abc'], ['--history', '/Users/garry/notes/x']]) {
        const w = write(f, body, extra);
        expect([w.status, w.stderr]).toEqual([EXIT.fail, expect.stringContaining(`${extra[0]!.slice(2)} (a `)]);
        expect(w.stderr).toContain('(RECEIPT_INVALID)');
        expect(w.stderr).not.toContain(extra[1]!);
        expect(fs.readFileSync(body, 'utf8')).toBe('## Summary\n\nA change.\n');
      }
    }
    const f = fixture('PRIVATE');
    const w = write(f, bodyFile(f), ['--thread', 'jam_01abc']);
    expect(w.status, w.stderr).toBe(EXIT.ok);
    expect(extractReceipt(w.stdout).receipt?.thread).toBe('jam_01abc');
  });
});

// Value: protects=rulings, finish and the receipt agree on one public-safe Ruled note form, and the relay ref stays in the private
//   approval row; fails_when=a public PR body must carry <thread>:<message> to satisfy write, or the three render different lines;
//   seam=lib/ruled-notes.ts repoRuledNotes read by gstack-approvals rulings, gstack-ship-release finish and gstack-ship-receipt write
describe('a relayed ruling on a public repository (CAPY-1 qm#3938)', () => {
  test('rulings, the receipt and finish say relayed from a private message; the row keeps the ref', () => {
    const f = fixture('PUBLIC');
    const reviewed = f.run(path.join(BIN, 'gstack-wtree'), []).stdout.trim();
    const post = path.join(f.root, 'post.json');
    expect(f.run(path.join(BIN, 'gstack-docs-candidate'), ['snapshot', '--out', post, '--audit-id', 'a1', '--mode', 'edit', '--base', 'main', '--docs', 'README.md']).status).toBe(0);
    expect(relayedRule(f).status).toBe(0);
    const rows = JSON.parse(bin(f, 'gstack-approvals', ['list', '--json']).stdout).rows as Array<{ source: string }>;
    expect(rows.map(r => r.source)).toEqual([`relayed:${REF}`]);
    const line = bin(f, 'gstack-approvals', ['rulings']).stdout.trim();
    expect(line).toMatch(/^Ruled note: src\/x\.ts:1:edit-share-race at [0-9a-f]{12} ruled by GBrain Minder \(GBRA-108\) \(relayed from a private message\) at /);
    const fin = f.run(RELEASE, ['finish', '--base', 'main', '--reviewed-tree', reviewed, '--docs-post', post, '--lane', LANE]);
    expect(lineOf(fin.stdout, 'RULED_NOTE')).toBe(`RULED_NOTE: ${line.slice('Ruled note: '.length)}`);
    const body = bodyFile(f, `## Pre-Landing Review\n\n${line}\n`);
    const w = write(f, body);
    expect(w.status, w.stderr).toBe(EXIT.ok);
    expect(extractReceipt(w.stdout).receipt?.ruled_notes?.[0]?.relayed).toBe('a private message');
    expect(fs.readFileSync(body, 'utf8')).not.toContain('GBRA-108:');
  });

  test('a body that still lists the internal relay line is refused on a public repository and accepted on a private one', () => {
    const f = fixture('PRIVATE');
    expect(relayedRule(f).status).toBe(0);
    const full = bin(f, 'gstack-approvals', ['rulings']).stdout.trim();
    expect(full).toContain(`(relayed from ${REF})`);
    const body = bodyFile(f, `## Pre-Landing Review\n\n- ${full}\n`);
    const ok = write(f, body);
    expect(ok.status, ok.stderr).toBe(EXIT.ok);
    expect(extractReceipt(ok.stdout).receipt?.ruled_notes?.[0]?.relayed).toBe(REF);
    setGh(f, 'PUBLIC');
    const redacted = bin(f, 'gstack-approvals', ['rulings']).stdout.trim();
    const pub = write(f, bodyFile(f, `## Pre-Landing Review\n\n- ${full}\n${redacted}\n`));
    expect([pub.status, pub.stderr]).toEqual([EXIT.fail, expect.stringContaining('names a Capy thread or message id')]);
    expect(pub.stderr).not.toContain(REF);
  });

  test('an id in the ruling\'s reason reads a private message too, so the line rulings prints still writes', () => {
    const f = fixture('PUBLIC');
    expect(relayedRule(f, 'as GSTA-36:icm_01M8GG556RYA3HGG7Q12G7GP1J said').status).toBe(0);
    const line = bin(f, 'gstack-approvals', ['rulings']).stdout.trim();
    expect(line).toContain(': as a private message said (approval ');
    const w = write(f, bodyFile(f, `## Pre-Landing Review\n\n${line}\n`));
    expect(w.status, w.stderr).toBe(EXIT.ok);
    expect(extractReceipt(w.stdout).receipt?.ruled_notes?.[0]).toMatchObject({ reason: 'as a private message said', relayed: 'a private message' });
  });
});

// Value: protects=abandon marks only the PR the checkout's branch opened and keeps Capy ids out of a public runs block;
//   fails_when=abandon edits another PR's body (qm#3992 for qm#3983), or posts a <thread>:<message> or jam_ id in by or reason
//   on a public repository; seam=gstack-ship-receipt abandoned, which gstack-ship-run abandon calls
describe('abandon binds its target PR and redacts Capy ids (CAPY-1 qm#3983)', () => {
  const abandoned = (f: ShipFx, target: string[], reason = 'the run stopped answering') => bin(f, 'gstack-ship-receipt', ['abandoned', ...target, '--run', HOME_RUN, '--by', 'GStack Minder (GSTA-36)', '--reason', reason]);

  test('a PR whose head branch is not this checkout\'s is refused before any edit; the matching PR is marked', () => {
    const f = fixture('PUBLIC', '{"body":"","headRefName":"other-branch"}');
    const wrong = abandoned(f, ['--pr', '3992']);
    expect([wrong.status, wrong.stderr]).toEqual([EXIT.refused, expect.stringContaining("PR #3992's head branch is other-branch, not this checkout's feat")]);
    expect(ghLog(f)).not.toContain('pr edit');
    setGh(f, 'PUBLIC', '{"body":"","headRefName":"feat"}');
    const right = abandoned(f, ['--pr', '3983']);
    expect(right.status, right.stderr).toBe(EXIT.ok);
    expect(right.stdout).toContain('RUN_ABANDON_MARK: run=ship-4590 ');
    expect(ghLog(f)).toContain('pr edit 3983');
  });

  test('a detached HEAD or a PR gh cannot name a head branch for is refused before any edit', () => {
    const f = fixture('PUBLIC', '{"body":""}');
    const unnamed = abandoned(f, ['--pr', '3983']);
    expect([unnamed.status, unnamed.stderr]).toEqual([EXIT.refused, expect.stringContaining('gh pr view 3983 did not name its head branch')]);
    setGh(f, 'PUBLIC', '{"body":"","headRefName":"feat"}');
    f.git('checkout', '-q', '--detach');
    const detached = abandoned(f, ['--pr', '3983']);
    expect([detached.status, detached.stderr]).toEqual([EXIT.refused, expect.stringContaining('this checkout has no branch, so PR #3983 cannot be matched to it')]);
    expect(ghLog(f)).not.toContain('pr edit');
  });

  test('by and reason lose their Capy ids on a public repository and keep them on a private one', () => {
    const reason = 'owner said stop in GSTA-36:icm_01M8GG556RYA3HGG7Q12G7GP1J (jam_01abc)';
    const f = fixture('PUBLIC');
    const body = bodyFile(f);
    const pub = abandoned(f, ['--body', body], reason);
    expect(pub.status, pub.stderr).toBe(EXIT.ok);
    expect(pub.stderr).toContain('RUN_ABANDON_REDACTED:');
    expect(receiptRuns(fs.readFileSync(body, 'utf8'))).toEqual([expect.objectContaining({ mark: 'abandoned', run: 'ship-4590', by: 'GStack Minder (GSTA-36)', reason: 'owner said stop in a private message (a private message)' })]);
    const p = fixture('PRIVATE');
    const kept = bodyFile(p);
    expect(abandoned(p, ['--body', kept], reason).status).toBe(EXIT.ok);
    expect(receiptRuns(fs.readFileSync(kept, 'utf8'))[0]).toMatchObject({ reason });
  });
});
