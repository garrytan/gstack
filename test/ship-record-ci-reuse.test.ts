/**
 * GST-1795: `gstack-evidence record-ci` reuses its own CI row when the label's newest ledger row already records the same
 * verified run at the same clean tree, profiles, policy and selection, instead of running the per_file remainder again.
 * harness-evals #315: /ship's Step 5 carry ran the remainder (one file takes about 7 minutes), then accept's record-ci at the
 * identical tree ran it again and hit the 600 s ci_record_timeout_s.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fakeGhScript, type FakeWorld } from './helpers/fake-gh-runs';
import { findFilesBySuffix } from './helpers/scratch-repo';
import { lineOf, PREFLIGHT, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const EVIDENCE = path.join(path.dirname(RELEASE), 'gstack-evidence');
const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

const FREE = "printf x >> ../free-runs; printf ' 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [1.00ms]\\n' >&2";
const PER = "printf '%s\\n' {files} >> ../perfile-args; printf ' 1 pass\\n 0 fail\\nRan 1 tests across 1 file. [1.00ms]\\n' >&2";
const HOST_OS = ({ darwin: 'macOS', win32: 'Windows' } as Record<string, string>)[process.platform] ?? 'Linux';
const RUNNER = ({ darwin: 'macos-latest', win32: 'windows-latest' } as Record<string, string>)[process.platform] ?? 'ubuntu-latest';
const PROFILE = { workflow: 'free.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['suite'], artifact: 'tested-tree', os: HOST_OS };
const BASE = {
  '.gstack/pregate.json': JSON.stringify({ run_profiles: { 'ci/free': PROFILE }, ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: "printf 'test/a.test.ts\\ntest/b.test.ts\\n'", per_file: PER } } }, null, 2) + '\n',
  '.github/workflows/free.yml': `name: Free\non: [pull_request, workflow_dispatch]\njobs:\n  suite:\n    runs-on: ${RUNNER}\n    steps:\n      - run: bun test\n`,
};
const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();

/** Run 7 of free.yml at HEAD, green, whose tree.json names HEAD's tree and lists test/b.test.ts as skipped entirely. */
function world(f: ShipFx, run: Record<string, unknown> = {}): void {
  const head = f.git('rev-parse', 'HEAD').stdout.trim();
  const tree = f.git('rev-parse', 'HEAD^{tree}').stdout.trim();
  const r = { id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: head, path: '.github/workflows/free.yml', created_at: at(20), run_started_at: at(20), updated_at: at(5), repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' }, ...run };
  const w: FakeWorld = {
    runs: [r] as FakeWorld['runs'],
    jobs: { [r.id as number]: [{ name: 'suite', conclusion: r.conclusion === 'success' ? 'success' : 'failure', completed_at: at(5) }] },
    trees: { [r.id as number]: { run_id: r.id, run_attempt: r.run_attempt, event: r.event, sha: head, tree, files: ['test/a.test.ts', 'test/b.test.ts'], skipped_files: ['test/b.test.ts'], tests: 12, os: HOST_OS } },
  };
  fs.writeFileSync(path.join(f.root, 'world.json'), JSON.stringify(w));
  f.gh(fakeGhScript(path.join(f.root, 'world.json')));
}
function fx(): ShipFx { const f = shipFixture(BASE); fixtures.push(f); world(f); return f; }
const recordCi = (f: ShipFx) => f.run(EVIDENCE, ['record-ci', '--label', 'free', '--base', 'main', '--', FREE]);
const perFileRuns = (f: ShipFx) => { const p = path.join(f.root, 'perfile-args'); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length : 0; };
const ledger = (f: ShipFx) => findFilesBySuffix(path.join(f.state, 'projects'), '-evidence.jsonl')[0]!;
const rows = (f: ShipFx) => fs.readFileSync(ledger(f), 'utf8').trim().split('\n').map(l => JSON.parse(l));
/** Rewrite the newest row matching `pick`, as a stale or foreign record would read. */
function tamper(f: ShipFx, pick: (r: Record<string, any>) => boolean, edit: (r: Record<string, any>) => Record<string, any>): void {
  const all = rows(f);
  const i = all.findLastIndex(pick);
  expect(i).toBeGreaterThanOrEqual(0);
  all[i] = edit(all[i]);
  fs.writeFileSync(ledger(f), all.map(r => JSON.stringify(r)).join('\n') + '\n');
}
const isCi = (r: Record<string, any>) => r.source === 'ci';
const isHere = (r: Record<string, any>) => r.label === 'free.skipped';

describe('record-ci reuses its own CI row at the same tree (GST-1795)', () => {
  // Value: protects=a second record-ci at an identical tree, run, profile, policy and selection reuses the row instead of rerunning
  //   the per_file remainder, and names the run it reused; fails_when=harness-evals #315: accept reruns a ~7-minute remainder file
  //   that Step 5 already ran at the same tree and stops at ci_record_timeout_s; seam=fake gh, gstack-evidence record-ci
  test('the second record-ci at the same tree reuses the row and runs nothing here', () => {
    const f = fx();
    const first = recordCi(f);
    expect([first.status, perFileRuns(f)], first.stderr).toEqual([0, 1]);
    const second = recordCi(f);
    expect([second.status, perFileRuns(f)], second.stderr).toEqual([0, 1]);
    expect(lineOf(second.stderr, 'CI_RECORD_REUSED')).toMatch(/^CI_RECORD_REUSED: label=free runs=7\/1 tree=[0-9a-f]{12} policy=origin\/main@/);
    expect(second.stderr).toMatch(/^gstack-evidence: recorded label=free exit=0 tests_ran=1 unit=files log=- source=ci runs=7\/1 policy=\S+ skipped_here=1 tests_ran_here=1$/m);
    expect(rows(f).filter(isCi)).toHaveLength(1);
  });

  // Value: protects=the /ship flow end to end: Step 5's carry ran the remainder, so accept at the pushed, identical tree reuses it and
  //   says so on its LANE line; fails_when=accept's record-ci runs the remainder again; seam=bin/gstack-ship-preflight, bin/gstack-ship-release accept
  test('accept after the Step 5 carry at the same tree reuses it', () => {
    const f = fx();
    const pre = f.run(PREFLIGHT, ['--tests-only', '--base', 'main', '--lane', `free=${FREE}`]);
    expect([pre.status, perFileRuns(f)], pre.stdout + pre.stderr).toEqual([0, 1]);
    expect(f.run(RELEASE, ['push', '--branch', 'feat', '--early', '--base', 'main'], { GSTACK_SESSION_KIND: 'unattended' }).status).toBe(0);
    const out = f.run(RELEASE, ['accept', '--base', 'main', '--lane', `free=${FREE}`, '--wait', '0']);
    expect(out.stdout.split('\n').find(l => l.startsWith('LANE: free ')), out.stdout + out.stderr).toMatch(/^LANE: free carried run=7\/1 tests_ran=1 \(files\) skipped_here=1 file\(s\) tests_ran_here=1 \(reused the CI record at tree [0-9a-f]{12}\)$/);
    expect(lineOf(out.stdout, 'EVIDENCE')).toStartWith('EVIDENCE: FRESH label=free');
    expect(perFileRuns(f)).toBe(1);
  });

  // Value: protects=reuse fails closed: any field that would differ in a fresh record (tree, command, profiles, policy, runs, count,
  //   selection, the remainder's local runs and their runtime) records afresh and reruns the remainder; fails_when=a stale or foreign
  //   row is reused; seam=gstack-evidence record-ci against a tampered ledger
  test.each([
    ['tree', isCi, (r: Record<string, any>) => ({ ...r, wtree: '0'.repeat(40) })],
    ['command', isCi, (r: Record<string, any>) => ({ ...r, cmd_sha256: '0'.repeat(64) })],
    ['profiles', isCi, (r: Record<string, any>) => ({ ...r, profiles: ['ci/other'] })],
    ['policy', isCi, (r: Record<string, any>) => ({ ...r, policy: 'origin/main@000000000000:.gstack/pregate.json' })],
    ['runs', isCi, (r: Record<string, any>) => ({ ...r, runs: ['6/1'] })],
    ['covered count', isCi, (r: Record<string, any>) => ({ ...r, tests_ran: 2 })],
    ['remainder selection', isCi, (r: Record<string, any>) => ({ ...r, skipped_here: { ...r.skipped_here, files: ['test/a.test.ts'] } })],
    ['age', isCi, (r: Record<string, any>) => ({ ...r, ts: at(25 * 60) })],
    ['exception', isCi, (r: Record<string, any>) => ({ ...r, exception: { approval: 'a-1', head: r.commit } })],
    ['clean flag', isCi, (r: Record<string, any>) => ({ ...r, dirty: true })],
    ['remainder runtime', isHere, (r: Record<string, any>) => ({ ...r, identity: '0'.repeat(64) })],
    ['remainder verdict', isHere, (r: Record<string, any>) => ({ ...r, exit: 1 })],
  ])('a mismatched %s records afresh', (_name, pick, edit) => {
    const f = fx();
    expect(recordCi(f).status).toBe(0);
    tamper(f, pick, edit);
    const again = recordCi(f);
    expect([again.status, perFileRuns(f), lineOf(again.stderr, 'CI_RECORD_REUSED')], again.stderr).toEqual([0, 2, '']);
  });

  // Value: protects=the run's own verdict still decides: a run that turned red (a failed rerun attempt) carries nothing even with a
  //   matching row in the ledger; fails_when=the ledger row is reused without the live check; seam=fake gh, gstack-evidence record-ci
  test('a run that is no longer green carries nothing, ledger row or not', () => {
    const f = fx();
    expect(recordCi(f).status).toBe(0);
    world(f, { run_attempt: 2, conclusion: 'failure' });
    const again = recordCi(f);
    expect([again.status, perFileRuns(f), lineOf(again.stderr, 'CI_RECORD_REUSED')], again.stderr).toEqual([1, 1, '']);
    expect(again.stderr).toMatch(/^CARRY_NONE: /m);
  });

  // Value: protects=reuse stands only on the remainder runs the CI row was written from, so a newer `.skipped` row (a zero-test rerun
  //   after a runtime change, which record-ci refuses as skipped_zero_run) never reads as the remainder's pass; fails_when=the newest
  //   exit-0 remainder row past the CI row satisfies reuse; seam=gstack-evidence record-ci against an appended ledger row
  test('a remainder run newer than the CI row vetoes reuse', () => {
    const f = fx();
    expect(recordCi(f).status).toBe(0);
    fs.appendFileSync(ledger(f), JSON.stringify({ ...rows(f).findLast(isHere)!, tests_ran: 0 }) + '\n');
    const again = recordCi(f);
    expect([again.status, perFileRuns(f), lineOf(again.stderr, 'CI_RECORD_REUSED')], again.stderr).toEqual([0, 2, '']);
  });

  // Value: protects=a newer label row (a local run of the lane after the carry) is what the ledger reads, so it vetoes reuse;
  //   fails_when=an older CI row is reused past a newer local row; seam=gstack-evidence run, record-ci
  test('a newer row for the label vetoes reuse', () => {
    const f = fx();
    expect(recordCi(f).status).toBe(0);
    expect(f.run(EVIDENCE, ['run', '--label', 'free', '--', FREE]).status).toBe(0);
    const again = recordCi(f);
    expect([again.status, perFileRuns(f), lineOf(again.stderr, 'CI_RECORD_REUSED')], again.stderr).toEqual([0, 2, '']);
  });
});
