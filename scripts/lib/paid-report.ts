/**
 * Paid-lane local diagnosis and the report: JUnit parsing, panel verdicts, history records and the human readout. Moved from scripts/test-paid-shards.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeRelativePath } from './shard-engine';
import { EVAL_POLICY } from '../../test/helpers/periodic-exclude-data';
import { STALL_WINDOW_MS } from '../../test/helpers/eval-budgets';
import {
  isFinalizedEvalResultFile, failureClassOf, panelVerdict, sanitizeTrialError, formatTrialOutcomes, TRIAL_OUTCOME_SCHEMA, TRIAL_OUTCOMES_FILE,
  type EvalCaseKind, type PanelVerdict, type TrialFailureClass, type TrialOutcome, type TrialOutcomeRecord,
  trialCostKnown, trialFailureFields, trialSessions, type TrialFailureDetail,
} from '../../test/helpers/eval-store';
import { readSessionLedger, type SessionLedgerRow } from '../../test/helpers/session-ledger';
import { publishedFence, sanitizeFixedFenceLine } from './published-text';
import { E2E_KINDS } from '../../test/helpers/touchfiles-data';
import { manualReviewProblem } from '../../test/helpers/cookie-workflow-manual-review';
import { writeNegativeReceipt, writePanelReceipt } from '../e2e-shard-reuse';
import { E2E_TOUCHFILES, E2E_TIERS, LLM_JUDGE_TOUCHFILES } from '../../test/helpers/touchfiles';
import { CASE_TEST_NAMES, type CaseTrialPlan, caseTestNamePattern, caseTrialPlan, fileCaseRegistration, shardCaseId, shardFile, trialShardKey } from './paid-cases';
import { type ManifestEntry, PAID_TEST_DURATIONS_FILE, type PaidRunManifest, type SliceResult, collectorOutcomeCounts, formatProfileCoverage, loadPaidTestDurations, mergePaidTestDurations, parseRunManifest, trialPanelKey, verifySliceResults, writePaidTestDurations } from './paid-plan';
import { DEFAULT_JOBS, type PaidCaseSelection, type PaidTier, ROOT, type ShardTrialRecord } from './paid-types';
import { collectPaidTestFiles, isAllSkippedPass, shardSlug, paidSelectionEnv } from './paid-select';
import type { RunShardsOptions } from '../test-paid-shards';

// ─── Local diagnosis: one case through the CI panel runner (A9) ────────────

/** How --case runs exactly one case: trials selected by its Bun test name, or its whole file when that file registers no other case. */
export interface CaseSelection { file: string; mode: 'name' | 'file'; reason: string }

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The paid file that registers `id` and how a trial selects it. A file whose
 * registration is complete wins over one that also lists the id; a test
 * registered literally under the id (or its CASE_TEST_NAMES label) is
 * selected by name; a loop that registers ids at runtime is selected by the
 * id it names its test; a file registering only this case runs whole (its
 * test names are not the id). Anything else throws before any process starts.
 */
export function caseSelection(id: string, rootDir = ROOT, discovered = collectPaidTestFiles(rootDir)): CaseSelection {
  const files = discovered.map(file => {
    const source = fs.readFileSync(path.join(rootDir, file), 'utf8');
    return { file, source, ...fileCaseRegistration(file, source) };
  }).filter(f => f.registered.includes(id));
  const owners = files.filter(f => f.known).length ? files.filter(f => f.known) : files;
  if (owners.length !== 1) throw new Error(`--case ${id}: ${owners.length ? `registered by ${owners.map(f => f.file).join(', ')}` : 'no paid file statically registers it'}; it needs exactly one`);
  const owner = owners[0]!;
  const name = escapeRe(CASE_TEST_NAMES[id] ?? id);
  if (owner.registered.length === 1) return { file: owner.file, mode: 'file', reason: 'the whole file (it registers no other case)' };
  if (new RegExp(`\\b(?:test|it|test\\.\\w+|test(?:Concurrent)?IfSelected)\\s*\\(\\s*(['"\`])${name}\\1|testName\\s*:\\s*(['"\`])${name}\\2`).test(owner.source)) {
    return { file: owner.file, mode: 'name', reason: `its Bun test is named ${CASE_TEST_NAMES[id] ?? id}` };
  }
  if (owner.computed) return { file: owner.file, mode: 'name', reason: `its loop names the Bun test ${id} at runtime` };
  throw new Error(`--case ${id}: ${owner.file} registers several cases and none of its tests is named ${id}; add its test name to CASE_TEST_NAMES`);
}

/** The one paid file that registers `id`, else a thrown reason. */
export function caseFile(id: string, rootDir = ROOT, discovered = collectPaidTestFiles(rootDir)): string {
  return caseSelection(id, rootDir, discovered).file;
}

/**
 * Run `trials` independent trials of one case exactly as CI runs a panel
 * (trial shards, TRIAL_ENV identity, name-pattern isolation), then print its
 * panelVerdict(). `trials` defaults to the case's policy panel; CI never
 * reads it. k keeps the kind's meaning (all trials for rule, the policy
 * majority for behavior, capped at n).
 */
