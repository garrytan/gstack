/** Fast PR policy. Cadence changes here never remove cases from the broad census. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { E2E_TOUCHFILES, E2E_TIERS, GLOBAL_TOUCHFILES, LLM_JUDGE_TOUCHFILES } from '../test/helpers/touchfiles-data';
import { matchGlob, TOUCHFILES_DATA_PATH } from '../test/helpers/test-selection';
import { isPaidTestFile } from '../test/helpers/paid-test-set';
import { FREE_FIXTURES } from '../test/helpers/free-fixtures-data';
import { derivedDependencies, type DerivedDependencies } from './pr-dependencies';

/** Existing short behavioral probes; intersect with changed-input selection. */
export const PR_PROFILE_CASE_IDS = [
  'hermetic-canary', 'hermetic-sentinel',
  'browse-basic', 'browse-snapshot', 'skillmd-setup-discovery',
  'qa-bootstrap', 'review-sql-injection', 'review-coverage-audit',
  'qa-functional-cli-report', 'qa-functional-webhook-report',
  'qa-functional-cli-fix', 'qa-functional-webhook-fix',
  'review-exploratory-small-cli', 'ship-exploratory-small-cli', 'ship-exploratory-unavailable',
  'ship-exploratory-plan-checks', 'ship-exploratory-late-input',
  'plan-eng-coverage-audit', 'plan-review-report',
  'auq-format-gate', 'plan-design-review-no-ui-scope',
  'tpa-present', 'tpa-absent-linux',
  'ship-local-workflow', 'ship-coverage-audit', 'docsync-spawned',
  'ship-docsync-completion', 'ship-docsync-current', 'ship-docsync-failure', 'ship-docsync-store',
  'ship-docsync-missing-marker', 'ship-docsync-missing-asset', 'ship-docsync-launch-failure',
  'ship-docsync-timeout-unsettled', 'ship-docsync-late-result', 'ship-docsync-stale-before',
  'ship-docsync-stale-after', 'ship-docsync-recovery',
  'ship-managed-hook-refresh', 'ship-unmanaged-hook-consent', 'ship-local-hook-preservation',
  'setup-deploy-workflow', 'context-restore-loads-latest', 'plan-tune-inspect',
  'skillify-provenance-refusal', 'diagram-triplet', 'learnings-show',
  'gstack-upgrade-happy-path',
  'investigate-owned-completion', 'investigate-owned-abort', 'investigate-owned-ending-error',
  'ship-coverage-value', 'review-test-value', 'test-audit-report-only',
  'office-hours-auto-mode', 'plan-ceo-review-plan-mode',
] as const;

