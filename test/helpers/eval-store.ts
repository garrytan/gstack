/**
 * Eval result persistence and comparison.
 *
 * EvalCollector accumulates test results, writes them to
 * ~/.gstack/projects/$SLUG/evals/{version}-{branch}-{tier}-{timestamp}.json,
 * prints a summary table, and auto-compares with the previous run.
 *
 * Comparison functions are exported for reuse by the eval:compare CLI.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { isManualReviewEntry } from './cookie-workflow-manual-review';
import type { ManualJudgeReview } from './cookie-workflow-manual-review';

// v2: EvalTestEntry.harvest gains optional {insertions, deletions, net} and
// may be explicitly null (arm-benchmark harvest-failure taxonomy). Readers
// stay tolerant of v1 runs: no reader requires the new fields, and
// eval-compare only warns on version mismatch.
const SCHEMA_VERSION = 2;
const LEGACY_EVAL_DIR = path.join(os.homedir(), '.gstack-dev', 'evals');

/**
 * Detect project-scoped eval dir via gstack-slug.
 * Falls back to legacy ~/.gstack-dev/evals/ if slug detection fails.
 */
export function getProjectEvalDir(): string {
  try {
    // Try repo-local gstack-slug first, then global install
    const localSlug = spawnSync('bash', ['-c', '.claude/skills/gstack/bin/gstack-slug 2>/dev/null || ~/.claude/skills/gstack/bin/gstack-slug 2>/dev/null'], {
      stdio: 'pipe', timeout: 3000,
    });
    const output = localSlug.stdout?.toString().trim();
    if (output) {
      const slugMatch = output.match(/^SLUG=(.+)$/m);
      if (slugMatch && slugMatch[1]) {
        const dir = path.join(os.homedir(), '.gstack', 'projects', slugMatch[1], 'evals');
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      }
    }
  } catch { /* fall through */ }
  return LEGACY_EVAL_DIR;
}

/**
 * Lazy + memoized so importing this module never spawns the gstack-slug
 * subprocess. Callers that pass an explicit dir or set GSTACK_EVAL_DIR
 * (the sharded paid runner does, per shard) never pay for slug detection.
 */
let memoizedDefaultEvalDir: string | null = null;
function defaultEvalDir(): string {
  if (memoizedDefaultEvalDir === null) memoizedDefaultEvalDir = getProjectEvalDir();
  return memoizedDefaultEvalDir;
}

// --- Interfaces ---

export interface EvalTestEntry {
  name: string;
  suite: string;
  tier: 'e2e' | 'llm-judge';
  passed: boolean;
  duration_ms: number;
  cost_usd: number;
  /** False when the harness captured no billing, so cost_usd 0 means unknown. Absent means known. */
  cost_known?: boolean;
  /** Absent in older records means executed; reuse is never a new model run. */
  execution?: 'executed' | 'reused';
  reused_from?: { input_key: string; run_id: string; revision: string; completed_at: string };
  manual_review?: ManualJudgeReview;
  /** 1-based record attempt for this name in this run. bun's --retry leaves
   *  retried passes INVISIBLE in its text output (a fail→pass prints no
   *  (fail) line and recaps as a clean pass — probed on 1.3.10), so the ONLY
   *  reliable attempt signal is this in-process record: a retried test runs
   *  its body again and re-records under the same name. Set by addTest. */
  attempt?: number;

  // Trial identity (eval reliability policy). Stamped by addTest from the
  // TRIAL_ENV variables the paid runner sets on an isolated trial shard.
  /** Registry id (E2E_TIERS / LLM_JUDGE_TOUCHFILES key) this record belongs to. */
  case_id?: string;
  kind?: EvalCaseKind;
  /** 1-based trial index within the case's panel. */
  trial?: number;
  panel?: PanelShape;
  /** Why a failed record failed; 'contract' comes only from expectContract. */
  failure_class?: TrialFailureClass;
  policy_version?: number;

  // E2E
  transcript?: any[];
  prompt?: string;
  output?: string;
  turns_used?: number;
  tokens_used?: number;
  browse_errors?: string[];

  // LLM judge
  judge_scores?: Record<string, number>;
  judge_reasoning?: string;

  // Machine-readable diagnostics
  exit_reason?: string;       // 'success' | 'timeout' | 'error_max_turns' | 'exit_code_N'
  timeout_at_turn?: number;   // which turn was active when timeout hit
  last_tool_call?: string;    // e.g. "Write(review-output.md)"

  // Model + timing diagnostics (added for Sonnet/Opus split)
  model?: string;                // e.g. 'claude-sonnet-4-6' or 'claude-opus-4-7'
  first_response_ms?: number;    // time from spawn to first NDJSON line
  max_inter_turn_ms?: number;    // peak latency between consecutive tool calls

  // Outcome eval
  detection_rate?: number;
  false_positives?: number;
  evidence_quality?: number;
  detected_bugs?: string[];
  missed_bugs?: string[];

  error?: string;

  // Diff harvest data. Two writers today:
  //   - WorktreeManager harvests set {filesChanged, patchPath, isDuplicate}.
  //   - Arm-benchmark cells (schema v2) set {filesChanged, insertions,
  //     deletions, net} from `git add -A && git diff --cached --stat`, and
  //     record an explicit `null` when harvest itself failed (failure
  //     taxonomy: a failed harvest is never silently dropped).
  harvest?: {
    filesChanged: number;
    patchPath?: string;
    isDuplicate?: boolean;
    insertions?: number;
    deletions?: number;
    net?: number;
  } | null;
}

export function evalEntryOutcome(entry: unknown): 'passed' | 'failed' | 'manual-review' {
  if (!entry || typeof entry !== 'object') return 'failed';
  if ('manual_review' in entry) return Object.hasOwn(entry, 'manual_review') && isManualReviewEntry(entry) ? 'manual-review' : 'failed';
  const result = entry as EvalTestEntry;
  if (result.execution !== undefined && result.execution !== 'executed' && result.execution !== 'reused') return 'failed';
  return result.passed === true ? 'passed' : 'failed';
}

// --- Trials and panel verdicts ---
//
// Paid evals never retry. Each case's kind (E2E_KINDS) fixes its trials before
// the run; a panel verdict is computed once, by panelVerdict(), from exactly
// panel.n trial records of one run attempt. The report, collector-outcomes,
// the PR comment and pass-rates all read that one function.

export type EvalCaseKind = 'rule' | 'behavior' | 'judge';
/** assertion: an ordinary failed expectation. contract: expectContract() fired
 *  (fails the panel at any count). timeout: the case budget ran out.
 *  infra: API/CLI/runner failure before the model could be graded. */
export type TrialFailureClass = 'assertion' | 'contract' | 'timeout' | 'infra';
export type TrialOutcome = 'passed' | 'failed' | 'skipped';
export interface PanelShape { n: number; k: number }

/** Environment the paid runner sets on an isolated trial shard. */
export const TRIAL_ENV = {
  caseId: 'GSTACK_EVAL_CASE_ID',
  kind: 'GSTACK_EVAL_KIND',
  trial: 'GSTACK_EVAL_TRIAL',
  panelN: 'GSTACK_EVAL_PANEL_N',
  panelK: 'GSTACK_EVAL_PANEL_K',
  policyVersion: 'GSTACK_EVAL_POLICY_VERSION',
} as const;

/** Sidecar every expectContract() failure appends to (in GSTACK_EVAL_DIR), so a
 *  contract veto survives a test that throws before recording its entry. */
export const CONTRACT_VIOLATIONS_FILE = 'contract-violations.jsonl';

export interface TrialContext {
  case_id: string;
  kind: EvalCaseKind;
  trial: number;
  panel: PanelShape;
  policy_version: number;
}

const EVAL_KINDS: readonly EvalCaseKind[] = ['rule', 'behavior', 'judge'];
const FAILURE_CLASSES: readonly TrialFailureClass[] = ['assertion', 'contract', 'timeout', 'infra'];

function positiveInt(raw: string | undefined): number | null {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return null;
  return Number(raw);
}

/** Trial context of this process, or null outside an isolated trial shard.
 *  A partial or malformed context throws: a mislabeled trial is fail-open. */
export function trialContextFromEnv(env: NodeJS.ProcessEnv = process.env): TrialContext | null {
  const caseId = env[TRIAL_ENV.caseId];
  if (!caseId) return null;
  const kind = env[TRIAL_ENV.kind] as EvalCaseKind | undefined;
  const trial = positiveInt(env[TRIAL_ENV.trial]);
  const n = positiveInt(env[TRIAL_ENV.panelN]);
  const k = positiveInt(env[TRIAL_ENV.panelK]);
  const policy = positiveInt(env[TRIAL_ENV.policyVersion]);
  if (!kind || !EVAL_KINDS.includes(kind) || trial === null || n === null || k === null || policy === null || k > n || trial > n) {
    throw new Error(`Malformed trial context for ${caseId}: ${Object.values(TRIAL_ENV).map((name) => `${name}=${env[name] ?? ''}`).join(' ')}`);
  }
  return { case_id: caseId, kind, trial, panel: { n, k }, policy_version: policy };
}

/** Failure class of a failed record: an explicit class wins, then the exit reason. */
export function failureClassOf(entry: Pick<EvalTestEntry, 'failure_class' | 'exit_reason'>): TrialFailureClass {
  if (entry.failure_class && FAILURE_CLASSES.includes(entry.failure_class)) return entry.failure_class;
  return entry.exit_reason === 'timeout' ? 'timeout' : 'assertion';
}

