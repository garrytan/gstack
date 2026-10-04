/**
 * eval:bg contract — free tripwire for scripts/eval-bg.ts (W5d, CEO-17, DX-1..3/7, ENG-12/19).
 *
 * The old contract made multi-hour detach walls legitimate (a 26 h eval:bg:pr
 * floor sized for every shard at its worst case). The contract now:
 *   - every eval:bg:<lane> script runs `scripts/eval-bg.ts <lane>`, never a
 *     literal --timeout;
 *   - local cap = ceil(1.5 x planned serial seconds / EVALS_JOBS) + 20 min,
 *     at most 4 h (--timeout overrides);
 *   - dispatch only from a clean HEAD pushed to garrytan/gstack with gh able
 *     to dispatch; otherwise local with the reason, or a refusal under --dispatch;
 *   - both backends run under bin/gstack-detach with the gstack-evals lock and
 *     end with the `### gstack-detach EXIT=<code> ###` sentinel; a followed CI
 *     run maps success 0, failure 1, cancelled 130, other 2.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CANONICAL_REPO, DISPATCH_FOLLOW_SECONDS, EVAL_BG_LANES, LANE_SPECS, LOCAL_CAP_SECONDS, UNRECORDED_SHARD_MS,
  chooseBackend, conclusionExitCode, dedupeKey, dispatchBlockers, dispatchPlan, findDuplicateRun, launchDetached,
  localCapSeconds, makeNonce, plannedSerialMs, statusOf, type CheckoutFacts, type RunSummary,
} from '../scripts/eval-bg';
import { buildRunManifest, loadPaidTestDurations, recordedShardMs } from '../scripts/test-paid-shards';

const ROOT = path.resolve(import.meta.dir, '..');
const SHA = 'a'.repeat(40);
const clean: CheckoutFacts = { sha: SHA, branch: 'feature/x', dirty: [], repo: CANONICAL_REPO, ghReady: true, canPush: true, remoteSha: SHA, ahead: null };

describe('package scripts', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts as Record<string, string>;
  test('every eval:bg lane delegates to eval-bg.ts and carries no literal detach timeout', () => {
    for (const lane of EVAL_BG_LANES) {
      expect(scripts[`eval:bg:${lane}`]).toBe(`bun run scripts/eval-bg.ts ${lane}`);
      expect(scripts[LANE_SPECS[lane].script], `${lane} runs package script ${LANE_SPECS[lane].script}`).toBeTruthy();
    }
  });
  test('the local worker defaults match the commands eval-bg runs', () => {
    expect(Number(/EVALS_JOBS=\$\{EVALS_JOBS:-(\d+)\}/.exec(scripts['test:pr']!)?.[1])).toBe(LANE_SPECS.pr.jobs);
    expect(scripts['test:release']).toContain('--tier gate --profile full');
    expect(scripts['test:release']).toContain('--tier periodic --profile full');
  });
});

describe('local cap', () => {
  test('ceil(1.5 x serial / jobs) + 20 min', () => {
    expect(localCapSeconds(3_600_000, 2)).toEqual({ seconds: Math.ceil(1.5 * 3600 / 2) + 1200, capped: false });
    expect(localCapSeconds(0, 8)).toEqual({ seconds: 1200, capped: false });
    expect(() => localCapSeconds(1, 0)).toThrow('EVALS_JOBS');
  });
  test('never more than 4 hours, and says so', () => {
    expect(LOCAL_CAP_SECONDS).toBe(14_400);
    expect(localCapSeconds(100 * 3_600_000, 2)).toEqual({ seconds: 14_400, capped: true });
  });
  test('serial work sums the recorded wall of every planned shard, unrecorded at the PR-lane case target', () => {
    const manifest = buildRunManifest({ tier: 'periodic', profile: 'full', sliceCount: 1, evalsAll: true, env: { EVALS_ALL: '1' } });
    const recorded = loadPaidTestDurations(ROOT, 'periodic');
    const expected = manifest.entries.filter(entry => entry.status === 'planned')
      .reduce((sum, entry) => sum + (recordedShardMs(recorded, entry.file) ?? UNRECORDED_SHARD_MS), 0);
    expect(plannedSerialMs('periodic')).toBe(expected);
    // The live census fits the cap with the lanes' default workers.
    for (const lane of ['gate', 'periodic', 'release'] as const) {
      expect(localCapSeconds(plannedSerialMs(lane), LANE_SPECS[lane].jobs).capped, lane).toBe(false);
    }
  });
});

describe('backend choice (DX-1)', () => {
  test('a clean HEAD pushed to garrytan/gstack dispatches', () => {
    expect(chooseBackend(clean, 'auto')).toMatchObject({ backend: 'dispatch' });
    expect(chooseBackend(clean, 'local')).toMatchObject({ backend: 'local' });
  });
  test('a dirty tree runs locally and names the files', () => {
    const choice = chooseBackend({ ...clean, dirty: [' M a.ts', '?? b.ts'] }, 'auto');
    expect(choice).toMatchObject({ backend: 'local' });
    expect(choice.reason).toContain('2 files are modified or untracked');
  });
  test('unpushed commits run locally; --dispatch refuses with the fix', () => {
    const facts = { ...clean, sha: 'b'.repeat(40), ahead: 2, dirty: ['?? c.ts'] };
    expect(chooseBackend(facts, 'auto').backend).toBe('local');
    expect(chooseBackend(facts, 'dispatch')).toEqual({ backend: 'refuse',
      reason: `HEAD ${'b'.repeat(12)} is 2 commits ahead of origin/feature/x and 1 files are modified or untracked; commit and push, or rerun with --local` });
  });
  test('a fork, a missing gh, a detached HEAD or an unpushed branch cannot dispatch', () => {
    expect(dispatchBlockers({ ...clean, repo: 'someone/gstack' })).toEqual([`origin is someone/gstack, not ${CANONICAL_REPO} (a fork cannot dispatch its workflows)`]);
    expect(dispatchBlockers({ ...clean, ghReady: false, canPush: false, remoteSha: null })[0]).toContain('gh auth status');
    expect(dispatchBlockers({ ...clean, branch: null })[0]).toContain('detached');
    expect(dispatchBlockers({ ...clean, remoteSha: null })).toEqual(['branch feature/x is not on garrytan/gstack; push it']);
    expect(dispatchBlockers({ ...clean, canPush: false })[0]).toContain('cannot dispatch workflows');
  });
  test('remote state is read with gh api, never git fetch or ls-remote (ENG-19)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'scripts/eval-bg.ts'), 'utf8');
    expect(source).not.toMatch(/['"`](?:fetch|ls-remote|pull)['"`]/);
    expect(source).toContain("'api', `repos/${CANONICAL_REPO}/branches/");
  });
});

describe('dispatch plan, nonce and dedupe (CEO-17, DX-3, ENG-12)', () => {
  const ids = { sha: SHA, baseRef: 'main', baseSha: 'c'.repeat(40), nonce: 'n1', prNumber: 7 };
  test('each lane dispatches its workflows with the tested revision and nonce', () => {
    expect(dispatchPlan('pr', ids)).toEqual([{ workflow: 'evals.yml', inputs: { evals_all: 'false', expected_sha: SHA, nonce: 'n1', base_ref: 'main', base_sha: 'c'.repeat(40), pr_receipts: '7' } }]);
    expect(dispatchPlan('gate', ids)).toEqual([{ workflow: 'evals.yml', inputs: { evals_all: 'true', expected_sha: SHA, nonce: 'n1' } }]);
    expect(dispatchPlan('periodic', ids)).toEqual([{ workflow: 'evals-periodic.yml', inputs: { expected_sha: SHA, nonce: 'n1' } }]);
    expect(dispatchPlan('release', ids).map(item => item.workflow)).toEqual(['evals.yml', 'evals-periodic.yml']);
  });
  test('the periodic workflow verifies the revision and names its run by the nonce', () => {
    const workflow = Bun.YAML.parse(fs.readFileSync(path.join(ROOT, '.github/workflows/evals-periodic.yml'), 'utf8')) as any;
    expect(workflow['run-name']).toContain("format('Periodic Evals [eval-bg {0}]', inputs.nonce)");
    expect(Object.keys(workflow.on.workflow_dispatch.inputs)).toEqual(expect.arrayContaining(['expected_sha', 'nonce']));
    const verify = workflow.jobs['plan-slices'].steps.find((step: any) => step.name === 'Verify the dispatched revision');
    expect(verify.run).toContain('[ "$GITHUB_SHA" != "$EXPECTED_SHA" ]');
  });
  test('a queued, running or green dispatch of the same lane, revision and base is followed, never a failed one or a PR run', () => {
    const key = dedupeKey('pr', SHA, 'c'.repeat(40));
    expect(makeNonce('pr', SHA, 'c'.repeat(40), 'zz')).toBe(`${key}zz`);
    const run = (over: Partial<RunSummary>): RunSummary => ({ databaseId: 1, displayTitle: `Evals [eval-bg ${key}ab]`, status: 'in_progress', conclusion: null, url: 'u', event: 'workflow_dispatch', ...over });
    expect(findDuplicateRun([run({})], key)?.databaseId).toBe(1);
    expect(findDuplicateRun([run({ status: 'completed', conclusion: 'success' })], key)).not.toBeNull();
    expect(findDuplicateRun([run({ status: 'completed', conclusion: 'failure' })], key)).toBeNull();
    expect(findDuplicateRun([run({ event: 'pull_request' })], key)).toBeNull();
    expect(findDuplicateRun([run({ displayTitle: `Evals [eval-bg ${dedupeKey('pr', SHA, 'd'.repeat(40))}ab]` })], key)).toBeNull();
  });
});

describe('completion contract on both backends (DX-2)', () => {
  const waitForExit = async (log: string): Promise<string> => {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      if (/### gstack-detach EXIT=/.test(text)) return text;
      await Bun.sleep(100);
    }
    throw new Error(`no EXIT sentinel in ${log}`);
  };
  const sandbox = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-bg-'));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, GSTACK_EVAL_BG_POLL_MS: '50' };
    return { dir, env };
  };

  test('conclusions map to exit codes', () => {
    expect(['success', 'failure', 'cancelled', 'timed_out', null].map(conclusionExitCode)).toEqual([0, 1, 130, 2, 2]);
    expect(DISPATCH_FOLLOW_SECONDS).toBe(LOCAL_CAP_SECONDS);
  });

  test('local: the header is the first line and the command exit lands in the sentinel', async () => {
    const { dir, env } = sandbox();
    try {
      const log = path.join(dir, 'local.log');
      launchDetached({ log, label: 'evals-test', timeoutSeconds: 60, header: '[eval-bg] backend=local lane=pr tested=abc', env,
        command: [process.execPath, '-e', 'process.exit(3)'] });
      const text = await waitForExit(log);
      expect(text.split('\n')[0]).toBe('[eval-bg] backend=local lane=pr tested=abc');
      expect(text).toContain("### gstack-detach LOCK 'gstack-evals' ACQUIRED ###");
      expect(text).toMatch(/### gstack-detach EXIT=3 ###/);
      expect(statusOf(log)).toBe('failed');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }, 40_000);

  for (const [conclusion, code, word] of [['failure', 1, 'failed'], ['cancelled', 130, 'cancelled'], ['success', 0, 'passed']] as const) {
    test(`dispatch: a followed run that ends ${conclusion} writes EXIT=${code}`, async () => {
      const { dir, env } = sandbox();
      try {
        const bin = path.join(dir, 'bin');
        fs.mkdirSync(bin);
        // A fake gh: dispatch records the nonce; run list shows that dispatch; run view completes it.
        fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh
state="${dir}/nonce"
case "$1 $2" in
  "workflow run") for a in "$@"; do case "$a" in nonce=*) printf '%s' "\${a#nonce=}" > "$state";; esac; done; exit 0;;
  "run list") if [ -f "$state" ]; then printf '[{"databaseId":42,"displayTitle":"Periodic Evals [eval-bg %s]","status":"queued","conclusion":null,"url":"https://example.invalid/runs/42","event":"workflow_dispatch"}]' "$(cat "$state")"; else echo '[]'; fi;;
  "run view") echo '{"status":"completed","conclusion":"${conclusion}"}';;
  *) exit 1;;
esac
`, { mode: 0o755 });
        const plan = dispatchPlan('periodic', { sha: SHA, baseRef: 'main', baseSha: '', nonce: makeNonce('periodic', SHA, '', 'fake01') });
        const log = path.join(dir, 'dispatch.log');
        launchDetached({ log, label: 'evals-test', timeoutSeconds: 60, header: `[eval-bg] backend=dispatch lane=periodic tested=${SHA}`,
          env: { ...env, PATH: `${bin}${path.delimiter}${env.PATH}` },
          command: [process.execPath, 'run', path.join(ROOT, 'scripts/eval-bg.ts'), '__follow', JSON.stringify(plan), 'feature/x', dedupeKey('periodic', SHA, '')] });
        const text = await waitForExit(log);
        expect(text.split('\n')[0]).toBe(`[eval-bg] backend=dispatch lane=periodic tested=${SHA}`);
        expect(text).toContain('evals-periodic.yml: run 42 https://example.invalid/runs/42');
        expect(text).toContain(`### gstack-detach EXIT=${code} ###`);
        expect(statusOf(log)).toBe(word);
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }, 40_000);
  }

  test('status reconnects to a run id or a log without a sentinel', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-bg-status-'));
    try {
      const log = path.join(dir, 'x.log');
      fs.writeFileSync(log, '[eval-bg] backend=local\n### gstack-detach START label=x pgid=999999 ### t\n');
      expect(statusOf(log, undefined, () => true)).toBe('running');
      expect(statusOf(log, undefined, () => false)).toBe('incomplete');
      const gh = (conclusion: string | null, status: string) => () => ({ status: 0, stdout: JSON.stringify({ status, conclusion }) });
      expect(statusOf('42', gh(null, 'in_progress'))).toBe('running');
      expect(statusOf('42', gh('cancelled', 'completed'))).toBe('cancelled');
      expect(statusOf('42', gh('failure', 'completed'))).toBe('failed');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