export async function runCaseDiagnosis(id: string, options: {
  trials?: number; jobs?: number; withinShardConcurrency?: number; timeoutMs?: number; rootDir?: string; env?: NodeJS.ProcessEnv;
  evalDirBase?: string; commandFor?: RunShardsOptions['commandFor']; log?: (line: string) => void; file?: string;
  /** The CLI passes its own runner: importing the entry module during its top-level await never resolves. */
  runShards?: typeof import('../test-paid-shards').runPaidShards;
} = {}): Promise<PanelVerdict> {
  const rootDir = options.rootDir ?? ROOT;
  const log = options.log ?? ((line: string) => console.log(line));
  const selection = options.file ? { file: options.file, mode: 'name' as const } : caseSelection(id, rootDir);
  const file = selection.file;
  const policy = caseTrialPlan(id);
  const n = options.trials ?? policy.panel.n;
  const plan: CaseTrialPlan = { ...policy, panel: { n, k: policy.panel.k === policy.panel.n ? n : Math.min(policy.panel.k, n) } };
  const keys = Array.from({ length: n }, (_, i) => trialShardKey(file, id, i + 1));
  const tier = E2E_TIERS[id] as PaidTier;
  log(`[test:paid] --case ${id}: ${n} trial(s) of ${file} (kind ${plan.kind}, PASS at ${plan.panel.k}/${n}${plan.quarantined ? ', quarantined' : ''}), tier=${tier}`);
  // The runner is the CLI module; load it lazily so this library never imports it statically (no cycle).
  const runPaidShards = options.runShards ?? (await import('../test-paid-shards')).runPaidShards;
  const shardOptions = { withinShardConcurrency: options.withinShardConcurrency, timeoutMs: options.timeoutMs, rootDir, log, commandFor: options.commandFor,
    env: { ...(options.env ?? process.env), EVALS: '1', EVALS_TIER: tier, EVALS_PREFLIGHT_OK: '1', EVALS_ALL: '1',
      ...paidSelectionEnv('full', { e2e: [id], judges: [] }, `--case ${id}`) } };
  if (selection.mode === 'file') {
    // The whole file is the case: one file shard per trial, each with its own eval dir, judged by shard status as CI does.
    const fileTrials = [];
    for (let trial = 1; trial <= n; trial++) {
      const [outcome] = (await runPaidShards([[file]], { ...shardOptions, jobs: 1,
        ...(options.evalDirBase ? { evalDirBase: path.join(options.evalDirBase, `t${trial}`) } : {}) })).outcomes;
      if (!outcome || outcome.runnerError !== undefined || isAllSkippedPass(outcome) || !['passed', 'failed', 'timed-out'].includes(outcome.status)) continue;
      fileTrials.push({ trial, outcome: outcome.status === 'passed' ? 'passed' as const : 'failed' as const,
        ...(outcome.status === 'passed' ? {} : { failure_class: outcome.status === 'timed-out' ? 'timeout' as const : 'assertion' as const }) });
    }
    const verdict = panelVerdict({ case: id, kind: plan.kind, panel: plan.panel, trials: fileTrials, quarantined: plan.quarantined });
    log(formatPanelLine({ ...verdict, file, slices: {} }, tier));
    return verdict;
  }
  const summary = await runPaidShards(keys.map(key => [key]), { ...shardOptions,
    jobs: Math.min(options.jobs ?? DEFAULT_JOBS, n), evalDirBase: options.evalDirBase,
    trials: Object.fromEntries(keys.map(key => [key, plan])) });
  const trials = summary.outcomes.flatMap(outcome => outcome.trial && outcome.trial.outcome !== null ? [{
    trial: outcome.trial.trial, outcome: outcome.trial.outcome, ...(outcome.trial.failure_class ? { failure_class: outcome.trial.failure_class } : {}),
    ...(outcome.trial.exit_reason ? { exit_reason: outcome.trial.exit_reason } : {}), ...(outcome.trial.error ? { error: outcome.trial.error } : {}),
    ...(outcome.trial.timeout_at_turn !== undefined ? { timeout_at_turn: outcome.trial.timeout_at_turn } : {}) }] : []);
  const verdict = panelVerdict({ case: id, kind: plan.kind, panel: plan.panel, trials, quarantined: plan.quarantined });
  log(formatPanelLine({ ...verdict, file, slices: {} }, tier));
  for (const outcome of summary.outcomes.filter(o => o.trial?.outcome === null)) log(`  t${outcome.trial!.trial}: no trial record (${outcome.trial!.harness})`);
  return verdict;
}

// ─── Report: verdicts, history records and the human readout ───────────────

/** One Bun JUnit testcase (`--reporter=junit`); `line` is absent on Bun's hook placeholders. */
export interface JUnitCase { name: string; classname: string; outcome: TrialOutcome; timeMs: number; line?: number; failureType?: string; message?: string }

const xmlUnescape = (text: string) => text.replace(/&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-f]+));/gi, (_, name: string, dec?: string, hex?: string) =>
  dec ? String.fromCodePoint(Number(dec)) : hex ? String.fromCodePoint(parseInt(hex, 16))
    : ({ lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' } as Record<string, string>)[name.toLowerCase()]!);

function xmlAttributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(match => [match[1]!, xmlUnescape(match[2]!)]));
}

/** Per-test outcomes from a Bun JUnit report; unparseable input yields []. */
export function parseJUnitCases(xml: string): JUnitCase[] {
  const cases: JUnitCase[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const attrs = xmlAttributes(match[1]!);
    const body = match[3] ?? '';
    const failure = /<(failure|error)\b([^>]*?)(?:\/>|>)/.exec(body);
    const failureAttrs = failure ? xmlAttributes(failure[2]!) : {};
    cases.push({
      name: attrs.name ?? '', classname: attrs.classname ?? '',
      outcome: failure ? 'failed' : /<skipped\b/.test(body) ? 'skipped' : 'passed',
      timeMs: Math.round(Number(attrs.time ?? 0) * 1000) || 0,
      ...(attrs.line !== undefined && Number.isSafeInteger(Number(attrs.line)) ? { line: Number(attrs.line) } : {}),
      ...(failure ? { failureType: failureAttrs.type ?? failure[1]!, message: failureAttrs.message } : {}),
    });
  }
  return cases;
}

/** Registry id of a Bun test name: the id itself or its CASE_TEST_NAMES label, else null (unattributed). */
export function caseIdForTestName(name: string): string | null {
  if (Object.hasOwn(E2E_TIERS, name) || Object.hasOwn(LLM_JUDGE_TOUCHFILES, name)) return name;
  return Object.keys(CASE_TEST_NAMES).find(id => CASE_TEST_NAMES[id] === name) ?? null;
}

/** Where one JUnit testcase lands in the census: a case result, a zero-credit deselection with its reason, or unattributed. */
export type JUnitAttribution =
  | { kind: 'case'; id: string }
  | { kind: 'deselected'; reason: string }
  | { kind: 'unattributed' };

export interface JUnitShardContext {
  /** Shard key: `<file>` or `<file>#<case id>`. */
  key: string;
  tier: PaidTier;
  /** The run's case selection; a null list selects every case of the tier. */
  selection?: PaidCaseSelection;
  /** Ids this file shard leaves to their isolated trial shards. */
  excludeCases?: readonly string[];
}

export const DESELECTION_REASONS = {
  hook: 'Bun hook placeholder of a skipped describe block (not a test)',
  sibling: 'sibling case of a case shard (its own shard runs it)',
  isolated: 'isolated case (its trial shards run it)',
  selection: "outside the run's case selection",
} as const;
export const RUNTIME_SKIP_REASON = 'selected in this lane but skipped at runtime by the test itself (test.skip, describe.skip or an unmet prerequisite)';

/**
 * Attribute one testcase of a non-trial shard. A case shard's own case is
 * its id or label; elsewhere a name is its registry id or CASE_TEST_NAMES
 * label, else the only id the file registers, else the file itself when it
 * registers none (one keyless case). A skipped testcase of another tier, a
 * case-shard sibling, an isolated or unselected case, or a Bun hook
 * placeholder (`(unnamed)` with no line) is deselected: zero credit, never
 * SKIPPED. Anything else is unattributed and reported by name.
 */
