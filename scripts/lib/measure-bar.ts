/**
 * The ship-measure measurement bar (approved by Garry 2026-10-06): one pure
 * decision over a case's diagnostic trials, shared by /ship's measure loop
 * (scripts/ship-measure.ts) and the weekly off-ship sweep
 * (scripts/ship-measure-sweep.ts). Nothing here runs a trial or reads a file.
 *
 * For N trials per batch (rule and judge N = 10; behavior N = 12, four panels
 * of 3; a judge trial is one output scored by its median 3-sample panel), the
 * counts round up from 9/10, 8/10 and 7/10 of N:
 *
 *   MEETS            passes >= 9/10 of N.
 *   MEETS-qualified  passes >= 8/10 of N and every failed trial is in a
 *                    qualifying class: provider (affirmative provider or
 *                    transport evidence only), judge-noise, or model-miss
 *                    citing its evidence (path:line).
 *   EXTEND           passes >= 7/10 of N without meeting either bar, and no red
 *                    has a known fixable cause: run N more trials on identical
 *                    inputs, then decide once on the pooled 2N (>= 9/10 strict,
 *                    >= 8/10 qualified). There is never a third batch.
 *   BELOW            everything else, and any red in a fix-round class
 *                    (timeout, hang, regression, fixable) or a contract
 *                    violation: a fix round.
 *
 * Before the counts: a batch where more than 30% of trials fail with
 * affirmative provider evidence is void (an outage, not a measurement) and may
 * be redispatched once; both batches are reported. A batch below strict whose
 * failed trials are not all classified returns needs-classify when the
 * classification decides the outcome (passes at or above the 7/10 floor).
 */