/** Machine-recorded cause of a failed trial, beside its policy class. failure_class
 *  (what verdicts read) is never changed by it; whether an assertion was a
 *  detector, harness or product fault is a human diagnosis, never a cause. */
export const FAILURE_CAUSES = ['contract', 'pre_turn_infra', 'api_error', 'refusal', 'provider_stall',
  'session_timeout', 'observer_timeout', 'assertion', 'unknown'] as const;
export type TrialFailureCause = typeof FAILURE_CAUSES[number];
export const FAILURE_CAUSE_EVIDENCE_MAX = 300;
export const FAILURE_DETAIL_PART_MAX = 200;

/** Session facts failureCauseOf reads (a structural subset of a session-ledger row). */
export interface SessionCauseFacts {
  key?: string;
  end: string;
  evidence?: string;
  elapsed_ms?: number;
  budget_ms?: number;
  liveness?: { partial: boolean; max_request_silence_ms: number; silence_started_ms?: number; silence_after?: string };
}

export interface FailureCauseFacts {
  failure_class: TrialFailureClass;
  exit_reason?: string;
  /** Raw failure text (the record's error or the JUnit message). */
  error?: string;
  sessions?: readonly SessionCauseFacts[];
}

const oneLine = (text: string | undefined, max: number): string | undefined => {
  const first = text?.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = first.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b');
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

/**
 * Pure and dependency-free: the cause of one failed trial from its recorded
 * facts. Precedence contract > pre_turn_infra > api_error > refusal >
 * provider_stall > session_timeout > observer_timeout > assertion > unknown;
 * the highest cause with evidence wins and its evidence line is returned.
 * A provider stall needs a session that streamed partial messages, did not
 * complete, and shows STALL_WINDOW_MS of silence with a request in flight and
 * nothing outstanding; sessions without partial messages are never stalls.
 * The window is STALL_WINDOW_MS (eval-budgets.ts), passed in so this stays
 * dependency-free (tests that mock eval-budgets still load eval-store).
 */
export function failureCauseOf(facts: FailureCauseFacts, stallWindowMs: number): { cause: TrialFailureCause; evidence?: string } {
  const sessions = facts.sessions ?? [];
  const ended = (end: string) => sessions.find((s) => s.end === end);
  const out = (cause: TrialFailureCause, evidence?: string) => {
    const line = oneLine(evidence, FAILURE_CAUSE_EVIDENCE_MAX);
    return line ? { cause, evidence: line } : { cause };
  };
  if (facts.failure_class === 'contract') return out('contract', facts.error);
  if (facts.failure_class === 'infra') return out('pre_turn_infra', facts.error ?? facts.exit_reason);
  const api = ended('api_error');
  if (api) return out('api_error', api.evidence);
  if (facts.exit_reason === 'error_api') return out('api_error', facts.error);
  const refusal = ended('refusal');
  if (refusal) return out('refusal', refusal.evidence);
  const stall = sessions.find((s) => s.end !== 'completed' && s.liveness?.partial === true && s.liveness.max_request_silence_ms >= stallWindowMs);
  if (stall?.liveness) {
    const l = stall.liveness;
    return out('provider_stall', `no stream event for ${Math.round(l.max_request_silence_ms / 1000)}s`
      + `${l.silence_started_ms !== undefined ? ` from ${Math.round(l.silence_started_ms / 1000)}s` : ''}`
      + `${l.silence_after ? ` (last: ${l.silence_after})` : ''}; model request in flight, no tool outstanding`);
  }
  const clock = (s: SessionCauseFacts) => `${s.key ?? 'session'} ran ${Math.round((s.elapsed_ms ?? 0) / 1000)}s`
    + `${s.budget_ms ? ` of its ${Math.round(s.budget_ms / 1000)}s budget` : ''}`;
  const timedOut = ended('session_timeout');
  if (timedOut) return out('session_timeout', timedOut.evidence ?? clock(timedOut));
  if (facts.exit_reason === 'timeout') return out('session_timeout', 'the runner\'s armed session timeout fired');
  const observerText = /\boutcome=timeout\b/.test(facts.error ?? '') ? facts.error : undefined;
  const observer = ended('observer_timeout');
  if (observer) return out('observer_timeout', observer.evidence ?? observerText ?? clock(observer));
  if (observerText) return out('observer_timeout', observerText);
  if (facts.failure_class === 'assertion') return out('assertion', facts.exit_reason === 'success' ? 'session completed; check failed' : undefined);
  return out('unknown', facts.failure_class === 'timeout' ? 'case budget expired with no session evidence' : undefined);
}

/** Expected/Received values of a failed Bun matcher, or a judge's failing dimensions. */
export type TrialFailureDetail =
  | { expected: string; received: string }
  | { judge: Array<{ dimension: string; mean: number; threshold: number; samples: number; rationale?: string }> };

const detailPart = (text: string): string => {
  // eslint-disable-next-line no-control-regex
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b');
  return flat.length > FAILURE_DETAIL_PART_MAX ? `${flat.slice(0, FAILURE_DETAIL_PART_MAX - 1)}…` : flat;
};

/**
 * Detail the stored error line cannot carry (it keeps only the matcher header).
 * A judge record with a `>= N` threshold names each dimension below it, its
 * gating value (the panel median since EVAL_POLICY v3, in the `mean` field), its sample count and the first sample sentence naming that dimension;
 * otherwise a Bun matcher message yields its Expected/Received values.
 */
export function failureDetailOf(text: string | undefined,
  record?: { judge_scores?: unknown; judge_reasoning?: unknown }): TrialFailureDetail | undefined {
  if (!text) return undefined;
  const threshold = /^Expected:\s*>=?\s*(-?[\d.]+)\s*$/m.exec(text);
  const scores = record?.judge_scores;
  if (threshold && scores && typeof scores === 'object' && !Array.isArray(scores)) {
    const limit = Number(threshold[1]);
    const reasoning = typeof record?.judge_reasoning === 'string' ? record.judge_reasoning : '';
    const samples = reasoning.split(/\[sample \d+\]\s*/).map((s) => s.trim()).filter(Boolean);
    const judge = Object.entries(scores as Record<string, unknown>)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] < limit)
      .slice(0, 8).map(([dimension, mean]) => {
        const word = dimension.replace(/_/g, ' ').toLowerCase();
        const sentence = samples.flatMap((s) => s.split(/(?<=[.!?])\s+/)).find((s) => s.toLowerCase().includes(word));
        return { dimension: detailPart(dimension), mean: Math.round(mean * 100) / 100, threshold: limit,
          samples: Math.max(1, samples.length), ...(sentence ? { rationale: detailPart(sentence.slice(0, 150)) } : {}) };
      });
    if (judge.length) return { judge };
  }
  const lines = text.split('\n');
  const expected = lines.map((l) => /^Expected(?:[^:]*)?:\s?(.*)$/.exec(l)).find(Boolean);
  const received = lines.map((l) => /^Received(?:[^:]*)?:\s?(.*)$/.exec(l)).find(Boolean);
  if (expected && received && !/^\s*[-+]\s*\d+\s*$/.test(expected[1]!)) {
    return { expected: detailPart(expected[1]!), received: detailPart(received[1]!) };
  }
  const minus = lines.filter((l) => /^-\s/.test(l) && !/^- Expected\s/.test(l)).map((l) => l.slice(1).trim());
  const plus = lines.filter((l) => /^\+\s/.test(l) && !/^\+ Received\s/.test(l)).map((l) => l.slice(1).trim());
  if (minus.length || plus.length) return { expected: detailPart(minus.join(' ')), received: detailPart(plus.join(' ')) };
  return undefined;
}

export interface TrialSessionSummary { key: string; runner: string; elapsed_ms: number; budget_ms?: number; end: string }

/** The compact per-session view a trial record carries (ledger evidence and liveness stay in the artifact). */
export function trialSessions(rows: ReadonlyArray<SessionCauseFacts & { runner?: string }>): { sessions?: TrialSessionSummary[] } {
  const sessions = rows.filter((r) => typeof r.key === 'string' && Number.isFinite(r.elapsed_ms)).slice(0, 32).map((r) => ({
    key: r.key!.slice(0, 160), runner: String(r.runner ?? 'unknown').slice(0, 20), elapsed_ms: r.elapsed_ms!,
    ...(Number.isFinite(r.budget_ms) ? { budget_ms: r.budget_ms } : {}), end: r.end.slice(0, 20) }));
  return sessions.length ? { sessions } : {};
}

/**
 * Whether a trial's cost_usd is its billed cost: every eval record and ledger
 * session captured billing. A trial with no eval record (a JUnit-only PTY
 * case) or a session that billed nothing (PTY, Codex, an SDK capture without
 * a terminal result) is unknown. Returns the field only when unknown, so a
 * known cost keeps today's record shape (absent means known).
 */
export function trialCostKnown(records: ReadonlyArray<{ cost_known?: unknown }>, sessions: ReadonlyArray<{ billed?: boolean }> = []): { cost_known?: false } {
  return records.length > 0 && records.every((r) => r.cost_known !== false) && sessions.every((s) => s.billed !== false) ? {} : { cost_known: false };
}