export function attributeJUnitCase(tc: JUnitCase, ctx: JUnitShardContext,
  touchfiles: Record<string, string[]> = E2E_TOUCHFILES, tiers: Record<string, string> = E2E_TIERS): JUnitAttribution {
  if (tc.outcome === 'skipped' && tc.name === '(unnamed)' && tc.line === undefined) return { kind: 'deselected', reason: DESELECTION_REASONS.hook };
  const file = shardFile(ctx.key);
  const shardCase = shardCaseId(ctx.key);
  const named = caseIdForTestName(tc.name);
  if (shardCase !== null && named !== shardCase) {
    return tc.outcome === 'skipped' ? { kind: 'deselected', reason: DESELECTION_REASONS.sibling } : { kind: 'unattributed' };
  }
  const registered = Object.keys(touchfiles).filter(id => touchfiles[id]!.includes(file));
  const id = named ?? (registered.length === 1 ? registered[0]! : registered.length === 0 ? file : null);
  if (id === null) return { kind: 'unattributed' };
  if (tc.outcome !== 'skipped') return { kind: 'case', id };
  const tier = tiers[id];
  if (tier !== undefined && tier !== ctx.tier) return { kind: 'deselected', reason: `${tier}-tier case (this lane runs ${ctx.tier})` };
  if (ctx.excludeCases?.includes(id)) return { kind: 'deselected', reason: DESELECTION_REASONS.isolated };
  const pool = tier !== undefined ? ctx.selection?.e2e : Object.hasOwn(LLM_JUDGE_TOUCHFILES, id) ? ctx.selection?.judges : null;
  if (pool && !pool.includes(id)) return { kind: 'deselected', reason: DESELECTION_REASONS.selection };
  return { kind: 'case', id };
}

interface RuleCase { id: string; kind: EvalCaseKind; outcome: TrialOutcome; line?: string }

/** JUnit evidence of the non-trial shards of one attempt. */
export interface JUnitCensus {
  /** One result per attributed case per shard. */
  ruleCases: RuleCase[];
  history: TrialOutcomeRecord[];
  failedShards: Set<string>;
  /** One line per selected in-lane case that skipped, with its reason. */
  skipped: string[];
  /** Zero-credit deselections: reason -> testcase count. */
  deselected: Map<string, number>;
  /** Per shard key: skip reason -> skipped testcase count. */
  shardSkipReasons: Map<string, Map<string, number>>;
  /** `<shard key> :: <test name> (<outcome>)` for every testcase no rule attributes. */
  unattributed: string[];
}

const bump = (counts: Map<string, number>, key: string) => counts.set(key, (counts.get(key) ?? 0) + 1);

/** Ledger rows of one JUnit case: its own id or test name, else the shard's only case. */
function caseSessions(rows: SessionLedgerRow[], id: string, onlyCase: boolean): SessionLedgerRow[] {
  return rows.filter(row => row.case === id || (!row.case && (onlyCase || row.test_name === id || row.test_name === CASE_TEST_NAMES[id])));
}

/** The artifact holding a slice's shards: the downloaded directory's own name when it is one. */
/** The red-census guide the report and every eval:pass-rates view link. */
export const CENSUS_RED_GUIDE = 'docs/evals/census-red.md';

export function sliceArtifactName(root: string, slice: number, attempt: number): string {
  const name = path.basename(root);
  return /^(?:paid-slice|gate-census)-\d+-a\d+$/.test(name) ? name : `slice ${slice} attempt ${attempt}`;
}

export function junitCensus(manifest: PaidRunManifest, artifacts: ReportArtifact[], recordsByShard: Map<string, any[]>,
  base: Record<string, unknown>, cliVersion?: string): JUnitCensus {
  const census: JUnitCensus = { ruleCases: [], history: [], failedShards: new Set(), skipped: [], deselected: new Map(), shardSkipReasons: new Map(), unattributed: [] };
  const entries = new Map(manifest.entries.map(entry => [normalizeRelativePath(entry.file), entry]));
  for (const { root, result } of artifacts) {
    for (const outcome of result.outcomes) {
      const key = normalizeRelativePath(outcome.files[0] ?? '');
      if (outcome.trial || outcome.files.length !== 1) continue;
      let xml = '';
      try { xml = fs.readFileSync(path.join(root, 'shards', shardSlug([key]), 'junit.xml'), 'utf8'); } catch { continue; }
      const ctx: JUnitShardContext = { key, tier: manifest.tier, selection: manifest.selection, excludeCases: entries.get(key)?.excludeCases };
      const byCase = new Map<string, JUnitCase[]>();
      const reasons = new Map<string, number>();
      for (const tc of parseJUnitCases(xml)) {
        const attributed = attributeJUnitCase(tc, ctx);
        if (attributed.kind === 'case') byCase.set(attributed.id, [...(byCase.get(attributed.id) ?? []), tc]);
        else if (attributed.kind === 'deselected') { bump(census.deselected, attributed.reason); bump(reasons, attributed.reason); }
        else census.unattributed.push(`${key} :: ${tc.name || '(no name)'} (${tc.outcome})`);
      }
      const records = recordsByShard.get(key) ?? [];
      const ledger = readSessionLedger(path.join(root, 'shards', shardSlug([key])));
      for (const [id, cases] of byCase) {
        const kind = (E2E_KINDS[id] ?? 'rule') as EvalCaseKind;
        const failed = cases.find(tc => tc.outcome === 'failed');
        const caseOutcome: TrialOutcome = failed ? 'failed' : cases.some(tc => tc.outcome === 'passed') ? 'passed' : 'skipped';
        const mine = records.filter((r: any) => r?.name === id || r?.case_id === id);
        const failedRecord = mine.find((r: any) => r.passed === false);
        const failureClass: TrialFailureClass | undefined = !failed ? undefined
          : failed.failureType === 'TimeoutError' ? 'timeout' : failedRecord ? failureClassOf(failedRecord) : 'assertion';
        const error = sanitizeTrialError(failedRecord?.error ?? failed?.message);
        const sessions = caseSessions(ledger, id, byCase.size === 1);
        // A case's JUnit times sum its concurrent tests (plan-mode-no-op: 346 s in a 176 s shard), so its wall is capped by the shard's.
        const diagnosis = failed && failureClass ? trialFailureFields({ failure_class: failureClass, exit_reason: failedRecord?.exit_reason,
          error: failedRecord?.error ?? failed.message, sessions, record: failedRecord }, STALL_WINDOW_MS) : undefined;
        if (failed) census.failedShards.add(key);
        if (caseOutcome === 'skipped') {
          bump(reasons, RUNTIME_SKIP_REASON);
          census.skipped.push(`◌ ${id}  ${key} (${cases.map(tc => tc.name).join('; ')}): ${RUNTIME_SKIP_REASON}`);
        }
        census.ruleCases.push({ id, kind, outcome: caseOutcome,
          ...(failed ? { line: `✗ ${id}  ${kind}  FAIL  ${failureClass}${failedRecord?.exit_reason === 'timeout' && failedRecord?.timeout_at_turn !== undefined ? ` at turn ${failedRecord.timeout_at_turn}` : ''}${error ? ` — ${error}` : ''}`
            + `${diagnosisText(diagnosis, error)}  [slice ${result.sliceIndex}, attempt ${result.attempt ?? 1}]`
            + `${evidencePointer(sliceArtifactName(root, result.sliceIndex, result.attempt ?? 1), key, typeof base.run_id === 'string' ? base.run_id : undefined, id)}`
            + `  after a repair: ${afterRepairCommand(manifest.tier, id, shardFile(key))}` } : {}) });
        census.history.push({ ...base, case: id, file: shardFile(key), kind, trial: 1, panel: { n: 1, k: 1 }, outcome: caseOutcome,
          ...(failureClass ? { failure_class: failureClass } : {}), ...(failedRecord?.exit_reason ? { exit_reason: String(failedRecord.exit_reason) } : {}),
          ...(error && failed ? { error } : {}), ...diagnosis, ...trialSessions(sessions), duration_ms: Math.min(cases.reduce((sum, tc) => sum + tc.timeMs, 0), outcome.elapsedMs),
          cost_usd: Math.round(mine.reduce((sum: number, r: any) => sum + (Number(r.cost_usd) || 0), 0) * 100) / 100, ...trialCostKnown(mine, sessions),
          ...(typeof mine[0]?.model === 'string' ? { model: mine[0].model } : {}), ...(cliVersion ? { cli_version: cliVersion } : {}),
          quarantined: false, execution: outcome.reused ? 'reused' : 'executed', source: 'junit' } as TrialOutcomeRecord);
      }
      census.shardSkipReasons.set(key, reasons);
    }
  }
  return census;
}

