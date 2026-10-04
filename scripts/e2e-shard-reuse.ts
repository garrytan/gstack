/**
 * Verified first-attempt reuse for PR-lane E2E shards, on the same receipts as
 * the workflow-judge reuse (scripts/eval-input-cache.ts).
 *
 * A PR-profile shard (a file, or one case of a case-sharded file) is reused
 * only when every consumed input is byte-identical to a fresh pass recorded in
 * this PR within the receipt age:
 *   - files: the test file's literal import closure (helpers, fixtures loaded
 *     as modules, installed packages), every tracked file matched by the
 *     touchfile patterns of every case the file registers, the global
 *     touchfiles, the paid runner and this module, the workflow and its setup
 *     actions, bun.lock and the CI Dockerfile;
 *   - prompts: the test source that builds each selected case's prompt;
 *   - parameters: case ids, name pattern, expected count, retries, wall,
 *     within-shard concurrency, tier/profile, the root package without its
 *     release label, and every EVALS_/GSTACK_/CLAUDE_/ANTHROPIC_/... variable
 *     the child receives (secrets contribute presence only);
 *   - runtime: the immutable CI image manifest, Bun, Node, OS/arch and the
 *     Claude CLI version.
 * Anything unknown fails closed: a computed case registration, a touchfile
 * pattern matching no tracked file, retries other than zero (a retried pass
 * cannot prove its first attempt), custom preload/endpoints, missing scope,
 * or a lane other than the PR gate. Failures are never stored; the weekly
 * census, marathon and release lanes always execute fresh.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildEvalInputIdentity, lookupEvalInputCache, sourceDependencyClosure, storeEvalInputCache,
  type EvalCacheValue, type EvalInputIdentity, type EvalPassingProof } from './eval-input-cache';
import { matchGlob } from '../test/helpers/test-selection';
import { E2E_TOUCHFILES, GLOBAL_TOUCHFILES } from '../test/helpers/touchfiles-data';
import { EVAL_CACHE_MAX_AGE_MS as RECEIPT_MAX_AGE_MS } from './eval-input-cache';
import { panelVerdict, TRIAL_ENV, type EvalCaseKind, type PanelShape, type PanelTrial } from '../test/helpers/eval-store';

export interface E2EShardReuseRequest {
  root: string;
  /** Shard key: `<file>` or `<file>#<case id>`. */
  key: string;
  file: string;
  /** Selected case ids this shard executes (the PR profile's exact expectation). */
  caseIds: string[];
  /** Every E2E id the file registers; all of their touchfiles are consumed inputs. */
  registeredIds: string[];
  registrationKnown: boolean;
  casePattern: string;
  expectedCases: number;
  retries: number;
  timeoutMs: number;
  withinShardConcurrency: number;
  tier: string;
  profile: string;
  /** The exact environment the child receives. */
  env: NodeJS.ProcessEnv;
  /** Isolated trial shard: its panel policy is part of the identity; the trial index is run-scoped. */
  panel?: { kind: EvalCaseKind; panel: PanelShape; quarantined: boolean };
}

export interface E2EShardReuseHit { key: string; source: EvalPassingProof['source'] }

const HARNESS_FILES = ['scripts/test-paid-shards.ts', 'scripts/e2e-shard-reuse.ts', 'scripts/eval-input-cache.ts',
  'lib/eval-model.ts', 'bun.lock', '.github/docker/Dockerfile.ci', '.github/workflows/evals.yml',
  '.github/actions/fix-bun-temp/action.yml', '.github/actions/restore-deps/action.yml',
  '.github/actions/seed-claude-config/action.yml', '.github/actions/register-gstack-skills/action.yml'];
const ENV_PREFIXES = ['EVALS_', 'GSTACK_', 'CLAUDE_', 'ANTHROPIC_', 'OPENAI_', 'GEMINI_', 'BUN_', 'NODE_', 'PLAYWRIGHT_'];
/** Run-scoped values: provenance or transport, never behavior. Selection is bound as case ids. */
const RUN_SCOPED_ENV = new Set(['EVALS_RUN_ID', 'GSTACK_EVAL_DIR', 'EVALS_CACHE_DIR', 'EVALS_CACHE_PR', 'EVALS_CACHE_REPOSITORY',
  'EVALS_CACHE_RUNTIME_ID', 'EVALS_CACHE_PURPOSE', 'EVALS_SELECTION_JSON', 'EVALS_JUDGE_SELECTION_JSON', TRIAL_ENV.trial]);
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/;

