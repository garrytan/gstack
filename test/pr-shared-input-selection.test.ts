import { expect, test } from 'bun:test';
import { computePaidCaseSelection } from '../scripts/test-paid-shards';
import { PR_PROFILE_CASE_IDS, selectPrProfile, type PrProfileMaps } from '../scripts/test-pr-profile';
import { E2E_TIERS, E2E_TOUCHFILES, LLM_JUDGE_TOUCHFILES } from './helpers/touchfiles-data';

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
