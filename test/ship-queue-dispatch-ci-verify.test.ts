/**
 * gstack-ship-queue ready --dispatch-ci clears through the run verifier (GSTA-156 P3b): a lane the base branch
 * profiles is cleared only by a run lib/run-evidence.ts verifies on pregate.json's tree, so a run whose newest
 * attempt is red, or a run on another tree, clears nothing and refuses; a lane with no profile records the URL as
 * before. gh and the Actions API are fakes; trees come from a fixture repository.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PregateFile } from '../lib/headless-artifacts';
import type { RunCheck } from '../lib/pregate/index';
import type { ApiRun, RunProfile } from '../lib/run-evidence';
import { dispatchCi } from '../lib/ship-queue-dispatch-ci';
import { cleanup, commit, makeFixtureRepo, type FixtureRepo } from './helpers/pregate-fixture';

const LANE = 'windows-free-tests.yml/windows-free-shard';
const OTHER = 'free-tests.yml/cso-docker-integration';
const NOW = new Date('2026-10-30T12:00:00Z');
const PROFILE: RunProfile = { workflow: 'windows-free-tests.yml', events: ['pull_request', 'workflow_dispatch'], jobs: ['windows-plan', 'windows-free-tests'], artifact: 'tested-tree', os: 'Windows' };
const repos: FixtureRepo[] = [];
const savedRoot = process.env.GSTACK_STATE_ROOT;
afterEach(() => {
  while (repos.length) cleanup(repos.pop()!);
  if (savedRoot === undefined) delete process.env.GSTACK_STATE_ROOT; else process.env.GSTACK_STATE_ROOT = savedRoot;
});

interface Scene { listed?: string; apiConclusion?: string; runOnParent?: boolean; error?: { error: string; profiled?: boolean } }
async function scene(s: Scene = {}) {
  const repo = makeFixtureRepo();
  repos.push(repo);
  process.env.GSTACK_STATE_ROOT = repo.home;
  const parent = repo.git('rev-parse', 'HEAD');
  if (s.runOnParent) commit(repo, { 'lib/util.js': 'exports.add = (a, b) => a + b + 0;\n' }, 'a real change after the run');
  const head = repo.git('rev-parse', 'HEAD');
  const runHead = s.runOnParent ? parent : head;
  const tree = repo.git('rev-parse', 'HEAD^{tree}');
  const pregate = path.join(repo.work, '.gstack', 'tmp', 'pregate.json');
  fs.mkdirSync(path.dirname(pregate), { recursive: true });
  const lane = (l: string, workflow: string) => ({ lane: l, platform: 'windows', workflow, job: l.split('/')[1]!, tests: ['test/util.test.js'], receipt: null });
  const file: PregateFile = { schema_version: 1, tree, head, verdict: 'requires-remote (2 uncleared)', checks: [{ id: 'lanes', status: 'requires-remote' }], requires_remote: [lane(LANE, 'windows-free-tests.yml'), lane(OTHER, 'free-tests.yml')] };
  fs.writeFileSync(pregate, JSON.stringify(file));
  const url = (id: number) => `https://github.com/fx/fx/actions/runs/${id}`;
  const listed = (wf: string) => [{ databaseId: wf === 'windows-free-tests.yml' ? 100 : 101, url: url(wf === 'windows-free-tests.yml' ? 100 : 101), status: 'completed', conclusion: wf === 'windows-free-tests.yml' ? s.listed ?? 'success' : 'success', headSha: head }];
  const gh = (args: string[]) => {
    if (args[0] === 'pr') return { ok: true, out: JSON.stringify({ headRefOid: head, isCrossRepository: false, state: 'OPEN', headRefName: 'pr-1' }), err: '' };
    if (args[0] === 'repo') return { ok: true, out: JSON.stringify({ nameWithOwner: 'fx/fx' }), err: '' };
    if (args[0] === 'run' && args[1] === 'list') return { ok: true, out: JSON.stringify(listed(args[args.indexOf('--workflow') + 1]!)), err: '' };
    return { ok: false, out: '', err: `unexpected gh ${args.join(' ')}` };
  };
  const api = (id: number): ApiRun => ({ id, run_attempt: 1, status: 'completed', conclusion: s.apiConclusion ?? 'success', event: 'workflow_dispatch', head_sha: runHead, path: '.github/workflows/windows-free-tests.yml', created_at: '2026-10-30T10:00:00Z', updated_at: '2026-10-30T10:30:00Z', repository: { full_name: 'fx/fx' }, head_repository: { full_name: 'fx/fx' } });
  const check: RunCheck = {
    repo: 'fx/fx', profiles: { [LANE]: PROFILE }, gateRuns: null, now: NOW, inventory: () => ({ error: 'unused' }),
    deps: {
      run: api, runsForHead: (_wf, sha) => (sha === runHead ? [api(100)] : []),
      jobs: () => [{ name: 'windows-plan', conclusion: 'success' }, { name: 'windows-free-tests', conclusion: 'success' }],
      artifact: id => ({ run_id: id, run_attempt: 1, event: 'workflow_dispatch', sha: runHead, head_sha: runHead, tree: repo.git('rev-parse', `${runHead}^{tree}`), os: ['Windows'], files: ['test/util.test.js'], tests: 3 }),
      commitTree: sha => repo.git('rev-parse', `${sha}^{tree}`),
    },
  };
  const r = await dispatchCi({ repoRoot: repo.work, base: 'main', gh }, { pr: '1', workflows: ['windows-free-tests.yml', 'free-tests.yml'], pregate, timeoutSec: 5, pollMs: 10, runCheck: () => s.error ?? check });
  const saved = JSON.parse(fs.readFileSync(pregate, 'utf8')) as PregateFile;
  return { r, failure: 'failure' in r ? r.failure.message : '', saved, tree, receipts: saved.requires_remote!.map(l => l.receipt) };
}

describe.skipIf(process.platform === 'win32')('ready --dispatch-ci verifies profiled lanes', () => {
  test('a verified run on pregate.json\'s tree clears the profiled lane with a run receipt; an unprofiled lane records its URL as before', async () => {
    const { r, receipts, tree } = await scene();
    expect('failure' in r).toBe(false);
    expect(receipts[0]).toBe(`run tree=${tree.slice(0, 12)} tests=3 runs=100/1 profiles=${LANE} heads=${receipts[0]!.split('heads=')[1]!.slice(0, 12)} verified=2026-10-30T12:00:00.000Z`);
    expect(receipts[1]).toBe('https://github.com/fx/fx/actions/runs/101');
    expect(r.lines.filter(l => l.startsWith('PREGATE_CLEARED:'))).toEqual([`PREGATE_CLEARED: ${LANE} ${receipts[0]}`, `PREGATE_CLEARED: ${OTHER} https://github.com/fx/fx/actions/runs/101`]);
  }, 60_000);

  test('a run whose newest attempt is red clears nothing for its lane and refuses, even when the run list showed it green', async () => {
    const { r, failure, receipts } = await scene({ apiConclusion: 'failure' });
    expect('failure' in r && r.failure.code).toBe('QUEUE_NOT_READY');
    expect(failure).toContain(`${LANE}: REUSE: refused reason=no_verified_run`);
    expect(failure).toContain('reason=run_not_success');
    expect(receipts[0]).toBeNull();
  }, 60_000);

  test('a green run on another tree clears nothing and refuses', async () => {
    const { failure, receipts } = await scene({ runOnParent: true });
    expect(failure).toContain(`${LANE}: REUSE: refused reason=tree_not_stamp_only`);
    expect(receipts[0]).toBeNull();
  }, 60_000);

  test('a red run in the run list still refuses before any lane clears, and an unreadable base refuses a lane that may be profiled', async () => {
    const red = await scene({ listed: 'failure' });
    expect(red.failure).toContain('a red run clears no lane');
    expect(red.receipts).toEqual([null, null]);
    const unreadable = await scene({ error: { error: 'the base branch\'s .gstack/pregate.json is unreadable', profiled: true } });
    expect(unreadable.failure).toContain('it may have a run profile, so it clears only with a verified run');
    expect(unreadable.receipts).toEqual([null, null]);
  }, 60_000);
});