/** The reuse-relevant environment the child sees; secrets contribute presence only. */
export function e2eReuseEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.keys(env).sort()
    .filter(name => (ENV_PREFIXES.some(prefix => name.startsWith(prefix)) || ['PATH', 'HOME'].includes(name)) && !RUN_SCOPED_ENV.has(name))
    .map(name => [name, SECRET_ENV.test(name) ? 'set' : env[name] ?? '']));
}

/** Why reuse cannot apply to this lane or environment, else null. */
export function e2eReuseLaneProblem(env: NodeJS.ProcessEnv, profileMode: string | undefined): string | null {
  const pr = Number(env.EVALS_CACHE_PR);
  if (profileMode !== 'pr') return 'Only the fast PR profile reuses results';
  if (!env.EVALS_CACHE_DIR || !env.EVALS_CACHE_REPOSITORY || !Number.isSafeInteger(pr) || pr <= 0) return 'No trusted same-PR cache scope';
  if (!/^(?:sha256:)?[a-f0-9]{64}$/.test(env.EVALS_CACHE_RUNTIME_ID ?? '')) return 'No immutable runtime identity';
  if (env.EVALS_TIER !== 'gate' || env.EVALS_FRESH === '1') return 'Fresh validation requested';
  if (['release', 'periodic', 'marathon'].includes(env.EVALS_CACHE_PURPOSE ?? '')) return 'Scheduled and release lanes execute fresh';
  if (env.NODE_OPTIONS || env.BUN_OPTIONS) return 'Preload options change execution outside the consumed source';
  if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_BASE_URL !== 'https://api.anthropic.com') return 'Custom model endpoint';
  return null;
}

function trackedFiles(root: string): string[] {
  const listed = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
  if (listed.status !== 0) throw new Error('Cannot list tracked files');
  return listed.stdout.split('\0').filter(Boolean);
}

/**
 * Every repository file one shard consumes: the test's import closure plus the
 * harness closure, and every tracked file the registered cases' touchfiles and
 * the global touchfiles match. Throws when a pattern matches nothing (unknown).
 */
export function e2eShardInputFiles(request: Pick<E2EShardReuseRequest, 'root' | 'file' | 'registeredIds'>): string[] {
  const tracked = trackedFiles(request.root);
  const declared = new Set<string>();
  for (const pattern of new Set([...request.registeredIds.flatMap(id => E2E_TOUCHFILES[id] ?? []), ...GLOBAL_TOUCHFILES])) {
    const matches = tracked.filter(file => matchGlob(file, pattern));
    if (!matches.length) throw new Error(`Touchfile pattern matches no tracked file: ${pattern}`);
    for (const file of matches) declared.add(file);
  }
  const closure = sourceDependencyClosure(request.root, [request.file, ...HARNESS_FILES]);
  return [...new Set([...closure, ...declared])].filter(file => file !== 'package.json').sort();
}