export type BarKind = 'rule' | 'behavior' | 'judge';
export type TrialSet = 'initial' | 'redispatch' | 'extend' | 'extend-redispatch';
export const QUALIFYING_CLASSES = ['provider', 'judge-noise', 'model-miss'] as const;
export const FIX_ROUND_CLASSES = ['timeout', 'hang', 'regression', 'fixable'] as const;
export const FAILURE_CLASSES = [...QUALIFYING_CLASSES, ...FIX_ROUND_CLASSES, 'unclassified'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

/** A batch is void when more than this share of its trials fail on affirmative provider evidence. */
export const VOID_SHARE = { num: 3, den: 10 } as const;

export interface BarTrial {
  trial: number;
  set: TrialSet;
  passed: boolean;
  contract?: boolean;
  /** Judge outputs: each sample's pass; the output passes at 2 of 3. */
  samples?: boolean[];
  failureCause?: string;
  failureDetail?: string;
  failureEvidence?: string;
}

export interface Classification { trial: number; class: FailureClass; evidence: string; by: 'machine' | 'agent'; at: string }

export type BarDecision = 'MEETS' | 'MEETS-qualified' | 'EXTEND' | 'BELOW' | 'needs-classify' | 'void' | 'incomplete';
export type BarNext = 'none' | 'redispatch' | 'extend' | 'classify' | 'fix' | 'stop';

export interface BarThresholds { trials: number; strict: number; qualified: number; floor: number }
export interface SetSummary { set: TrialSet; trials: number; passes: number; providerFailures: number; void: boolean }

export interface BarOutcome {
  decision: BarDecision;
  next: BarNext;
  passes: number;
  thresholds: BarThresholds;
  pooled: boolean;
  sets: SetSummary[];
  /** Failed counted trials that still need a class. */
  needsClassify: number[];
  reason: string;
}

const atLeast = (n: number, num: number) => Math.ceil((n * num) / 10);

/** Strict 9/10, qualified 8/10 and extend floor 7/10 of n, rounded up (10: 9/8/7; 12: 11/10/9; 20: 18/16/14; 24: 22/20/17). */
export function barThresholds(n: number): BarThresholds {
  return { trials: n, strict: atLeast(n, 9), qualified: atLeast(n, 8), floor: atLeast(n, 7) };
}

/** A trial's pass under the bar: a judge output at 2 of its 3 samples; a contract violation never passes. */
export function trialPassed(kind: BarKind, t: BarTrial): boolean {
  if (t.contract) return false;
  if (kind === 'judge' && t.samples) return t.samples.length === 3 && t.samples.filter(Boolean).length >= 2;
  return t.passed;
}

const PROVIDER_TEXT = /\b(?:429|5\d\d)\b|rate[ _-]?limit|overloaded|api_error|ECONNRESET|connection reset|socket hang up|ETIMEDOUT|EAI_AGAIN|service unavailable|bad gateway/i;
const TIMEOUT_CAUSES = new Set(['session_timeout', 'observer_timeout', 'provider_stall']);

/**
 * The affirmative provider or transport evidence for a failed trial, or null.
 * `api_error` is provider evidence by itself; `pre_turn_infra` only when its
 * evidence or detail names a 429/5xx, rate limit, overload or connection reset
 * (a crash or module-load failure is a harness defect, never an outage).
 */
export function providerEvidence(t: BarTrial): string | null {
  if (t.passed && !t.contract) return null;
  const text = [t.failureEvidence, t.failureDetail].filter(Boolean).join(' ');
  if (t.failureCause === 'api_error') return text || 'failure_cause api_error';
  if (t.failureCause === 'pre_turn_infra' && PROVIDER_TEXT.test(text)) return text;
  return null;
}

/** The class a failed trial gets without review: provider on affirmative evidence; timeout or hang from its cause. */
export function machineClass(t: BarTrial): FailureClass | null {
  if (providerEvidence(t)) return 'provider';
  if (t.failureCause === 'provider_stall') return 'hang';
  if (t.failureCause && TIMEOUT_CAUSES.has(t.failureCause)) return 'timeout';
  return null;
}

const CITATION = /[\w./-]+:\d+/;

/** Why an agent classification is refused, or null when it is accepted. */
export function classificationProblem(t: BarTrial | undefined, kind: BarKind, cls: string, evidence: string): string | null {
  if (!t) return 'no such trial in this measurement';
  if (trialPassed(kind, t)) return `trial ${t.trial} passed; only failed trials are classified`;
  if (!(FAILURE_CLASSES as readonly string[]).includes(cls)) return `class must be one of ${FAILURE_CLASSES.join(', ')}. Received: ${cls}`;
  if (!evidence.trim()) return 'every classification needs --evidence (what you read: a capture path:line, a failure line, a transcript line)';
  if (cls === 'provider' && !providerEvidence(t)) {
    return `provider needs affirmative provider or transport evidence (failure_cause api_error, or pre_turn_infra naming a 429/5xx, rate limit or connection reset); trial ${t.trial}'s failure_cause is ${t.failureCause ?? 'unrecorded'}`;
  }
  if ((QUALIFYING_CLASSES as readonly string[]).includes(cls) && t.failureCause && TIMEOUT_CAUSES.has(t.failureCause)) {
    return `trial ${t.trial} failed on ${t.failureCause}: a timeout or hang never qualifies; it goes to a fix round`;
  }
  return null;
}

/** Each failed trial's effective class: its latest agent record, else its machine class. */
export function effectiveClasses(trials: readonly BarTrial[], records: readonly Classification[]): Map<number, Classification> {
  const out = new Map<number, Classification>();
  for (const t of trials) {
    const cls = machineClass(t);
    if (cls) out.set(t.trial, { trial: t.trial, class: cls, evidence: providerEvidence(t) ?? t.failureCause ?? '', by: 'machine', at: '' });
  }
  for (const r of records) if (r.by === 'agent') out.set(r.trial, r);
  return out;
}

const qualifies = (c: Classification) => (QUALIFYING_CLASSES as readonly string[]).includes(c.class) && (c.class !== 'model-miss' || CITATION.test(c.evidence));
const fixRound = (c: Classification) => (FIX_ROUND_CLASSES as readonly string[]).includes(c.class);

function summarize(kind: BarKind, set: TrialSet, trials: BarTrial[]): SetSummary {
  const providerFailures = trials.filter(t => !trialPassed(kind, t) && providerEvidence(t)).length;
  return { set, trials: trials.length, passes: trials.filter(t => trialPassed(kind, t)).length, providerFailures,
    void: trials.length > 0 && providerFailures * VOID_SHARE.den > trials.length * VOID_SHARE.num };
}

/** The counted batch of a pair (first try, its one redispatch), or a void/incomplete stop. */
function countedBatch(n: number, first: SetSummary, retry: SetSummary, firstTrials: BarTrial[], retryTrials: BarTrial[], label: string):
  { trials: BarTrial[] } | { stop: Pick<BarOutcome, 'decision' | 'next' | 'reason'> } {
  const use = first.void ? retry : first;
  if (use.trials === 0) return { stop: { decision: 'void', next: 'redispatch', reason: `${label} batch is void: ${first.providerFailures} of ${first.trials} trials failed on provider evidence (> 30%); redispatch it once` } };
  if (use.void) return { stop: { decision: 'void', next: 'stop', reason: `${label} batch and its one redispatch are both void (provider evidence in ${first.providerFailures}/${first.trials} and ${retry.providerFailures}/${retry.trials}); stop with a named infrastructure red` } };
  if (use.trials < n) return { stop: { decision: 'incomplete', next: 'stop', reason: `${label} batch ran ${use.trials} of ${n} trials` } };
  return { trials: first.void ? retryTrials : firstTrials };
}

/**
 * The bar's decision over a measurement's trials and its classification
 * records (append-only; the latest agent record for a trial wins).
 */
export function decide(kind: BarKind, n: number, trials: readonly BarTrial[], records: readonly Classification[] = []): BarOutcome {
  const of = (set: TrialSet) => trials.filter(t => t.set === set);
  const sets = (['initial', 'redispatch', 'extend', 'extend-redispatch'] as const).map(set => summarize(kind, set, of(set)));
  const [initial, redispatch, extend, extendRedispatch] = sets as [SetSummary, SetSummary, SetSummary, SetSummary];
  const reported = sets.filter(s => s.trials > 0);
  const base = countedBatch(n, initial, redispatch, of('initial'), of('redispatch'), 'the first');
  const empty = { passes: 0, pooled: false, sets: reported, needsClassify: [] as number[] };
  if ('stop' in base) return { ...empty, thresholds: barThresholds(n), ...base.stop };
  const pooled = extend.trials > 0;
  const ext = pooled ? countedBatch(n, extend, extendRedispatch, of('extend'), of('extend-redispatch'), 'the extension') : { trials: [] };
  if ('stop' in ext) return { ...empty, pooled, thresholds: barThresholds(2 * n), ...ext.stop };
  const counted = [...base.trials, ...ext.trials];
  const thresholds = barThresholds(counted.length);
  const passes = counted.filter(t => trialPassed(kind, t)).length;
  const failed = counted.filter(t => !trialPassed(kind, t));
  const classes = effectiveClasses(failed, records);
  const result = (decision: BarDecision, next: BarNext, reason: string, needsClassify: number[] = []): BarOutcome =>
    ({ decision, next, passes, thresholds, pooled, sets: reported, needsClassify, reason });
  const count = `${passes}/${counted.length}${pooled ? ' pooled' : ''}`;
  const contract = failed.find(t => t.contract);
  if (contract) return result('BELOW', 'fix', `${count}; trial ${contract.trial} violated a contract: a fix round, whatever the count`);
  if (passes >= thresholds.strict) return result('MEETS', 'none', `${count} meets the strict bar (${thresholds.strict}/${counted.length})`);
  if (passes < (pooled ? thresholds.qualified : thresholds.floor)) {
    return result('BELOW', 'fix', `${count} is under the ${pooled ? `qualified pooled bar (${thresholds.qualified}/${counted.length})` : `extend floor (${thresholds.floor}/${counted.length})`}: a fix round`);
  }
  const unclassified = failed.filter(t => !classes.has(t.trial)).map(t => t.trial);
  if (unclassified.length) return result('needs-classify', 'classify', `${count} is below strict; classify trial(s) ${unclassified.map(t => `t${t}`).join(', ')}, then decide`, unclassified);
  const fix = failed.find(t => fixRound(classes.get(t.trial)!));
  if (fix) return result('BELOW', 'fix', `${count}; trial ${fix.trial} is ${classes.get(fix.trial)!.class}, which never qualifies: a fix round`);
  if (passes >= thresholds.qualified && failed.every(t => qualifies(classes.get(t.trial)!))) {
    return result('MEETS-qualified', 'none', `${count} meets the qualified bar (${thresholds.qualified}/${counted.length}); every red qualifies (${failed.map(t => `t${t.trial} ${classes.get(t.trial)!.class}`).join(', ')})`);
  }
  if (pooled) return result('BELOW', 'fix', `${count} does not meet the pooled bar (${thresholds.strict} strict, or ${thresholds.qualified} with every red qualifying); there is no third batch: a fix round`);
  return result('EXTEND', 'extend', `${count} is at or above the extend floor (${thresholds.floor}/${counted.length}) without meeting a bar: run ${n} more trials on identical inputs, then decide once on the pooled ${2 * n}`);
}

/** The first identity field that differs between two batches, or null when they may pool. */
export function identityMismatch(a: Record<string, string>, b: Record<string, string>): string | null {
  for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (a[key] !== b[key]) return `${key} changed (${a[key] ?? 'absent'} -> ${b[key] ?? 'absent'})`;
  }
  return null;
}