/** Audited ownership: unknown/direct-describe files remain broad coverage. */
export const PR_PROFILE_FILES: Record<string, readonly string[]> = {
  'test/skill-e2e-office-hours-auto-mode.test.ts': ['office-hours-auto-mode'],
  'test/skill-e2e-plan-ceo-plan-mode.test.ts': ['plan-ceo-review-plan-mode'],
  'test/skill-e2e-investigate-owned-completion.test.ts': ['investigate-owned-completion'],
  'test/skill-e2e-investigate-owned-termination.test.ts': ['investigate-owned-abort', 'investigate-owned-ending-error'],
  'test/skill-e2e-hermetic-canary.test.ts': ['hermetic-canary', 'hermetic-sentinel'],
  'test/skill-e2e-bws.test.ts': ['browse-basic', 'browse-snapshot', 'skillmd-setup-discovery'],
  'test/skill-e2e-qa-workflow.test.ts': ['qa-bootstrap'],
  'test/skill-e2e-qa-functional.test.ts': ['qa-functional-cli-report', 'qa-functional-webhook-report'],
  'test/skill-e2e-qa-functional-fix.test.ts': ['qa-functional-cli-fix', 'qa-functional-webhook-fix'],
  'test/skill-e2e-qa-callers.test.ts': ['review-exploratory-small-cli', 'ship-exploratory-small-cli', 'ship-exploratory-unavailable', 'ship-exploratory-plan-checks', 'ship-exploratory-late-input'],
  'test/skill-e2e-review.test.ts': ['review-sql-injection'],
  'test/skill-e2e-coverage-audit.test.ts': ['review-coverage-audit', 'plan-eng-coverage-audit'],
  'test/skill-e2e-test-value.test.ts': ['ship-coverage-value', 'review-test-value', 'test-audit-report-only'],
  'test/skill-e2e-plan.test.ts': ['plan-review-report'],
  'test/skill-e2e-ask-user-question-format-compliance.test.ts': ['auq-format-gate'],
  'test/skill-e2e-design.test.ts': ['plan-design-review-no-ui-scope'],
  'test/skill-e2e-third-party-actions.test.ts': ['tpa-present', 'tpa-absent-linux'],
  'test/skill-e2e-workflow.test.ts': ['ship-local-workflow', 'ship-coverage-audit', 'gstack-upgrade-happy-path'],
  'test/skill-e2e-ship-hook-refresh.test.ts': ['ship-managed-hook-refresh'],
  'test/skill-e2e-ship-hook-consent.test.ts': ['ship-unmanaged-hook-consent', 'ship-local-hook-preservation'],
  'test/skill-e2e-docsync-spawned.test.ts': ['docsync-spawned'],
  'test/skill-e2e-ship-docsync.test.ts': ['ship-docsync-completion', 'ship-docsync-current', 'ship-docsync-failure', 'ship-docsync-store', 'ship-docsync-missing-marker', 'ship-docsync-missing-asset', 'ship-docsync-launch-failure', 'ship-docsync-timeout-unsettled', 'ship-docsync-late-result', 'ship-docsync-stale-before', 'ship-docsync-stale-after', 'ship-docsync-recovery'],
  'test/skill-e2e-deploy.test.ts': ['setup-deploy-workflow'],
  'test/skill-e2e-session-intelligence.test.ts': ['context-restore-loads-latest'],
  'test/skill-e2e-plan-tune.test.ts': ['plan-tune-inspect'],
  'test/skill-e2e-skillify.test.ts': ['skillify-provenance-refusal'],
  'test/skill-e2e-diagram.test.ts': ['diagram-triplet'],
  'test/skill-e2e-learnings.test.ts': ['learnings-show'],
};

const ROOT = path.resolve(import.meta.dir, '..');

/** The one paid test file whose source registers a case (its touchfiles name exactly one), else null. */
export function caseOwnerFile(id: string, maps: Pick<PrProfileMaps, 'e2eTouchfiles'> = PR_PROFILE_MAPS): string | null {
  const owners = (maps.e2eTouchfiles[id] ?? []).filter(dep => /^test\/[^/]+\.test\.ts$/.test(dep) && isPaidTestFile(dep));
  return owners.length === 1 ? owners[0]! : null;
}

/**
 * DX-11: a gate case outside the audited profile can run in the PR lane only
 * when the runner can select it by name: its owner registers a Bun test whose
 * name is the case id (testIfSelected / testConcurrentIfSelected / test with
 * the literal id), which is what the PR lane's case-name pattern matches.
 */
export function caseNameAddressable(id: string, source: string): boolean {
  const quoted = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  return new RegExp(`(?:^|[\\s;{(])(?:test(?:Concurrent)?IfSelected|test(?:\\.concurrent)?)\\(\\s*(['"\`])${quoted}\\1`, 'm').test(code);
}

const sourceCache = new Map<string, string>();
const readRepoSource = (file: string): string => {
  if (!sourceCache.has(file)) {
    try { sourceCache.set(file, fs.readFileSync(path.join(ROOT, file), 'utf8')); } catch { sourceCache.set(file, ''); }
  }
  return sourceCache.get(file)!;
};

/** Selectable outside the profile: a gate case with one owning paid file that names it as a test. */
export function prProfileDirectCase(id: string, maps: PrProfileMaps = PR_PROFILE_MAPS, readSource = readRepoSource): string | null {
  if (maps.tiers[id] !== 'gate') return null;
  const owner = caseOwnerFile(id, maps);
  return owner && caseNameAddressable(id, readSource(owner)) ? owner : null;
}

