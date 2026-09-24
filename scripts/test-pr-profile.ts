/** Fast PR policy. Cadence changes here never remove cases from the broad census. */
import { E2E_TOUCHFILES, E2E_TIERS, GLOBAL_TOUCHFILES, LLM_JUDGE_TOUCHFILES } from '../test/helpers/touchfiles-data';
import { matchGlob, TOUCHFILES_DATA_PATH } from '../test/helpers/test-selection';
import { isPaidTestFile } from '../test/helpers/paid-test-set';

/** Existing short behavioral probes; intersect with changed-input selection. */
export const PR_PROFILE_CASE_IDS = [
  'hermetic-canary', 'hermetic-sentinel',
  'browse-basic', 'browse-snapshot', 'skillmd-setup-discovery',
  'qa-bootstrap', 'review-sql-injection', 'review-coverage-audit',
  'plan-ceo-review-benefits', 'plan-eng-coverage-audit', 'plan-review-report',
  'auq-format-gate', 'plan-design-review-no-ui-scope', 'office-hours-spec-review',
  'tpa-present', 'tpa-absent-linux',
  'ship-local-workflow', 'ship-coverage-audit', 'docsync-spawned',
  'setup-deploy-workflow', 'context-restore-loads-latest', 'plan-tune-inspect',
  'skillify-provenance-refusal', 'diagram-triplet', 'learnings-show',
  'gstack-upgrade-happy-path',
] as const;

/** Audited ownership: unknown/direct-describe files remain broad coverage. */
export const PR_PROFILE_FILES: Record<string, readonly string[]> = {
  'test/skill-e2e-hermetic-canary.test.ts': ['hermetic-canary', 'hermetic-sentinel'],
  'test/skill-e2e-bws.test.ts': ['browse-basic', 'browse-snapshot', 'skillmd-setup-discovery'],
  'test/skill-e2e-qa-workflow.test.ts': ['qa-bootstrap'],
  'test/skill-e2e-review.test.ts': ['review-sql-injection'],
  'test/skill-e2e-coverage-audit.test.ts': ['review-coverage-audit', 'plan-eng-coverage-audit'],
  'test/skill-e2e-plan.test.ts': ['plan-ceo-review-benefits', 'plan-review-report', 'office-hours-spec-review'],
  'test/skill-e2e-ask-user-question-format-compliance.test.ts': ['auq-format-gate'],
  'test/skill-e2e-design.test.ts': ['plan-design-review-no-ui-scope'],
  'test/skill-e2e-third-party-actions.test.ts': ['tpa-present', 'tpa-absent-linux'],
  'test/skill-e2e-workflow.test.ts': ['ship-local-workflow', 'ship-coverage-audit', 'gstack-upgrade-happy-path'],
  'test/skill-e2e-docsync-spawned.test.ts': ['docsync-spawned'],
  'test/skill-e2e-deploy.test.ts': ['setup-deploy-workflow'],
  'test/skill-e2e-session-intelligence.test.ts': ['context-restore-loads-latest'],
  'test/skill-e2e-plan-tune.test.ts': ['plan-tune-inspect'],
  'test/skill-e2e-skillify.test.ts': ['skillify-provenance-refusal'],
  'test/skill-e2e-diagram.test.ts': ['diagram-triplet'],
  'test/skill-e2e-learnings.test.ts': ['learnings-show'],
};

export interface PrProfileMaps {
  e2eTouchfiles: Record<string, string[]>;
  judgeTouchfiles: Record<string, string[]>;
  tiers: Record<string, 'gate' | 'periodic'>;
  globalTouchfiles: readonly string[];
}

export const PR_PROFILE_MAPS: PrProfileMaps = {
  e2eTouchfiles: E2E_TOUCHFILES, judgeTouchfiles: LLM_JUDGE_TOUCHFILES,
  tiers: E2E_TIERS, globalTouchfiles: GLOBAL_TOUCHFILES,
};

export interface PrProfileSelection {
  mode: 'pr' | 'full-fallback';
  e2e: string[];
  judges: string[];
  deferred: Array<{ id: string; tier: 'gate' | 'periodic'; reason: string }>;
  unknownFiles: string[];
  deferredPromptFiles: string[];
  missingCoverage: string[];
  needsFullValidation: boolean;
  reasons: string[];
}

/** Reject stale profile registrations and deferred cases with no scheduled home. */
export function validatePrProfileInventory(
  maps: PrProfileMaps = PR_PROFILE_MAPS,
  profile: readonly string[] = PR_PROFILE_CASE_IDS,
): void {
  if (new Set(profile).size !== profile.length) throw new Error('Duplicate PR profile case');
  for (const id of profile) {
    if (!Object.hasOwn(maps.e2eTouchfiles, id) || maps.tiers[id] !== 'gate') {
      throw new Error(`PR profile case must exist in the broad gate census: ${id}`);
    }
  }
  for (const id of Object.keys(maps.e2eTouchfiles)) {
    if (maps.tiers[id] !== 'gate' && maps.tiers[id] !== 'periodic') {
      throw new Error(`E2E case has no broad gate/periodic census: ${id}`);
    }
  }
}

function expandSelection(selected: readonly string[] | null, inventory: Record<string, unknown>): string[] {
  const ids = [...new Set(selected ?? Object.keys(inventory))].sort();
  for (const id of ids) {
    if (!Object.hasOwn(inventory, id)) throw new Error(`Unregistered selected case: ${id}`);
  }
  return ids;
}

function matches(file: string, patterns: readonly string[]): boolean {
  return patterns.some(pattern => matchGlob(file, pattern));
}