/** Cause, cause evidence and detail of one failed trial, for both record builders. */
export function trialFailureFields(input: FailureCauseFacts & { record?: { judge_scores?: unknown; judge_reasoning?: unknown } }, stallWindowMs: number): {
  failure_cause: TrialFailureCause; failure_cause_evidence?: string; failure_detail?: TrialFailureDetail;
} {
  const { cause, evidence } = failureCauseOf(input, stallWindowMs);
  const detail = failureDetailOf(input.error, input.record);
  return { failure_cause: cause, ...(evidence ? { failure_cause_evidence: evidence } : {}), ...(detail ? { failure_detail: detail } : {}) };
}

export class ContractViolation extends Error {
  constructor(message: string) {
    super(`CONTRACT: ${message}`);
    this.name = 'ContractViolation';
  }
}

/**
 * Assert a contract: an outcome the product must meet on every run. On failure
 * it records failure_class 'contract' before throwing, both on the collector
 * entry named `record.name` (now or when the test records it) and in the
 * GSTACK_EVAL_DIR sidecar, so panelVerdict() fails the panel even at 2 of 3.
 */
export function expectContract(
  condition: unknown,
  message: string,
  record?: { collector: EvalCollector | null; name: string },
): asserts condition {
  if (condition) return;
  record?.collector?.markContractViolation(record.name, message);
  const evalDir = process.env.GSTACK_EVAL_DIR;
  if (evalDir) {
    const context = trialContextFromEnv();
    fs.mkdirSync(evalDir, { recursive: true });
    fs.appendFileSync(path.join(evalDir, CONTRACT_VIOLATIONS_FILE), JSON.stringify({
      case_id: context?.case_id ?? record?.name ?? null,
      name: record?.name ?? null,
      trial: context?.trial ?? null,
      message,
      at: new Date().toISOString(),
    }) + '\n');
  }
  throw new ContractViolation(message);
}

export interface PanelTrial {
  trial: number;
  outcome: TrialOutcome;
  /** Required meaning for a failed trial; absent reads as 'assertion'. */
  failure_class?: TrialFailureClass;
  /** CI run attempt (github.run_attempt); absent means 1. */
  attempt?: number;
  exit_reason?: string;
  error?: string;
  execution?: 'executed' | 'reused';
}

export interface PanelVerdictInput {
  case: string;
  kind: EvalCaseKind;
  panel: PanelShape;
  trials: readonly PanelTrial[];
  quarantined?: boolean;
}

export type PanelStatus = 'PASS' | 'FAIL' | 'INCOMPLETE' | 'SKIPPED';

export interface PanelVerdict {
  case: string;
  kind: EvalCaseKind;
  panel: PanelShape;
  attempt: number;
  quarantined: boolean;
  status: PanelStatus;
  passed: number;
  failed: number;
  /** A failed trial carried failure_class 'contract'. */
  contract: boolean;
  /** PASS with at least one failed trial: shown as `PASS k/n`, never clean. */
  split: boolean;
  /** Whether this verdict makes the lane red. */
  failsLane: boolean;
  /** Whether it counts as passing coverage (never for quarantined or skipped). */
  coverage: boolean;
  /** Machine classification of a lane-failing verdict: INCOMPLETE (missing or
   *  malformed trial records), INFRA (every failed trial is infra-class), or
   *  VERDICT (a real red). Null when the verdict does not fail the lane. */
  redClass: 'INCOMPLETE' | 'INFRA' | 'VERDICT' | null;
  /** One glyph per trial index: ✓ pass, ✗ fail, – skipped, · missing. */
  marks: string;
  reason: string;
  trials: PanelTrial[];
}

/**
 * The single verdict function. `rule`/`judge` cases run panel {1,1}; `behavior`
 * cases run EVAL_POLICY.panel; a quarantined case runs a full panel whose k
 * keeps its kind's meaning (k = n for rule). Verdict: INCOMPLETE unless
 * exactly one record per trial index 1..n; SKIPPED when every trial skipped;
 * FAIL on any contract trial; otherwise PASS iff passed >= k. A quarantined
 * FAIL fails the lane only on a hard break (0 of n) or a contract violation.
 */
export function panelVerdict(input: PanelVerdictInput): PanelVerdict {
  const { n, k } = input.panel;
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 1 || k < 1 || k > n) {
    throw new Error(`${input.case}: invalid panel {n:${n}, k:${k}}`);
  }
  if (!EVAL_KINDS.includes(input.kind)) throw new Error(`${input.case}: unknown kind ${String(input.kind)}`);
  const attempts = new Set(input.trials.map((t) => t.attempt ?? 1));
  if (attempts.size > 1) {
    throw new Error(`${input.case}: trials from run attempts ${[...attempts].join(', ')}; compute one verdict per attempt`);
  }
  const attempt = [...attempts][0] ?? 1;
  const quarantined = input.quarantined === true;
  const trials = [...input.trials].sort((a, b) => a.trial - b.trial);
  const byIndex = new Map<number, PanelTrial>();
  const problems: string[] = [];
  for (const t of trials) {
    if (!Number.isInteger(t.trial) || t.trial < 1 || t.trial > n) problems.push(`unexpected trial t${t.trial}`);
    else if (byIndex.has(t.trial)) problems.push(`duplicate trial t${t.trial}`);
    else if (t.outcome !== 'passed' && t.outcome !== 'failed' && t.outcome !== 'skipped') problems.push(`t${t.trial} has outcome ${String(t.outcome)}`);
    else byIndex.set(t.trial, t);
  }
  for (let i = 1; i <= n; i++) if (!trials.some((t) => t.trial === i)) problems.push(`missing trial t${i}`);
  const marks = Array.from({ length: n }, (_, i) => {
    const t = byIndex.get(i + 1);
    return !t ? '·' : t.outcome === 'passed' ? '✓' : t.outcome === 'failed' ? '✗' : '–';
  }).join('');
  const passed = [...byIndex.values()].filter((t) => t.outcome === 'passed').length;
  const failedTrials = [...byIndex.values()].filter((t) => t.outcome === 'failed');
  const skipped = [...byIndex.values()].filter((t) => t.outcome === 'skipped').length;
  const contract = failedTrials.some((t) => failureClassOf(t) === 'contract');
  const base = { case: input.case, kind: input.kind, panel: { n, k }, attempt, quarantined, passed, failed: failedTrials.length, contract, marks, trials };

  if (problems.length === 0 && skipped === n) {
    return { ...base, status: 'SKIPPED', split: false, failsLane: false, coverage: false, redClass: null, reason: 'every trial skipped (no verdict credit)' };
  }
  if (problems.length === 0 && skipped > 0) problems.push(`${skipped} of ${n} trials skipped`);
  if (problems.length > 0) {
    return { ...base, status: 'INCOMPLETE', split: false, failsLane: true, coverage: false, redClass: 'INCOMPLETE', reason: problems.join('; ') };
  }
  if (!contract && passed >= k) {
    const split = failedTrials.length > 0;
    return {
      ...base, status: 'PASS', split, failsLane: false, coverage: !quarantined, redClass: null,
      reason: split ? `PASS ${passed}/${n}` : `${passed}/${n} passed`,
    };
  }
  const hardBreak = passed === 0;
  const failsLane = !quarantined || contract || hardBreak;
  const allInfra = !contract && failedTrials.length > 0 && failedTrials.every((t) => failureClassOf(t) === 'infra');
  const why = contract ? 'contract violation' : `${passed}/${n} passed, needs ${k}`;
  return {
    ...base, status: 'FAIL', split: false, failsLane, coverage: false,
    redClass: failsLane ? (allInfra ? 'INFRA' : 'VERDICT') : null,
    reason: !quarantined ? why
      : contract ? `${why}; quarantine never excuses a contract`
        : hardBreak ? `${why}; quarantined hard break`
          : `${why}; quarantined, does not fail the lane`,
  };
}

// --- trial-outcomes JSONL (one line per trial; pass-rate history input) ---

export const TRIAL_OUTCOME_SCHEMA = 'gstack-trial-outcome/v1';
export const TRIAL_OUTCOMES_FILE = 'trial-outcomes.jsonl';
/** Cap on a stored `error` line (sanitized first line of the failure). */
export const TRIAL_ERROR_MAX = 300;

export interface TrialOutcomeRecord {
  schema: typeof TRIAL_OUTCOME_SCHEMA;
  /** Registry id. */
  case: string;
  file: string;
  tier: string;
  kind: EvalCaseKind;
  trial: number;
  panel: PanelShape;
  /** CI run attempt (github.run_attempt); 1 locally and for pre-policy backfill. */
  attempt: number;
  outcome: TrialOutcome;
  /** Present exactly when outcome is 'failed'. */
  failure_class?: TrialFailureClass;
  exit_reason?: string;
  error?: string;
  duration_ms: number;
  cost_usd: number;
  model?: string;
  cli_version?: string;
  /** Reuse input key of the trial's shard, when known. */
  input_identity?: string;
  /** EVAL_POLICY.version; 0 marks pre-policy backfill. */
  policy_version: number;
  quarantined: boolean;
  execution: 'executed' | 'reused';
  /** shard: isolated trial shard status. junit: a rule file shard's per-test
   *  JUnit outcome. backfill: imported pre-policy artifact record. */
  source: 'shard' | 'junit' | 'backfill';
  run_id?: string;
  sha?: string;
  lane?: string;
  recorded_at?: string;
  /** History series key: a hash of the case's own touchfiles (GLOBAL_TOUCHFILES excluded), stamped by the report job. */
  series_identity?: string;
  /** Failed trials only: what the runners observed (failureCauseOf); verdicts never read it. */
  failure_cause?: TrialFailureCause;
  failure_cause_evidence?: string;
  failure_detail?: TrialFailureDetail;
  /** Ledger sessions of this trial; absent means unknown, never scored. */
  sessions?: TrialSessionSummary[];
  /** False when the harness captured no billing, so cost_usd 0 means unknown. Absent means known. */
  cost_known?: boolean;
}