/** The census block of the readout: every skipped case with its reason, deselections by reason, every unattributed testcase by name. */
export function formatJUnitCensus(census: JUnitCensus): string[] {
  const deselected = [...census.deselected.entries()].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1));
  return [
    ...(census.skipped.length ? [`SKIPPED cases (${census.skipped.length}):`, ...census.skipped.map(line => `  ${line}`)] : []),
    ...(deselected.length ? [`deselected testcases, zero credit (${deselected.reduce((sum, [, n]) => sum + n, 0)}):`,
      ...deselected.map(([reason, n]) => `  ${String(n).padStart(4)}  ${reason}`)] : []),
    ...(census.unattributed.length ? [`UNATTRIBUTED testcases (${census.unattributed.length}; no registry id, label, single registered id or keyless file):`,
      ...census.unattributed.map(line => `  ? ${line}`)] : []),
  ];
}

interface ReportArtifact { root: string; result: SliceResult }

/** Every slice result under the report dir: flat (merged) or one directory per attempt-scoped artifact. */
export function loadSliceArtifacts(reportDir: string): ReportArtifact[] {
  const found: ReportArtifact[] = [];
  for (const name of fs.readdirSync(reportDir, { recursive: true }) as string[]) {
    const rel = normalizeRelativePath(name);
    if (!/^slice-\d+\.json$/.test(path.basename(rel)) || rel.split('/').includes('shards') || rel.split('/').includes('receipts')) continue;
    found.push({ root: path.join(reportDir, path.dirname(rel)), result: JSON.parse(fs.readFileSync(path.join(reportDir, rel), 'utf8')) as SliceResult });
  }
  return found.sort((a, b) => (a.result.attempt ?? 1) - (b.result.attempt ?? 1) || a.result.sliceIndex - b.result.sliceIndex);
}

export interface PanelReport extends PanelVerdict {
  file: string;
  /** Slice per trial index (trial n -> slice), for the rerun/artifact pointer. */
  slices: Record<number, number>;
}

/** Panel verdicts of one run attempt: exactly the planned trials, each from its reported record. */
export function panelReports(manifest: PaidRunManifest, results: SliceResult[], attempt: number): PanelReport[] {
  const reported = new Map<string, { slice: number; outcome: SliceResult['outcomes'][number] }>();
  for (const result of results.filter(r => (r.attempt ?? 1) === attempt)) {
    for (const outcome of result.outcomes) reported.set(normalizeRelativePath(outcome.files[0] ?? ''), { slice: result.sliceIndex, outcome });
  }
  const panels = new Map<string, ManifestEntry[]>();
  for (const entry of manifest.entries.filter(e => e.status === 'planned' && e.trial)) {
    const key = trialPanelKey(entry.file)!;
    panels.set(key, [...(panels.get(key) ?? []), entry]);
  }
  return [...panels.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, entries]) => {
    const plan = entries[0]!.trial!;
    const slices: Record<number, number> = {};
    const trials = entries.flatMap(entry => {
      const got = reported.get(normalizeRelativePath(entry.file));
      const t = got?.outcome.trial;
      if (!got || !t || t.outcome === null) return [];
      slices[t.trial] = got.slice;
      return [{ trial: t.trial, outcome: t.outcome, attempt, ...(t.failure_class ? { failure_class: t.failure_class } : {}),
        ...(t.exit_reason ? { exit_reason: t.exit_reason } : {}), ...(t.error ? { error: t.error } : {}),
        ...(got.outcome.reused ? { execution: 'reused' as const } : {}),
        ...(t.timeout_at_turn !== undefined ? { timeout_at_turn: t.timeout_at_turn } : {}),
        ...(t.failure_cause ? { failure_cause: t.failure_cause } : {}), ...(t.failure_cause_evidence ? { failure_cause_evidence: t.failure_cause_evidence } : {}),
        ...(t.failure_detail ? { failure_detail: t.failure_detail } : {}) }];
    });
    const verdict = panelVerdict({ case: shardCaseId(key)!, kind: plan.kind, panel: plan.panel, trials, quarantined: plan.quarantined });
    // Reuse is whole-panel only: every trial reused from one run, or none.
    const sources = entries.map(entry => reported.get(normalizeRelativePath(entry.file))?.outcome.reused?.runId ?? null);
    if (sources.some(source => source !== null) && (sources.some(source => source === null) || new Set(sources).size > 1)) {
      return { ...verdict, status: 'INCOMPLETE', split: false, failsLane: true, coverage: false, redClass: 'INCOMPLETE',
        reason: 'partial panel reuse (every trial must come from one reused panel, or none)', file: shardFile(key), slices };
    }
    return { ...verdict, file: shardFile(key), slices };
  });
}

type TrialDiagnosis = { failure_cause?: string; failure_cause_evidence?: string; failure_detail?: TrialFailureDetail };

/** Cause (when it says more than the class), its evidence and the failure detail, appended to a red line. */
function diagnosisText(d: TrialDiagnosis | undefined, error?: string): string {
  if (!d?.failure_cause) return '';
  const evidence = d.failure_cause_evidence && d.failure_cause_evidence !== error ? `: ${d.failure_cause_evidence}` : '';
  const detail = !d.failure_detail ? ''
    : 'judge' in d.failure_detail ? `  ${d.failure_detail.judge.map(j => `${j.dimension} ${j.mean} < ${j.threshold} (${j.samples} samples)${j.rationale ? ` "${j.rationale}"` : ''}`).join('; ')}`
      : `  Expected: ${d.failure_detail.expected} · Received: ${d.failure_detail.received}`;
  return `  · cause ${d.failure_cause}${evidence}${detail}`;
}

