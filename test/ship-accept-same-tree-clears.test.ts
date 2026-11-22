/**
 * GST-1627: accept's final pregate keeps the remote-lane clears recorded at the same tree. #4063 (GSTA-343) cleared
 * macos-named-regressions and windows-smoke from CI runs, then accept's final `gstack-pregate` wrote a fresh record that
 * dropped both, so accept never exited 0 and the lane re-cleared by hand. A rerun at the same tree now keeps each receipt;
 * a record for another tree keeps nothing.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PregateFile, PregateRemote } from '../lib/headless-artifacts';
import { keepSameTreeClears } from '../lib/pregate/index';
import { fakeGhScript, type FakeWorld } from './helpers/fake-gh-runs';
import { lineOf, RELEASE, shipFixture, type ShipFx } from './helpers/ship-bin-fixture';

setDefaultTimeout(120_000);
const fixtures: ShipFx[] = [];
afterEach(() => { while (fixtures.length) fixtures.pop()!.cleanup(); });

const BIN = path.dirname(RELEASE);
const FREE = "printf ' 3 pass\\n 0 fail\\nRan 3 tests across 1 file. [1.00ms]\\n' >&2";
const HOST_OS = ({ darwin: 'macOS', win32: 'Windows' } as Record<string, string>)[process.platform] ?? 'Linux';
const RUNNER = ({ darwin: 'macos-latest', win32: 'windows-latest' } as Record<string, string>)[process.platform] ?? 'ubuntu-latest';
const OTHER = process.platform === 'darwin' ? 'windows-latest' : 'macos-latest';
const LANE = 'other.yml/named-regressions';
const RUN_URL = 'https://github.com/fx/fx/actions/runs/9/attempts/1';
const TESTS = ['test/a.test.ts'];
const BASE = {
  '.gstack/pregate.json': JSON.stringify({
    run_profiles: { 'ci/free': { workflow: 'free.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['suite'], artifact: 'tested-tree', os: HOST_OS } },
    ship_lanes_from: { [FREE]: { profiles: ['ci/free'], inventory: `printf '${TESTS.join('\\n')}\\n'` } },
    dependencies: { 'src/a.ts': ['test/a.test.ts'], 'src/b.ts': ['test/a.test.ts'], 'test/**': [], '.gstack/ship-policy.json': [] },
  }, null, 2) + '\n',
  '.github/workflows/free.yml': `name: Free\non: [pull_request, workflow_dispatch]\njobs:\n  suite:\n    runs-on: ${RUNNER}\n    steps:\n      - run: bun test\n`,
  '.github/workflows/other.yml': `name: Other\non: [pull_request, workflow_dispatch]\njobs:\n  named-regressions:\n    runs-on: ${OTHER}\n    steps:\n      - run: bun test test/a.test.ts\n`,
  'test/a.test.ts': "import { expect, test } from 'bun:test';\ntest('ok', () => expect(1).toBe(1));\n",
};

/** A pushed branch with a green CI run at HEAD, and the lane's own pregate run, whose other-platform lane it then clears. */
function cleared(): ShipFx {
  const f = shipFixture(BASE, { 'src/b.ts': 'export const b = 2;\n' });
  fixtures.push(f);
  const sha = f.git('rev-parse', 'HEAD').stdout.trim();
  const tree = f.git('rev-parse', 'HEAD^{tree}').stdout.trim();
  const at = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  const run = { id: 7, run_attempt: 1, status: 'completed', conclusion: 'success', event: 'workflow_dispatch', head_sha: sha, path: '.github/workflows/free.yml', created_at: at(20), run_started_at: at(20), updated_at: at(5), repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } };
  const other = { ...run, id: 9, path: '.github/workflows/other.yml' };
  const w: FakeWorld = { runs: [run, other] as FakeWorld['runs'], jobs: { 7: [{ name: 'suite', conclusion: 'success', completed_at: at(5) }], 9: [{ name: 'named-regressions', conclusion: 'success', completed_at: at(5) }] }, trees: { 7: { run_id: 7, run_attempt: 1, event: 'workflow_dispatch', sha, tree, files: TESTS, tests: 1, os: HOST_OS } } };
  fs.writeFileSync(path.join(f.root, 'world.json'), JSON.stringify(w));
  f.gh(fakeGhScript(path.join(f.root, 'world.json')));
  expect(f.run(RELEASE, ['push', '--branch', 'feat', '--early', '--base', 'main'], { GSTACK_SESSION_KIND: 'unattended' }).status).toBe(0);
  const first = pregate(f);
  expect(first.stdout, first.stdout + first.stderr).toContain(`requires-remote: ${LANE} `);
  expect(lineOf(first.stdout, 'PREGATE')).toStartWith('PREGATE: requires-remote (1 uncleared) ');
  const clear = f.run(path.join(BIN, 'gstack-pregate'), ['clear', '--remote', LANE, '--run-url', RUN_URL]);
  expect(clear.status, clear.stdout + clear.stderr).toBe(0);
  return f;
}
const pregate = (f: ShipFx) => f.run(path.join(BIN, 'gstack-pregate'), ['--allow-repo-commands', '--base', 'main']);
const accept = (f: ShipFx) => f.run(RELEASE, ['accept', '--base', 'main', '--lane', `free=${FREE}`, '--wait', '0']);
const record = (f: ShipFx): PregateFile => JSON.parse(fs.readFileSync(path.join(f.work, '.gstack/tmp/pregate.json'), 'utf8'));