/** The consumed input identity of one PR shard, or why it is ineligible. */
export function e2eShardIdentity(request: E2EShardReuseRequest): { status: 'eligible'; identity: EvalInputIdentity } | { status: 'ineligible'; reason: string } {
  try {
    if (!/^test\/skill-e2e-.+\.test\.ts$/.test(request.file) || /overlay-harness/.test(request.file)) return { status: 'ineligible', reason: 'Not an audited E2E file' };
    if (!request.registrationKnown || !request.registeredIds.length) return { status: 'ineligible', reason: 'Case registration is not statically complete' };
    if (!request.caseIds.length || request.caseIds.length !== request.expectedCases || request.caseIds.some(id => !request.registeredIds.includes(id))) {
      return { status: 'ineligible', reason: 'Selected cases are not exactly known' };
    }
    if (request.retries !== 0) return { status: 'ineligible', reason: 'A retried pass cannot prove its first attempt' };
    const files = e2eShardInputFiles(request);
    const { version: _releaseLabel, ...rootPackage } = JSON.parse(fs.readFileSync(path.join(request.root, 'package.json'), 'utf8'));
    const source = fs.readFileSync(path.join(request.root, request.file), 'utf8');
    const env = request.env;
    const result = buildEvalInputIdentity({
      root: request.root,
      scope: { repository: env.EVALS_CACHE_REPOSITORY!, pullRequest: Number(env.EVALS_CACHE_PR) },
      coverage: { dependencies: 'complete', prompts: 'complete', environment: 'complete' }, unknownDependencies: [],
      files,
      prompts: Object.fromEntries(request.caseIds.map(id => [id, source])),
      parameters: { rootPackage, key: request.panel ? request.key.replace(/~t\d+$/, '') : request.key,
        ...(request.panel ? { panel: { kind: request.panel.kind, n: request.panel.panel.n, k: request.panel.panel.k, quarantined: request.panel.quarantined } } : {}), caseIds: [...request.caseIds].sort(), casePattern: request.casePattern,
        expectedCases: request.expectedCases, retries: request.retries, timeoutMs: request.timeoutMs,
        withinShardConcurrency: request.withinShardConcurrency, tier: request.tier, profile: request.profile,
        environment: e2eReuseEnvironment(env) },
      runtime: { image: env.EVALS_CACHE_RUNTIME_ID!, bun: Bun.version, node: process.versions.node,
        platform: process.platform, arch: process.arch, claudeCli: claudeCliVersion(env) },
    });
    return result;
  } catch (error) {
    return { status: 'ineligible', reason: error instanceof Error ? error.message : 'Cannot identify consumed inputs' };
  }
}

function claudeCliVersion(env: NodeJS.ProcessEnv): string {
  const version = spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 5_000, env });
  const line = version.status === 0 ? version.stdout.split('\n')[0]!.trim() : '';
  if (!line) throw new Error('Claude CLI version is unknown');
  return line;
}

const validResult = (identity: EvalInputIdentity, key: string) => (value: EvalCacheValue) =>
  !!value && typeof value === 'object' && !Array.isArray(value)
  && value.key === key && JSON.stringify(value.cases) === JSON.stringify(identity.caseIds);

/**
 * Prepare reuse for one shard: `lookup` returns a verified receipt for these
 * exact inputs; `publish` stores a receipt after a fresh first-attempt pass
 * whose inputs did not change during execution.
 */
export function prepareE2EShardReuse(request: E2EShardReuseRequest): {
  /** The input identity key: recorded on the outcome so the report can store verdicts against it. */
  inputKey: string;
  lookup(): E2EShardReuseHit | null;
  /** Trial shards only: this trial's record from a whole PASS panel receipt of the plan's receipts. */
  lookupPanelTrial(trial: number): { hit: E2EShardReuseHit; trial: PanelTrial } | null;
  /** True when the inputs are unchanged since `before` (the outcome may carry inputKey). */
  unchanged(): boolean;
  publish(): void;
  /**
   * A completed single-trial shard that did not pass: write its negative
   * receipt at the execution boundary (CEO-25), beside the pass receipts the
   * slice artifact carries, so a cancelled run's FAIL still blocks an older
   * PASS for the same inputs when its report never runs.
   */
  publishFailure(): void;
} | null {
  if (e2eReuseLaneProblem(request.env, 'pr') !== null) return null;
  const before = e2eShardIdentity(request);
  if (before.status !== 'eligible') return null;
  const common = { cacheDir: request.env.EVALS_CACHE_DIR!, purpose: 'gate' as const };
  return {
    inputKey: before.identity.key,
    unchanged() {
      const after = e2eShardIdentity(request);
      return after.status === 'eligible' && after.identity.key === before.identity.key;
    },
    lookupPanelTrial(trial) {
      if (!request.panel) return null;
      const receipt = readPanelReceipt(common.cacheDir, before.identity.key);
      if (!receipt || receipt.case !== request.caseIds[0] || receipt.kind !== request.panel.kind
        || receipt.panel.n !== request.panel.panel.n || receipt.panel.k !== request.panel.panel.k) return null;
      const record = receipt.trials.find(t => t.trial === trial);
      return record ? { hit: { key: receipt.key, source: receipt.source }, trial: record } : null;
    },
    lookup() {
      const found = lookupEvalInputCache({ ...common, identity: before.identity, validateResult: validResult(before.identity, request.key) });
      return found.status === 'reused' ? { key: found.key, source: found.source } : null;
    },
    publish() {
      const after = e2eShardIdentity(request);
      const source = executionSource(request);
      if (after.status !== 'eligible' || !source) return;
      storeEvalInputCache({ ...common, before: before.identity, after: after.identity, proof: {
        execution: 'new', finalized: true, completeAttemptHistory: true, exitCode: 0, timedOut: false,
        cancelled: false, skipped: 0, failed: 0, passed: before.identity.caseIds.length,
        cases: before.identity.caseIds.map(id => ({ id, outcome: 'passed' as const, attempt: 1 as const })),
        source, result: { key: request.key, cases: before.identity.caseIds },
      } });
    },
    publishFailure() {
      const source = executionSource(request);
      if (source) writeNegativeReceipt(common.cacheDir, { schema: 1, key: before.identity.key, source });
    },
  };
}