/** Where a red's transcript lives and how to fetch it. */
function evidencePointer(artifact: string, key: string, runId: string | undefined, id: string): string {
  const arg = /^[\w./-]+$/.test(id) ? id : `'${id.replace(/'/g, `'\\''`)}'`;
  return `  evidence: ${artifact}/shards/${shardSlug([key])}${runId ? ` (fetch: bun run eval:pass-rates --run ${runId} --case ${arg})` : ''}`;
}

/** Why one failed trial failed, in one line: a case timeout names its turn. */
function trialCause(trial: PanelVerdict['trials'][number] & TrialDiagnosis & { timeout_at_turn?: number }): string {
  if (trial.outcome === 'skipped') return `t${trial.trial}: skipped`;
  const cls = trial.failure_class ?? 'assertion';
  const head = cls === 'timeout' || trial.exit_reason === 'timeout'
    ? `timeout${trial.timeout_at_turn !== undefined ? ` at turn ${trial.timeout_at_turn}` : ''}`
    : cls;
  const exit = trial.exit_reason === 'success' ? ' (session completed; check failed)'
    : trial.exit_reason && trial.exit_reason !== 'timeout' ? ` (${trial.exit_reason})` : '';
  return `t${trial.trial}: ${head}${exit}${trial.error ? ` — ${trial.error}` : ''}${diagnosisText(trial, trial.error)}`;
}

/**
 * A paid run of exactly one case, for after a repair (never on unchanged
 * inputs): E2E cases through --case, judges through their selection and an
 * exact test-name filter, a keyless file (its own case) by file.
 */
export function afterRepairCommand(tier: PaidTier, id: string, file: string, trials = 1): string {
  if (Object.hasOwn(E2E_TIERS, id) && resolvesAlone(id)) return `bun run scripts/test-paid-shards.ts --tier ${tier} --case ${id}${trials > 1 ? ` --trials ${trials}` : ''}`;
  if (Object.hasOwn(LLM_JUDGE_TOUCHFILES, id)) {
    return `EVALS=1 EVALS_TIER=${tier} EVALS_JUDGE_SELECTION_JSON='${JSON.stringify({ version: 1, selected: [id], reason: 'after a repair' })}' bun test ${file} -t '${caseTestNamePattern([id])}'`;
  }
  return `EVALS=1 EVALS_TIER=${tier} bun test ${file}`;
}

const resolved = new Map<string, boolean>();
/** Whether --case can select this E2E id (a case several files register runs by its shard file instead). */
function resolvesAlone(id: string): boolean {
  if (!resolved.has(id)) { try { caseSelection(id); resolved.set(id, true); } catch { resolved.set(id, false); } }
  return resolved.get(id)!;
}

/** One line per non-PASS or split panel verdict. `artifacts` names each slice's artifact (slice -> name). */
export function formatPanelLine(panel: PanelReport, tier: PaidTier, ctx: { artifacts?: Map<number, string>; runId?: string } = {}): string {
  const mark = panel.status === 'PASS' ? '⚠' : panel.failsLane ? '✗' : '◌';
  const label = panel.status === 'PASS' ? `PASS ${panel.passed}/${panel.panel.n}` : `${panel.status} ${panel.passed}/${panel.panel.n}`;
  const causes = panel.trials.filter(t => t.outcome !== 'passed').map(t => trialCause(t as any));
  const where = Object.entries(panel.slices).map(([trial, slice]) => `t${trial}@slice ${slice}`).join(', ');
  const red = panel.trials.find(t => t.outcome === 'failed');
  const slice = red ? panel.slices[red.trial] : undefined;
  const evidence = red && slice !== undefined
    ? evidencePointer(ctx.artifacts?.get(slice) ?? `slice ${slice} attempt ${panel.attempt}`, trialShardKey(panel.file, panel.case, red.trial), ctx.runId, panel.case) : '';
  return `${mark} ${panel.case}  ${panel.kind}${panel.quarantined ? ' (quarantined)' : ''}  ${label} (${panel.marks})`
    + `${causes.length ? `  ${causes.join('; ')}` : ''}${panel.status === 'INCOMPLETE' || panel.status === 'SKIPPED' ? `  [${panel.reason}]` : ''}`
    + `${where ? `  [${where}, attempt ${panel.attempt}]` : ''}${evidence}  after a repair: ${afterRepairCommand(tier, panel.case, panel.file, panel.panel.n)}`;
}

export interface ReportHeadline {
  lane: string;
  verdict: 'GREEN' | 'RED';
  attempt: number;
  counts: {
    rule: { passed: number; total: number };
    behavior: { passed: number; total: number; split: number };
    judge: { passed: number; total: number };
    quarantined: { total: number; failingLane: number };
    skipped: number;
    infra: number;
    incomplete: number;
    unattributed: number;
  };
  actionRequired: number;
  wallMs: number | null;
  costUsd: number;
  redispatchEligible: boolean;
}

/** Known cost, never a bare total when any trial's cost is unknown, and no total when none is known. */
export function formatCost(knownUsd: number, unknownTrials: number, trials: number): string {
  if (trials > 0 && unknownTrials === trials) return `cost unknown (no billing captured for any of ${trials} trial(s))`;
  return `cost $${knownUsd.toFixed(2)}${unknownTrials ? ` known + ${unknownTrials} of ${trials} trial(s) cost unknown` : ''}`;
}

export function formatHeadline(h: ReportHeadline, cost: { unknownTrials: number; trials: number } = { unknownTrials: 0, trials: 0 }): string[] {
  const c = h.counts;
  const minutes = h.wallMs === null ? 'unknown' : `${Math.floor(h.wallMs / 60_000)}m${String(Math.round((h.wallMs % 60_000) / 1000)).padStart(2, '0')}s`;
  return [
    `[test:paid] VERDICT ${h.verdict} — lane ${h.lane}, attempt ${h.attempt}`,
    `  rule ${c.rule.passed}/${c.rule.total} · behavior ${c.behavior.passed}/${c.behavior.total}${c.behavior.split ? ` (${c.behavior.split} split)` : ''}`
      + ` · judge ${c.judge.passed}/${c.judge.total} · quarantined ${c.quarantined.total} (${c.quarantined.failingLane} failing the lane)`,
    `  SKIPPED ${c.skipped} · INFRA ${c.infra} · INCOMPLETE ${c.incomplete} · unattributed ${c.unattributed} · ACTION REQUIRED ${h.actionRequired}`,
    `  wall ${minutes} · ${formatCost(h.costUsd, cost.unknownTrials, cost.trials)}${h.redispatchEligible ? ' · every red is machine-classified INFRA/INCOMPLETE: eligible for ONE re-dispatch as a new run (EVAL_POLICY.infraRedispatch); report both runs' : ''}`,
  ];
}

/** Problems a runner loss or an API/CLI failure before grading produces; nothing else qualifies for re-dispatch. */
const INFRA_PROBLEMS = [
  /^slice \d+\/\d+ reported NO result/,
  /^planned .* was never reported$/,
  /: never-started$/,
  /: no trial record \((?:never started|runner error: .*|no test summary)\)$/,
  /^PANEL \S+ INCOMPLETE /,
  /^PANEL \S+ FAIL \(INFRA\)/,
];
export function infraOnly(problems: readonly string[]): boolean {
  return problems.length > 0 && problems.every(problem => INFRA_PROBLEMS.some(re => re.test(problem)));
}

/**
 * Report mode: reconcile slice artifacts against the manifest (fail-closed),
 * compute every panel verdict with panelVerdict(), write collector-outcomes
 * v2, trial-outcomes.jsonl and report-summary.md, and exit non-zero when the
 * lane is red. Only the earliest run attempt decides the lane; later attempts
 * are reported beside it and never replace it.
 */
export function runPaidReport(reportDir: string, options: { writeDurations?: boolean; env?: NodeJS.ProcessEnv; rootDir?: string } = {}): number {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? ROOT;
  const summaryPath = path.join(reportDir, 'collector-outcomes.json');
  const summaryMdPath = path.join(reportDir, 'report-summary.md');
  const trialOutcomesPath = path.join(reportDir, TRIAL_OUTCOMES_FILE);
  for (const file of [summaryPath, summaryMdPath, trialOutcomesPath]) fs.rmSync(file, { force: true });
  const manifest = parseRunManifest(fs.readFileSync(path.join(reportDir, 'manifest.json'), 'utf-8'));
  const artifacts = loadSliceArtifacts(reportDir);
  const attempts = [...new Set(artifacts.map(a => a.result.attempt ?? 1))].sort((a, b) => a - b);
  const primary = attempts[0] ?? 1;
  const results = artifacts.filter(a => (a.result.attempt ?? 1) === primary).map(a => a.result);
  const verdict = verifySliceResults(manifest, results);
  const planned = manifest.entries.filter((e) => e.status === 'planned').length;
  const lane = `${manifest.tier}/${manifest.profile ?? 'full'}${manifest.evalsAll ? ' census' : ''}`;
  console.log(`[test:paid] report: ${results.length}/${manifest.sliceCount} slices, ${planned} planned shards, tier=${manifest.tier}, attempt ${primary}${attempts.length > 1 ? ` (later attempts ${attempts.slice(1).join(', ')} reported, never replacing it)` : ''}`);
  for (const line of formatProfileCoverage(manifest)) console.log(line);
  for (const result of [...results].sort((a, b) => a.sliceIndex - b.sliceIndex)) {
    for (const outcome of result.outcomes) {
      const shown = outcome.reused ? `reused (run ${outcome.reused.runId})` : outcome.trial
        ? `trial ${outcome.trial.outcome ?? 'NO RECORD'}` : outcome.status;
      console.log(`  slice ${result.sliceIndex}  ${shown.padEnd(15)} ${String(Math.round(outcome.elapsedMs / 1000)).padStart(5)}s  ${outcome.files.join(' ')}`);
    }
  }
  if (options.writeDurations) {
    const durations = mergePaidTestDurations(loadPaidTestDurations(rootDir, manifest.tier), results);
    writePaidTestDurations(manifest.tier, durations, rootDir);
    console.log(`[test:paid] wrote ${Object.keys(durations).length} ${manifest.tier} durations to ${PAID_TEST_DURATIONS_FILE}`);
  }

  // Which artifact root (attempt) and which shard (isolated or not) each file belongs to.
  const roots = artifacts.map(a => ({ root: path.resolve(a.root), attempt: a.result.attempt ?? 1 }))
    .sort((a, b) => b.root.length - a.root.length);
  const attemptOf = (abs: string) => roots.find(r => abs === r.root || abs.startsWith(r.root + path.sep))?.attempt ?? primary;
  const entryBySlug = new Map(manifest.entries.map(entry => [shardSlug([entry.file]), entry]));
  const shardOf = (rel: string) => {
    const parts = normalizeRelativePath(rel).split('/');
    const at = parts.lastIndexOf('shards');
    return at >= 0 && parts[at + 1] ? entryBySlug.get(parts[at + 1]!) ?? null : null;
  };

  const flaky: Array<{ name: string; attempts: number; file: string }> = [];
  const collectors: Parameters<typeof collectorOutcomeCounts>[0] = [];
  const files: Array<{ file: string; tier: string; shard: string | number; cost: number;
    flaky: number; total: number; executed: number; reused: number; passed: number;
    failed: number; manual_accepted: number; attempts: number }> = [];
  const manualProblems: string[] = [];
  const manualClaims = new Map<string, string>();
  const recordsByShard = new Map<string, any[]>();
  let costUsd = 0;
  for (const name of fs.readdirSync(reportDir, { recursive: true }) as string[]) {
    const rel = normalizeRelativePath(name);
    if (!isFinalizedEvalResultFile(rel) || rel.split('/').includes('receipts') || rel === 'collector-outcomes.json') continue;
    if (attemptOf(path.resolve(reportDir, rel)) !== primary) continue;
    const shard = shardOf(rel);
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(reportDir, rel), 'utf-8'));
      if (!Array.isArray(parsed.tests)) {
        if (Object.hasOwn(parsed, 'tests') || parsed.total_tests !== undefined || parsed.manual_review !== undefined) {
          manualProblems.push(`${rel}: malformed collector tests[]`);
        }
        continue;
      }
      costUsd += Number(parsed.total_cost_usd) || 0;
      if (shard) recordsByShard.set(shard.file, [...(recordsByShard.get(shard.file) ?? []), ...parsed.tests]);
      // Trial records are verdict input for panelVerdict(), never collector gates.
      if (shard?.trial) continue;
      const seen = new Map<string, number>();
      for (const [index, entry] of parsed.tests.entries()) {
        if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || !entry.name
          || typeof entry.passed !== 'boolean') {
          manualProblems.push(`${rel}: attempt ${index + 1}: malformed collector entry (name/passed required)`);
          continue;
        }
        const key = `${entry.suite ?? ''}\0${entry.name}`;
        const occurrence = (seen.get(key) ?? 0) + 1;
        seen.set(key, occurrence);
        if (Object.hasOwn(entry, 'manual_review') && occurrence !== 1) {
          manualProblems.push(`${rel}: attempt ${index + 1}: manual review is only valid on the first case attempt`);
        }
        if (Object.hasOwn(entry, 'manual_review')) {
          const previous = manualClaims.get(key);
          if (previous && previous !== rel) manualProblems.push(`${rel}: duplicate manual-review claim for ${entry.name} (also in ${previous})`);
          else manualClaims.set(key, rel);
        }
        const problem = manualReviewProblem(entry, rootDir);
        if (problem) manualProblems.push(`${rel}: attempt ${index + 1}: ${problem}`);
      }
      collectors.push(parsed);
      const counts = collectorOutcomeCounts([parsed]);
      files.push({ file: rel, tier: parsed.tier ?? 'unknown', shard: parsed.shard ?? '-',
        cost: parsed.total_cost_usd ?? 0, flaky: parsed.flaky_retries?.length ?? 0,
        total: counts.passed + counts.failed + counts.manual_accepted, ...counts });
      for (const f of parsed.flaky_retries ?? []) flaky.push({ ...f, file: rel });
    } catch (error) {
      manualProblems.push(`${rel}: malformed collector JSON (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const evidence = collectorOutcomeCounts(collectors);
  console.log(`[test:paid] collector final outcomes: ${evidence.executed} executed, ${evidence.reused} reused; ${evidence.passed} passed, ${evidence.failed} failed, ${evidence.manual_accepted} manual accepted (unscored; no score-cache credit) (${evidence.attempts} attempt records from ${collectors.length} collectors; every record counts)`);
  if (flaky.length > 0) {
    console.log(`[test:paid] report: ⚠ ${flaky.length} cases with multiple attempts this run: (paid evals never retry; each record counts)`);
    for (const f of flaky) console.log(`  ⚠ ${f.name} (x${f.attempts}) — ${f.file}`);
  }
  if (manualProblems.length) verdict.problems.push(...manualProblems);
  if (evidence.failed > 0) verdict.problems.push(`${evidence.failed} unapproved final collector failure(s)`);
  if (files.reduce((sum, file) => sum + file.total, 0) !== evidence.passed + evidence.failed + evidence.manual_accepted
    || files.reduce((sum, file) => sum + file.executed + file.reused, 0) !== evidence.executed + evidence.reused) {
    verdict.problems.push('Collector summary totals are inconsistent');
  }

  // Panel verdicts: one function, computed here only.
  const panels = panelReports(manifest, results, primary);
  for (const panel of panels.filter(p => p.failsLane)) {
    verdict.problems.push(`PANEL ${panel.case} ${panel.status}${panel.redClass === 'INFRA' ? ' (INFRA)' : ''} ${panel.passed}/${panel.panel.n} (${panel.marks}): ${panel.reason}`);
  }
  const laterPanels = attempts.slice(1).flatMap(attempt => panelReports(manifest, artifacts.map(a => a.result), attempt)
    .filter(panel => panel.trials.length > 0));

  // PR-lane receipts from verdicts (the planner ships them to the next run):
  // a whole fresh PASS panel with one input identity becomes a panel receipt;
  // a FAIL panel or a failed rule shard becomes a negative receipt that
  // blocks reuse of any older PASS for the same identity.
  const revision = env.GITHUB_SHA ?? '';
  if (env.GITHUB_RUN_ID && /^[a-f0-9]{40}$/.test(revision)) {
    const receiptsDir = path.join(reportDir, 'report-receipts');
    const source = { runId: `${env.GITHUB_RUN_ID}/${primary}`, revision, completedAt: Date.now() };
    const outcomes = results.flatMap(r => r.outcomes);
    for (const panel of panels) {
      const keys = outcomes.filter(o => o.trial?.case === panel.case && shardFile(o.files[0] ?? '') === panel.file).map(o => o.reused ? null : o.inputKey ?? null);
      if (keys.length !== panel.panel.n || keys.some(k => k === null) || new Set(keys).size !== 1) continue;
      if (panel.status === 'PASS') {
        writePanelReceipt(receiptsDir, { schema: 1, key: keys[0]!, case: panel.case, kind: panel.kind, panel: panel.panel, source,
          trials: panel.trials.map(({ trial, outcome, failure_class, exit_reason, error }) => ({ trial, outcome,
            ...(failure_class ? { failure_class } : {}), ...(exit_reason ? { exit_reason } : {}), ...(error ? { error } : {}) })) });
      } else if (panel.status === 'FAIL') writeNegativeReceipt(receiptsDir, { schema: 1, key: keys[0]!, source });
    }
    for (const outcome of outcomes.filter(o => !o.trial && o.inputKey && !o.reused && o.status !== 'passed')) {
      writeNegativeReceipt(receiptsDir, { schema: 1, key: outcome.inputKey!, source });
    }
  }

  // Quarantine cap and expiry are the weekly pass-rates gate's (eval-flake-rank --gate).

  // History: one trial-outcomes line per isolated trial and per JUnit rule/judge case.
  const runId = env.GITHUB_RUN_ID;
  const sha = env.GITHUB_SHA;
  const history: TrialOutcomeRecord[] = [];
  const common = (attempt: number) => ({ schema: TRIAL_OUTCOME_SCHEMA, tier: manifest.tier, attempt, policy_version: EVAL_POLICY.version,
    ...(runId ? { run_id: runId } : {}), ...(sha ? { sha } : {}), lane, recorded_at: new Date().toISOString() });
  for (const { result } of artifacts) {
    const attempt = result.attempt ?? 1;
    for (const outcome of result.outcomes) {
      const t = outcome.trial;
      if (!t || t.outcome === null) continue;
      history.push({ ...common(attempt), case: t.case, file: shardFile(outcome.files[0]!), kind: t.kind, trial: t.trial, panel: t.panel,
        outcome: t.outcome, ...(t.outcome === 'failed' ? { failure_class: t.failure_class ?? 'assertion' } : {}),
        ...(t.exit_reason ? { exit_reason: t.exit_reason } : {}), ...(t.error ? { error: t.error } : {}),
        ...(t.outcome === 'failed' && t.failure_cause ? { failure_cause: t.failure_cause } : {}),
        ...(t.outcome === 'failed' && t.failure_cause_evidence ? { failure_cause_evidence: t.failure_cause_evidence } : {}),
        ...(t.outcome === 'failed' && t.failure_detail ? { failure_detail: t.failure_detail } : {}), ...(t.sessions ? { sessions: t.sessions } : {}),
        duration_ms: t.duration_ms, cost_usd: t.cost_usd, ...(t.cost_known === false ? { cost_known: false } : {}), ...(t.model ? { model: t.model } : {}),
        ...(outcome.reused ? { input_identity: outcome.reused.inputKey } : {}),
        quarantined: t.quarantined, execution: outcome.reused ? 'reused' : 'executed', source: 'shard' } as TrialOutcomeRecord);
    }
  }
  const sliceArtifacts = new Map(artifacts.filter(a => (a.result.attempt ?? 1) === primary)
    .map(a => [a.result.sliceIndex, sliceArtifactName(a.root, a.result.sliceIndex, primary)] as const));
  const census = junitCensus(manifest, artifacts.filter(a => (a.result.attempt ?? 1) === primary), recordsByShard,
    common(primary), env.GSTACK_CLAUDE_CLI_VERSION);
  history.push(...census.history);
  const { ruleCases } = census;
  const allSkipped = results.flatMap((r) => r.outcomes.filter(isAllSkippedPass));
  const hollowWithoutJUnit = allSkipped.filter(outcome => !census.shardSkipReasons.has(normalizeRelativePath(outcome.files[0] ?? '')));
  if (allSkipped.length > 0) {
    console.log(`[test:paid] report: ⚠ ${allSkipped.length} shard(s) passed with EVERY test skipped — they verified nothing:`);
    for (const outcome of allSkipped) {
      const reasons = census.shardSkipReasons.get(normalizeRelativePath(outcome.files[0] ?? ''));
      console.log(`  ⚠ ${outcome.files.join(' ')} (${outcome.executedTests} skipped — ${reasons?.size
        ? [...reasons.entries()].map(([reason, n]) => `${n} ${reason}`).join('; ') : 'no JUnit report, reason unknown'})`);
    }
  }
  const censusLines = formatJUnitCensus(census);
  for (const line of censusLines) console.log(`[test:paid] ${line}`);
  // series_identity is stamped afterwards by scripts/eval-trial-series.ts (the report job's next step).
  fs.writeFileSync(trialOutcomesPath, formatTrialOutcomes(history));

  // Headline and failure block (A4): one formatter for the log, the PR comment and the weekly issue.
  const ruleShardFailures = manifest.entries.filter(entry => entry.status === 'planned' && !entry.trial).flatMap(entry => {
    const got = results.flatMap(r => r.outcomes.map(o => ({ o, slice: r.sliceIndex }))).find(({ o }) => normalizeRelativePath(o.files[0] ?? '') === normalizeRelativePath(entry.file));
    if (got && got.o.status === 'passed') return [];
    if (got && census.failedShards.has(normalizeRelativePath(entry.file))) return [];
    const id = shardCaseId(entry.file);
    return [`✗ ${entry.file}  rule shard ${got ? got.o.status : 'NOT REPORTED'}${got?.o.runnerError ? ` — ${sanitizeTrialError(got.o.runnerError)}` : ''}  [slice ${entry.slice}, attempt ${primary}]${id ? `  after a repair: ${afterRepairCommand(manifest.tier, id, shardFile(entry.file))}` : ''}`];
  });
  const behaviorPanels = panels.filter(p => !p.quarantined && p.kind === 'behavior');
  const lanePanels = panels.filter(p => !p.quarantined);
  const count = (kind: EvalCaseKind) => ({
    passed: ruleCases.filter(c => c.kind === kind && c.outcome === 'passed').length
      + lanePanels.filter(p => p.kind === kind && p.status === 'PASS').length,
    total: ruleCases.filter(c => c.kind === kind).length + lanePanels.filter(p => p.kind === kind).length,
  });
  const primaryTrials = results.flatMap(r => r.outcomes.map(o => o.trial)).filter((t): t is ShardTrialRecord => !!t);
  const wall = results.filter(r => Number.isSafeInteger(r.startedAt) && Number.isSafeInteger(r.finishedAt));
  const failureLines = [
    ...ruleShardFailures,
    ...ruleCases.filter(c => c.line).map(c => c.line!),
    ...panels.filter(p => p.status !== 'PASS' || p.split).map(p => formatPanelLine(p, manifest.tier, { artifacts: sliceArtifacts, runId })),
  ];
  const red = verdict.problems.length > 0;
  const headline: ReportHeadline = {
    lane, verdict: red ? 'RED' : 'GREEN', attempt: primary,
    counts: {
      rule: count('rule'),
      behavior: { ...count('behavior'), split: behaviorPanels.filter(p => p.split).length },
      judge: count('judge'),
      quarantined: { total: panels.filter(p => p.quarantined).length, failingLane: panels.filter(p => p.quarantined && p.failsLane).length },
      skipped: hollowWithoutJUnit.length + panels.filter(p => p.status === 'SKIPPED').length + ruleCases.filter(c => c.outcome === 'skipped').length,
      infra: primaryTrials.filter(t => t.failure_class === 'infra').length
        + results.flatMap(r => r.outcomes).filter(o => !o.trial && o.runnerError !== undefined).length,
      incomplete: panels.filter(p => p.status === 'INCOMPLETE').length,
      unattributed: census.unattributed.length,
    },
    actionRequired: verdict.problems.length,
    wallMs: wall.length ? Math.max(...wall.map(r => r.finishedAt!)) - Math.min(...wall.map(r => r.startedAt!)) : null,
    costUsd: Math.round(costUsd * 100) / 100,
    redispatchEligible: red && infraOnly(verdict.problems),
  };
  const executed = history.filter(r => r.attempt === primary && r.execution === 'executed' && r.outcome !== 'skipped');
  const headlineLines = formatHeadline(headline, { unknownTrials: executed.filter(r => r.cost_known === false).length, trials: executed.length });
  for (const line of headlineLines) console.log(line);
  if (failureLines.length) {
    console.log('[test:paid] failures and split verdicts:');
    for (const line of failureLines) console.log(`  ${line}`);
  }
  for (const panel of laterPanels) console.log(`  attempt ${panel.attempt} (re-run; reported, never replacing attempt ${primary}): ${formatPanelLine(panel, manifest.tier)}`);
  const fence = (lines: string[]) => publishedFence(lines);
  fs.writeFileSync(summaryMdPath, [
    ...fence(headlineLines),
    ...(failureLines.length ? ['', '**Failures and split verdicts**', '', ...fence(failureLines)] : []),
    ...(censusLines.length ? ['', '**Skipped, deselected and unattributed testcases**', '', ...fence(censusLines)] : []),
    ...(verdict.problems.length ? ['', `**ACTION REQUIRED (${verdict.problems.length})**`, '', ...fence(verdict.problems.map(p => sanitizeTrialError(p) ?? p)), '', `Guide: ${CENSUS_RED_GUIDE}`] : []),
  ].join('\n') + '\n');
  if (!manualProblems.length) fs.writeFileSync(summaryPath, JSON.stringify({ version: 2, files, totals: {
    ...evidence, total: evidence.passed + evidence.failed + evidence.manual_accepted,
    flaky: files.reduce((sum, file) => sum + file.flaky, 0),
  }, verdict: headline, headline: headlineLines,
  census: { skipped: census.skipped, deselected: Object.fromEntries(census.deselected), unattributed: census.unattributed },
  panels: panels.map(p => ({ case: p.case, kind: p.kind, status: p.status, passed: p.passed, n: p.panel.n, k: p.panel.k,
    marks: p.marks, split: p.split, quarantined: p.quarantined, failsLane: p.failsLane, redClass: p.redClass, reason: p.reason,
    trials: p.trials.map(t => ({ trial: t.trial, outcome: t.outcome, ...(t.failure_class ? { failure_class: t.failure_class } : {}),
      ...(t.exit_reason ? { exit_reason: t.exit_reason } : {}), ...(t.error ? { error: t.error } : {}) })) })),
  // evals.yml wraps these in a fixed fence for the PR comment.
  failures: failureLines.map(line => sanitizeFixedFenceLine(line)) }, null, 2) + '\n');
  if (verdict.problems.length) {
    console.error(`[test:paid] report: ${verdict.problems.length} problem(s):`);
    for (const problem of verdict.problems) console.error(`  ✗ ${problem}`);
    if (headline.redispatchEligible) console.error('[test:paid] report: INFRA-ONLY RED — one re-dispatch as a new run is allowed; report both runs');
    return 1;
  }
  console.log(evidence.manual_accepted
    ? `[test:paid] report: every planned shard accounted; ${evidence.manual_accepted} manual acceptance(s), no automated-score credit`
    : '[test:paid] report: every planned shard accounted and passed');
  return 0;
}