describe('accept keeps the remote-lane clears made at its tree (GST-1627)', () => {
  // Value: protects=accept exits 0 on a tree whose other-platform lane the lane already cleared from CI (#4063's macOS and Windows
  //   clears); fails_when=accept's final gstack-pregate writes a fresh record that drops the receipt and stops on requires-remote;
  //   seam=bin/gstack-pregate's run writer under gstack-ship-release accept
  test('a clear at the same tree survives accept\'s final pregate, and accept exits 0', () => {
    const f = cleared();
    const out = accept(f);
    expect([out.status, lineOf(out.stdout, 'PREGATE_CLEAR_KEPT'), lineOf(out.stdout, 'PREGATE')], out.stdout).toEqual([0,
      expect.stringMatching(new RegExp(`^PREGATE_CLEAR_KEPT: ${LANE} receipt=${RUN_URL} \\(recorded at this tree [0-9a-f]{12}; docs/pregate\\.md#same-tree-clears\\)$`)),
      'PREGATE: requires-remote cleared (final tree)']);
    expect(record(f).requires_remote?.find(r => r.lane === LANE)?.receipt).toBe(RUN_URL);
    const verify = f.run(path.join(BIN, 'gstack-pregate'), ['verify']);
    expect(verify.status, verify.stdout + verify.stderr).toBe(0);
  });

  // Value: protects=a clear binds one tree: a commit after it leaves the lane uncleared; fails_when=the writer carries a receipt
  //   onto another tree; seam=bin/gstack-pregate's run writer
  test('a different tree drops the clear', () => {
    const f = cleared();
    f.write({ 'src/b.ts': 'export const b = 3;\n' }); f.commit('a change after the clear');
    const out = pregate(f);
    expect([lineOf(out.stdout, 'PREGATE_CLEAR_KEPT'), lineOf(out.stdout, 'PREGATE')], out.stdout).toEqual(['', expect.stringMatching(/^PREGATE: requires-remote \(1 uncleared\) /)]);
    expect(record(f).requires_remote?.find(r => r.lane === LANE)?.receipt).toBeNull();
  });
});

