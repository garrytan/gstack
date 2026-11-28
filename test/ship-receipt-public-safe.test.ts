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
import { bunIsolationArgs } from '../lib/bun-isolation';
import { EXIT } from '../lib/headless-artifacts';
import { INTERNAL_ID, redactInternalIds } from '../lib/ruled-notes';
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
/** gh pr view's answer for an open PR whose head is `branch` on `owner`/fx (the fixture's origin is github.com/fx/fx) and whose body records run ship-4590's started stub. */
const VIEW = (branch: string, owner = 'fx', o: { state?: string; body?: string } = {}) => JSON.stringify({ body: o.body ?? runsBody({ head: H, run: 'ship-4590', status: 'started', review_loop: LOOP }), headRefName: branch, headRepository: { name: 'fx' }, headRepositoryOwner: { login: owner }, state: o.state ?? 'OPEN' });
const VIEW_FEAT = VIEW('feat');

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
  `if [ "$1" = pr ] && [ "$2" = view ]; then printf '%s\\n' '${view}'; exit 0; fi`,
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
    expect(publicReceiptLeaks({ reason: 'see icm_01M8GG556RYA3HGG7Q12G7GP1J', note: 'iev_01M8GG5564BWTXRD3PP941B4PD', gate: { '/home/user/.capy/work/ev.json': true, 'jam_01abc': 1, tests: { pass: 3 } } })).toEqual([
      'reason (a Capy thread or message id)', 'note (a Capy thread or message id)', 'gate.<key 0> (a home path or Capy id in a key)', 'gate.<key 1> (a home path or Capy id in a key)',
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
    const f = fixture('PUBLIC', VIEW('other-branch'));
    const wrong = abandoned(f, ['--pr', '3992']);
    expect([wrong.status, wrong.stderr]).toEqual([EXIT.refused, expect.stringContaining("PR #3992's head branch is other-branch, not this checkout's feat")]);
    expect(ghLog(f)).not.toContain('pr edit');
    setGh(f, 'PUBLIC', VIEW_FEAT);
    const right = abandoned(f, ['--pr', '3983']);
    expect(right.status, right.stderr).toBe(EXIT.ok);
    expect(right.stdout).toContain('RUN_ABANDON_MARK: run=ship-4590 ');
    expect(ghLog(f)).toContain('pr edit 3983');
  });

  test('a detached HEAD or a PR gh cannot name a head branch for is refused before any edit', () => {
    const f = fixture('PUBLIC', '{"body":""}');
    const unnamed = abandoned(f, ['--pr', '3983']);
    expect([unnamed.status, unnamed.stderr]).toEqual([EXIT.refused, expect.stringContaining('gh pr view 3983 did not name its head branch and repository')]);
    setGh(f, 'PUBLIC', VIEW_FEAT);
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

// Value: protects=the privacy decision follows the repository the text is published to, an explicit --repo included; fails_when=a
//   private checkout lets write or abandon publish Capy ids to a public --repo; seam=repoVisibility's target in keepsInternalIds
//   and write's refusal
describe('visibility is read for the --repo a command publishes to (#4868 second-model review)', () => {
  const targetGh = (f: ShipFx) => f.gh([
    'if [ "$1" = repo ]; then case "$*" in *acme/pub*) echo PUBLIC;; *) echo PRIVATE;; esac; exit 0; fi',
    `if [ "$1" = pr ] && [ "$2" = view ]; then echo '${VIEW_FEAT}'; exit 0; fi`,
    'exit 0',
  ].join('\n'));

  test('write refuses a Capy id for a public --repo from a private checkout, and keeps it without one', () => {
    const f = fixture('PRIVATE');
    targetGh(f);
    const body = bodyFile(f);
    const pub = write(f, body, ['--thread', 'jam_01abc', '--repo', 'acme/pub']);
    expect([pub.status, pub.stderr]).toEqual([EXIT.fail, expect.stringContaining('thread (a Capy thread or message id)')]);
    const priv = write(f, body, ['--thread', 'jam_01abc']);
    expect(priv.status, priv.stderr).toBe(EXIT.ok);
  });

  test('abandon redacts for a public --repo even when the checkout is private', () => {
    const f = fixture('PRIVATE');
    targetGh(f);
    const body = bodyFile(f);
    expect(bin(f, 'gstack-ship-receipt', ['abandoned', '--body', body, '--repo', 'acme/pub', '--run', 'ship-1', '--by', 'GStack Minder (GSTA-36)', '--reason', 'per GSTA-36:icm_01abc']).status).toBe(EXIT.ok);
    expect(receiptRuns(fs.readFileSync(body, 'utf8'))[0]).toMatchObject({ reason: 'per a private message' });
  });
});

// Value: protects=abandon binds the PR to this checkout's origin repository as well as its branch; fails_when=a fork's PR from a
//   branch of the same name is marked (headRefName names no repository); seam=prOffBranch in gstack-ship-receipt abandoned
describe('abandon refuses a fork PR with the same branch name (#4868 second-model review)', () => {
  test('a head on another owner\'s repository is refused before any edit', () => {
    const f = fixture('PUBLIC', VIEW('feat', 'someone-else'));
    const r = bin(f, 'gstack-ship-receipt', ['abandoned', '--pr', '3983', '--run', 'ship-1', '--by', 'GStack Minder (GSTA-36)', '--reason', 'stopped']);
    expect([r.status, r.stderr]).toEqual([EXIT.refused, expect.stringContaining("PR #3983's head is on someone-else/fx, not this checkout's origin fx/fx")]);
    expect(ghLog(f)).not.toContain('pr edit');
  });
});

// Value: protects=carry stores the run dir name and never republishes a Capy id on a public repository; fails_when=a carried
//   receipt keeps an older write's /home/... run or jam_ thread; seam=gstack-ship-receipt carry before postBody
describe('carry normalizes the run and refuses a public receipt that still holds a Capy id (#4868 second-model review)', () => {
  const carryFixture = (vis: 'PUBLIC' | 'PRIVATE', extra: Record<string, unknown>) => {
    const f = fixture(vis);
    const reviewed = f.git('rev-parse', 'HEAD').stdout.trim();
    f.write({ 'test/x.test.ts': "import { expect, test } from 'bun:test';\ntest('x', () => { expect(1).toBe(1); });\n" }); f.commit('test: add x');
    const body = bodyFile(f, placeReceipt('## Summary\n\nA change.\n', { schema_version: 1, pr: 5, head: reviewed, base: 'main', queue_mode: 'stamp-at-merge', review_loop: LOOP, ...extra } as any));
    return { f, body, carry: () => bin(f, 'gstack-ship-receipt', ['carry', '--body', body]) };
  };

  test('an older receipt\'s full-path run carries as the run dir name', () => {
    const { body, carry } = carryFixture('PUBLIC', { run: HOME_RUN });
    const r = carry();
    expect(r.status, r.stderr + r.stdout).toBe(EXIT.ok);
    expect(extractReceipt(fs.readFileSync(body, 'utf8')).receipt?.run).toBe('ship-4590');
    expect(fs.readFileSync(body, 'utf8')).not.toContain('/home/');
  });

  test('a jam_ thread is refused on a public repository and carried on a private one', () => {
    const pub = carryFixture('PUBLIC', { run: 'ship-1', thread: 'jam_01abc' });
    const before = fs.readFileSync(pub.body, 'utf8');
    const r = pub.carry();
    expect([r.status, r.stderr + r.stdout]).toEqual([EXIT.refused, expect.stringContaining('thread (a Capy thread or message id)')]);
    expect(fs.readFileSync(pub.body, 'utf8')).toBe(before);
    const priv = carryFixture('PRIVATE', { run: 'ship-1', thread: 'jam_01abc' });
    expect(priv.carry().status).toBe(EXIT.ok);
  });
});

// Value: protects=a public-repo PR carrying a Captain's relayed ruling and gate disposition writes a clean public-safe receipt, with
//   rulings, dispositions, finish and write rendering the same lines; fails_when=write deadlocks (the body line it requires holds an
//   id its leak check refuses) or any of them prints a Capy id; seam=repoRuledNotes and publicGateDisposition
describe('a Captain ruling and gate disposition on a public repository write cleanly (#4868 second-model review)', () => {
  test('GStack Minder (GSTA-36) relays both with Capy ids in its words; every public line reads a private message', () => {
    const f = fixture('PUBLIC');
    const head = f.git('rev-parse', 'HEAD').stdout.trim();
    const by = 'GStack Minder (GSTA-36)', relay = 'GSTA-36:icm_01M8GG556RYA3HGG7Q12G7GP1J';
    expect(bin(f, 'gstack-approvals', ['rule', '--finding', 'src/x.ts:1:edit-share-race', '--head', head, '--reason', `ships as a note per ${relay}`, '--words', 'A1', '--by', by, '--owner-ref', relay]).status).toBe(0);
    const g = bin(f, 'gstack-approvals', ['gate', '--finding', 'tests/x.test.ts:3:gate-integrity', '--gate-id', '69c7c3432501', '--head', head, '--reason', 'kept as the owner ruled', '--words', `do it (${relay})`, '--by', by]);
    expect(g.status, g.stderr).toBe(0);
    const rulings = bin(f, 'gstack-approvals', ['rulings']).stdout.trim(), dispositions = bin(f, 'gstack-approvals', ['dispositions']).stdout.trim();
    expect(rulings).toContain(`ruled by ${by} (relayed from a private message) at `);
    expect(rulings).toContain(': ships as a note per a private message (approval ');
    expect(dispositions).toContain(`by ${by} at `);
    expect(dispositions).toContain('"do it (a private message)"');
    const body = bodyFile(f, `## Pre-Landing Review\n\n${rulings}\n${dispositions}\n`);
    const w = write(f, body);
    expect(w.status, w.stderr).toBe(EXIT.ok);
    const text = fs.readFileSync(body, 'utf8');
    expect(text).not.toMatch(/icm_|jam_|GSTA-36:/);
    expect(extractReceipt(text).receipt?.gate_dispositions?.[0]).toMatchObject({ by, words: 'do it (a private message)' });
  });
});

// Value: protects=INTERNAL_ID keeps every Capy id and relay ref it caught while look-alike text (hashes, encodings, issue refs, file
//   names) stops reading as one; fails_when=SHA-256:abc, UTF-8:x, PR-12:fix, A-1:b or test/jam_fix.ts is refused or redacted on a
//   public repository, or any earlier catch slips through; seam=lib/ruled-notes.ts INTERNAL_ID, redactInternalIds, publicReceiptLeaks
describe('INTERNAL_ID leaves look-alike text alone and keeps every Capy id catch (GST-4105)', () => {
  const caught = ['jam_01abc', 'icm_01M8GG556RYA3HGG7Q12G7GP1J', 'iev_01M8GG5564BWTXRD3PP941B4PD', 'GSTA-36:icm_01M8GG556RYA3HGG7Q12G7GP1J', 'per GSTA-36:icm_01abc',
    REF, 'GSTA-36:2026-11-28T09:28Z', 'GSTA-36:2026-11-19', 'GSTA-36:1732790000', 'ends GSTA-36:1732790000.', 'GSTA-36:iev_01abc', '(jam_01abc)', 'see .capy/work/jam_01M8GSKHFHTDZWPHJVG6ZVJ3D4/x', 'ids/icm_01M8GG556RYA3HGG7Q12G7GP1J'];
  const text = ['SHA-256:abc', 'SHA-256:1234567890abcdef', 'UTF-8:x', 'PR-12:fix', 'A-1:b', 'test/jam_fix.ts', 'GStack Minder (GSTA-36)', 'my_jam_fix', 'approval a-315e17d615b1', 'lib/icm_parse.ts'];

  test('each earlier catch still matches and each look-alike does not', () => {
    expect(caught.filter(s => !INTERNAL_ID.test(s))).toEqual([]);
    expect(text.filter(s => INTERNAL_ID.test(s))).toEqual([]);
  });

  test('redaction replaces only the ids, and a receipt holding only look-alikes has no leak', () => {
    expect(redactInternalIds('SHA-256:abc and UTF-8:x per GSTA-36:icm_01abc in test/jam_fix.ts (jam_01abc), PR-12:fix at GBRA-108:2026-11-19T12:29:59Z'))
      .toBe('SHA-256:abc and UTF-8:x per a private message in test/jam_fix.ts (a private message), PR-12:fix at a private message');
    expect(publicReceiptLeaks({ reason: text.join(' '), gate: { 'PR-12:fix': 1, 'test/jam_fix.ts': true } })).toEqual([]);
    expect(publicReceiptLeaks({ reason: 'see GSTA-36:2026-11-28T09:28Z', note: 'x/jam_01M8GSKHFHTDZWPHJVG6ZVJ3D4' })).toEqual(['reason (a Capy thread or message id)', 'note (a Capy thread or message id)']);
  });

  test('a relay ref INTERNAL_ID does not match still reads a private message on a public repository, and its old body line is refused', () => {
    const f = fixture('PRIVATE');
    const rule = bin(f, 'gstack-approvals', ['rule', '--finding', 'src/x.ts:1:edit-share-race', '--head', f.git('rev-parse', 'HEAD').stdout.trim(), '--reason', 'ships as a disclosed note', '--words', 'B, note it', '--by', 'GBrain Minder (GBRA-108)', '--owner-ref', 'GBRA-108:fix']);
    expect(rule.status, rule.stderr).toBe(0);
    const full = bin(f, 'gstack-approvals', ['rulings']).stdout.trim();
    expect(full).toContain('(relayed from GBRA-108:fix)');
    setGh(f, 'PUBLIC');
    const redacted = bin(f, 'gstack-approvals', ['rulings']).stdout.trim();
    expect(redacted).toContain('(relayed from a private message)');
    const stale = write(f, bodyFile(f, `## Pre-Landing Review\n\n${full}\n${redacted}\n`));
    expect([stale.status, stale.stderr]).toEqual([EXIT.fail, expect.stringContaining('names a Capy thread or message id or relays from a ref')]);
    const clean = write(f, bodyFile(f, `## Pre-Landing Review\n\n${redacted}\n`));
    expect(clean.status, clean.stderr).toBe(EXIT.ok);
  });

  test('a reason that says relayed from in its own words is no relay, so the line rulings prints writes on a public repository', () => {
    const f = fixture('PUBLIC');
    const rule = bin(f, 'gstack-approvals', ['rule', '--finding', 'src/x.ts:1:edit-share-race', '--head', f.git('rev-parse', 'HEAD').stdout.trim(), '--reason', 'kept as is (relayed from the owner) for now', '--words', 'B, note it', '--by', 'GBrain Minder (GBRA-108)']);
    expect(rule.status, rule.stderr).toBe(0);
    const line = bin(f, 'gstack-approvals', ['rulings']).stdout.trim();
    expect(line).toContain(': kept as is (relayed from the owner) for now (approval ');
    const w = write(f, bodyFile(f, `## Pre-Landing Review\n\n${line}\n`));
    expect(w.status, w.stderr).toBe(EXIT.ok);
  });
});

// Value: protects=a hand-edited runs block never throws the round count and a repeated mark is placed once; fails_when=a non-string
//   run throws in prReviewHistory, or the same abandon mark lands twice because one side holds the run dir path; seam=lib/pr-review-history.ts
describe('the runs block reads hand-edited entries safely (GST-4105)', () => {
  test('a non-string run counts as its own entry instead of throwing', () => {
    const body = runsBody({ head: H, run: 42, review_loop: LOOP }, { head: H, run: { dir: 'ship-1' }, review_loop: LOOP }, { head: H, run: 'ship-2', review_loop: LOOP });
    expect(prReviewHistory(body)).toMatchObject({ rounds: 3, runs: 3 });
  });

  test('a mark already in the block is not placed again when one side holds the run dir path', () => {
    const mark = { head: H, run: 'ship-4590', mark: 'abandoned' as const, by: 'GStack Minder (GSTA-36)', reason: 'stopped' };
    const body = runsBody(mark);
    expect(placeRunEntry(body, { ...mark, run: HOME_RUN })).toBe(body);
    const fromPath = runsBody({ ...mark, run: HOME_RUN });
    expect(placeRunEntry(fromPath, mark)).toBe(fromPath);
    expect(receiptRuns(placeRunEntry(body, { ...mark, reason: 'other' }))).toHaveLength(2);
  });
});

// Value: protects=a private repository's PR body written before GST-1955 still lands while a public one must carry the redacted line;
//   fails_when=the queue refuses the legacy unredacted line on a private repository, or accepts it on a public one;
//   seam=gateAcceptance (lib/gate-dispositions.ts), the check land, verify and ready share
describe('the queue takes a private repository\'s legacy gate disposition line (GST-4105)', () => {
  test('private accepts the legacy and the redacted line; public accepts only the redacted line', () => {
    const f = fixture('PRIVATE');
    const head = f.git('rev-parse', 'HEAD').stdout.trim();
    const g = bin(f, 'gstack-approvals', ['gate', '--finding', 'tests/x.test.ts:3:gate-integrity', '--gate-id', '69c7c3432501', '--head', head, '--reason', 'kept as the owner ruled', '--words', 'do it (GSTA-36:icm_01M8GG556RYA3HGG7Q12G7GP1J)', '--by', 'GStack Minder (GSTA-36)']);
    expect(g.status, g.stderr).toBe(0);
    const redacted = bin(f, 'gstack-approvals', ['dispositions']).stdout.trim();
    expect(redacted).toContain('"do it (a private message)"');
    const script = path.join(f.root, 'accept.ts');
    fs.writeFileSync(script, [
      "import * as fs from 'node:fs';",
      `import { appliedGateDispositions, gateAcceptance } from ${JSON.stringify(path.join(path.dirname(BIN), 'lib', 'gate-dispositions.ts'))};`,
      'const [head, mode, file] = process.argv.slice(2) as [string, string, string];',
      'const { applied } = appliedGateDispositions(process.cwd(), { pin: head });',
      "if (mode === 'show') { console.log(JSON.stringify(applied)); process.exit(0); }",
      "const r = gateAcceptance({ cwd: process.cwd(), branch: 'feat', pin: head, body: fs.readFileSync(file, 'utf8'), receipt: { gate_dispositions: applied } as any });",
      "console.log(r.failure?.message ?? 'ok');",
    ].join('\n'));
    const accept = (mode: string, file = '') => f.run(process.execPath, [...bunIsolationArgs(), script, head, mode, file], { GSTACK_APPROVALS_MIRROR: '0' });
    const shown = accept('show');
    expect(shown.status, shown.stderr).toBe(0);
    const [d] = JSON.parse(shown.stdout) as Array<Record<string, string>>;
    const legacy = `Gate disposition: ${d!.finding} [gate ${d!.gate_id}] at ${d!.head!.slice(0, 12)} by ${d!.by} at ${d!.at}: ${d!.reason} — "${d!.words}" (approval ${d!.approval})`;
    expect(legacy).toContain('GSTA-36:icm_');
    const legacyBody = bodyFile(f, `## Summary\n\n${legacy}\n`), redactedBody = path.join(f.root, 'redacted.md');
    fs.writeFileSync(redactedBody, `## Summary\n\n${redacted}\n`);
    expect([accept('check', legacyBody).stdout.trim(), accept('check', redactedBody).stdout.trim()]).toEqual(['ok', 'ok']);
    setGh(f, 'PUBLIC');
    expect(accept('check', legacyBody).stdout.trim()).toContain('the PR body lacks the line "Gate disposition: ');
    expect(accept('check', redactedBody).stdout.trim()).toBe('ok');
  });
});

// Value: protects=the runs block write, carry and abandon post is scanned like the receipt, so a hand-written home path or Capy id in
//   an earlier entry or an abandon reason never publishes on a public repository; fails_when=write, carry or abandon posts one;
//   seam=runsBlockLeaks in gstack-ship-receipt write, carry and abandoned
describe('the rendered runs block is scanned before it publishes (GST-4105)', () => {
  const handWritten = { head: H, run: 'ship-1', mark: 'abandoned', by: 'GStack Minder (GSTA-36)', reason: 'logs in /home/user/.capy/work/ship-1' };

  test('write refuses a body whose runs block holds a home path on a public repository and writes it on a private one', () => {
    const f = fixture('PUBLIC');
    const body = bodyFile(f, '## Summary\n\nA change.\n\n' + runsBody(handWritten));
    const before = fs.readFileSync(body, 'utf8');
    const pub = write(f, body, ['--run', 'ship-2']);
    expect([pub.status, pub.stderr]).toEqual([EXIT.fail, expect.stringContaining(`runs block holds ${RUNS_FENCE}[0].reason (a home path)`)]);
    expect(pub.stderr).toContain('(RECEIPT_INVALID)');
    expect(pub.stderr).not.toContain('/home/user');
    expect(fs.readFileSync(body, 'utf8')).toBe(before);
    setGh(f, 'PRIVATE');
    const priv = write(f, body, ['--run', 'ship-2']);
    expect(priv.status, priv.stderr).toBe(EXIT.ok);
    expect(receiptRuns(fs.readFileSync(body, 'utf8'))).toEqual([expect.objectContaining({ reason: handWritten.reason })]);
  });

  test('carry refuses a public body whose runs block holds a Capy id', () => {
    const f = fixture('PUBLIC');
    const reviewed = f.git('rev-parse', 'HEAD').stdout.trim();
    f.write({ 'test/x.test.ts': "import { expect, test } from 'bun:test';\ntest('x', () => { expect(1).toBe(1); });\n" }); f.commit('test: add x');
    const body = bodyFile(f, placeReceipt('## Summary\n\nA change.\n\n' + runsBody({ ...handWritten, reason: 'per jam_01abc' }), { schema_version: 1, pr: 5, head: reviewed, base: 'main', queue_mode: 'stamp-at-merge', run: 'ship-2', review_loop: LOOP } as any));
    const before = fs.readFileSync(body, 'utf8');
    const r = bin(f, 'gstack-ship-receipt', ['carry', '--body', body]);
    expect([r.status, r.stderr + r.stdout]).toEqual([EXIT.refused, expect.stringContaining(`${RUNS_FENCE}[0].reason (a Capy thread or message id)`)]);
    expect(fs.readFileSync(body, 'utf8')).toBe(before);
  });

  test('abandon refuses a home path in its reason on a public repository and keeps it on a private one', () => {
    const args = ['abandoned', '--run', 'ship-1', '--by', 'GStack Minder (GSTA-36)', '--reason', 'see /home/user/.capy/work/ship-1/log'];
    const f = fixture('PUBLIC');
    const body = bodyFile(f);
    const pub = bin(f, 'gstack-ship-receipt', [...args, '--body', body]);
    expect([pub.status, pub.stderr]).toEqual([EXIT.refused, expect.stringContaining(`${RUNS_FENCE}[0].reason (a home path)`)]);
    expect(fs.readFileSync(body, 'utf8')).toBe('## Summary\n\nA change.\n');
    const p = fixture('PRIVATE');
    const kept = bodyFile(p);
    expect(bin(p, 'gstack-ship-receipt', [...args, '--body', kept]).status).toBe(EXIT.ok);
    expect(receiptRuns(fs.readFileSync(kept, 'utf8'))[0]).toMatchObject({ reason: 'see /home/user/.capy/work/ship-1/log' });
  });

  test('abandon checks its own entry even when a runs block quoted above the Agent notes is the one it would edit', () => {
    const args = ['abandoned', '--run', 'ship-1', '--by', 'GStack Minder (GSTA-36)', '--reason', 'see /home/user/.capy/work/ship-1/log'];
    const f = fixture('PUBLIC');
    const text = '## Summary\n\n\`\`\`' + RUNS_FENCE + '\n' + JSON.stringify({ head: H, run: 'ship-0', review_loop: LOOP }) + '\n\`\`\`\n\n' + runsBody({ head: H, run: 'ship-1', status: 'started', review_loop: LOOP });
    const body = bodyFile(f, text);
    const pub = bin(f, 'gstack-ship-receipt', [...args, '--body', body]);
    expect([pub.status, pub.stderr]).toEqual([EXIT.refused, expect.stringContaining('abandon.reason (a home path)')]);
    expect(fs.readFileSync(body, 'utf8')).toBe(text);
  });
});

// Value: protects=abandon marks only an open PR that records the run, on the repository the branch pushes to; fails_when=a merged or
//   closed PR, a PR with no entry for the run, or a contributor's fork PR (origin is upstream) is handled wrongly;
//   seam=prOffBranch and the run-entry check in gstack-ship-receipt abandoned
describe('abandon needs an open PR that records the run, on the branch\'s push remote (GST-4105)', () => {
  const abandon = (f: ShipFx, pr = '3983') => bin(f, 'gstack-ship-receipt', ['abandoned', '--pr', pr, '--run', HOME_RUN, '--by', 'GStack Minder (GSTA-36)', '--reason', 'stopped answering']);

  test('a merged or closed PR is refused before any edit', () => {
    for (const state of ['MERGED', 'CLOSED']) {
      const f = fixture('PUBLIC', VIEW('feat', 'fx', { state }));
      const r = abandon(f);
      expect([r.status, r.stderr]).toEqual([EXIT.refused, expect.stringContaining(`PR #3983 is ${state.toLowerCase()}, not open`)]);
      expect(ghLog(f)).not.toContain('pr edit');
    }
  });

  test('a PR whose body records no entry for the run is refused; one with its stop record is marked', () => {
    const f = fixture('PUBLIC', VIEW('feat', 'fx', { body: runsBody({ head: H, run: 'ship-9', status: 'started', review_loop: LOOP }) }));
    const r = abandon(f);
    expect([r.status, r.stderr]).toEqual([EXIT.refused, expect.stringContaining("PR #3983's body records no entry for run ship-4590")]);
    expect(ghLog(f)).not.toContain('pr edit');
    setGh(f, 'PUBLIC', VIEW('feat', 'fx', { body: runsBody({ head: H, run: HOME_RUN, mark: 'stop', tree: 'b'.repeat(40), at: '2026-11-28T09:28:00Z' }) }));
    const ok = abandon(f);
    expect(ok.status, ok.stderr).toBe(EXIT.ok);
    expect(ghLog(f)).toContain('pr edit 3983');
  });

  test('a contributor whose branch pushes to a fork marks the fork PR and refuses the upstream one', () => {
    const f = fixture('PUBLIC', VIEW('feat', 'me'));
    f.git('remote', 'add', 'fork', 'https://github.com/me/fx.git');
    f.git('config', 'branch.feat.pushRemote', 'fork');
    const ok = abandon(f);
    expect(ok.status, ok.stderr).toBe(EXIT.ok);
    expect(ghLog(f)).toContain('pr edit 3983');
    setGh(f, 'PUBLIC', VIEW('feat', 'fx'));
    const upstream = abandon(f, '3984');
    expect([upstream.status, upstream.stderr]).toEqual([EXIT.refused, expect.stringContaining("PR #3984's head is on fx/fx, not this checkout's push remote fork me/fx")]);
    expect(ghLog(f)).not.toContain('pr edit 3984');
  });

  test('origin\'s pushurl names the fork, and a branch that only tracks another remote still pushes to origin', () => {
    const f = fixture('PUBLIC', VIEW('feat', 'me'));
    f.git('config', 'remote.origin.pushurl', 'https://github.com/me/fx.git');
    const fork = abandon(f);
    expect(fork.status, fork.stderr).toBe(EXIT.ok);
    f.git('config', '--unset', 'remote.origin.pushurl');
    f.git('remote', 'add', 'upstream', 'https://github.com/up/fx.git');
    f.git('config', 'branch.feat.remote', 'upstream');
    setGh(f, 'PUBLIC', VIEW('feat', 'fx'));
    const tracked = abandon(f, '3985');
    expect(tracked.status, tracked.stderr).toBe(EXIT.ok);
    expect(ghLog(f)).toContain('pr edit 3985');
  });
});

