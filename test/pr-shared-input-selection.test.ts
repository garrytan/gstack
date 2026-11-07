import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computePaidCaseSelection } from '../scripts/test-paid-shards';
import { PR_PROFILE_CASE_IDS, selectPrProfile, type PrProfileMaps } from '../scripts/test-pr-profile';
import { E2E_TIERS, E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES } from './helpers/touchfiles-data';

const ROOT = path.resolve(import.meta.dir, '..');

const sharedInputs = [
  'package.json', 'bun.lock', '.github/docker/Dockerfile.ci',
  'scripts/host-config.ts', 'scripts/discover-skills.ts', 'hosts/index.ts',
];
const skipId = 'ship-skipped-queued-finding';
const gateIds = Object.keys(E2E_TOUCHFILES).filter(id => E2E_TIERS[id] === 'gate').sort();
// Periodic and marathon cases are both deferred by the PR gate; only their lanes run them.
const deferredIds = Object.keys(E2E_TOUCHFILES).filter(id => E2E_TIERS[id] === 'periodic' || E2E_TIERS[id] === 'marathon').sort();
const judgeIds = Object.keys(LLM_JUDGE_TOUCHFILES).sort();
// Every selection names its base and package.json history explicitly: an
// omitted base runs detectBaseBranch and an omitted packageVersionOnly diffs
// package.json against the checkout's merge-base, so the verdict would follow
// whatever branch CI checked out (main runs 36572856858 and 36594314027).
const select = (profile: 'pr' | 'full', changedFiles: string[], packageVersionOnly = false) =>
  computePaidCaseSelection({ profile, env: { EVALS_BASE: 'fixture-base' }, changedFiles, packageVersionOnly });

test.each(sharedInputs)('%s retains the full gate after native dependency registration', file => {
  const result = select('pr', [file]);
  expect(result.coverage?.mode).toBe('full-fallback');
  expect(result.selection.e2e).toEqual(gateIds);
  expect(result.selection.judges).toEqual(judgeIds);
  expect(result.coverage?.deferred.map(({ id }) => id).sort()).toEqual(deferredIds);
  expect(result.coverage?.reasons).toContain(`Shared runtime/build inputs restore every gate case and judge: ${file}`);
  expect(result.coverage?.needsFullValidation).toBe(false);
});

test('a version-only package.json change does not restore the full gate', () => {
  const result = select('pr', ['package.json'], true);
  expect(result.coverage?.mode).not.toBe('full-fallback');
  expect(result.coverage?.reasons.join('\n')).not.toContain('Shared runtime/build inputs restore every gate case and judge: package.json');
});

test.each(sharedInputs)('%s broad policy is independent of native, judge and global maps', file => {
  for (const registration of ['none', 'broad', 'fast', 'judge', 'global']) {
    const maps: PrProfileMaps = {
      e2eTouchfiles: { fast: [], broad: [], periodic: [] },
      judgeTouchfiles: { quality: [] },
      tiers: { fast: 'gate', broad: 'gate', periodic: 'periodic' },
      globalTouchfiles: [],
    };
    if (registration === 'broad' || registration === 'fast') maps.e2eTouchfiles[registration].push(file);
    if (registration === 'judge') maps.judgeTouchfiles.quality.push(file);
    if (registration === 'global') maps.globalTouchfiles = [file];
    const result = selectPrProfile({ maps, profile: ['fast'], changedFiles: [file.replaceAll('/', '\\')],
      selectedE2E: [], selectedJudges: [] });
    expect(result.mode, registration).toBe('full-fallback');
    expect(result.e2e, registration).toEqual(['broad', 'fast']);
    expect(result.judges, registration).toEqual(['quality']);
    expect(result.deferred.map(({ id }) => id), registration).toEqual(['periodic']);
    expect(result.unknownFiles, registration).toEqual(registration === 'none' ? [file] : []);
  }
});