export const FREE_ONLY_PR_FILES = [
  'scripts/test-free-shards.ts',
  'test/helpers/auq-parallel-worker.ts',
] as const;

function knownNonBehaviorFile(file: string): boolean {
  // A mapped dependency still wins over these exemptions. New helper/fixture,
  // runtime, dependency, or workflow files are deliberately not exempted.
  return /^(?:docs\/|(?:README|CONTRIBUTING|ARCHITECTURE|CHANGELOG|TODOS)\.md$|VERSION$)/.test(file)
    // Hermetic skill views exclude checkout instructions; these are maintained
    // by free doc/generation checks and are not copied into paid fixtures.
    || ['AGENTS.md', 'CLAUDE.md', 'agents-digest/gstack-AGENTS.md'].includes(file)
    || FREE_ONLY_PR_FILES.some(freeOnly => freeOnly === file)
    || (file.startsWith('test/') && /\.test\.tsx?$/.test(file) && !isPaidTestFile(file));
}

/** Only the release version may be ignored; dependency/script changes still matter. */
export function packageChangeOnlyVersion(before: string, after: string): boolean {
  try {
    const old = JSON.parse(before), current = JSON.parse(after);
    if (typeof old?.version !== 'string' || typeof current?.version !== 'string') return false;
    delete old.version; delete current.version;
    return JSON.stringify(old) === JSON.stringify(current);
  } catch { return false; }
}

function isPromptFile(file: string): boolean {
  return file.endsWith('.tmpl') || /(?:^|\/)SKILL\.md$/.test(file)
    || /^[^/]+\/sections\/.+\.md$/.test(file);
}

/**
 * Diff selection → fast case intersection → explicit deferred coverage.
 * Unknown dependencies restore the full gate, while periodic work stays visible.
 * A changed prompt without a relevant retained check requires full validation.
 */
export function selectPrProfile(options: {
  selectedE2E: readonly string[] | null;
  selectedJudges: readonly string[] | null;
  changedFiles: readonly string[];
  maps?: PrProfileMaps;
  profile?: readonly string[];
  /** Generated artifacts may inherit the identity of their verified source template. */
  sourceAliases?: Readonly<Record<string, string>>;
}): PrProfileSelection {
  const maps = options.maps ?? PR_PROFILE_MAPS;
  const profile = options.profile ?? PR_PROFILE_CASE_IDS;
  validatePrProfileInventory(maps, profile);
  const selectedE2E = expandSelection(options.selectedE2E, maps.e2eTouchfiles);
  const selectedJudges = expandSelection(options.selectedJudges, maps.judgeTouchfiles);
  const files = [...new Set(options.changedFiles.map(file => file.replace(/\\/g, '/')))].sort();
  const depends = (file: string, patterns: readonly string[]) => matches(file, patterns)
    || (!!options.sourceAliases?.[file] && matches(options.sourceAliases[file], patterns));
  const dependencyPatterns = [...new Set([
    ...Object.values(maps.e2eTouchfiles).flat(), ...Object.values(maps.judgeTouchfiles).flat(),
    ...maps.globalTouchfiles,
  ])];
  const unknownFiles = files.filter(file => file !== TOUCHFILES_DATA_PATH
    && !depends(file, dependencyPatterns) && !knownNonBehaviorFile(file));
  const fallback = unknownFiles.length > 0;
  const candidates = fallback ? Object.keys(maps.e2eTouchfiles).sort() : selectedE2E;
  const e2e = candidates.filter(id => maps.tiers[id] === 'gate' && (fallback || profile.includes(id)));
  const judges = fallback ? Object.keys(maps.judgeTouchfiles).sort() : selectedJudges;
  const kept = new Set(e2e);
  const deferred = candidates.filter(id => !kept.has(id)).map(id => ({
    id, tier: maps.tiers[id],
    reason: maps.tiers[id] === 'periodic'
      ? 'Broad periodic/release coverage; not executed by the PR gate'
      : 'Broad gate census/release coverage; outside the fast PR profile',
  }));
  const noQuickCoverage = files.filter(file => isPromptFile(file)
    && !(depends(file, maps.globalTouchfiles) && (e2e.length > 0 || judges.length > 0))
    && !e2e.some(id => depends(file, maps.e2eTouchfiles[id]))
    && !judges.some(id => depends(file, maps.judgeTouchfiles[id])));
  const hasQuickDependency = (file: string) => profile.some(id => depends(file, maps.e2eTouchfiles[id]))
    || Object.values(maps.judgeTouchfiles).some(patterns => depends(file, patterns));
  const deferredPromptFiles = noQuickCoverage.filter(file => !hasQuickDependency(file)
    && Object.values(maps.e2eTouchfiles).some(patterns => depends(file, patterns)));
  const missingCoverage = noQuickCoverage.filter(file => !deferredPromptFiles.includes(file));
  const reasons = fallback
    ? [`Unknown dependencies restore every gate case and judge: ${unknownFiles.join(', ')}`]
    : ['Changed-input selection intersected with the fast PR profile; selected judges retained'];
  if (deferred.length) reasons.push(`${deferred.length} selected behaviors remain scheduled/release coverage, not PR passes`);
  if (deferredPromptFiles.length) reasons.push(`No quick live coverage; known broad prompt checks deferred: ${deferredPromptFiles.join(', ')}`);
  if (missingCoverage.length) reasons.push(`Full validation required for prompts without a relevant PR check: ${missingCoverage.join(', ')}`);
  return {
    mode: fallback ? 'full-fallback' : 'pr', e2e, judges, deferred,
    unknownFiles, deferredPromptFiles, missingCoverage, needsFullValidation: missingCoverage.length > 0, reasons,
  };
}