/** First line of free text, stripped of @-mentions and control characters, capped. */
export function sanitizeTrialError(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const first = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!first) return undefined;
  // eslint-disable-next-line no-control-regex
  const clean = first.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/`/g, "'").replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b');
  return clean.length > TRIAL_ERROR_MAX ? `${clean.slice(0, TRIAL_ERROR_MAX - 1)}…` : clean;
}

function trialRecordProblems(r: any): string[] {
  const problems: string[] = [];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['not an object'];
  if (r.schema !== TRIAL_OUTCOME_SCHEMA) problems.push(`schema ${String(r.schema)}`);
  for (const key of ['case', 'file', 'tier'] as const) if (typeof r[key] !== 'string' || r[key].length === 0) problems.push(`${key} missing`);
  if (!EVAL_KINDS.includes(r.kind)) problems.push(`kind ${String(r.kind)}`);
  const n = r.panel?.n, k = r.panel?.k;
  if (!Number.isInteger(n) || !Number.isInteger(k) || n < 1 || k < 1 || k > n) problems.push('panel invalid');
  if (!Number.isInteger(r.trial) || r.trial < 1 || (Number.isInteger(n) && r.trial > n)) problems.push('trial invalid');
  if (!Number.isInteger(r.attempt) || r.attempt < 1) problems.push('attempt invalid');
  if (!['passed', 'failed', 'skipped'].includes(r.outcome)) problems.push(`outcome ${String(r.outcome)}`);
  if (r.outcome === 'failed' && !FAILURE_CLASSES.includes(r.failure_class)) problems.push('failed without failure_class');
  if (r.outcome !== 'failed' && r.failure_class !== undefined) problems.push('failure_class on a non-failed trial');
  if (typeof r.duration_ms !== 'number' || !Number.isFinite(r.duration_ms) || r.duration_ms < 0) problems.push('duration_ms invalid');
  if (typeof r.cost_usd !== 'number' || !Number.isFinite(r.cost_usd) || r.cost_usd < 0) problems.push('cost_usd invalid');
  if (!Number.isInteger(r.policy_version) || r.policy_version < 0) problems.push('policy_version invalid');
  if (typeof r.quarantined !== 'boolean') problems.push('quarantined invalid');
  if (r.execution !== 'executed' && r.execution !== 'reused') problems.push('execution invalid');
  if (!['shard', 'junit', 'backfill'].includes(r.source)) problems.push('source invalid');
  if (r.error !== undefined && (typeof r.error !== 'string' || r.error.length > TRIAL_ERROR_MAX)) problems.push('error invalid');
  if (r.series_identity !== undefined && (typeof r.series_identity !== 'string' || !/^[\w.-]{1,64}$/.test(r.series_identity))) problems.push('series_identity invalid');
  problems.push(...optionalFieldProblems(r));
  return problems;
}

const boundedString = (v: unknown, max: number) => typeof v === 'string' && v.length <= max;
const finiteNonNegative = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** The optional diagnostic fields, checked only when present. */
function optionalFieldProblems(r: any): string[] {
  const problems: string[] = [];
  if (r.failure_cause !== undefined) {
    if (r.outcome !== 'failed') problems.push('failure_cause on a non-failed trial');
    else if (!FAILURE_CAUSES.includes(r.failure_cause)) problems.push(`unknown failure_cause ${JSON.stringify(String(r.failure_cause).slice(0, 40))} (written by a newer gstack; update this checkout to read it)`);
  }
  if (r.failure_cause_evidence !== undefined && !boundedString(r.failure_cause_evidence, FAILURE_CAUSE_EVIDENCE_MAX)) problems.push('failure_cause_evidence invalid');
  const d = r.failure_detail;
  if (d !== undefined) {
    const assertion = d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 2
      && boundedString(d.expected, FAILURE_DETAIL_PART_MAX) && boundedString(d.received, FAILURE_DETAIL_PART_MAX);
    const judge = d && typeof d === 'object' && Object.keys(d).length === 1 && Array.isArray(d.judge) && d.judge.length >= 1 && d.judge.length <= 8
      && d.judge.every((j: any) => j && boundedString(j.dimension, FAILURE_DETAIL_PART_MAX) && Number.isFinite(j.mean) && Number.isFinite(j.threshold)
        && Number.isInteger(j.samples) && j.samples >= 1 && j.samples <= 20 && (j.rationale === undefined || boundedString(j.rationale, FAILURE_DETAIL_PART_MAX)));
    if (!assertion && !judge) problems.push('failure_detail invalid');
  }
  if (r.sessions !== undefined && !(Array.isArray(r.sessions) && r.sessions.length <= 32 && r.sessions.every((x: any) => x
    && boundedString(x.key, 160) && boundedString(x.runner, 20) && finiteNonNegative(x.elapsed_ms) && boundedString(x.end, 20)
    && (x.budget_ms === undefined || finiteNonNegative(x.budget_ms))))) problems.push('sessions invalid');
  if (r.cost_known !== undefined && typeof r.cost_known !== 'boolean') problems.push('cost_known invalid');
  return problems;
}

/** Serialize records as JSONL; throws on any invalid record (writers fail closed). */
export function formatTrialOutcomes(records: readonly TrialOutcomeRecord[]): string {
  return records.map((r) => {
    const problems = trialRecordProblems(r);
    if (problems.length > 0) throw new Error(`invalid trial record ${r?.case}~t${r?.trial}: ${problems.join(', ')}`);
    return JSON.stringify(r);
  }).join('\n') + (records.length > 0 ? '\n' : '');
}

/** Parse downloaded JSONL as data only: invalid lines are reported, never guessed. */
export function parseTrialOutcomes(text: string, opts: { maxBytes?: number } = {}): { records: TrialOutcomeRecord[]; errors: string[] } {
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  if (Buffer.byteLength(text) > maxBytes) return { records: [], errors: [`trial outcomes exceed ${maxBytes} bytes`] };
  const records: TrialOutcomeRecord[] = [];
  const errors: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { errors.push(`line ${i + 1}: not JSON`); return; }
    const problems = trialRecordProblems(parsed);
    if (problems.length > 0) errors.push(`line ${i + 1}: ${problems.join(', ')}`);
    else records.push(parsed as TrialOutcomeRecord);
  });
  return { records, errors };
}

export interface EvalResult {
  schema_version: number;
  version: string;
  branch: string;
  git_sha: string;
  timestamp: string;
  hostname: string;
  /** `claude --version` first line at run time (schema-additive, optional).
   *  TUI drift broke the PTY harness three times before runs recorded which
   *  CLI they actually exercised. */
  claude_cli_version?: string;
  tier: 'e2e' | 'llm-judge';
  total_tests: number;
  executed_tests?: number;
  reused_tests?: number;
  manual_accepted_tests?: number;
  passed: number;
  failed: number;
  total_cost_usd: number;
  total_duration_ms: number;
  wall_clock_ms?: number;     // wall-clock from collector creation to finalization (shows parallelism)
  tests: EvalTestEntry[];
  /** Shard slug when the run was collected under <evalDir>/shards/<slug>/. */
  shard?: string;
  /** Tests recorded more than once this run — the flake ledger for the paid
   *  lane. A test passing on attempt 2 every week used to read permanently
   *  green (the retry's entry was indistinguishable and bun's output hides
   *  retries entirely). Present only when non-empty. */
  flaky_retries?: Array<{ name: string; attempts: number }>;
  _partial?: boolean;  // true for incremental saves, absent in final
}

export interface TestDelta {
  name: string;
  before: { passed: boolean; cost_usd: number; turns_used?: number; duration_ms?: number;
            detection_rate?: number; tool_summary?: Record<string, number>; manual_review?: boolean };
  after:  { passed: boolean; cost_usd: number; turns_used?: number; duration_ms?: number;
            detection_rate?: number; tool_summary?: Record<string, number>; manual_review?: boolean };
  status_change: 'improved' | 'regressed' | 'unchanged' | 'manual-review';
}

export interface ComparisonResult {
  before_file: string;
  after_file: string;
  before_branch: string;
  after_branch: string;
  before_timestamp: string;
  after_timestamp: string;
  deltas: TestDelta[];
  total_cost_delta: number;
  total_duration_delta: number;
  improved: number;
  regressed: number;
  unchanged: number;
  manual_reviewed?: number;
  tool_count_before: number;
  tool_count_after: number;
  /** After-tests that had a same-named entry in the before run. 0 = nothing was
   *  actually compared, so no stability claim is warranted. */
  matched?: number;
}

// --- Shared helpers ---

/**
 * Is this eval file an in-progress accumulator rather than a finalized run?
 *
 * True on either signal: the `_partial` flag inside the JSON (the authoritative
 * role marker) OR a filename starting with `_partial` (catches accumulators
 * whose body predates the flag, and flagged files that were renamed keep being
 * caught by the flag). Every baseline lookup must exclude these — an
 * accumulator carries the current run's tier, branch, and freshest timestamp,
 * so treating it as a baseline makes the run compare against itself.
 */
export function isPartialEval(data: unknown, filename: string): boolean {
  if (path.basename(filename).startsWith('_partial')) return true;
  return Boolean((data as { _partial?: unknown } | null)?._partial);
}

/**
 * Is this path a FINALIZED eval-store result file? Single owner of the
 * filename taxonomy (manifest.json / slice-N.json are runner artifacts,
 * _partial* are in-progress accumulators) — the paid runner's report mode
 * and eval-flake-rank both consume this instead of re-encoding the rule
 * (review finding: the rule lived in three places).
 */
export function isFinalizedEvalResultFile(relPath: string): boolean {
  const base = path.basename(relPath);
  if (!base.endsWith('.json')) return false;
  if (base === 'manifest.json' || /^slice-\d+\.json$/.test(base)) return false;
  if (base.startsWith('_partial')) return false;
  return true;
}

/**
 * List eval JSON files in `evalDir` plus one level of `<evalDir>/shards/<slug>/`
 * subdirectories (where the sharded paid runner points each shard's collector).
 * Returns absolute paths. Missing dirs yield [].
 */
export function listEvalJsonFiles(evalDir: string): string[] {
  const jsonIn = (dir: string): string[] => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names.filter(f => f.endsWith('.json')).map(f => path.join(dir, f));
  };

  const files = jsonIn(evalDir);
  const shardsRoot = path.join(evalDir, 'shards');
  let shardDirs: fs.Dirent[];
  try {
    shardDirs = fs.readdirSync(shardsRoot, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of shardDirs) {
    if (!entry.isDirectory()) continue;
    files.push(...jsonIn(path.join(shardsRoot, entry.name)));
  }
  return files;
}

/**
 * Shard slug for an eval dir: when the dir is directly under a `shards/`
 * directory (the sharded paid runner's per-shard GSTACK_EVAL_DIR layout),
 * the dir name is the slug; otherwise null.
 */
export function shardSlugOfEvalDir(evalDir: string): string | null {
  const normalized = path.resolve(evalDir);
  return path.basename(path.dirname(normalized)) === 'shards' ? path.basename(normalized) : null;
}

/** The reserved suffix scopes collectors that share one paid-runner shard. */
function collectorNamespaceOfFile(file: string): string | null {
  return path.basename(file).match(/--suite-([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/)?.[1] ?? null;
}

/**
 * Find the most recent finalized (non-partial) eval file for a tier, scanning
 * `evalDir` and one level of `shards/<slug>/` subdirs. Shared by the budget
 * regression gate and any tooling that needs "the latest real run".
 */
export function findLatestFinalizedRun(
  evalDir: string,
  tier: 'e2e' | 'llm-judge',
): { filepath: string; result: EvalResult } | null {
  let latest: { filepath: string; result: EvalResult; timestamp: string } | null = null;
  for (const filepath of listEvalJsonFiles(evalDir)) {
    let data: EvalResult;
    try {
      data = JSON.parse(fs.readFileSync(filepath, 'utf-8')) as EvalResult;
    } catch { continue; }
    if (isPartialEval(data, filepath)) continue;
    if (data.tier !== tier) continue;
    const timestamp = data.timestamp ?? '';
    if (!latest || timestamp.localeCompare(latest.timestamp) > 0) {
      latest = { filepath, result: data, timestamp };
    }
  }
  return latest ? { filepath: latest.filepath, result: latest.result } : null;
}

/**
 * Determine if a planted-bug eval passed based on judge results vs ground truth thresholds.
 * Centralizes the pass/fail logic so all planted-bug tests use the same criteria.
 */
export function judgePassed(
  judgeResult: { detection_rate: number; false_positives: number; evidence_quality: number },
  groundTruth: { minimum_detection: number; max_false_positives: number },
): boolean {
  return judgeResult.detection_rate >= groundTruth.minimum_detection
    && judgeResult.false_positives <= groundTruth.max_false_positives
    && judgeResult.evidence_quality >= 2;
}

// --- Comparison functions (exported for eval:compare CLI) ---

/**
 * Extract tool call counts from a transcript.
 * Returns e.g. { Bash: 8, Read: 3, Write: 1 }.
 */
export function extractToolSummary(transcript: any[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of transcript) {
    if (event.type === 'assistant') {
      const content = event.message?.content || [];
      for (const item of content) {
        if (item.type === 'tool_use') {
          const name = item.name || 'unknown';
          counts[name] = (counts[name] || 0) + 1;
        }
      }
    }
  }
  return counts;
}

/**
 * Find the most recent prior COMPLETED eval file for comparison.
 * Scans the eval dir plus one level of `shards/<slug>/` subdirs. Prefers
 * same shard slug (a shard's own history over another shard's or the flat
 * dir's), then same branch, then falls back to anything in the same collector
 * namespace. A sibling suite is never a comparable baseline.
 *
 * In-progress accumulators (`_partial: true`, written by savePartial after every
 * test) are never candidates: the current run's own partial carries the current
 * tier + branch and the freshest timestamp, so including it made every run
 * compare against itself and report "no regressions" unconditionally. The
 * exclusion is by role (the `_partial` flag), not by filename.
 */
export function findPreviousRun(
  evalDir: string,
  tier: string,
  branch: string,
  excludeFile: string,
): string | null {
  // Parse top-level fields from each file (cheap — no full tests array needed)
  const namespace = collectorNamespaceOfFile(excludeFile);
  const entries: Array<{ file: string; branch: string; timestamp: string; shard: string | null }> = [];
  for (const fullPath of listEvalJsonFiles(evalDir)) {
    if (path.resolve(fullPath) === path.resolve(excludeFile)) continue;
    if (collectorNamespaceOfFile(fullPath) !== namespace) continue;
    try {
      const raw = fs.readFileSync(fullPath, 'utf-8');
      // Quick parse — only grab the fields we need
      const data = JSON.parse(raw);
      if (isPartialEval(data, fullPath)) continue; // in-progress run, not a baseline
      if (data.tier !== tier) continue;
      entries.push({
        file: fullPath,
        branch: data.branch || '',
        timestamp: data.timestamp || '',
        shard: data.shard || shardSlugOfEvalDir(path.dirname(fullPath)),
      });
    } catch { continue; }
  }

  if (entries.length === 0) return null;

  // Sort by timestamp descending
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Prefer same shard slug (null = the flat dir), then same branch, then any.
  const targetShard = shardSlugOfEvalDir(path.dirname(excludeFile));
  const preferences: Array<(e: typeof entries[number]) => boolean> = [
    e => e.shard === targetShard && e.branch === branch,
    e => e.shard === targetShard,
    e => e.branch === branch,
  ];
  for (const matches of preferences) {
    const hit = entries.find(matches);
    if (hit) return hit.file;
  }
  return entries[0].file;
}

/**
 * Compare two eval results. Matches tests by name.
 */
export function compareEvalResults(
  before: EvalResult,
  after: EvalResult,
  beforeFile: string,
  afterFile: string,
): ComparisonResult {
  const deltas: TestDelta[] = [];
  let improved = 0, regressed = 0, unchanged = 0;
  let manualReviewed = 0;
  let toolCountBefore = 0, toolCountAfter = 0;
  let matched = 0;

  // Index before tests by name
  const beforeMap = new Map<string, EvalTestEntry>();
  for (const t of before.tests) {
    beforeMap.set(t.name, t);
  }

  // Walk after tests, match by name
  for (const afterTest of after.tests) {
    const beforeTest = beforeMap.get(afterTest.name);
    const beforeToolSummary = beforeTest?.transcript ? extractToolSummary(beforeTest.transcript) : {};
    const afterToolSummary = afterTest.transcript ? extractToolSummary(afterTest.transcript) : {};

    const beforeToolCount = Object.values(beforeToolSummary).reduce((a, b) => a + b, 0);
    const afterToolCount = Object.values(afterToolSummary).reduce((a, b) => a + b, 0);
    toolCountBefore += beforeToolCount;
    toolCountAfter += afterToolCount;

    let statusChange: TestDelta['status_change'] = 'unchanged';
    const beforeManual = beforeTest !== undefined && evalEntryOutcome(beforeTest) === 'manual-review';
    const afterOutcome = evalEntryOutcome(afterTest);
    const afterManual = afterOutcome === 'manual-review';
    if (beforeTest) {
      matched++;
      if (beforeManual && afterOutcome === 'failed') { statusChange = 'regressed'; regressed++; }
      else if (beforeManual || afterManual) { statusChange = 'manual-review'; manualReviewed++; }
      else if (evalEntryOutcome(beforeTest) === 'failed' && evalEntryOutcome(afterTest) === 'passed') { statusChange = 'improved'; improved++; }
      else if (evalEntryOutcome(beforeTest) === 'passed' && evalEntryOutcome(afterTest) === 'failed') { statusChange = 'regressed'; regressed++; }
      else { unchanged++; }
    } else {
      if (afterManual) { statusChange = 'manual-review'; manualReviewed++; }
      else unchanged++;
    }

    deltas.push({
      name: afterTest.name,
      before: {
        passed: beforeTest !== undefined && evalEntryOutcome(beforeTest) === 'passed',
        cost_usd: beforeTest?.cost_usd ?? 0,
        turns_used: beforeTest?.turns_used,
        duration_ms: beforeTest?.duration_ms,
        detection_rate: beforeTest?.detection_rate,
        tool_summary: beforeToolSummary,
        ...(beforeManual ? { manual_review: true } : {}),
      },
      after: {
        passed: afterOutcome === 'passed',
        cost_usd: afterTest.cost_usd,
        turns_used: afterTest.turns_used,
        duration_ms: afterTest.duration_ms,
        detection_rate: afterTest.detection_rate,
        tool_summary: afterToolSummary,
        ...(afterManual ? { manual_review: true } : {}),
      },
      status_change: statusChange,
    });

    beforeMap.delete(afterTest.name);
  }

  // Tests that were in before but not in after (removed tests)
  for (const [name, beforeTest] of beforeMap) {
    const beforeToolSummary = beforeTest.transcript ? extractToolSummary(beforeTest.transcript) : {};
    const beforeToolCount = Object.values(beforeToolSummary).reduce((a, b) => a + b, 0);
    toolCountBefore += beforeToolCount;
    unchanged++;
    deltas.push({
      name: `${name} (removed)`,
      before: {
        passed: evalEntryOutcome(beforeTest) === 'passed',
        cost_usd: beforeTest.cost_usd,
        turns_used: beforeTest.turns_used,
        duration_ms: beforeTest.duration_ms,
        detection_rate: beforeTest.detection_rate,
        tool_summary: beforeToolSummary,
        ...(evalEntryOutcome(beforeTest) === 'manual-review' ? { manual_review: true } : {}),
      },
      after: { passed: false, cost_usd: 0, tool_summary: {} },
      status_change: 'unchanged',
    });
  }

  return {
    before_file: beforeFile,
    after_file: afterFile,
    before_branch: before.branch,
    after_branch: after.branch,
    before_timestamp: before.timestamp,
    after_timestamp: after.timestamp,
    deltas,
    total_cost_delta: after.total_cost_usd - before.total_cost_usd,
    total_duration_delta: after.total_duration_ms - before.total_duration_ms,
    improved,
    regressed,
    unchanged,
    ...(manualReviewed ? { manual_reviewed: manualReviewed } : {}),
    tool_count_before: toolCountBefore,
    tool_count_after: toolCountAfter,
    matched,
  };
}

/**
 * Format a ComparisonResult as a readable string.
 */
export function formatComparison(c: ComparisonResult): string {
  const lines: string[] = [];
  const ts = c.before_timestamp ? c.before_timestamp.replace('T', ' ').slice(0, 16) : 'unknown';
  lines.push(`\nvs previous: ${c.before_branch}/${c.deltas.length ? 'eval' : ''} (${ts})`);
  lines.push('─'.repeat(70));

  // Per-test deltas
  for (const d of c.deltas) {
    const arrow = d.status_change === 'improved' ? '↑' : d.status_change === 'regressed' ? '↓' : '=';
    const beforeStatus = d.before.manual_review ? 'MANUAL' : d.before.passed ? 'PASS' : 'FAIL';
    const afterStatus = d.after.manual_review ? 'MANUAL' : d.after.passed ? 'PASS' : 'FAIL';

    // Turns delta
    let turnsDelta = '';
    if (d.before.turns_used !== undefined && d.after.turns_used !== undefined) {
      const td = d.after.turns_used - d.before.turns_used;
      turnsDelta = ` ${d.before.turns_used}→${d.after.turns_used}t`;
      if (td !== 0) turnsDelta += `(${td > 0 ? '+' : ''}${td})`;
    } else if (d.after.turns_used !== undefined) {
      turnsDelta = ` ${d.after.turns_used}t`;
    }

    // Duration delta
    let durDelta = '';
    if (d.before.duration_ms !== undefined && d.after.duration_ms !== undefined) {
      const bs = Math.round(d.before.duration_ms / 1000);
      const as = Math.round(d.after.duration_ms / 1000);
      const dd = as - bs;
      durDelta = ` ${bs}→${as}s`;
      if (dd !== 0) durDelta += `(${dd > 0 ? '+' : ''}${dd})`;
    } else if (d.after.duration_ms !== undefined) {
      durDelta = ` ${Math.round(d.after.duration_ms / 1000)}s`;
    }

    let detail = '';
    if (d.before.detection_rate !== undefined || d.after.detection_rate !== undefined) {
      detail = ` ${d.before.detection_rate ?? '?'}→${d.after.detection_rate ?? '?'} det`;
    } else {
      const costBefore = d.before.cost_usd.toFixed(2);
      const costAfter = d.after.cost_usd.toFixed(2);
      detail = ` $${costBefore}→$${costAfter}`;
    }

    const name = d.name.length > 30 ? d.name.slice(0, 27) + '...' : d.name.padEnd(30);
    lines.push(`  ${name}  ${beforeStatus.padEnd(5)} → ${afterStatus.padEnd(5)}  ${arrow}${detail}${turnsDelta}${durDelta}`);
  }

  lines.push('─'.repeat(70));

  // Totals
  const parts: string[] = [];
  if (c.improved > 0) parts.push(`${c.improved} improved`);
  if (c.regressed > 0) parts.push(`${c.regressed} regressed`);
  if (c.unchanged > 0) parts.push(`${c.unchanged} unchanged`);
  if (c.manual_reviewed) parts.push(`${c.manual_reviewed} unscored manual review`);
  lines.push(`  Status: ${parts.join(', ')}`);

  const costSign = c.total_cost_delta >= 0 ? '+' : '';
  lines.push(`  Cost:   ${costSign}$${c.total_cost_delta.toFixed(2)}`);

  const durDelta = Math.round(c.total_duration_delta / 1000);
  const durSign = durDelta >= 0 ? '+' : '';
  lines.push(`  Duration: ${durSign}${durDelta}s`);

  const toolDelta = c.tool_count_after - c.tool_count_before;
  const toolSign = toolDelta >= 0 ? '+' : '';
  lines.push(`  Tool calls: ${c.tool_count_before} → ${c.tool_count_after} (${toolSign}${toolDelta})`);

  // Tool breakdown (show tools that changed)
  const allTools = new Set<string>();
  for (const d of c.deltas) {
    for (const t of Object.keys(d.before.tool_summary || {})) allTools.add(t);
    for (const t of Object.keys(d.after.tool_summary || {})) allTools.add(t);
  }

  if (allTools.size > 0) {
    // Aggregate tool counts across all tests
    const totalBefore: Record<string, number> = {};
    const totalAfter: Record<string, number> = {};
    for (const d of c.deltas) {
      for (const [t, n] of Object.entries(d.before.tool_summary || {})) {
        totalBefore[t] = (totalBefore[t] || 0) + n;
      }
      for (const [t, n] of Object.entries(d.after.tool_summary || {})) {
        totalAfter[t] = (totalAfter[t] || 0) + n;
      }
    }

    for (const tool of [...allTools].sort()) {
      const b = totalBefore[tool] || 0;
      const a = totalAfter[tool] || 0;
      if (b !== a) {
        const d = a - b;
        lines.push(`    ${tool}: ${b} → ${a} (${d >= 0 ? '+' : ''}${d})`);
      }
    }
  }

  // Commentary — interpret what the deltas mean
  const commentary = generateCommentary(c);
  if (commentary.length > 0) {
    lines.push('');
    lines.push('  Takeaway:');
    for (const line of commentary) {
      lines.push(`    ${line}`);
    }
  }

  return lines.join('\n');
}

/**
 * Generate human-readable commentary interpreting comparison deltas.
 * Pure function — analyzes the numbers and explains what they mean.
 */
export function generateCommentary(c: ComparisonResult): string[] {
  const notes: string[] = [];

  // 1. Regressions are the most important signal — call them out first
  const regressions = c.deltas.filter(d => d.status_change === 'regressed');
  if (regressions.length > 0) {
    for (const d of regressions) {
      notes.push(d.before.manual_review
        ? `REGRESSION: "${d.name}" lost its unscored manual acceptance and now has a blocking failure. Investigate immediately.`
        : `REGRESSION: "${d.name}" was passing, now fails. Investigate immediately.`);
    }
  }

  // 2. Improvements
  const improvements = c.deltas.filter(d => d.status_change === 'improved');
  for (const d of improvements) {
    notes.push(`Fixed: "${d.name}" now passes.`);
  }

  for (const d of c.deltas.filter(delta => delta.status_change === 'manual-review')) {
    notes.push(`"${d.name}" includes an unscored manual acceptance; no model-score improvement or regression is inferred.`);
  }

  // 3. Per-test efficiency changes (only for unchanged-status tests — regressions/improvements are already noted)
  const stable = c.deltas.filter(d => d.status_change === 'unchanged' && d.after.passed);
  for (const d of stable) {
    const insights: string[] = [];

    // Turns
    if (d.before.turns_used !== undefined && d.after.turns_used !== undefined && d.before.turns_used > 0) {
      const turnsDelta = d.after.turns_used - d.before.turns_used;
      const turnsPct = Math.round((turnsDelta / d.before.turns_used) * 100);
      if (Math.abs(turnsPct) >= 20 && Math.abs(turnsDelta) >= 2) {
        if (turnsDelta < 0) {
          insights.push(`${Math.abs(turnsDelta)} fewer turns (${Math.abs(turnsPct)}% more efficient)`);
        } else {
          insights.push(`${turnsDelta} more turns (${turnsPct}% less efficient)`);
        }
      }
    }

    // Duration
    if (d.before.duration_ms !== undefined && d.after.duration_ms !== undefined && d.before.duration_ms > 0) {
      const durDelta = d.after.duration_ms - d.before.duration_ms;
      const durPct = Math.round((durDelta / d.before.duration_ms) * 100);
      if (Math.abs(durPct) >= 20 && Math.abs(durDelta) >= 5000) {
        if (durDelta < 0) {
          insights.push(`${Math.round(Math.abs(durDelta) / 1000)}s faster`);
        } else {
          insights.push(`${Math.round(durDelta / 1000)}s slower`);
        }
      }
    }

    // Detection rate
    if (d.before.detection_rate !== undefined && d.after.detection_rate !== undefined) {
      const detDelta = d.after.detection_rate - d.before.detection_rate;
      if (detDelta !== 0) {
        if (detDelta > 0) {
          insights.push(`detecting ${detDelta} more bug${detDelta > 1 ? 's' : ''}`);
        } else {
          insights.push(`detecting ${Math.abs(detDelta)} fewer bug${Math.abs(detDelta) > 1 ? 's' : ''} — check prompt quality`);
        }
      }
    }

    // Cost
    if (d.before.cost_usd > 0) {
      const costDelta = d.after.cost_usd - d.before.cost_usd;
      const costPct = Math.round((costDelta / d.before.cost_usd) * 100);
      if (Math.abs(costPct) >= 30 && Math.abs(costDelta) >= 0.05) {
        if (costDelta < 0) {
          insights.push(`${Math.abs(costPct)}% cheaper`);
        } else {
          insights.push(`${costPct}% more expensive`);
        }
      }
    }

    if (insights.length > 0) {
      notes.push(`"${d.name}": ${insights.join(', ')}.`);
    }
  }

  // 4. No baseline — say so. A run with nothing to compare against must never
  //    read as "stable"; silence or a false all-clear is worse than no output.
  if (c.matched === 0 && c.deltas.length > 0) {
    notes.push(
      `NO BASELINE: none of these ${c.deltas.length} test(s) appear in ${path.basename(c.before_file)}. ` +
      'Nothing was compared, so this run says nothing about regressions.',
    );
    return notes;
  }

  // 5. Overall summary
  if (c.deltas.length >= 3 && regressions.length === 0) {
    const overallParts: string[] = [];

    // Total cost
    const totalBefore = c.deltas.reduce((s, d) => s + d.before.cost_usd, 0);
    if (totalBefore > 0) {
      const costPct = Math.round((c.total_cost_delta / totalBefore) * 100);
      if (Math.abs(costPct) >= 10) {
        overallParts.push(`${Math.abs(costPct)}% ${costPct < 0 ? 'cheaper' : 'more expensive'} overall`);
      }
    }

    // Total duration
    const totalDurBefore = c.deltas.reduce((s, d) => s + (d.before.duration_ms || 0), 0);
    if (totalDurBefore > 0) {
      const durPct = Math.round((c.total_duration_delta / totalDurBefore) * 100);
      if (Math.abs(durPct) >= 10) {
        overallParts.push(`${Math.abs(durPct)}% ${durPct < 0 ? 'faster' : 'slower'}`);
      }
    }

    // Total turns
    const turnsBefore = c.deltas.reduce((s, d) => s + (d.before.turns_used || 0), 0);
    const turnsAfter = c.deltas.reduce((s, d) => s + (d.after.turns_used || 0), 0);
    if (turnsBefore > 0) {
      const turnsPct = Math.round(((turnsAfter - turnsBefore) / turnsBefore) * 100);
      if (Math.abs(turnsPct) >= 10) {
        overallParts.push(`${Math.abs(turnsPct)}% ${turnsPct < 0 ? 'fewer' : 'more'} turns`);
      }
    }

    if (overallParts.length > 0) {
      notes.push(`Overall: ${overallParts.join(', ')}. ${regressions.length === 0 ? 'No regressions.' : ''}`);
    } else if (regressions.length === 0) {
      notes.push('Stable run — no significant efficiency changes, no regressions.');
    }
  }

  return notes;
}

// --- Budget regression assertion ---

export interface BudgetRegression {
  testName: string;
  metric: 'tools' | 'turns';
  before: number;
  after: number;
  ratio: number;
}

/**
 * Compute budget regressions: tests where tool calls or turns grew by more
 * than `ratioCap` between two runs. Pure function — caller decides how to
 * surface the result. Used by test/skill-budget-regression.test.ts and any
 * future ship gate.
 *
 * `ratioCap` defaults to 2.0 (>2× growth is a regression). Override via
 * `GSTACK_BUDGET_RATIO` env var. New tests with no prior data are skipped.
 */
export function findBudgetRegressions(
  comparison: ComparisonResult,
  opts?: { ratioCap?: number; minPriorTools?: number; minPriorTurns?: number },
): BudgetRegression[] {
  const envRatio = Number(process.env.GSTACK_BUDGET_RATIO);
  const cap = opts?.ratioCap ?? (Number.isFinite(envRatio) && envRatio > 0 ? envRatio : 2.0);
  // Floors avoid noise on tiny numbers (1 → 3 tools is 3× but meaningless).
  const minPriorTools = opts?.minPriorTools ?? 5;
  const minPriorTurns = opts?.minPriorTurns ?? 3;
  const out: BudgetRegression[] = [];
  for (const d of comparison.deltas) {
    const beforeTools = Object.values(d.before.tool_summary ?? {}).reduce((a, b) => a + b, 0);
    const afterTools  = Object.values(d.after.tool_summary  ?? {}).reduce((a, b) => a + b, 0);
    const beforeTurns = d.before.turns_used ?? 0;
    const afterTurns  = d.after.turns_used  ?? 0;
    if (beforeTools >= minPriorTools && afterTools / beforeTools > cap) {
      out.push({ testName: d.name, metric: 'tools', before: beforeTools, after: afterTools, ratio: afterTools / beforeTools });
    }
    if (beforeTurns >= minPriorTurns && afterTurns / beforeTurns > cap) {
      out.push({ testName: d.name, metric: 'turns', before: beforeTurns, after: afterTurns, ratio: afterTurns / beforeTurns });
    }
  }
  return out;
}

/**
 * Throw if any test in the comparison exceeds the budget cap. Convenience
 * wrapper around findBudgetRegressions for use in test assertions.
 */
export function assertNoBudgetRegression(
  comparison: ComparisonResult,
  opts?: { ratioCap?: number; minPriorTools?: number; minPriorTurns?: number },
): void {
  const regressions = findBudgetRegressions(comparison, opts);
  if (regressions.length === 0) return;
  const cap = opts?.ratioCap ?? (Number(process.env.GSTACK_BUDGET_RATIO) || 2.0);
  const lines = regressions.map(
    r => `  "${r.testName}" ${r.metric}: ${r.before} → ${r.after} (${r.ratio.toFixed(2)}× > ${cap.toFixed(2)}× cap)`,
  );
  throw new Error(
    `Budget regression: ${regressions.length} test(s) exceeded ${cap.toFixed(2)}× prior usage:\n` +
    lines.join('\n') +
    `\n(Override per run: GSTACK_BUDGET_RATIO=<n>. ${comparison.before_file} vs ${comparison.after_file})`,
  );
}

// --- EvalCollector ---

function getGitInfo(): { branch: string; sha: string } {
  try {
    const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: 'pipe', timeout: 5000 });
    const sha = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { stdio: 'pipe', timeout: 5000 });
    return {
      branch: branch.stdout?.toString().trim() || 'unknown',
      sha: sha.stdout?.toString().trim() || 'unknown',
    };
  } catch {
    return { branch: 'unknown', sha: 'unknown' };
  }
}

function getVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

// Cached per process: savePartial runs after EVERY test and must not pay a
// CLI spawn each time. Three separate harness breakages were traced to
// claude-CLI TUI drift only after long flake hunts — stamping the version
// into every run record makes that correlation a grep instead of an
// archaeology dig.
//
// GSTACK_CLAUDE_CLI_VERSION short-circuits the spawn entirely: the paid
// runner's parent resolves the version once and passes it to every shard,
// so test processes never block on it. The fallback spawn is SYNCHRONOUS on
// the same thread that polls PTY sessions — the judgePtyState blocking
// class — so its budget is a tight 3s, not a generous one: a slow/hung CLI
// costs one bounded stall per process and records 'unknown'.
let claudeCliVersionCache: string | null = null;
export function getClaudeCliVersion(): string {
  if (claudeCliVersionCache !== null) return claudeCliVersionCache;
  const fromEnv = process.env.GSTACK_CLAUDE_CLI_VERSION;
  if (fromEnv) {
    claudeCliVersionCache = fromEnv;
    return claudeCliVersionCache;
  }
  try {
    const result = spawnSync('claude', ['--version'], { stdio: 'pipe', timeout: 3_000 });
    claudeCliVersionCache = result.stdout?.toString().split('\n')[0].trim() || 'unknown';
  } catch {
    claudeCliVersionCache = 'unknown';
  }
  return claudeCliVersionCache;
}

export class EvalCollector {
  private tier: 'e2e' | 'llm-judge';
  private tests: EvalTestEntry[] = [];
  private finalized = false;
  private evalDir: string;
  private shard: string | null;
  private fileNamespace?: string;
  private createdAt = Date.now();
  private pendingContract = new Map<string, string>();

  constructor(tier: 'e2e' | 'llm-judge', evalDir?: string, fileNamespace?: string) {
    if (fileNamespace !== undefined && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fileNamespace)) {
      throw new Error('Eval collector namespace must be a lowercase kebab-case slug');
    }
    this.tier = tier;
    this.evalDir = evalDir || process.env.GSTACK_EVAL_DIR || defaultEvalDir();
    this.shard = shardSlugOfEvalDir(this.evalDir);
    this.fileNamespace = fileNamespace;
  }

  addTest(entry: EvalTestEntry): void {
    // Same-name re-record = the test body ran again = bun retried it (test
    // names are unique by convention). Stamp the 1-based attempt so a
    // pass-on-attempt-2 stays visible forever — the stream hides it.
    const prior = this.tests.filter((t) => t.name === entry.name).length;
    const context = trialContextFromEnv();
    const record: EvalTestEntry = { ...(context ?? {}), ...entry, attempt: prior + 1 };
    const contract = this.pendingContract.get(entry.name);
    if (contract !== undefined) {
      this.pendingContract.delete(entry.name);
      Object.assign(record, { passed: false, failure_class: 'contract', error: record.error ?? contract });
    }
    this.tests.push(record);
    this.savePartial();
  }

  /** expectContract() hook: mark `name`'s latest record (or its next one) as a
   *  contract failure. An unmatched mark becomes its own failed record at
   *  finalize, so the veto is never lost. */
  markContractViolation(name: string, message: string): void {
    const existing = this.tests.filter((t) => t.name === name).at(-1);
    if (!existing) {
      this.pendingContract.set(name, message);
      return;
    }
    existing.passed = false;
    existing.failure_class = 'contract';
    existing.error = existing.error ?? message;
    this.savePartial();
  }

  /** Names recorded more than once this run, with their attempt counts. */
  private flakyRetries(): Array<{ name: string; attempts: number }> {
    const counts = new Map<string, number>();
    for (const t of this.tests) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
    return [...counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([name, attempts]) => ({ name, attempts }));
  }

  /** Write incremental results after each test. Atomic write, non-fatal. */
  savePartial(): void {
    try {
      const git = getGitInfo();
      const version = getVersion();
      const totalCost = this.tests.reduce((s, t) => s + t.cost_usd, 0);
      const totalDuration = this.tests.reduce((s, t) => s + t.duration_ms, 0);
      const passed = this.tests.filter(t => evalEntryOutcome(t) === 'passed').length;
      const manual = this.tests.filter(t => evalEntryOutcome(t) === 'manual-review').length;

      const partial: EvalResult = {
        schema_version: SCHEMA_VERSION,
        version,
        branch: git.branch,
        git_sha: git.sha,
        timestamp: new Date().toISOString(),
        hostname: os.hostname(),
        claude_cli_version: getClaudeCliVersion(),
        tier: this.tier,
        total_tests: this.tests.length,
        executed_tests: this.tests.filter(t => t.execution !== 'reused').length,
        reused_tests: this.tests.filter(t => t.execution === 'reused').length,
        ...(manual ? { manual_accepted_tests: manual } : {}),
        passed,
        failed: this.tests.length - passed - manual,
        total_cost_usd: Math.round(totalCost * 100) / 100,
        total_duration_ms: totalDuration,
        tests: this.tests,
        ...(this.shard ? { shard: this.shard } : {}),
        _partial: true,
      };

      fs.mkdirSync(this.evalDir, { recursive: true });
      const partialPath = path.join(this.evalDir, `_partial-e2e${this.fileNamespace ? `-${this.fileNamespace}` : ''}.json`);
      const tmp = partialPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(partial, null, 2) + '\n');
      fs.renameSync(tmp, partialPath);
    } catch { /* non-fatal — partial saves are best-effort */ }
  }

  async finalize(): Promise<string> {
    if (this.finalized) return '';
    this.finalized = true;
    for (const [name, message] of this.pendingContract) {
      this.tests.push({
        ...(trialContextFromEnv() ?? {}),
        name, suite: 'contract', tier: this.tier, passed: false, duration_ms: 0, cost_usd: 0,
        failure_class: 'contract', error: message, attempt: 1,
      });
    }
    this.pendingContract.clear();

    const git = getGitInfo();
    const version = getVersion();
    const timestamp = new Date().toISOString();
    const totalCost = this.tests.reduce((s, t) => s + t.cost_usd, 0);
    const totalDuration = this.tests.reduce((s, t) => s + t.duration_ms, 0);
    const passed = this.tests.filter(t => evalEntryOutcome(t) === 'passed').length;
    const manual = this.tests.filter(t => evalEntryOutcome(t) === 'manual-review').length;

    const flaky = this.flakyRetries();
    const result: EvalResult = {
      schema_version: SCHEMA_VERSION,
      version,
      branch: git.branch,
      git_sha: git.sha,
      timestamp,
      hostname: os.hostname(),
      claude_cli_version: getClaudeCliVersion(),
      tier: this.tier,
      total_tests: this.tests.length,
      executed_tests: this.tests.filter(t => t.execution !== 'reused').length,
      reused_tests: this.tests.filter(t => t.execution === 'reused').length,
      ...(manual ? { manual_accepted_tests: manual } : {}),
      passed,
      failed: this.tests.length - passed - manual,
      total_cost_usd: Math.round(totalCost * 100) / 100,
      total_duration_ms: totalDuration,
      wall_clock_ms: Date.now() - this.createdAt,
      tests: this.tests,
      ...(this.shard ? { shard: this.shard } : {}),
      ...(flaky.length > 0 ? { flaky_retries: flaky } : {}),
    };

    // Write eval file
    fs.mkdirSync(this.evalDir, { recursive: true });
    const dateStr = timestamp.replace(/[:.]/g, '').replace('T', '-').slice(0, 15);
    const safeBranch = git.branch.replace(/[^a-zA-Z0-9._-]/g, '-');
    // Keep the legacy stem first: eval:compare orders candidates by basename.
    const suffix = this.fileNamespace ? `--suite-${this.fileNamespace}` : '';
    const filename = `${version}-${safeBranch}-${this.tier}-${dateStr}${suffix}.json`;
    const filepath = path.join(this.evalDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(result, null, 2) + '\n');

    // Print summary table
    this.printSummary(result, filepath, git);

    // Auto-compare with previous run
    try {
      const prevFile = findPreviousRun(this.evalDir, this.tier, git.branch, filepath);
      if (prevFile) {
        const prevResult: EvalResult = JSON.parse(fs.readFileSync(prevFile, 'utf-8'));
        const comparison = compareEvalResults(prevResult, result, prevFile, filepath);
        process.stderr.write(formatComparison(comparison) + '\n');
      } else {
        process.stderr.write(
          `\nNO BASELINE: no completed prior ${this.tier} run found in ${this.evalDir}` +
          ' (the in-progress accumulator is not a baseline). Nothing compared —' +
          ' this run says nothing about regressions.\n',
        );
      }
    } catch (err: any) {
      process.stderr.write(`\nCompare error: ${err.message}\n`);
    }

    return filepath;
  }

  private printSummary(result: EvalResult, filepath: string, git: { branch: string; sha: string }): void {
    const lines: string[] = [];
    lines.push('');
    lines.push(`Eval Results — v${result.version} @ ${git.branch} (${git.sha}) — ${this.tier}`);
    lines.push('═'.repeat(70));

    for (const t of this.tests) {
      const outcome = evalEntryOutcome(t);
      const status = outcome === 'manual-review' ? 'MANUAL' : outcome === 'failed' ? ' FAIL '
        : t.execution === 'reused' ? ' REUSE' : ' PASS ';
      const cost = `$${t.cost_usd.toFixed(2)}`;
      const dur = t.duration_ms ? `${Math.round(t.duration_ms / 1000)}s` : '';
      const turns = t.turns_used !== undefined ? `${t.turns_used}t` : '';

      let detail = '';
      if (t.detection_rate !== undefined) {
        detail = `${t.detection_rate}/${(t.detected_bugs?.length || 0) + (t.missed_bugs?.length || 0)} det`;
      } else if (t.judge_scores) {
        const scores = Object.entries(t.judge_scores).map(([k, v]) => `${k[0]}:${v}`).join(' ');
        detail = scores;
      } else if (outcome === 'manual-review') {
        detail = `unscored; approved by ${t.manual_review!.approval.approved_by} (${t.manual_review!.approval.approval_url})`;
      }

      const name = t.name.length > 35 ? t.name.slice(0, 32) + '...' : t.name.padEnd(35);
      lines.push(`  ${name}  ${status}  ${cost.padStart(6)}  ${turns.padStart(4)}  ${dur.padStart(5)}  ${detail}`);
    }

    lines.push('─'.repeat(70));
    const totalCost = `$${result.total_cost_usd.toFixed(2)}`;
    const totalDur = `${Math.round(result.total_duration_ms / 1000)}s`;
    lines.push(`  Total: ${result.passed}/${result.total_tests} passed${' '.repeat(20)}${totalCost.padStart(6)}  ${totalDur}`);
    if (result.manual_accepted_tests) lines.push(`  Manual accepted: ${result.manual_accepted_tests} unscored provider refusal(s)`);
    lines.push(`  Evidence: ${result.executed_tests ?? result.total_tests} executed, ${result.reused_tests ?? 0} reused`);
    if (result.flaky_retries && result.flaky_retries.length > 0) {
      // Loud, never fatal: a flaky pass must not block anyone, but it must
      // never be silent either — that invisibility is how flakes calcified.
      lines.push(`  ⚠ FLAKY: ${result.flaky_retries.length} test(s) recorded multiple attempts this run: `
        + result.flaky_retries.map((f) => `${f.name} (x${f.attempts})`).join(', '));
    }
    lines.push(`Saved: ${filepath}`);

    process.stderr.write(lines.join('\n') + '\n');
  }
}