/** Provenance of a receipt written by this execution: `<run id>/<attempt>`, the checked-out revision and now. */
function executionSource(request: E2EShardReuseRequest): { runId: string; revision: string; completedAt: number } | null {
  const env = request.env;
  const runId = env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}/${env.GITHUB_RUN_ATTEMPT ?? '1'}` : env.EVALS_RUN_ID;
  const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: request.root, encoding: 'utf8', timeout: 3_000 });
  if (!runId || revision.status !== 0) return null;
  return { runId, revision: revision.stdout.trim(), completedAt: Date.now() };
}

// ─── Panel receipts, negative receipts and the planner's receipt selection ──
//
// Reuse is decided by the planner, once per panel: it ships the plan a
// receipt set in which every panel receipt is a whole PASS panel from one run
// and no pass receipt has a newer FAIL for the same identity. Executors look
// up only that set, so every trial of a panel sees the same receipts. The
// report writes panel receipts (all n trials fresh, one identity) and
// negative receipts (FAIL verdicts) after the verdict is known.

export interface PanelReceipt {
  schema: 1;
  key: string;
  case: string;
  kind: EvalCaseKind;
  panel: PanelShape;
  trials: PanelTrial[];
  source: { runId: string; revision: string; completedAt: number };
}

export interface NegativeReceipt { schema: 1; key: string; source: { runId: string; revision: string; completedAt: number } }

const RECEIPT_KEY = /^[a-f0-9]{64}$/;
const RECEIPT_FILE = /^[a-f0-9]{64}(?:\.panel|\.fail)?\.json$/;
const validSource = (source: any) => !!source && typeof source.runId === 'string' && /^[\w./-]{1,160}$/.test(source.runId)
  && typeof source.revision === 'string' && /^[a-f0-9]{40}$/.test(source.revision) && Number.isSafeInteger(source.completedAt) && source.completedAt > 0;

function readJson(file: string, maxBytes = 64 * 1024): any {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

/** A whole, unexpired PASS panel receipt for `key`, re-verified with panelVerdict(); else null. */
export function readPanelReceipt(cacheDir: string, key: string, now = Date.now()): PanelReceipt | null {
  if (!RECEIPT_KEY.test(key)) return null;
  const receipt = readJson(path.join(cacheDir, `${key}.panel.json`));
  if (!receipt || receipt.schema !== 1 || receipt.key !== key || typeof receipt.case !== 'string' || !validSource(receipt.source)
    || receipt.source.completedAt > now || now - receipt.source.completedAt >= RECEIPT_MAX_AGE_MS || !Array.isArray(receipt.trials)) return null;
  try {
    const verdict = panelVerdict({ case: receipt.case, kind: receipt.kind, panel: receipt.panel,
      trials: receipt.trials.map((t: PanelTrial) => ({ ...t, attempt: 1 })) });
    if (verdict.status !== 'PASS' || verdict.trials.length !== receipt.panel.n) return null;
  } catch { return null; }
  const negative = readJson(path.join(cacheDir, `${key}.fail.json`));
  if (negative && validSource(negative.source) && negative.source.completedAt >= receipt.source.completedAt) return null;
  return receipt as PanelReceipt;
}

export function writePanelReceipt(dir: string, receipt: PanelReceipt): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${receipt.key}.panel.json`), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}

export function writeNegativeReceipt(dir: string, receipt: NegativeReceipt): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${receipt.key}.fail.json`), `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
}