test.each(['test/helpers/ship-skip-actor.ts'])
  ('%s remains explicitly deferred by the fast profile, not promoted', file => {
    expect(PR_PROFILE_CASE_IDS as readonly string[]).not.toContain(skipId);
    const result = select('pr', [file]);
    expect(result.coverage?.mode).toBe('pr');
    expect(result.selection).toEqual({ e2e: [], judges: [] });
    expect(result.coverage?.deferred).toEqual([{
      id: skipId, tier: 'gate', reason: 'Broad gate census/release coverage; outside the fast PR profile',
    }]);
    const full = select('full', [file]);
    expect(full.selection).toEqual({ e2e: [skipId], judges: [] });
  });

test('editing the case\'s own test file runs it in the PR lane (DX-11)', () => {
  const result = computePaidCaseSelection({ profile: 'pr', env: {}, changedFiles: ['test/skill-e2e-ship-skip.test.ts'] });
  expect(result.coverage?.mode).toBe('pr');
  expect(result.selection).toEqual({ e2e: [skipId], judges: [] });
  expect(result.coverage?.directCases).toEqual([skipId]);
});

test('cumulative shared, native and prompt edits retain every gate case and judge', () => {
  const result = select('pr', [...sharedInputs, 'test/helpers/ship-skip-actor.ts', 'qa-only/SKILL.md.tmpl']);
  expect(result.coverage?.mode).toBe('full-fallback');
  expect(result.selection.e2e).toEqual(gateIds);
  expect(result.selection.judges).toEqual(judgeIds);
  expect(result.coverage?.deferred.map(({ id }) => id).sort()).toEqual(deferredIds);
  expect(result.coverage?.needsFullValidation).toBe(false);
});

// GST-1575: no paid run executes ./setup (evals.yml only builds), so a narrow screen derives it like any
// other file. Diffs of #4045 (9e809ab) and #4047 (4743132), whose narrow screens (runs 42093259982 and
// 42103721891) fell back to all gate cases on setup alone. GST-1615: setup now runs bin/gstack-skill-gates, so
// that file derives setup's consumers and the screen runs in dependents mode, which also keeps the gate case
// whose touchfiles name bin/gstack-config (ship-skipped-queued-finding) instead of intersecting with the profile.
const setupHookCases = ['gstack-upgrade-happy-path', 'ship-local-hook-preservation', 'ship-managed-hook-refresh',
  'ship-skipped-queued-finding', 'ship-unmanaged-hook-consent', 'skillmd-setup-discovery'];
const setupScreens: Record<string, string[]> = {
  '#4045': ['bin/gstack-config', 'bin/gstack-settings-hook', 'bin/gstack-skill-gates', 'bin/gstack-skill-route',
    'changelog.d/capy-gst-1461-investigate-gate.md', 'docs/skill-gates.md', 'docs/skill-routing-and-contracts.md',
    'hosts/claude/hooks/investigate-gate-post', 'hosts/claude/hooks/investigate-gate-post-failure',
    'hosts/claude/hooks/investigate-gate-pre', 'hosts/claude/hooks/investigate-gate-stop',
    'hosts/claude/hooks/investigate-gate.ts', 'lib/investigate-gate.ts', 'lib/skill-contract.ts', 'lib/skill-gates.ts',
    'lib/skill-route.ts', 'scripts/skill-gates-smoke.ts', 'setup', 'test/investigate-gate.test.ts',
    'test/setup-hook-syntax-gate.test.ts', 'test/setup-skill-hooks-gate.test.ts',
    'test/skill-gates-advisory-bytes.test.ts', 'test/skill-gates.test.ts'],
  '#4047': ['bin/gstack-config', 'bin/gstack-settings-hook', 'bin/gstack-skill-gates', 'bin/gstack-skill-route',
    'changelog.d/capy-gst-1461-ceo-review-gate.md', 'docs/skill-gates.md', 'docs/skill-routing-and-contracts.md',
    'hosts/claude/hooks/ceo-review-gate-stop', 'hosts/claude/hooks/ceo-review-gate-subagent-stop',
    'hosts/claude/hooks/ceo-review-gate.ts', 'hosts/claude/hooks/investigate-gate.ts',
    'hosts/claude/hooks/skill-contract-stop-hook.ts', 'hosts/claude/hooks/spawn-bin.ts', 'lib/ceo-review-gate.ts',
    'lib/investigate-gate.ts', 'lib/skill-contract.ts', 'lib/skill-gates.ts', 'lib/skill-route.ts',
    'scripts/skill-gates-smoke.ts', 'setup', 'test/ceo-review-gate.test.ts', 'test/investigate-gate.test.ts',
    'test/setup-hook-syntax-gate.test.ts', 'test/setup-skill-hooks-gate.test.ts',
    'test/skill-gates-advisory-bytes.test.ts', 'test/skill-gates.test.ts'],
};
const screen = (policy: 'narrow' | 'broad', changedFiles: string[]) => computePaidCaseSelection({
  profile: 'pr', env: { EVALS_BASE: 'fixture-base', EVALS_SCREEN_POLICY: policy }, changedFiles, packageVersionOnly: false });

