/**
 * GST-1595 (2): a CI-carried lane whose inventory has a file no run's tree.json lists. bun registers an imported test
 * file's tests under the importer, so the imported file's JUnit suite never appears (gstack-evals #240). accept names
 * that pattern, and an owner-granted test-lane exception (gstack-approvals lane-exception, the trust path of ruled notes)
 * lets the lane carry once a local preflight of exactly those files passes at the exact head; the receipt and PR body
 * carry it. The lane itself can never write the grant.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { appendRows, buildRow, locate } from '../lib/approval-record';
import { importedTestLines } from '../lib/ci-carry';
import { EXIT } from '../lib/headless-artifacts';
import { extractReceipt } from '../lib/ship-receipt';
import { testLaneExceptionRow } from '../lib/test-lane-exception';
import { fakeGhScript, type FakeWorld } from './helpers/fake-gh-runs';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const BIN = path.dirname(RELEASE);
const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

const FREE = "printf ' 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [1.00ms]\\n' >&2";
const PROFILE = { workflow: 'free.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['suite'], artifact: 'tested-tree', os: 'Linux' };
const HELPERS = 'test/helpers.test.ts';
const PASSING = "import { expect, test } from 'bun:test';\ntest('helpers', () => expect(1).toBe(1));\n";
const FAILING = "import { expect, test } from 'bun:test';\ntest('helpers', () => expect(1).toBe(2));\n";
const BASE = {
  '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: 'ls test/*.test.ts', per_file: 'bun --no-env-file test {files}' } } }, null, 2) + '\n',
  '.github/workflows/free.yml': 'name: Free\non: [pull_request, workflow_dispatch]\njobs:\n  suite:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test\n',
  'test/a.test.ts': "import './helpers.test';\nimport { expect, test } from 'bun:test';\ntest('a', () => expect(1).toBe(1));\n",
  [HELPERS]: PASSING,
};
const NO_MIRROR = { GSTACK_APPROVALS_MIRROR: '0' };
const BUN_PLACED = `CARRY_DIAGNOSIS: bun registers ${HELPERS} under test/a.test.ts; its JUnit suite won't appear`;

/** A pushed branch whose green CI run's tree.json lists test/a.test.ts only: bun put the helpers' suite under it. */
function fx(feat: Record<string, string> = {}, ciFiles = ['test/a.test.ts']): { f: ShipFx; head: string } {
  const f = shipFixture(BASE, { 'src/b.ts': 'export const b = 2;\n', ...feat });
  fixtures.push(f);
  const head = f.git('rev-parse', 'HEAD').stdout.trim();
  const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const run = { id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: head, path: '.github/workflows/free.yml', created_at: at(20), run_started_at: at(20), updated_at: at(5), repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } };
  const w: FakeWorld = { runs: [run] as FakeWorld['runs'], jobs: { 7: [{ name: 'suite', conclusion: 'success', completed_at: at(5) }] },
    trees: { 7: { run_id: 7, run_attempt: 1, event: 'workflow_dispatch', sha: head, tree: f.git('rev-parse', 'HEAD^{tree}').stdout.trim(), files: ciFiles, tests: 2, os: 'Linux' } } };
  fs.writeFileSync(path.join(f.root, 'world.json'), JSON.stringify(w));
  f.gh(fakeGhScript(path.join(f.root, 'world.json')));
  expect(f.run(RELEASE, ['push', '--branch', 'feat', '--early', '--base', 'main'], { GSTACK_SESSION_KIND: 'unattended' }).status).toBe(0);
  return { f, head };
}
const accept = (f: ShipFx) => f.run(RELEASE, ['accept', '--base', 'main', '--lane', `free=${FREE}`, '--wait', '0'], NO_MIRROR);
const grant = (f: ShipFx, head: string, files = HELPERS, by = 'Garry (via GStack Minder)') => f.run(path.join(BIN, 'gstack-approvals'), ['lane-exception', '--head', head, '--files', files,
  '--reason', 'bun registers the helpers suite under test/a.test.ts', '--words', 'grant it for that head', '--by', by, '--json'], NO_MIRROR);