describe('same-tree clears survive a stage run and a moved base (GST-1775)', () => {
  // GBRA-347 (gbrain#8730): after `gstack-pregate clear --run-url`, `gstack-pregate --stage tests` with no --base wrote a record
  //   against origin/HEAD, which named another PR's branch, so the clear was dropped; accept's `--base master` run then
  //   dropped every clear with no PREGATE_CLEAR_KEPT line. The policy label also names the base commit, so a base that
  //   moved between the runs dropped them too.
  // Value: protects=a clear at this head and tree survives a no --base stage run and accept's full run, and a base advance;
  //   fails_when=a stage run takes origin/HEAD over the record's base, or the policy label's base commit decides the carry;
  //   seam=bin/gstack-pregate's run writer under gstack-ship-release accept
  test('a stage run with no --base keeps the record\'s base and the clear, and accept still exits 0', () => {
    const f = cleared();
    f.git('push', '-q', 'origin', 'main:other-pr');
    f.git('fetch', '-q', 'origin');
    expect(f.git('remote', 'set-head', 'origin', 'other-pr').status).toBe(0);
    const stage = f.run(path.join(BIN, 'gstack-pregate'), ['--stage', 'tests', '--allow-repo-commands']);
    expect([stage.status, lineOf(stage.stdout, 'PREGATE_CLEAR_KEPT')], stage.stdout + stage.stderr).toEqual([0, expect.stringMatching(new RegExp(`^PREGATE_CLEAR_KEPT: ${LANE} `))]);
    expect(stage.stderr).toContain('gstack-pregate: no --base; using main, the base of the record at this head (.gstack/tmp/pregate.json), not other-pr');
    expect(record(f).base).toStartWith('origin/main@');
    const out = accept(f);
    expect([out.status, lineOf(out.stdout, 'PREGATE_CLEAR_KEPT'), lineOf(out.stdout, 'PREGATE')], out.stdout).toEqual([0,
      expect.stringMatching(new RegExp(`^PREGATE_CLEAR_KEPT: ${LANE} receipt=${RUN_URL} `)), 'PREGATE: requires-remote cleared (final tree)']);
  });

  test('a base that moved between the runs keeps the clear at the same head and tree', () => {
    const f = cleared();
    const before = record(f).policy;
    f.advanceBase({ 'README.md': '# Fx moved\n' });
    f.git('fetch', '-q', 'origin');
    const out = pregate(f);
    expect([lineOf(out.stdout, 'PREGATE_CLEAR_KEPT'), lineOf(out.stdout, 'PREGATE')], out.stdout + out.stderr).toEqual([
      expect.stringMatching(new RegExp(`^PREGATE_CLEAR_KEPT: ${LANE} receipt=${RUN_URL} `)), expect.stringMatching(/^PREGATE: requires-remote cleared /)]);
    expect(record(f).policy).not.toBe(before);
  });
});