// GST-1717 deleted the /investigate gate files: a deleted hook under hosts/claude/hooks/ is still "referenced" by setup's
// hook paths and restores the full gate, so the replay screens only the files that still exist.
test.each(Object.entries(setupScreens))('a narrow screen of %s derives setup and selects its six cases', (_pr, files) => {
  const result = screen('narrow', files.filter(file => fs.existsSync(path.join(ROOT, file))));
  expect(result.coverage?.mode).not.toBe('full-fallback');
  expect(result.selection.e2e).toEqual(setupHookCases);
  expect(result.coverage?.reasons.join('\n')).not.toContain('Shared runtime/build inputs');
});

test('a narrow screen of setup alone runs only the gate cases that invoke it', () => {
  const result = screen('narrow', ['setup']);
  expect(result.coverage?.mode).not.toBe('full-fallback');
  expect(result.selection.e2e).toEqual(['gstack-upgrade-happy-path', 'skillmd-setup-discovery']);
});

test.each(Object.entries(setupScreens))('%s keeps the full gate on a broad screen, and --profile full ignores the screen policy', (_pr, files) => {
  for (const changed of [files, ['setup']]) {
    const broad = screen('broad', changed);
    expect(broad.coverage?.mode).toBe('full-fallback');
    expect(broad.selection.e2e).toEqual(gateIds);
    expect(broad.selection.judges).toEqual(judgeIds);
    expect(broad.coverage?.reasons).toContain('Shared runtime/build inputs restore every gate case and judge: setup');
    const full = (policy: string, all = '') => computePaidCaseSelection({ profile: 'full',
      env: { EVALS_BASE: 'fixture-base', EVALS_SCREEN_POLICY: policy, EVALS_ALL: all }, changedFiles: changed, packageVersionOnly: false });
    expect(full('narrow')).toEqual(full('broad'));
    expect(full('narrow', '1')).toEqual({ selection: { e2e: null, judges: null }, reason: 'run-all' });
  }
});

test('narrow screens still restore the full gate for every other shared input', () => {
  for (const file of sharedInputs) {
    const result = screen('narrow', [file]);
    expect(result.coverage?.mode, file).toBe('full-fallback');
    expect(result.selection.e2e, file).toEqual(gateIds);
  }
});


// GST-1575: modules/loadouts.json is read through scripts/modules.ts (LOADOUTS_FILE), whose static closure
// reaches every gate case; no paid case passes --loadout. Derived like that reader instead of an unknown file.
test('modules/loadouts.json is derived through its reader instead of restoring the full gate', () => {
  const narrow = screen('narrow', ['modules/loadouts.json']);
  expect(narrow.coverage?.mode).toBe('pr');
  expect(narrow.selection).toEqual({ e2e: [], judges: [] });
  expect(narrow.coverage?.hubFiles).toEqual(['modules/loadouts.json']);
  const broad = screen('broad', ['modules/loadouts.json']);
  expect(broad.coverage?.mode).toBe('dependents');
  expect(broad.selection.e2e).toEqual(gateIds);
  expect(broad.coverage?.unknownFiles).toEqual([]);
});

