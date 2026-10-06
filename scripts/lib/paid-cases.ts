/**
 * Case and trial shard keys for the paid lane: which files shard per case, how a case shard and its trials are named, and expansion of files into case/trial shards. Moved from scripts/test-paid-shards.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeRelativePath } from './shard-engine';
import { CASE_CI_EXCLUDE, CASE_QUARANTINE, EVAL_POLICY } from '../../test/helpers/periodic-exclude-data';
import type { EvalCaseKind, PanelShape } from '../../test/helpers/eval-store';
import { E2E_KINDS } from '../../test/helpers/touchfiles-data';
import { E2E_TOUCHFILES, E2E_TIERS } from '../../test/helpers/touchfiles';
import { type PaidTier, ROOT } from './paid-types';

/**
 * The E2E ids a paid file registers: the touchfile registrations that list the
 * file. `known` is true only when those ids are complete: no computed
 * registration (testName, *IfSelected, describeIfSelected with a non-literal
 * argument) and every literal registration argument is among them
 * (`unregistered` lists the literal ids that are not). Quoted strings
 * elsewhere (comments, skill paths) never count.
 */
export function fileCaseRegistration(
  file: string, source: string,
  touchfiles: Record<string, string[]> = E2E_TOUCHFILES,
  tiers: Record<string, string> = E2E_TIERS,
): { registered: string[]; known: boolean; computed: boolean; unregistered: string[] } {
  const rel = normalizeRelativePath(file);
  const registered = Object.keys(touchfiles).filter(key => touchfiles[key]!.includes(rel));
  const computed = /testName\s*:\s*(?!string\b)(?:`[^`]*\$\{|[A-Za-z_$])/.test(source)
    || /\btest(?:Concurrent)?IfSelected\s*\(\s*(?:`[^`]*\$\{|[A-Za-z_$])/.test(source)
    || /\bdescribeIfSelected\s*\([^,]*,(?!\s*\[)/.test(source)
    || [...source.matchAll(/\bdescribeIfSelected\s*\([^,]*,\s*\[([^\]]*)\]/g)].some(m => m[1]!.split(',')
      .map(item => item.trim()).some(item => item && !/^(['"`])[^'"`$]*\1$/.test(item)));
  const literal = [
    ...[...source.matchAll(/testName\s*:\s*(['"`])([^'"`]+)\1/g)].map(m => m[2]!),
    ...[...source.matchAll(/\btest(?:Concurrent)?IfSelected\s*\(\s*(['"`])([^'"`]+)\1/g)].map(m => m[2]!),
    ...[...source.matchAll(/\bdescribeIfSelected\s*\([^,]*,\s*\[([^\]]*)\]/g)]
      .flatMap(m => [...m[1]!.matchAll(/(['"`])([^'"`]+)\1/g)].map(n => n[2]!)),
  ].filter(id => id in tiers);
  const unregistered = [...new Set(literal.filter(id => !registered.includes(id)))];
  return { registered, known: registered.length > 0 && !computed && unregistered.length === 0, computed, unregistered };
}


/**
 * Files whose cases run in separate processes, one shard per registered E2E
 * case (`<file>#<case id>`): the file's lane wall exceeds one runner's budget
 * while every case is short. Separate processes also give each case its own
 * SDK semaphore, so shared-libs(-paths) capture waves never queue inside a
 * sibling case's wall (the reason paths runs test.serial in one process).
 * Every case must be a registered, literal E2E id whose Bun test name is the
 * id or its CASE_TEST_NAMES label (test/paid-shards.test.ts scans the sources).
 */
export const CASE_SHARDED_FILES: readonly string[] = [
  // W5a: one carved skill per case shard (was 15 one-line wrapper files under one case id).
  'test/carve-section-loading.test.ts',
  'test/skill-e2e-deploy.test.ts',
  'test/skill-e2e-design.test.ts',
  'test/skill-e2e-plan.test.ts',
  'test/skill-e2e-review-army.test.ts',
  'test/skill-e2e-shared-libs-paths.test.ts',
  'test/skill-e2e-shared-libs.test.ts',
  'test/skill-e2e-ship-docsync.test.ts',
  'test/skill-e2e-qa-callers.test.ts',
  // W5c: its gate cases (qa-quick, qa-only-no-fix, qa-bootstrap) no longer share one ~7-minute runner.
  'test/skill-e2e-qa-workflow.test.ts',
];

/** Bun test names that differ from their E2E id. */
export const CASE_TEST_NAMES: Record<string, string> = {
  'plan-review-report': '/plan-eng-review writes GSTACK REVIEW REPORT to plan file',
  'auq-format-gate': "/plan-ceo-review's first AskUserQuestion is a compliant decision brief (7/7 + substance)",
  'autoplan-dual-voice': 'both Claude + Codex voices produce output in Phase 1 (within timeout)',
  'cso-full-audit': '/cso persists supported tenant-boundary findings with redacted evidence',
  'cso-diff-mode': '/cso --diff records its base and investigates changed security paths',
  'cso-infra-scope': '/cso --infra finds an attacker-to-credential execution path',
  'plan-ceo-review-plan-mode': 'first terminal outcome is asked (Step 0 fires before any plan write)',
  'plan-eng-review-artifact': 'an interactive review writes one QA test plan about the reviewed change',
  'plan-eng-review-artifact-full': 'a fresh interactive review reaches Test review and writes one QA test plan',
};

export const CASE_KEY_SEPARATOR = '#';
const TRIAL_SUFFIX = /~t([1-9][0-9]*)$/;

/** The test file behind a shard key (`<file>`, `<file>#<case id>` or `<file>#<case id>~t<N>`). */
export function shardFile(key: string): string {
  return normalizeRelativePath(key).split(CASE_KEY_SEPARATOR)[0]!;
}

/** The E2E case id of a case or trial shard key, else null. */
export function shardCaseId(key: string): string | null {
  const [, id] = normalizeRelativePath(key).split(CASE_KEY_SEPARATOR);
  return id === undefined ? null : id.replace(TRIAL_SUFFIX, '');
}

/** The 1-based trial index of an isolated trial shard key, else null. */
export function shardTrial(key: string): number | null {
  const [, id] = normalizeRelativePath(key).split(CASE_KEY_SEPARATOR);
  const match = id === undefined ? null : TRIAL_SUFFIX.exec(id);
  return match ? Number(match[1]) : null;
}

/** Shard key of one trial of an isolated case. */
export function trialShardKey(file: string, id: string, trial: number): string {
  return `${normalizeRelativePath(file)}${CASE_KEY_SEPARATOR}${id}~t${trial}`;
}

/** Trial policy of one case, fixed from the registries before the run. */
export interface CaseTrialPlan { kind: EvalCaseKind; panel: PanelShape; quarantined: boolean }

/**
 * `behavior` cases run EVAL_POLICY.panel; a quarantined case runs a full panel
 * whose k keeps its kind's meaning (k = n for rule); everything else runs one
 * trial. Only behavior and quarantined cases are isolated into trial shards.
 */
export function caseTrialPlan(id: string, kinds: Record<string, EvalCaseKind> = E2E_KINDS,
  quarantine: Record<string, unknown> = CASE_QUARANTINE): CaseTrialPlan {
  const kind = kinds[id] ?? 'rule';
  const quarantined = Object.hasOwn(quarantine, id);
  if (kind === 'behavior') return { kind, panel: { ...EVAL_POLICY.panel }, quarantined };
  if (quarantined) return { kind, panel: { n: EVAL_POLICY.panel.n, k: EVAL_POLICY.panel.n }, quarantined };
  return { kind, panel: { n: 1, k: 1 }, quarantined };
}

export function isIsolatedCase(plan: CaseTrialPlan): boolean {
  return plan.kind === 'behavior' || plan.quarantined;
}

export function sameTrialPlan(a: CaseTrialPlan | undefined, b: CaseTrialPlan | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && a.quarantined === b.quarantined && a.panel?.n === b.panel?.n && a.panel?.k === b.panel?.k;
}

/** Bun name pattern that runs every case of a file except `ids` (their trial shards run them). */
export function excludedCasesNamePattern(ids: string[]): string {
  const escaped = ids.map(id => (CASE_TEST_NAMES[id] ?? id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `^(?!.*(?:^|\\s)(?:${escaped.join('|')})$)`;
}

/** Exact Bun name pattern for a set of case ids (labels where the test name differs). */
export function caseTestNamePattern(ids: string[]): string {
  const escaped = ids.map(id => (CASE_TEST_NAMES[id] ?? id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `(?:^|\\s)(?:${escaped.join('|')})$`;
}

/**
 * Replace each case-sharded file with one key per registered case of `tier`.
 * Throws when such a file's registration is not statically complete: an
 * unregistered case would otherwise silently never run.
 */
export function expandCaseShards(files: string[], tier: PaidTier, rootDir = ROOT,
  touchfiles: Record<string, string[]> = E2E_TOUCHFILES, tiers: Record<string, string> = E2E_TIERS): string[] {
  return files.flatMap(file => {
    const rel = normalizeRelativePath(file);
    if (!CASE_SHARDED_FILES.includes(rel)) return [file];
    const { registered, known } = fileCaseRegistration(rel, fs.readFileSync(path.join(rootDir, rel), 'utf8'), touchfiles, tiers);
    if (!known) throw new Error(`Case-sharded ${rel} needs a complete literal case registration`);
    return registered.filter(id => tiers[id] === tier).sort().map(id => `${rel}${CASE_KEY_SEPARATOR}${id}`);
  });
}

export interface TrialExpansion {
  keys: string[];
  /** Trial policy per trial shard key. */
  trials: Record<string, CaseTrialPlan>;
  /** File shard key -> isolated case ids its name pattern excludes. */
  excludeCases: Record<string, string[]>;
}

/**
 * Isolate every behavior or quarantined case of `tier` into its panel of trial
 * shards (`<file>#<id>~t1..tn`), each selected by EVALS_SELECTION_JSON=[id] and
 * its exact test name. The file shard keeps the remaining ids of the tier and
 * excludes the isolated ones by name; with none remaining it is dropped. A case
 * may be isolated only when its file's registration is statically known.
 */
export function expandTrialShards(keys: string[], tier: PaidTier, rootDir = ROOT, opts: {
  kinds?: Record<string, EvalCaseKind>; quarantine?: Record<string, unknown>;
  touchfiles?: Record<string, string[]>; tiers?: Record<string, string>;
} = {}): TrialExpansion {
  const touchfiles = opts.touchfiles ?? E2E_TOUCHFILES;
  const tiers = opts.tiers ?? E2E_TIERS;
  const planOf = (id: string) => caseTrialPlan(id, opts.kinds, opts.quarantine);
  const out: TrialExpansion = { keys: [], trials: {}, excludeCases: {} };
  const addPanel = (file: string, id: string) => {
    const plan = planOf(id);
    for (let trial = 1; trial <= plan.panel.n; trial++) {
      const key = trialShardKey(file, id, trial);
      out.keys.push(key);
      out.trials[key] = plan;
    }
  };
  for (const key of keys) {
    const file = shardFile(key);
    const caseId = shardCaseId(key);
    if (caseId !== null) {
      if (isIsolatedCase(planOf(caseId))) addPanel(file, caseId);
      else out.keys.push(key);
      continue;
    }
    const { registered, known } = fileCaseRegistration(file, fs.readFileSync(path.join(rootDir, file), 'utf8'), touchfiles, tiers);
    const inTier = registered.filter(id => tiers[id] === tier);
    const isolated = inTier.filter(id => isIsolatedCase(planOf(id)));
    if (isolated.length === 0) { out.keys.push(key); continue; }
    if (!known) {
      throw new Error(`${file}: behavior or quarantined case(s) ${isolated.join(', ')} need a statically known case registration`);
    }
    for (const id of isolated) addPanel(file, id);
    if (inTier.length > isolated.length) {
      out.keys.push(key);
      out.excludeCases[normalizeRelativePath(key)] = [...isolated].sort();
    }
  }
  return out;
}

/**
 * Split expanded shard keys into runnable keys and CI-unrunnable cases
 * (CASE_CI_EXCLUDE), each with its surfaced reason; never an empty shard.
 */
export function partitionCaseExclusions(keys: string[]): { runnable: string[]; excluded: Array<{ file: string; reason: string }> } {
  const excluded: Array<{ file: string; reason: string }> = [];
  const runnable = keys.filter(key => {
    const exclusion = CASE_CI_EXCLUDE[normalizeRelativePath(key)];
    if (exclusion) excluded.push({ file: key, reason: `excluded: ${exclusion.reason} [${exclusion.tracking}]` });
    return !exclusion;
  });
  return { runnable, excluded };
}

/**
 * Codex access in the CI eval image, scoped per paid shard.
 *
 * The image installs the pinned Codex CLI off PATH (GSTACK_CI_CODEX_BIN_DIR)
 * and the eval workflows log it in under a non-default home
 * (GSTACK_CI_CODEX_HOME). A gate shard never sees either. A non-gate shard
 * whose every file exercises Codex gets the CLI on PATH and the home as
 * CODEX_HOME. A file that mixes one Codex case with other cases keeps only
 * the two variables, and that case opts in on its own session; hermetic
 * child environments drop GSTACK_* names, so its sibling sessions see no
 * Codex. Every other shard sees neither, so a skill's outside-voice probe
 * (`command -v codex`) reports not_installed exactly as it did before Codex
 * entered the image. Outside CI neither variable is set and nothing changes.
 */
export const CODEX_CI_ENV = { binDir: 'GSTACK_CI_CODEX_BIN_DIR', home: 'GSTACK_CI_CODEX_HOME' } as const;

/** Paid files whose every case exercises the real Codex CLI. */
export const CODEX_CI_FILES: readonly string[] = [
  'test/codex-e2e.test.ts',
  'test/codex-e2e-sol-scope.test.ts',
  'test/codex-e2e-shared-libs.test.ts',
  'test/codex-e2e-recommendation-substance.test.ts',
  'test/skill-e2e-outside-voice.test.ts',
  'test/skill-e2e-outside-plan-disabled.test.ts',
  'test/skill-e2e-safety-codex-boundary.test.ts',
  'test/codex-e2e-multiblock-live.test.ts',
];

/**
 * Codex cases inside files whose other cases must not see Codex. Each listed
 * case opts in by putting $GSTACK_CI_CODEX_BIN_DIR on its own session PATH
 * (inline, so the file's other touchfile keys do not grow a helper).
 */
export const CODEX_CI_CASES: Readonly<Record<string, readonly string[]>> = {
  'test/skill-e2e-workflow.test.ts': ['codex-review'],
};

export type CodexShardAccess = 'none' | 'case-opt-in' | 'path';

/** What one shard, given the test files behind its keys, may see of the CI Codex install in `tier`. */
export function codexShardAccess(files: readonly string[], tier: string | undefined): CodexShardAccess {
  if (tier === 'gate' || files.length === 0) return 'none';
  if (files.every(file => CODEX_CI_FILES.includes(file))) return 'path';
  return files.every(file => file in CODEX_CI_CASES) ? 'case-opt-in' : 'none';
}

/** Scope one shard's child environment in place; `files` are the shard keys' test files. */
export function scopeCodexAccess(env: NodeJS.ProcessEnv, files: readonly string[]): void {
  const binDir = env[CODEX_CI_ENV.binDir];
  if (!binDir) return;
  const home = env[CODEX_CI_ENV.home];
  const access = codexShardAccess(files, env.EVALS_TIER);
  delete env.CODEX_HOME;
  if (access === 'case-opt-in') return;
  delete env[CODEX_CI_ENV.binDir];
  delete env[CODEX_CI_ENV.home];
  if (access !== 'path') return;
  env.PATH = env.PATH ? `${binDir}${path.delimiter}${env.PATH}` : binDir;
  if (home) env.CODEX_HOME = home;
}