const receiptSource = (file: string): { runId: string; completedAt: number } => {
  const parsed = readJson(file);
  const source = parsed?.source ?? parsed?.proof?.source;
  return { runId: typeof source?.runId === 'string' ? source.runId : '', completedAt: Number(source?.completedAt) || 0 };
};
const receiptTime = (file: string): number => receiptSource(file).completedAt;

/**
 * Receipt order (ENG-6): within one CI run, a later attempt is newer
 * whatever its clock says; otherwise the later `completedAt` is newer.
 * Positive when `a` is newer than `b`, zero on a tie.
 */
export function compareReceiptSources(a: { runId: string; completedAt: number }, b: { runId: string; completedAt: number }): number {
  const [runA, attemptA] = a.runId.split('/');
  const [runB, attemptB] = b.runId.split('/');
  if (runA && runA === runB && Number(attemptA) !== Number(attemptB)) return (Number(attemptA) || 0) - (Number(attemptB) || 0);
  return a.completedAt - b.completedAt;
}

/**
 * Planner-side selection: copy `from` into `to`, dropping every pass or panel
 * receipt that has a same-or-newer negative receipt for its identity, and
 * every panel receipt that is not a whole PASS panel. Workflow-judge and
 * other receipts pass through for their own validation at lookup.
 */
export function selectPlanReceipts(from: string, to: string, now = Date.now()): { shipped: number; blocked: string[] } {
  fs.mkdirSync(to, { recursive: true });
  const blocked: string[] = [];
  let shipped = 0;
  let names: string[] = [];
  try { names = fs.readdirSync(from).filter(name => name.endsWith('.json')); } catch { return { shipped, blocked }; }
  for (const name of names) {
    const file = path.join(from, name);
    const [key, suffix] = [name.slice(0, 64), name.slice(64)];
    const negative = RECEIPT_KEY.test(key) ? readJson(path.join(from, `${key}.fail.json`)) : null;
    const newerFail = negative && validSource(negative.source) && negative.source.completedAt >= receiptTime(file);
    if (suffix === '.panel.json' && (newerFail || !readPanelReceipt(from, key, now))) { blocked.push(name); continue; }
    if (suffix === '.json' && newerFail) { blocked.push(name); continue; }
    fs.copyFileSync(file, path.join(to, name));
    shipped++;
  }
  return { shipped, blocked };
}

/**
 * Merge receipt directories into one store, keeping the newest file per name
 * by (run attempt, completedAt); a tie keeps the file already there. Negative
 * receipts merge before passes, so a reader of a partial merge never sees a
 * PASS without the FAIL that blocks it.
 */
export function mergeReceiptDirs(out: string, dirs: string[]): number {
  fs.mkdirSync(out, { recursive: true });
  let merged = 0;
  const negativesFirst = (a: string, b: string) => Number(b.endsWith('.fail.json')) - Number(a.endsWith('.fail.json')) || (a < b ? -1 : a > b ? 1 : 0);
  for (const dir of dirs) {
    let names: string[] = [];
    try { names = fs.readdirSync(dir).filter(name => RECEIPT_FILE.test(name)).sort(negativesFirst); } catch { continue; }
    for (const name of names) {
      const source = path.join(dir, name);
      const target = path.join(out, name);
      if (!fs.lstatSync(source).isFile()) continue;
      if (fs.existsSync(target) && compareReceiptSources(receiptSource(source), receiptSource(target)) <= 0) continue;
      fs.copyFileSync(source, target);
      merged++;
    }
  }
  return merged;
}

if (import.meta.main) {
  const [command, first, ...rest] = process.argv.slice(2);
  if (command === 'select' && first && rest[0]) {
    const result = selectPlanReceipts(first, rest[0]);
    console.log(`[e2e-reuse] shipped ${result.shipped} receipt(s) to the plan; blocked ${result.blocked.length} (newer FAIL or partial panel)`);
  } else if (command === 'merge' && first) {
    console.log(`[e2e-reuse] merged ${mergeReceiptDirs(first, rest)} receipt(s) into ${first}`);
  } else {
    console.error('usage: bun run scripts/e2e-shard-reuse.ts select <from> <to> | merge <out> <dir...>');
    process.exit(2);
  }
}