/** Whether a manifest may carry this case in the PR lane: audited profile, or a recorded name-addressable direct case. */
export function prProfileCaseAllowed(id: string, directCases: readonly string[] = []): boolean {
  return (PR_PROFILE_CASE_IDS as readonly string[]).includes(id) || (directCases.includes(id) && prProfileDirectCase(id) !== null);
}

/** File -> PR-lane case ids: the audited map plus the selected direct cases each file owns (DX-11). */
export function prProfileFileMap(selected: readonly string[] | null): Record<string, readonly string[]> {
  const map: Record<string, string[]> = Object.fromEntries(Object.entries(PR_PROFILE_FILES).map(([file, ids]) => [file, [...ids]]));
  for (const id of selected ?? []) {
    if ((PR_PROFILE_CASE_IDS as readonly string[]).includes(id)) continue;
    const owner = prProfileDirectCase(id);
    if (owner) (map[owner] ??= []).push(id);
  }
  return map;
}

/** The PR-lane case ids one test file owns under `selected`. */
export function prProfileFileCases(file: string, selected: readonly string[] | null): readonly string[] {
  return prProfileFileMap(selected)[file] ?? [];
}

export interface PrProfileMaps {
  e2eTouchfiles: Record<string, string[]>;
  judgeTouchfiles: Record<string, string[]>;
  tiers: Record<string, 'gate' | 'periodic' | 'marathon'>;
  globalTouchfiles: readonly string[];
}

export const PR_PROFILE_MAPS: PrProfileMaps = {
  e2eTouchfiles: E2E_TOUCHFILES, judgeTouchfiles: LLM_JUDGE_TOUCHFILES,
  tiers: E2E_TIERS, globalTouchfiles: GLOBAL_TOUCHFILES,
};