describe('inventory_uncovered names the bun import pattern (GST-1595)', () => {
  // Value: protects=the operator learns why a file is missing from tree.json instead of chasing CI; fails_when=accept stops on inventory_uncovered
  //   without naming the importer; why_new=GEVA-2 spent most of a day on #240 finding it; seam=gstack-evidence record-ci CARRY_DIAGNOSIS
  test('accept stops and names the importing test file', () => {
    const { f } = fx();
    const out = accept(f);
    expect([out.status, lineOf(out.stdout, 'CI_CARRY')]).toEqual([3, `CI_CARRY: none label=free (inventory_uncovered: 1 of 2 inventory file(s) are in no run's tree.json: ${HELPERS})`]);
    expect(out.stdout.split('\n')).toContain(BUN_PLACED);
  });

  // Value: protects=the import scan resolves relative specifiers with and without extensions, require and dynamic import, and names nothing it
  //   cannot tie to a missing file; fails_when=a missing file is blamed on the wrong importer or a self-import; seam=lib/ci-carry.ts importedTestLines
  test('importedTestLines resolves import, require and import() by relative path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imported-tests-'));
    try {
      const files: Record<string, string> = {
        'test/a.test.ts': "import { x } from './shared/b.test';\n",
        'test/c.test.js': "const y = require('../test/shared/d.test.js');\n",
        'test/e.test.ts': "await import('./f.test.ts');\nimport '../lib/unrelated';\n",
        'test/shared/b.test.ts': '', 'test/shared/d.test.js': '', 'test/f.test.ts': "import './f.test';\n", 'test/g.test.ts': '',
      };
      for (const [p, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); }
      expect(importedTestLines(dir, ['test/shared/b.test.ts', './test/shared/d.test.js', 'test/f.test.ts', 'test/g.test.ts'], Object.keys(files))).toEqual([
        'bun registers test/shared/b.test.ts under test/a.test.ts; its JUnit suite won\'t appear',
        'bun registers ./test/shared/d.test.js under test/c.test.js; its JUnit suite won\'t appear',
        'bun registers test/f.test.ts under test/e.test.ts; its JUnit suite won\'t appear',
      ]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('an owner-granted test-lane exception (GST-1595)', () => {
  // Value: protects=a granted exception at the pushed head lets the lane carry after a local preflight of exactly those files, and nothing about
  //   it is hidden: accept, the ledger, the receipt and the PR body all carry it; fails_when=the grant is ignored, the preflight is skipped, or the
  //   receipt writes without the body line; why_new=#240 had no exception path at all; seam=record-ci, accept, gstack-ship-receipt write
  test('a grant at the head with a passing preflight binds, and the receipt and PR body carry it', () => {
    const { f, head } = fx();
    expect(grant(f, head).status).toBe(0);
    const ok = accept(f);
    expect([ok.status, lineOf(ok.stdout, 'LANE')], ok.stdout).toEqual([0, 'LANE: free carried run=7/1 tests_ran=2 (files)']);
    const line = lineOf(ok.stdout, 'TEST_LANE_EXCEPTION');
    expect(line).toMatch(new RegExp(`^TEST_LANE_EXCEPTION: ${HELPERS} at ${head.slice(0, 12)}: preflight free\\.excepted ran 1 test\\(s\\) here; granted by Garry \\(via GStack Minder\\) at \\S+Z: bun registers the helpers suite under test/a\\.test\\.ts \\(approval a-[0-9a-f]{12}\\)$`));
    const bodyLine = `Test-lane exception: ${line.slice('TEST_LANE_EXCEPTION: '.length)}`;
    expect(lineOf(ok.stdout, 'NEXT')).toContain(JSON.stringify(bodyLine));
    expect(lineOf(ok.stdout, 'EVIDENCE')).toMatch(/^EVIDENCE: FRESH label=free /);

    const body = path.join(f.root, 'body.md');
    const write = () => f.run(path.join(BIN, 'gstack-ship-receipt'), ['write', '--pr', '7', '--base', 'main', '--version', '1.0.0', '--session-kind', 'unattended', '--body', body], NO_MIRROR);
    fs.writeFileSync(body, '## Summary\n\nAdds b.\n');
    const short = write();
    expect([short.status, short.stderr]).toEqual([EXIT.fail, expect.stringContaining(`does not list ${JSON.stringify(bodyLine)}`)]);
    fs.writeFileSync(body, `## Summary\n\nAdds b.\n\n${bodyLine}\n`);
    const written = write();
    expect(written.status, written.stderr).toBe(EXIT.ok);
    const receipt = extractReceipt(written.stdout);
    expect(receipt.errors).toEqual([]);
    expect(receipt.receipt?.ci_carried).toEqual([expect.objectContaining({ lane: 'free', run: 7, attempt: 1,
      exception: expect.objectContaining({ head, files: [HELPERS], by: 'Garry (via GStack Minder)', preflight: { label: 'free.excepted', tests_ran: 1 } }) })]);
  });

  // Value: protects=each excepted file must run and pass on its own, a lane CI covered none of still counts its preflighted files, and two
  //   grants at one head each keep their own file set; fails_when=a passing file masks a zero-test one in one aggregate run, a fully excepted
  //   lane grades ZERO-RUN, or a later grant at the same head replaces the one that matches; seam=record-ci's preflight and testLaneExceptions
  test('a zero-test excepted file refuses even beside a passing one', () => {
    const { f, head } = fx({ 'test/empty.test.ts': 'export const empty = true;\n' });
    expect(grant(f, head, `${HELPERS},test/empty.test.ts`).status).toBe(0);
    const out = accept(f);
    expect([out.status, lineOf(out.stdout, 'CI_CARRY')], out.stdout).toEqual([3, expect.stringMatching(/exception_preflight_failed: test-lane exception a-[0-9a-f]{12}'s preflight of test\/empty\.test\.ts (exited \d+|ran 0 tests) here/)]);
    expect(lineOf(out.stdout, 'TEST_LANE_EXCEPTION')).toBe('');
  });

  test('a lane whose every inventory file is excepted carries with its preflighted files counted', () => {
    const { f, head } = fx({}, ['test/other.test.ts']);
    expect(grant(f, head, `test/a.test.ts,${HELPERS}`).status).toBe(0);
    const ok = accept(f);
    expect([ok.status, lineOf(ok.stdout, 'LANE'), lineOf(ok.stdout, 'EVIDENCE')], ok.stdout).toEqual([0, 'LANE: free carried run=7/1 tests_ran=2 (files)', expect.stringMatching(/^EVIDENCE: FRESH label=free /)]);
  });

  test('a later grant at the same head for another file set leaves the matching grant bound', () => {
    const { f, head } = fx();
    const first = grant(f, head);
    expect(first.status).toBe(0);
    expect(grant(f, head, `${HELPERS},test/other.test.ts`).status).toBe(0);
    const ok = accept(f);
    expect([ok.status, lineOf(ok.stdout, 'TEST_LANE_EXCEPTION')], ok.stdout).toEqual([0, expect.stringContaining(`(approval ${JSON.parse(first.stdout).added[0]})`)]);
  });

  // Value: protects=the grant binds one head, one exact file set and a passing preflight only; fails_when=a grant made at an earlier head, a grant
  //   for other files, or a failing local run lets the lane carry; seam=findCarry's excepted set and record-ci's preflight
  test.each([
    ['granted at another head', {}, (f: ShipFx) => f.git('rev-parse', 'HEAD~1').stdout.trim(), HELPERS, /binds another head, not HEAD [0-9a-f]{12}/],
    ['granted for another file set', {}, (f: ShipFx) => f.git('rev-parse', 'HEAD').stdout.trim(), `${HELPERS},test/other.test.ts`, /names test\/helpers\.test\.ts, test\/other\.test\.ts, not exactly these/],
    ['whose preflight fails here', { [HELPERS]: FAILING }, (f: ShipFx) => f.git('rev-parse', 'HEAD').stdout.trim(), HELPERS, /^CI_CARRY: none label=free \(exception_preflight_failed: test-lane exception a-[0-9a-f]{12}'s preflight of test\/helpers\.test\.ts exited 1 here/],
  ] as const)('a grant %s refuses', (_what, feat, at, files, why) => {
    const { f } = fx(feat);
    expect(grant(f, at(f), files).status).toBe(0);
    const out = accept(f);
    expect([out.status, lineOf(out.stdout, 'CI_CARRY')], out.stdout).toEqual([3, expect.stringMatching(why)]);
    expect(lineOf(out.stdout, 'TEST_LANE_EXCEPTION')).toBe('');
  });

  // Value: protects=the lane cannot grant itself the exception; fails_when=gstack-approvals writes a grant inside the open /ship run, through add, or
  //   by gstack, or record-ci binds a row gstack wrote; seam=gstack-approvals lane-exception and testLaneExceptions
  test('a lane-written grant refuses: inside the open /ship run, through add, by gstack, or a row gstack wrote', () => {
    const { f, head } = fx();
    const marker = path.resolve(f.work, f.git('rev-parse', '--git-path', 'gstack-ship-run').stdout.trim());
    fs.writeFileSync(marker, 'ship-1595-abc\n');
    const inRun = grant(f, head);
    expect([inRun.status, inRun.stderr]).toEqual([EXIT.usage, expect.stringContaining('/ship run ship-1595-abc is open on this checkout')]);
    fs.rmSync(marker);
    const add = f.run(path.join(BIN, 'gstack-approvals'), ['add', '--ask', 'exception', '--words', 'yes', '--by', 'Garry', '--scope', `test_lane_exception ${head} ${HELPERS}`], NO_MIRROR);
    expect([add.status, add.stderr]).toEqual([EXIT.usage, expect.stringContaining('gstack-approvals lane-exception')]);
    const self = grant(f, head, HELPERS, 'gstack ship lane');
    expect([self.status, self.stderr]).toEqual([EXIT.usage, expect.stringContaining('--by names gstack')]);
    const loc = locate({ cwd: f.work, env: { ...process.env, GSTACK_STATE_ROOT: f.state, GSTACK_HOME: f.state, ...NO_MIRROR } });
    const row = buildRow({ ...testLaneExceptionRow(head, [HELPERS], 'the lane says so'), words: 'granted', by: 'gstack ship lane' }, 'feat');
    if ('code' in loc || 'code' in row) throw new Error('fixture record unavailable');
    expect(appendRows(loc, [row])).not.toHaveProperty('code');
    expect(JSON.parse(f.run(path.join(BIN, 'gstack-approvals'), ['list', '--json'], NO_MIRROR).stdout).rows.map((r: { by: string }) => r.by)).toEqual(['gstack ship lane']);
    const out = accept(f);
    expect([out.status, lineOf(out.stdout, 'CI_CARRY')]).toEqual([3, expect.stringContaining('inventory_uncovered')]);
    expect(lineOf(out.stdout, 'TEST_LANE_EXCEPTION')).toBe('');
  });
});
