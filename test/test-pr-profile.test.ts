import { describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import { CASE_TEST_NAMES, fileCaseRegistration } from '../scripts/lib/paid-cases';
import {
  PR_PROFILE_CASE_IDS, PR_PROFILE_FILES, PR_PROFILE_MAPS, caseNameAddressable, formatPrCoverageSummary, packageChangeOnlyVersion, selectPrProfile, validatePrProfileInventory,
  type PrProfileMaps,
} from '../scripts/test-pr-profile';

const maps: PrProfileMaps = {
  e2eTouchfiles: {
    'ceo-smoke': ['plan-ceo-review/**'],
    'ceo-full': ['plan-ceo-review/**'],
    'ceo-periodic': ['plan-ceo-review/**'],
    'autoplan-full': ['autoplan/**'],
    'browse-smoke': ['browse/**'],
  },
  tiers: {
    'ceo-smoke': 'gate', 'ceo-full': 'gate', 'ceo-periodic': 'periodic',
    'autoplan-full': 'periodic', 'browse-smoke': 'gate',
  },
  judgeTouchfiles: {
    'plan-ceo-review/SKILL.md modes': ['plan-ceo-review/**'],
    'browse quality': ['browse/**'],
  },
  globalTouchfiles: ['test/helpers/shared-runner.ts'],
};
const profile = ['ceo-smoke', 'browse-smoke'];
const select = (options: Partial<Parameters<typeof selectPrProfile>[0]> = {}) => selectPrProfile({
  maps, profile, selectedE2E: ['ceo-smoke', 'ceo-full', 'ceo-periodic'],
  selectedJudges: ['plan-ceo-review/SKILL.md modes'],
  changedFiles: ['plan-ceo-review/SKILL.md.tmpl'], ...options,
});

describe('fast PR coverage policy', () => {
  test('canonical short probes exist in the unchanged broad gate census', () => {
    expect(() => validatePrProfileInventory()).not.toThrow();
    expect(PR_PROFILE_CASE_IDS).toContain('plan-review-report');
    expect(PR_PROFILE_CASE_IDS).toContain('auq-format-gate');
    for (const tier of Object.values(PR_PROFILE_MAPS.tiers)) expect(['gate', 'periodic', 'marathon']).toContain(tier);
  });

  test('keeps relevant short probes and the failing CEO quality obligation; reports broad work', () => {
    const result = select();
    expect(result.mode).toBe('pr');
    expect(result.e2e).toEqual(['ceo-smoke']);
    expect(result.judges).toEqual(['plan-ceo-review/SKILL.md modes']);
    expect(result.deferred.map(({ id, tier }) => ({ id, tier }))).toEqual([
      { id: 'ceo-full', tier: 'gate' }, { id: 'ceo-periodic', tier: 'periodic' },
    ]);
    expect(result.needsFullValidation).toBe(false);
  });

  test('does not add unrelated short probes or drop selected quality judges', () => {
    const result = select({ selectedJudges: ['browse quality', 'plan-ceo-review/SKILL.md modes'] });
    expect(result.e2e).not.toContain('browse-smoke');
    expect(result.judges).toEqual(['browse quality', 'plan-ceo-review/SKILL.md modes']);
  });

  test('unknown source dependencies restore the full gate and judges, but never launch periodic work', () => {
    const result = select({ changedFiles: ['lib/new-runtime.ts'] });
    expect(result.mode).toBe('full-fallback');
    expect(result.unknownFiles).toEqual(['lib/new-runtime.ts']);
    expect(result.e2e).toEqual(['browse-smoke', 'ceo-full', 'ceo-smoke']);
    expect(result.judges).toEqual(['browse quality', 'plan-ceo-review/SKILL.md modes']);
    expect(result.deferred.map(x => x.id)).toEqual(['autoplan-full', 'ceo-periodic']);
    expect(result.reasons[0]).toContain('Unknown dependencies');
  });

  test('unknown runner helpers and paid test files also trigger broad fallback', () => {
    for (const file of ['test/helpers/new-runner.ts', 'test/fixtures/new-prompt.ts', 'test/skill-e2e-new.test.ts', 'bun.lock']) {
      expect(select({ changedFiles: [file] }).mode).toBe('full-fallback');
    }
  });

  test('docs, free tests and touchfile-map edits do not accidentally spend on the full gate', () => {
    for (const file of ['README.md', 'docs/testing.md', 'VERSION', 'AGENTS.md', 'CLAUDE.md', 'agents-digest/gstack-AGENTS.md', 'test/new-parser.test.ts', 'test/helpers/touchfiles-data.ts']) {
      expect(select({ changedFiles: [file], selectedE2E: [], selectedJudges: [] }).mode).toBe('pr');
    }
  });

  test('only verified package version metadata is safe to ignore', () => {
    const old = JSON.stringify({ version: '1', scripts: { test: 'bun test' }, dependencies: { bun: '1' } });
    expect(packageChangeOnlyVersion(old, old.replace('"version":"1"', '"version":"2"'))).toBe(true);
    expect(packageChangeOnlyVersion(old, old.replace('bun test', 'bun skip'))).toBe(false);
    expect(packageChangeOnlyVersion(old, old.replace('"bun":"1"', '"bun":"2"'))).toBe(false);
    expect(packageChangeOnlyVersion(old, '{}')).toBe(false);
    expect(packageChangeOnlyVersion(old, 'broken')).toBe(false);
  });

  test('a periodic-only prompt reports deferred coverage instead of a quick-check claim', () => {
    const result = select({ changedFiles: ['autoplan/SKILL.md.tmpl'], selectedE2E: ['autoplan-full'], selectedJudges: [] });
    expect(result.e2e).toEqual([]);
    expect(result.deferred.map(x => x.id)).toEqual(['autoplan-full']);
    expect(result.missingCoverage).toEqual([]);
    expect(result.deferredPromptFiles).toEqual(['autoplan/SKILL.md.tmpl']);
    expect(result.needsFullValidation).toBe(false);
  });

  test('an unrelated retained check does not satisfy a changed prompt', () => {
    const result = select({ changedFiles: ['autoplan/sections/phase-close.md'], selectedE2E: ['browse-smoke'], selectedJudges: ['browse quality'] });
    expect(result.needsFullValidation).toBe(false);
    expect(result.missingCoverage).toEqual([]);
    expect(result.deferredPromptFiles).toEqual(['autoplan/sections/phase-close.md']);
  });

  test('verified template identity covers its generated artifact while reporting the original path', () => {
    const generatedMaps = { ...maps,
      e2eTouchfiles: { ...maps.e2eTouchfiles, 'generated-broad': ['generated/SKILL.md.tmpl'] },
      tiers: { ...maps.tiers, 'generated-broad': 'periodic' as const },
    };
    const result = select({ maps: generatedMaps, selectedE2E: ['generated-broad'], selectedJudges: [],
      changedFiles: ['generated/SKILL.md'], sourceAliases: { 'generated/SKILL.md': 'generated/SKILL.md.tmpl' } });
    expect(result.unknownFiles).toEqual([]);
    expect(result.deferredPromptFiles).toEqual(['generated/SKILL.md']);
    expect(result.needsFullValidation).toBe(false);
    expect(select({ maps: generatedMaps, selectedE2E: ['generated-broad'], selectedJudges: [],
      changedFiles: ['generated/SKILL.md'] }).needsFullValidation).toBe(true);
  });

  test('an unknown new skill is visibly unvalidated even after broad fallback', () => {
    const result = select({ changedFiles: ['new-skill/SKILL.md.tmpl'] });
    expect(result.mode).toBe('full-fallback');
    expect(result.needsFullValidation).toBe(true);
  });

  test('a selected judge alone can cover a changed prompt with broad behavioral work deferred', () => {
    const result = select({ selectedE2E: ['ceo-periodic'], selectedJudges: ['plan-ceo-review/SKILL.md modes'] });
    expect(result.e2e).toEqual([]);
    expect(result.needsFullValidation).toBe(false);
    expect(result.deferred).toHaveLength(1);
  });

  test('a missing selected prompt dependency is detected even when there are no selected cases', () => {
    const result = select({ selectedE2E: [], selectedJudges: [] });
    expect(result.needsFullValidation).toBe(true);
    const globalPrompt = select({ maps: { ...maps, globalTouchfiles: ['plan-ceo-review/**'] }, selectedE2E: [], selectedJudges: [] });
    expect(globalPrompt.needsFullValidation).toBe(true);
  });

  test('null selections expand inventories while an empty selection remains empty', () => {
    expect(select({ selectedE2E: null, selectedJudges: null }).e2e).toEqual(['browse-smoke', 'ceo-smoke']);
    const empty = select({ selectedE2E: [], selectedJudges: [], changedFiles: ['README.md'] });
    expect(empty.e2e).toEqual([]);
    expect(empty.judges).toEqual([]);
    expect(empty.needsFullValidation).toBe(false);
  });

  test('normalizes Windows paths and deduplicates selection and changes', () => {
    const result = select({ changedFiles: ['plan-ceo-review\\SKILL.md.tmpl', 'plan-ceo-review/SKILL.md.tmpl'], selectedE2E: ['ceo-smoke', 'ceo-smoke'] });
    expect(result.e2e).toEqual(['ceo-smoke']);
    expect(result.unknownFiles).toEqual([]);
    expect(result.needsFullValidation).toBe(false);
  });

  test('marathon cases are deferred to their non-blocking lane, even on full fallback', () => {
    const marathon: PrProfileMaps = { ...maps, tiers: { ...maps.tiers, 'ceo-full': 'marathon' } };
    for (const changedFiles of [['plan-ceo-review/SKILL.md.tmpl'], ['lib/new-runtime.ts']]) {
      const result = select({ maps: marathon, changedFiles });
      expect(result.e2e).not.toContain('ceo-full');
      expect(result.deferred.find(({ id }) => id === 'ceo-full')).toEqual({ id: 'ceo-full', tier: 'marathon',
        reason: 'Full end-to-end marathon coverage; non-blocking lane, not executed by the PR gate' });
    }
    expect(() => select({ maps: marathon, profile: ['ceo-full'] })).toThrow('broad gate census');
  });

  test('every audited PR-profile case is addressable by its Bun test name', () => {
    // The PR lane runs each audited file with -t built from CASE_TEST_NAMES[id] ?? id;
    // office-hours-auto-mode's test is named differently and matched 0 tests (#3077 eval-slices run 37741434771).
    const unaddressable = Object.entries(PR_PROFILE_FILES).flatMap(([file, ids]) => {
      const source = fs.readFileSync(path.join(import.meta.dir, '..', file), 'utf8');
      const computed = fileCaseRegistration(file, source).computed;
      return ids.filter((id) => {
        const name = CASE_TEST_NAMES[id] ?? id;
        return !caseNameAddressable(name, source) && !(computed && source.includes(`'${name}'`));
      }).map(id => `${file}: ${id}`);
    });
    expect(unaddressable).toEqual([]);
  });

  test('rejects stale profile IDs, incorrect tiers, missing cadence, and unknown selections', () => {
    expect(() => select({ profile: ['missing'] })).toThrow('broad gate census');
    expect(() => select({ profile: ['ceo-periodic'] })).toThrow('broad gate census');
    expect(() => select({ profile: ['ceo-smoke', 'ceo-smoke'] })).toThrow('Duplicate');
    expect(() => select({ maps: { ...maps, tiers: { 'ceo-smoke': 'gate' } } })).toThrow('broad gate census');
    expect(() => select({ maps: { ...maps, tiers: { ...maps.tiers, 'ceo-full': undefined! } } })).toThrow('no broad');
    expect(() => select({ selectedE2E: ['missing'] })).toThrow('Unregistered');
    expect(() => select({ selectedJudges: ['missing judge'] })).toThrow('Unregistered');
  });

  test('job summary states the mode, case counts and reuse; a fallback names each file with its fix (CEO-13)', () => {
    const fallback = select({ changedFiles: ['lib/new-runtime.ts', 'test/fixtures/new.json'] });
    const fallbackLines = formatPrCoverageSummary({ profile: 'pr', selection: { e2e: fallback.e2e, judges: fallback.judges }, prCoverage: fallback },
      { total: 9, reused: 4 }).join('\n');
    expect(fallbackLines).toContain('- Mode: `full-fallback`');
    expect(fallbackLines).toContain('- Selected: 3 E2E case(s), 2 judge(s); 2 deferred');
    expect(fallbackLines).toContain('- Reused: 4 of 9 rule/judge record(s)');
    expect(fallbackLines).toContain('Full gate restored by 2 file(s) (fix: docs/TESTING_INTERNALS.md#pr-paid-lane-fallback)');
    expect(fallbackLines).toContain('`lib/new-runtime.ts` (real unknown dependency): register lib/new-runtime.ts under the cases that consume it');
    expect(fallbackLines).toContain('`test/fixtures/new.json` (needs touchfile entry):');
    expect(fallbackLines).toContain('FREE_FIXTURES');

    const pr = select();
    const prLines = formatPrCoverageSummary({ profile: 'pr', selection: { e2e: pr.e2e, judges: pr.judges }, prCoverage: pr }).join('\n');
    expect(prLines).toContain('- Mode: `pr`');
    expect(prLines).toContain('- Selected: 1 E2E case(s), 1 judge(s); 2 deferred');
    expect(prLines).not.toContain('Reused:');
    expect(prLines).not.toContain('Full gate restored');
  });

  test('DX-11: an edited paid test file selects its own name-addressable gate cases outside the profile', () => {
    const direct: PrProfileMaps = { ...maps,
      e2eTouchfiles: { ...maps.e2eTouchfiles, 'own-named': ['test/skill-e2e-own.test.ts'], 'own-prose': ['test/skill-e2e-own.test.ts'] },
      tiers: { ...maps.tiers, 'own-named': 'gate', 'own-prose': 'gate' } };
    const readSource = () => "describeE2E('own', () => {\n  testIfSelected('own-named', async () => {});\n  test('a prose name', async () => {});\n});";
    const result = select({ maps: direct, readSource, changedFiles: ['test/skill-e2e-own.test.ts'],
      selectedE2E: ['own-named', 'own-prose'], selectedJudges: [] });
    expect(result.mode).toBe('pr');
    expect(result.e2e).toEqual(['own-named']);
    expect(result.directCases).toEqual(['own-named']);
    expect(result.deferred.find(item => item.id === 'own-prose')?.reason).toContain("name its Bun test 'own-prose'");
    expect(result.reasons).toContain('Edited paid test files select their own gate cases: own-named');
    // A dependency edit (not the case's own test file) still keeps the audited profile only.
    const viaHelper = select({ maps: { ...direct, e2eTouchfiles: { ...direct.e2eTouchfiles, 'own-named': ['test/skill-e2e-own.test.ts', 'own/**'] } },
      readSource, changedFiles: ['own/x.ts'], selectedE2E: ['own-named'], selectedJudges: [] });
    expect(viaHelper.e2e).toEqual([]);
  });

  test('DX-11: name addressing ignores comments and near-miss names', () => {
    expect(caseNameAddressable('a-b', "  testIfSelected('a-b', async () => {})")).toBe(true);
    expect(caseNameAddressable('a-b', '  test(`a-b`, async () => {})')).toBe(true);
    expect(caseNameAddressable('a-b', '  testConcurrentIfSelected("a-b", async () => {})')).toBe(true);
    expect(caseNameAddressable('a-b', ' * test (`a-b` in E2E_TIERS)')).toBe(false);
    expect(caseNameAddressable('a-b', "/* testIfSelected('a-b') */")).toBe(false);
    expect(caseNameAddressable('a-b', "  testIfSelected('a-bc', async () => {})")).toBe(false);
  });

  test('the summary lists derived dependents and files no paid case reaches', () => {
    const lines = formatPrCoverageSummary({ profile: 'pr', selection: { e2e: ['a'], judges: [] }, prCoverage: { mode: 'dependents', deferred: [], unknownFiles: [],
      derivedFiles: [{ file: 'design/src/evolve.ts', e2e: 12, judges: 1 }], noConsumerFiles: ['scripts/typecheck-test.ts'] } }).join('\n');
    expect(lines).toContain('- Mode: `dependents`');
    expect(lines).toContain('  - `design/src/evolve.ts`: 12 case(s), 1 judge(s)');
    expect(lines).toContain('- No paid case reaches: `scripts/typecheck-test.ts`');
  });
});