export interface PrProfileSelection {
  /**
   * pr: the fast profile on mapped inputs; dependents: every gate case whose
   * derived reference closure holds a changed file (no profile cut);
   * full-fallback: a global build/runtime input or an underivable file.
   */
  mode: 'pr' | 'dependents' | 'full-fallback';
  e2e: string[];
  judges: string[];
  deferred: Array<{ id: string; tier: 'gate' | 'periodic' | 'marathon'; reason: string }>;
  unknownFiles: string[];
  /** One label and fix per unknown file (CEO-13/DX-6). */
  unknownFileLabels: Array<{ file: string; label: string; fix: string }>;
  /** DX-11: gate cases outside the profile selected because their own paid test file changed. */
  directCases: string[];
  /** Unmapped changed files placed by derived references (scripts/pr-dependencies.ts), with their consumer counts. */
  derivedFiles: Array<{ file: string; e2e: number; judges: number }>;
  /** Unmapped changed files under derivable directories that no paid case's reference closure reaches. */
  noConsumerFiles: string[];
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
    if (maps.tiers[id] !== 'gate' && maps.tiers[id] !== 'periodic' && maps.tiers[id] !== 'marathon') {
      throw new Error(`E2E case has no broad gate/periodic/marathon census: ${id}`);
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

/** Workflows that define or feed the paid eval lanes; every other workflow is free-lane only. */
export const PAID_WORKFLOW_FILES = [
  '.github/workflows/evals.yml',
  '.github/workflows/evals-periodic.yml',
  '.github/workflows/evals-marathon.yml',
] as const;

/**
 * Files no paid case consumes. Entries may be globs. Scheduler inputs change
 * packing and derived job timeouts, never which cases run or how they are
 * judged; the listed workflows never run a paid case (test/free-fixtures.test.ts
 * fails when a workflow is in neither this list nor PAID_WORKFLOW_FILES).
 */
export const FREE_ONLY_PR_FILES = [
  'scripts/test-free-shards.ts',
  'scripts/lib/free-home-guard.ts', // Imported only by the free shard runner.
  'test/helpers/auq-parallel-worker.ts',
  'test/helpers/stored-zip.ts', // Read only by the free test-health report tests.
  'scripts/free-test-durations.json',
  'scripts/paid-test-durations.json',
  'scripts/ubicloud/**',
  'tsconfig.test.json', // Read only by `tsc -p tsconfig.test.json` (typecheck:test); Bun's runtime reads tsconfig.json.
  '.gitignore', // Changes which untracked files git reports, never tracked content a case reads.
  'scripts/retired-command.ts', // One-release stubs for retired package scripts; no paid case imports it.
  // Reporting and launch tools: they read CI history or start a lane, never run inside a paid case.
  'scripts/test-health-report.ts',
  'scripts/bump-harness-version.ts',
  'scripts/eval-bg.ts',
  '.github/workflows/actionlint.yml',
  '.github/workflows/arm-setup-smoke.yml',
  '.github/workflows/ci-image.yml',
  '.github/workflows/cso-runtime-images.yml',
  '.github/workflows/cso-runtime-promote.yml',
  '.github/workflows/cso-runtime-qualification.yml',
  '.github/workflows/cso-scanner-images.yml',
  '.github/workflows/dependency-review.yml',
  '.github/workflows/free-tests.yml',
  '.github/workflows/make-pdf-gate.yml',
  '.github/workflows/native-qualification.yml',
  '.github/workflows/osv-scanner.yml',
  '.github/workflows/platform-qualification.yml',
  '.github/workflows/pr-title-sync.yml',
  '.github/workflows/quality-gate.yml',
  '.github/workflows/scorecard.yml',
  '.github/workflows/skill-docs.yml',
  '.github/workflows/test-health.yml',
  '.github/workflows/eval-sweep.yml', // The weekly off-ship sweep on main; no PR-gate case reads it, and it never gates a PR.
  '.github/actionlint.yaml', // Runner labels for actionlint only.
  'scripts/ship-measure-sweep.ts', // The weekly sweep CLI; it launches paid cases, never runs inside one.
  '.github/workflows/version-gate.yml',
  '.github/workflows/windows-free-tests.yml',
  '.github/workflows/windows-setup-e2e.yml',
] as const;

/**
 * Inputs every paid case consumes that must always restore the full gate
 * (fail closed, even when a touchfile or a derived reference also names
 * them): dependencies and the CI image, setup and the build, the PR
 * workflow and its setup actions, the Bun test preload and compiler config,
 * line-ending policy, the skill generator with the preamble every skill
 * embeds, and the eval policy every case is planned under.
 */
export const PR_FULL_GATE_FILES = [
  'package.json', 'bun.lock', '.github/docker/Dockerfile.ci',
  'scripts/host-config.ts', 'scripts/discover-skills.ts', 'hosts/index.ts',
  'setup', 'scripts/build.sh', '.github/workflows/evals.yml', '.github/actions/**',
  'test-setup.ts', 'bunfig.toml', 'tsconfig.json', '.gitattributes',
  'scripts/gen-skill-docs.ts', 'scripts/resolvers/index.ts', 'scripts/resolvers/types.ts',
  'scripts/resolvers/preamble.ts', 'scripts/resolvers/preamble/**', 'scripts/resolvers/runtime-root.ts',
  'test/helpers/periodic-exclude-data.ts',
] as const;

/** Periodic- and marathon-lane workflows: the PR gate never runs a case under them; their branch dispatch validates them. */
export const PERIODIC_ONLY_PR_FILES = ['.github/workflows/evals-periodic.yml', '.github/workflows/evals-marathon.yml'] as const;

/** Directories the reference derivation covers: an unmapped file there with no consumer is consumed by no paid case. */
export const DERIVABLE_PREFIXES = ['bin/', 'lib/', 'scripts/', 'browse/', 'design/', 'make-pdf/', 'hosts/', 'extension/', 'model-overlays/', 'agents/', 'test/helpers/'] as const;

function knownNonBehaviorFile(file: string): boolean {
  // A mapped dependency still wins over these exemptions. New helper,
  // runtime, dependency, or paid-workflow files are deliberately not exempted.
  return /^(?:docs\/|(?:README|CONTRIBUTING|ARCHITECTURE|CHANGELOG|TODOS)\.md$|VERSION$)/.test(file)
    // Hermetic skill views exclude checkout instructions; these are maintained
    // by free doc/generation checks and are not copied into paid fixtures.
    || ['AGENTS.md', 'CLAUDE.md', 'agents-digest/gstack-AGENTS.md'].includes(file)
    || FREE_ONLY_PR_FILES.some(pattern => matchGlob(file, pattern))
    || (PERIODIC_ONLY_PR_FILES as readonly string[]).includes(file)
    || (file.startsWith('test/fixtures/') && Object.keys(FREE_FIXTURES).some(pattern => matchGlob(file, pattern)))
    // Free test files anywhere (test/, browse/test/, design/test/, make-pdf/test/): no paid case runs or reads a free test.
    || (/\.test\.tsx?$/.test(file) && !isPaidTestFile(file));
}

export const FALLBACK_FIX_ANCHOR = 'docs/TESTING_INTERNALS.md#pr-paid-lane-fallback';

/** Why one changed file restored the full gate, and the edit that narrows it next time (DX-6). */
export function unknownFileLabel(file: string): { label: string; fix: string } {
  if (isPaidTestFile(file) || file.startsWith('test/helpers/')) {
    return { label: 'needs touchfile entry', fix: `register ${file} under the cases that consume it in test/helpers/touchfiles-data.ts` };
  }
  if (file.startsWith('test/fixtures/')) {
    return { label: 'needs touchfile entry', fix: `register ${file} in the touchfiles of the paid cases that read it, or add it with its free consumers to FREE_FIXTURES in test/helpers/free-fixtures-data.ts` };
  }
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) && !(PAID_WORKFLOW_FILES as readonly string[]).includes(file)) {
    return { label: 'add to FREE_ONLY_PR_FILES', fix: `add ${file} to FREE_ONLY_PR_FILES in scripts/test-pr-profile.ts` };
  }
  return { label: 'real unknown dependency', fix: `register ${file} under the cases that consume it in test/helpers/touchfiles-data.ts, add it to FREE_ONLY_PR_FILES in scripts/test-pr-profile.ts if no paid case reads it, or add its directory to DERIVABLE_PREFIXES so scripts/pr-dependencies.ts derives its consumers` };
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
  /** Test-file source reader for the DX-11 addressability check (defaults to the checkout). */
  readSource?: (file: string) => string;
  /** Derived references; default: derived from the checkout for the real maps, none for fixture maps. */
  derived?: DerivedDependencies | null;
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
  const unmapped = files.filter(file => file !== TOUCHFILES_DATA_PATH
    && !depends(file, dependencyPatterns) && !knownNonBehaviorFile(file));
  // Unmapped files are placed by derived references where the derivation covers them; the rest restore the full gate.
  const derived = options.derived !== undefined ? options.derived : maps === PR_PROFILE_MAPS ? derivedDependencies(maps, ROOT) : null;
  // A path absent from the head tree was deleted by the diff: its consumers are the live files that still reference it.
  const consumers = new Map<string, { e2e: Set<string>; judges: Set<string> }>();
  const derivedGlobal: string[] = [];
  const noConsumerFiles: string[] = [];
  const deletedLabels = new Map<string, { label: string; fix: string }>();
  for (const file of derived ? unmapped : []) {
    if (derived!.tracked.has(file)) {
      if (derived!.global.has(file)) { derivedGlobal.push(file); continue; }
      const found = { e2e: derived!.e2e.get(file) ?? new Set<string>(), judges: derived!.judges.get(file) ?? new Set<string>() };
      if (found.e2e.size + found.judges.size > 0) consumers.set(file, found);
      else if (DERIVABLE_PREFIXES.some(prefix => file.startsWith(prefix))) noConsumerFiles.push(file);
      continue;
    }
    const referencers = derived!.referencers(file);
    const fullGate = referencers.find(referencer => matches(referencer, PR_FULL_GATE_FILES));
    if (fullGate) {
      deletedLabels.set(file, { label: 'deleted but still referenced', fix: `${file} is deleted but ${fullGate} (a full-gate input) still references it; remove the reference or restore the file` });
      continue;
    }
    if (referencers.some(referencer => derived!.global.has(referencer))) { derivedGlobal.push(file); continue; }
    const found = { e2e: new Set(referencers.flatMap(referencer => [...derived!.e2e.get(referencer) ?? []])),
      judges: new Set(referencers.flatMap(referencer => [...derived!.judges.get(referencer) ?? []])) };
    if (found.e2e.size + found.judges.size > 0) consumers.set(file, found);
    else noConsumerFiles.push(file);
  }
  const derivedFiles = [...consumers.keys()];
  const unknownFiles = unmapped.filter(file => !derivedGlobal.includes(file) && !consumers.has(file) && !noConsumerFiles.includes(file));
  const sharedInputs = files.filter(file => depends(file, PR_FULL_GATE_FILES));
  const fallback = unknownFiles.length > 0 || sharedInputs.length > 0;
  const dependentsMode = !fallback && derivedFiles.length > 0;
  const derivedE2E = derivedFiles.flatMap(file => [...consumers.get(file)!.e2e]);
  const derivedJudges = derivedFiles.flatMap(file => [...consumers.get(file)!.judges]);
  // A file in the global touchfiles' import closure is as broad as a global touchfile.
  const everything = derivedGlobal.length > 0;
  const candidates = fallback || everything ? Object.keys(maps.e2eTouchfiles).sort() : [...new Set([...selectedE2E, ...derivedE2E])].sort();
  // DX-11: an edited paid test file runs its own gate cases even outside the profile, when the runner can select them by name.
  const editedPaid = new Set(files.filter(file => isPaidTestFile(file)));
  const owned = candidates.filter(id => maps.tiers[id] === 'gate' && !profile.includes(id) && editedPaid.has(caseOwnerFile(id, maps) ?? ''));
  const directCases = fallback || dependentsMode ? [] : owned.filter(id => prProfileDirectCase(id, maps, options.readSource) !== null);
  const unaddressed = fallback || dependentsMode ? [] : owned.filter(id => !directCases.includes(id));
  const e2e = candidates.filter(id => maps.tiers[id] === 'gate' && (fallback || dependentsMode || profile.includes(id) || directCases.includes(id)));
  const judges = fallback || everything ? Object.keys(maps.judgeTouchfiles).sort() : [...new Set([...selectedJudges, ...derivedJudges])].sort();
  const kept = new Set(e2e);
  const deferred = candidates.filter(id => !kept.has(id)).map(id => ({
    id, tier: maps.tiers[id],
    reason: maps.tiers[id] === 'marathon'
      ? 'Full end-to-end marathon coverage; non-blocking lane, not executed by the PR gate'
      : maps.tiers[id] === 'periodic'
        ? 'Broad periodic/release coverage; not executed by the PR gate'
        : unaddressed.includes(id)
          ? `Its test file changed, but the PR lane cannot select it by name; name its Bun test '${id}' (testIfSelected) to run it on PRs`
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
  const reasons: string[] = [];
  if (unknownFiles.length) reasons.push(`Unknown dependencies restore every gate case and judge: ${unknownFiles.map(file => `${file} (${(deletedLabels.get(file) ?? unknownFileLabel(file)).label})`).join(', ')}`);
  if (sharedInputs.length) reasons.push(`Shared runtime/build inputs restore every gate case and judge: ${sharedInputs.join(', ')}`);
  if (dependentsMode) reasons.push(`Derived references select every dependent gate case: ${derivedFiles.map(file => `${file} (${consumers.get(file)!.e2e.size} cases)`).join(', ')}`);
  else if (!fallback) reasons.push('Changed-input selection intersected with the fast PR profile; selected judges retained');
  if (derivedGlobal.length) reasons.push(`Paid-runner inputs (global touchfile import closure) select every case: ${derivedGlobal.join(', ')}`);
  if (noConsumerFiles.length) reasons.push(`No paid case's reference closure reaches (or, deleted, still references): ${noConsumerFiles.join(', ')}`);
  if (directCases.length) reasons.push(`Edited paid test files select their own gate cases: ${directCases.join(', ')}`);
  if (deferred.length) reasons.push(`${deferred.length} selected behaviors remain scheduled/release coverage, not PR passes`);
  if (deferredPromptFiles.length) reasons.push(`No quick live coverage; known broad prompt checks deferred: ${deferredPromptFiles.join(', ')}`);
  if (missingCoverage.length) reasons.push(`Full validation required for prompts without a relevant PR check: ${missingCoverage.join(', ')}`);
  return {
    mode: fallback ? 'full-fallback' : dependentsMode ? 'dependents' : 'pr', e2e, judges, deferred,
    unknownFiles, unknownFileLabels: unknownFiles.map(file => ({ file, ...(deletedLabels.get(file) ?? unknownFileLabel(file)) })), directCases,
    derivedFiles: derivedFiles.map(file => ({ file, e2e: consumers.get(file)!.e2e.size, judges: consumers.get(file)!.judges.size })), noConsumerFiles,
    deferredPromptFiles, missingCoverage, needsFullValidation: missingCoverage.length > 0, reasons,
  };
}

/** The manifest fields the coverage summary reads (a PaidRunManifest subset). */
export interface CoverageSummaryInput {
  profile?: string;
  selection?: { e2e: string[] | null; judges: string[] | null };
  prCoverage?: Pick<PrProfileSelection, 'mode' | 'deferred' | 'unknownFiles'> & Partial<Pick<PrProfileSelection, 'unknownFileLabels' | 'derivedFiles' | 'noConsumerFiles'>>;
}

/**
 * Job-summary block for one PR plan (CEO-13): the profile mode, selected case
 * counts, reused records once the report has them, and on fallback every
 * file that restored the full gate with its fix.
 */
export function formatPrCoverageSummary(manifest: CoverageSummaryInput, totals?: { total: number; reused: number }): string[] {
  const coverage = manifest.prCoverage;
  const count = (ids: string[] | null | undefined) => ids === null || ids === undefined ? 'all' : String(ids.length);
  const lines = [
    '### PR paid lane coverage',
    `- Mode: \`${coverage?.mode ?? manifest.profile ?? 'full'}\``,
    `- Selected: ${count(manifest.selection?.e2e)} E2E case(s), ${count(manifest.selection?.judges)} judge(s); ${coverage?.deferred.length ?? 0} deferred to scheduled/release coverage`,
  ];
  if (totals) lines.push(`- Reused: ${totals.reused} of ${totals.total} rule/judge record(s) came from verified receipts`);
  if (coverage?.derivedFiles?.length) {
    lines.push(`- Derived dependents (scripts/pr-dependencies.ts) of ${coverage.derivedFiles.length} unmapped file(s):`);
    for (const item of coverage.derivedFiles.slice(0, 40)) lines.push(`  - \`${item.file}\`: ${item.e2e} case(s), ${item.judges} judge(s)`);
  }
  if (coverage?.noConsumerFiles?.length) lines.push(`- No paid case reaches: ${coverage.noConsumerFiles.slice(0, 40).map(file => `\`${file}\``).join(', ')}`);
  if (coverage?.mode === 'full-fallback' && coverage.unknownFiles.length) {
    lines.push(`- Full gate restored by ${coverage.unknownFiles.length} file(s) (fix: ${FALLBACK_FIX_ANCHOR}):`);
    for (const file of coverage.unknownFiles) {
      const labeled = coverage.unknownFileLabels?.find(entry => entry.file === file) ?? { file, ...unknownFileLabel(file) };
      lines.push(`  - \`${file}\` (${labeled.label}): ${labeled.fix}`);
    }
  }
  return lines;
}

if (import.meta.main) {
  const [command, manifestPath, outcomesPath] = process.argv.slice(2);
  if (command !== 'summary' || !manifestPath) {
    console.error('usage: bun run scripts/test-pr-profile.ts summary <manifest.json> [collector-outcomes.json]');
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as CoverageSummaryInput;
  let totals: { total: number; reused: number } | undefined;
  if (outcomesPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(outcomesPath, 'utf8'));
      if (Number.isSafeInteger(parsed?.totals?.total) && Number.isSafeInteger(parsed?.totals?.reused)) totals = parsed.totals;
    } catch { /* No verified report: the summary omits the reuse line. */ }
  }
  console.log(formatPrCoverageSummary(manifest, totals).join('\n'));
}