describe('keepSameTreeClears (GST-1627)', () => {
  const obligation = (o: Partial<PregateRemote> = {}): PregateRemote => ({ lane: LANE, platform: 'macos', workflow: 'other.yml', job: 'named-regressions', tests: ['test/a.test.ts'], receipt: null, ...o });
  const file = (remote: PregateRemote[], o: Partial<PregateFile> = {}): PregateFile => ({ schema_version: 1, tree: 'a'.repeat(40), head: 'b'.repeat(40), base: 'origin/main@cccccccccccc', policy: 'base origin/main', checks: [{ id: 'lanes', status: 'requires-remote' }], requires_remote: remote, ...o });
  const prev = () => file([obligation({ receipt: RUN_URL, cleared_by: 'gstack-pregate clear 2026-11-06T00:00:00Z' })]);

  // Value: protects=a kept receipt is the same evidence for the same obligation; fails_when=it carries across a head, policy, base
  //   branch or tree change (a same-tree amend whose receipt and flaky exception were vetted against the old head), onto an obligation that now needs tests the earlier run never covered, or into a rerun whose own check failed
  //   or did not finish; seam=keepSameTreeClears
  test('keeps a receipt only for the same head, tree, policy, base branch and lane with covered tests, in a rerun that finished', () => {
    const now = file([obligation()]);
    expect(keepSameTreeClears(prev(), now)).toEqual([expect.stringMatching(/^PREGATE_CLEAR_KEPT: /)]);
    expect([now.requires_remote![0]!.receipt, now.requires_remote![0]!.cleared_by, now.verdict]).toEqual([RUN_URL, 'gstack-pregate clear 2026-11-06T00:00:00Z', 'requires-remote cleared']);
    const kept = (next: PregateFile) => { keepSameTreeClears(prev(), next); return next.requires_remote![0]!.receipt; };
    expect(kept(file([obligation()], { base: 'origin/main@dddddddddddd' }))).toBe(RUN_URL);
    for (const next of [file([obligation()], { head: 'f'.repeat(40) }), file([obligation()], { tree: 'e'.repeat(40) }), file([obligation()], { policy: 'head' }), file([obligation()], { base: 'origin/release@cccccccccccc' }),
      file([obligation({ tests: ['test/a.test.ts', 'test/b.test.ts'] })]), file([obligation({ job: 'smoke', lane: LANE })]), file([obligation({ platform: 'windows' })]), file([obligation({ command: 'node scripts/other-gate.js' })])]) {
      expect(kept(next)).toBeNull();
    }
    expect(kept(file([obligation()], { checks: [{ id: 'lanes', status: 'incomplete' }] }))).toBeNull();
    expect(keepSameTreeClears(null, file([obligation()]))).toEqual([]);
  });

  // Value: protects=the policy label's base commit never decides the carry, its source does (GST-1775); fails_when=a moved base
  //   drops the clear, or a policy from another branch, the head or a user file carries it; seam=keepSameTreeClears
  test('compares the policy source, not the base commit its label names', () => {
    const at = (policy: string, base = 'origin/main@cccccccccccc') => ({ policy, base });
    const carried = (from: { policy: string; base: string }, to: { policy: string; base: string }) => {
      const next = file([obligation()], to);
      keepSameTreeClears(file([obligation({ receipt: RUN_URL })], from), next);
      return next.requires_remote![0]!.receipt;
    };
    const main = (sha: string) => at(`origin/main@${sha}:.gstack/pregate.json`, `origin/main@${sha}`);
    expect(carried(main('cccccccccccc'), main('dddddddddddd'))).toBe(RUN_URL);
    for (const other of [at('origin/release@dddddddddddd:.gstack/pregate.json', 'origin/release@dddddddddddd'), at('head (unreviewed) .gstack/pregate.json'), at('user /home/u/.gstack/pregate.json'), at('origin/main@dddddddddddd (no .gstack/pregate.json)')]) {
      expect(carried(main('cccccccccccc'), other)).toBeNull();
    }
  });

  // Value: protects=a receipt a stamp-only substitution accepted carries only at the base commit whose stamp rules accepted it
  //   (GST-1775 cross-family read: a moved base may tighten them, and base policies carry no content digest); fails_when=the
  //   substitution carries past a moved base, or a same-base rerun drops it; seam=keepSameTreeClears
  test('a stamp-only substitution carries at the same base commit and fails closed when the base moved', () => {
    const substitution = { gated_tree: 'd'.repeat(40), accepted_for: 'a'.repeat(40), policy: 'origin/main@cccccccccccc:.gstack/ship-policy.json', files: [{ path: 'VERSION', rule: 'stamp_files' }] };
    const main = (sha: string) => ({ policy: `origin/main@${sha}:.gstack/pregate.json`, base: `origin/main@${sha}` });
    const carried = (to: { policy: string; base: string }) => {
      const next = file([obligation()], to);
      const kept = keepSameTreeClears(file([obligation({ receipt: RUN_URL, substitution })], main('cccccccccccc')), next);
      return [kept.length, next.requires_remote![0]!.receipt, next.requires_remote![0]!.substitution ?? null];
    };
    expect(carried(main('cccccccccccc'))).toEqual([1, RUN_URL, substitution]);
    expect(carried(main('dddddddddddd'))).toEqual([0, null, null]);
  });
});
