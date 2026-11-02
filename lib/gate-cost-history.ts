/**
 * gate-cost-history — the two history replays of GSTA-49 plan lane T0 (P-i,
 * P-k, and the READY-to-merge guardrail in its Risks). Pure logic: the CLI
 * (`scripts/gate-cost-replay.ts --history`) passes run lists, report texts,
 * head signatures and selections in; nothing here runs git or calls GitHub.
 *
 *   1. Red attribution: each red PR-gate run's failed cases split into
 *      PR-caused and outside reds by GSTA-47's rule (`classifyReds`).
 *   2. Red-head replay: every PR-caused red case against the
 *      screen-provisional rule on the failing head's diff from its tested base,
 *      with the canary set below fixed before the replay first ran.
 *   3. READY arrivals: a READY time per merged PR from its check history, and
 *      a seeded replay of those arrivals through the train policy with the
 *      merge-train model's red and bisect rules.
 */
import { createHash } from 'node:crypto';
import { PyRandom, policyLabel, screenedIndexes, type ScreenPolicy, type ScreenSelection } from './gate-cost';

const HOUR_MS = 3_600_000;

// --- 1. Red attribution ---

export interface CaseFailure { caseId: string; kind: string }
export interface ReportVerdict { verdict: 'GREEN' | 'RED' | 'NONE'; failures: CaseFailure[] }

/** report-verdict's report.txt: the verdict line and each `✗ <id>  <kind>  <status>` line (judge ids contain single spaces; an unbound shard is named by its test file). */
export function parseReportVerdict(text: string): ReportVerdict {
  const verdict = /VERDICT (GREEN|RED)/.exec(text)?.[1] as 'GREEN' | 'RED' | undefined;
  const failures = [...text.matchAll(/^\s+✗ (\S(?:.*?\S)?) {2,}(\w+) +\S/gm)].map(m => ({ caseId: m[1]!, kind: m[2]! }));
  return { verdict: verdict ?? 'NONE', failures };
}

/** One PR-gate run that produced a report (GSTA-47's "gated" run); failures are the union over its attempts. */
export interface GatedRun { id: number; pr: number | null; head: string; createdAt: string; green: boolean; failures: CaseFailure[] }
/** A head's own diff: the files changed from its merge-base with main, and GSTA-47's stamp-free signature of that diff. */
export interface HeadDiff { ownSig: string; files: string[] }

export const STAMP_FILES = ['VERSION', 'CHANGELOG.md', 'agents-digest/gstack-AGENTS.md'] as const;

/**
 * GSTA-47's own-diff signature over `git diff -U0 <merge-base> <head> -- . ':(exclude)<stamp>'...`:
 * hunk headers, index lines and the package.json version line are dropped, so
 * a main merge or a restamp keeps the signature.
 */
export function stampFreeSignature(diffU0: string): string {
  let current = '';
  const blocks: string[][] = [];
  for (const line of diffU0.split('\n')) {
    if (line.startsWith('diff --git')) { current = line.split(' b/')[1] ?? ''; blocks.push([`F ${current}`]); continue; }
    if (!blocks.length || /^(index |@@|--- |\+\+\+ )/.test(line)) continue;
    if (current === 'package.json' && /^[-+]\s*"version":/.test(line)) continue;
    blocks[blocks.length - 1]!.push(line);
  }
  const kept = blocks.filter(block => block.length > 1 || !block[0]!.startsWith('F package.json')).flat();
  return createHash('sha256').update(kept.join('\n')).digest('hex').slice(0, 16);
}

/** A case red in another PR's run within this window is an outside red. */
export const RED_ELSEWHERE_WINDOW_MS = 72 * HOUR_MS;
/** Reds GSTA-47 set from transcripts: GSTA-45's own-edit reds on #3260, and the main defects fix wave 3 (#3260) diagnosed. */
export const DIAGNOSED_REDS = {
  prCaused: [39073934326, 39075977549, 39077524802],
  outside: [38973329985, 38986120559, 38990111230, 38993076767, 39002269281, 39004466422, 39011101113, 38980005793,
    39067746095, 39070632885, 39067885089, 39070276914, 39066860900, 39053431488],
} as const;

export type RedCause = 'pr' | 'outside' | 'unknown';
export interface CaseRed extends CaseFailure { cause: RedCause; reason: string }
export interface RedRun { runId: number; pr: number; head: string; createdAt: string; nextRunId: number | null; cause: RedCause; cases: CaseRed[] }

export interface ClassifyDeps {
  heads: ReadonlyMap<string, HeadDiff>;
  /** `git diff --name-only <from> <to>`; null when unreadable. */
  delta(from: string, to: string): string[] | null;
  /** The files among `files` that are inputs of the case (declared touchfiles, its test file, harness globals). */
  touches(caseId: string, files: string[]): string[];
}

/**
 * GSTA-47's attribution, per failed case of a red run, first match wins:
 * a transcript diagnosis; red in another PR within 72 h (outside); no later
 * gated run on the PR (unknown); the next gated run has the same own diff
 * (outside); the push to the next run changed one of the case's inputs among
 * either head's own files (PR-caused, whether or not the case then passed);
 * otherwise outside. A run is PR-caused when any case is, outside when every
 * case is (or none was named: infra or incomplete), unknown otherwise.
 */
export function classifyReds(runs: GatedRun[], deps: ClassifyDeps, diagnosed: { prCaused: readonly number[]; outside: readonly number[] } = DIAGNOSED_REDS): RedRun[] {
  const reds = runs.filter(run => !run.green);
  const index = reds.flatMap(run => run.failures.map(f => ({ caseId: f.caseId, pr: run.pr, t: Date.parse(run.createdAt) })));
  const out: RedRun[] = [];
  for (const run of reds) {
    if (run.pr === null) continue;
    const next = runs.filter(r => r.pr === run.pr && r.createdAt > run.createdAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
    const own = deps.heads.get(run.head), nextOwn = next ? deps.heads.get(next.head) : undefined;
    const t = Date.parse(run.createdAt);
    const cases: CaseRed[] = [];
    for (const failure of run.failures) {
      if (cases.some(c => c.caseId === failure.caseId)) continue;
      const elsewhere = [...new Set(index.filter(x => x.caseId === failure.caseId && x.pr !== run.pr && Math.abs(x.t - t) < RED_ELSEWHERE_WINDOW_MS).map(x => x.pr))];
      const verdict = ((): [RedCause, string] => {
        if (diagnosed.prCaused.includes(run.id)) return ['pr', 'diagnosed own edit (GSTA-45)'];
        if (diagnosed.outside.includes(run.id)) return ['outside', 'diagnosed main defect (fix wave 3)'];
        if (elsewhere.length) return ['outside', `also red in ${elsewhere.map(pr => (pr === null ? 'an unmapped run' : `#${pr}`)).join(', ')}`];
        if (!next) return ['unknown', 'no later gated run'];
        const passed = !next.failures.some(f => f.caseId === failure.caseId);
        if (!own || !nextOwn) return ['unknown', 'a head is not readable'];
        if (own.ownSig === nextOwn.ownSig) return ['outside', passed ? 'passed next with the same own diff' : 'still red with the same own diff'];
        const delta = deps.delta(run.head, next.head);
        if (!delta) return ['unknown', 'the push between runs is not readable'];
        const hit = deps.touches(failure.caseId, delta.filter(file => own.files.includes(file) || nextOwn.files.includes(file)));
        if (hit.length) return ['pr', `${passed ? 'fixed by own push' : 'own push touched its inputs, still red'}: ${hit.slice(0, 3).join(' ')}`];
        return ['outside', passed ? 'passed next after an unrelated push' : 'still red after an unrelated push'];
      })();
      cases.push({ ...failure, cause: verdict[0], reason: verdict[1] });
    }
    const cause: RedCause = cases.every(c => c.cause === 'outside') ? 'outside' : cases.some(c => c.cause === 'pr') ? 'pr' : 'unknown';
    out.push({ runId: run.id, pr: run.pr, head: run.head, createdAt: run.createdAt, nextRunId: next?.id ?? null, cause, cases });
  }
  return out;
}

// --- 2. Red-head replay ---

/**
 * T2's structural canary rule (PLAN.md rev 6: one case per preamble-dependent
 * surface), resolved to gate cases before this replay first ran and not
 * changed after: for each surface, the gate case with the shortest recorded
 * session time (run 39075977549) among the cases on that surface. No gate
 * case runs plan mode on the claude -p host, so that surface has none.
 * Provisional until T2's reviewed list in test/helpers/touchfiles-data.ts.
 */
export const SCREEN_CANARY_CASES: Readonly<Record<string, string>> = {
  'skill start, claude -p (skillmd-* cases)': 'skillmd-outside-git',
  'skill start, PTY (PTY cases outside plan mode)': 'office-hours-auto-mode',
  'plan mode, PTY (*-plan-mode and plan-mode-no-op)': 'plan-devex-review-plan-mode',
  'AskUserQuestion format': 'auq-format-gate',
  'bins every skill runs (cases declaring scripts/resolvers/preamble.ts)': 'operational-learning',
  'hermetic sentinels (1 of 2)': 'hermetic-canary',
  'hermetic sentinels (2 of 2)': 'hermetic-sentinel',
};

export const JUDGE_TEST_FILE = 'test/skill-llm-eval.test.ts';
export type ScreenHit = 'judge' | 'global' | 'touchfiles' | 'canary' | null;

/**
 * Would the screen select this failed case? Judges always run. A failure
 * named by its test file (an unbound shard) counts as selected when any
 * selected case lives in that file.
 */
export function screenHit(failure: CaseFailure, selection: ScreenSelection, caseFile: (caseId: string) => string | null,
  canaryCases: readonly string[] = Object.values(SCREEN_CANARY_CASES)): ScreenHit {
  if (failure.kind === 'judge' || caseFile(failure.caseId) === JUDGE_TEST_FILE) return 'judge';
  if (selection.global) return 'global';
  const byFile = /^test\/.+\.test\.ts$/.test(failure.caseId);
  const covers = (ids: readonly string[]) => (byFile ? ids.some(id => caseFile(id) === failure.caseId) : ids.includes(failure.caseId));
  if (covers(selection.e2e)) return 'touchfiles';
  return selection.canary && covers(canaryCases) ? 'canary' : null;
}

export interface RedHeadRow extends CaseFailure {
  pr: number;
  runId: number;
  head: string;
  base: string;
  /** `tested-merge`: the first parent of the run's tested merge commit; `main-at-run`: main's first-parent tip when the run was created. */
  baseSource: 'tested-merge' | 'main-at-run';
  files: number;
  hit: ScreenHit;
  canaryReasons: string[];
}

export interface RedHeadSummary {
  mergedPrs: number;
  paidRelevantPrs: number;
  /** Merged PRs with at least one PR-caused red run (P-k's numerator). */
  prsWithPrRed: number[];
  prCausedRuns: number;
  prCausedCases: number;
  /** Merged PRs with a PR-caused red case the screen would not select (P-i's numerator). */
  missedPrs: number[];
  missedCases: number;
  /** Misses if the canary set were empty, to show how much of the result the canary choice carries. */
  missedPrsWithoutCanary: number[];
  byHit: Record<string, number>;
  /** PR-caused red runs on PRs that did not merge in the window (not counted above). */
  otherPrCausedRuns: number;
}

export function summarizeRedHeads(rows: RedHeadRow[], redRuns: RedRun[], merged: Array<{ pr: number; paidRelevant: boolean }>): RedHeadSummary {
  const mergedSet = new Set(merged.map(m => m.pr));
  const inCohort = rows.filter(row => mergedSet.has(row.pr));
  const prRuns = redRuns.filter(run => run.cause === 'pr');
  const prsOf = (list: Array<{ pr: number }>) => [...new Set(list.map(row => row.pr))].sort((a, b) => a - b);
  const byHit: Record<string, number> = {};
  for (const row of inCohort) byHit[row.hit ?? 'missed'] = (byHit[row.hit ?? 'missed'] ?? 0) + 1;
  return {
    mergedPrs: merged.length,
    paidRelevantPrs: merged.filter(m => m.paidRelevant).length,
    prsWithPrRed: prsOf(prRuns.filter(run => mergedSet.has(run.pr))),
    prCausedRuns: prRuns.filter(run => mergedSet.has(run.pr)).length,
    prCausedCases: inCohort.length,
    missedPrs: prsOf(inCohort.filter(row => row.hit === null)),
    missedCases: inCohort.filter(row => row.hit === null).length,
    missedPrsWithoutCanary: prsOf(inCohort.filter(row => row.hit === null || row.hit === 'canary')),
    byHit,
    otherPrCausedRuns: prRuns.filter(run => !mergedSet.has(run.pr)).length,
  };
}

// --- 3. READY arrivals ---

export interface CheckRun { head: string; workflow: 'free' | 'evals'; createdAt: string; completedAt: string; conclusion: string | null }

/**
 * When each head's checks went green: its latest Free Tests run succeeded and
 * its latest E2E Evals run (if any) succeeded or was skipped; the time is the
 * later of the two completions (`updated_at`). Null: never green.
 */
export function headGreenAt(runs: CheckRun[]): Map<string, string | null> {
  const latest = new Map<string, Partial<Record<CheckRun['workflow'], CheckRun>>>();
  for (const run of runs) {
    const entry = latest.get(run.head) ?? {};
    latest.set(run.head, entry);
    if (!entry[run.workflow] || entry[run.workflow]!.createdAt < run.createdAt) entry[run.workflow] = run;
  }
  const out = new Map<string, string | null>();
  for (const [head, { free, evals }] of latest) {
    const green = free?.conclusion === 'success' && (!evals || ['success', 'skipped', 'neutral'].includes(evals.conclusion ?? ''));
    out.set(head, green ? [free!.completedAt, evals?.completedAt ?? ''].sort().pop()! : null);
  }
  return out;
}

export interface PrChecks {
  pr: number;
  mergedAt: string;
  finalHead: string;
  /** Every head that ran Free Tests or E2E Evals on the PR, with its own-diff signature (null: unreadable). */
  heads: Array<{ sha: string; ownSig: string | null }>;
  /** Creation times of the PR's gated E2E Evals runs. */
  gatedRuns: string[];
}

export type ReadySource = 'final-own-diff' | 'final-head' | 'none';
export interface ReadyRow { pr: number; mergedAt: string; ready: string | null; source: ReadySource; readyToMergeHours: number | null; gatesAfterReady: number }

/**
 * READY is approximated by the first time the PR's final own diff (its merged
 * changes modulo main merges and stamps) had green checks before the merge:
 * the earliest green time among heads with the final head's signature, which
 * is when an unstamped READY report could first be sent. Fallback: the final
 * head's own green time. A green time after the merge does not count.
 */
export function readyTimes(prs: PrChecks[], greenAt: ReadonlyMap<string, string | null>): ReadyRow[] {
  return prs.map(pr => {
    const finalSig = pr.heads.find(h => h.sha === pr.finalHead)?.ownSig ?? null;
    const before = (sha: string) => { const at = greenAt.get(sha) ?? null; return at !== null && at <= pr.mergedAt ? at : null; };
    const sameDiff = finalSig === null ? [] : pr.heads.filter(h => h.ownSig === finalSig).map(h => before(h.sha)).filter((at): at is string => at !== null).sort();
    const finalAt = before(pr.finalHead);
    const [ready, source]: [string | null, ReadySource] = sameDiff.length ? [sameDiff[0]!, 'final-own-diff'] : finalAt ? [finalAt, 'final-head'] : [null, 'none'];
    return {
      pr: pr.pr, mergedAt: pr.mergedAt, ready, source,
      readyToMergeHours: ready ? (Date.parse(pr.mergedAt) - Date.parse(ready)) / HOUR_MS : null,
      gatesAfterReady: ready ? pr.gatedRuns.filter(at => at > ready && at <= pr.mergedAt).length : 0,
    };
  });
}

/** Nearest-rank percentile; 0 for an empty list. */
export function percentile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

export interface LatencySummary { prs: number; p50Hours: number; p90Hours: number; meanHours: number }
export const latencySummary = (hours: number[]): LatencySummary => ({
  prs: hours.length, p50Hours: percentile(hours, 0.5), p90Hours: percentile(hours, 0.9),
  meanHours: hours.reduce((a, b) => a + b, 0) / Math.max(1, hours.length),
});

export interface ArrivalTrainInput {
  /** One per merged PR with a READY time; `screenUsd` orders the cheapest/expensive-half policies. */
  arrivals: Array<{ pr: number; readyMs: number; paidRelevant: boolean; screenUsd: number }>;
  policy: ScreenPolicy;
  windowDays: number;
  trainSize?: number;
  fillLimitHours?: number;
  gateMinutes?: number;
  bisectMinutes?: number;
  outsideRed?: number;
  redScreened?: number;
  redUnscreened?: number;
  reps?: number;
  seed?: number;
}

export interface ArrivalTrainResult {
  policy: string;
  outsideRed: number;
  trainsWeekly: number;
  meanOccupancy: number;
  fullTrainShare: number;
  /** Initial trains per repetition by size, index 0 = one PR. */
  occupancy: number[];
  gateAttemptsWeekly: number;
  bisectsWeekly: number;
  /** Gates again after a bisect dropped a defective PR. */
  attributedRebuildsWeekly: number;
  /** Garry's one unchanged rebuild after an unattributed red. */
  rebuildOnceWeekly: number;
  stallsWeekly: number;
  readyToMerge: LatencySummary;
}

interface Waiting { pr: number; readyMs: number; enqueuedMs: number; screened: boolean; defect: boolean }

/**
 * The next train, or null to keep waiting, as orderSlots and fillDue seat it:
 * screened PRs first, then unscreened PRs fill the remaining seats, each by
 * age; a full train dispatches at once, a smaller one once its oldest PR has
 * waited the fill limit.
 */
export function pickTrain<T extends { enqueuedMs: number; screened: boolean }>(pool: T[], nowMs: number, size: number, fillMs: number): T[] | null {
  const byAge = (a: T, b: T) => a.enqueuedMs - b.enqueuedMs;
  const mixed = [...pool.filter(x => x.screened).sort(byAge), ...pool.filter(x => !x.screened).sort(byAge)];
  if (mixed.length >= size) return mixed.slice(0, size);
  return mixed.length && nowMs - Math.min(...mixed.map(x => x.enqueuedMs)) >= fillMs ? mixed : null;
}

/**
 * Replay READY arrivals through trains, one train gating at a time (each
 * builds on the previous train's merge). Each paid-relevant PR carries a
 * defect at the screened or unscreened rate; each attempt flakes at the
 * outside-red rate; every attempt takes gateMinutes and every red adds a
 * bisect of bisectMinutes. A defect drops its PR, which rejoins the queue at
 * once (repair time is not modeled), and the rest gate again; an unattributed
 * red gets one unchanged rebuild, a second is a stall and gates again. PRs
 * with no paid case ride with the screened ones.
 */
export function simulateArrivalTrains(input: ArrivalTrainInput): ArrivalTrainResult {
  const k = input.trainSize ?? 5, fillMs = (input.fillLimitHours ?? 3) * HOUR_MS;
  const gateMs = (input.gateMinutes ?? 45) * 60_000, bisectMs = (input.bisectMinutes ?? 45) * 60_000;
  const o = input.outsideRed ?? 0.15, rs = input.redScreened ?? 0.06, ru = input.redUnscreened ?? 0.25, reps = input.reps ?? 200;
  const rnd = new PyRandom(input.seed ?? 1);
  const t = { trains: 0, full: 0, gates: 0, bisects: 0, attributed: 0, rebuildOnce: 0, stalls: 0 };
  const occupancy = Array.from({ length: k }, () => 0);
  const hours: number[] = [];
  for (let rep = 0; rep < reps; rep += 1) {
    const screened = screenedIndexes(input.arrivals, input.policy, rnd);
    const arrivals: Waiting[] = input.arrivals.map((a, i) => ({
      pr: a.pr, readyMs: a.readyMs, enqueuedMs: a.readyMs, screened: !a.paidRelevant || screened.has(i),
      defect: a.paidRelevant && rnd.random() < (screened.has(i) ? rs : ru),
    })).sort((a, b) => a.readyMs - b.readyMs);
    const pool: Waiting[] = [];
    let next = 0, freeAt = -Infinity;
    while (next < arrivals.length || pool.length) {
      let now = pool.length ? freeAt : Math.max(freeAt, arrivals[next]!.readyMs);
      let train: Waiting[] | null;
      while (true) {
        while (next < arrivals.length && arrivals[next]!.readyMs <= now) pool.push(arrivals[next++]!);
        train = pickTrain(pool, now, k, fillMs);
        if (train) break;
        now = Math.min(next < arrivals.length ? arrivals[next]!.readyMs : Infinity, Math.min(...pool.map(x => x.enqueuedMs)) + fillMs);
      }
      for (const item of train) pool.splice(pool.indexOf(item), 1);
      t.trains += 1;
      occupancy[train.length - 1]! += 1;
      if (train.length === k) t.full += 1;
      let rebuilt = false;
      while (train.length) {
        t.gates += 1;
        now += gateMs;
        const flake = rnd.random() < o;
        const bad: Waiting[] = train.filter(item => item.defect);
        if (!flake && !bad.length) { for (const item of train) hours.push((now - item.readyMs) / HOUR_MS); break; }
        t.bisects += 1;
        now += bisectMs;
        if (bad.length) {
          const culprit: Waiting = bad[0]!;
          train = train.filter(item => item !== culprit);
          Object.assign(culprit, { defect: false, enqueuedMs: now });
          pool.push(culprit);
          rebuilt = false;
          if (train.length) t.attributed += 1;
        } else if (!rebuilt) {
          rebuilt = true;
          t.rebuildOnce += 1;
        } else {
          t.stalls += 1;
          rebuilt = false;
        }
      }
      freeAt = now;
    }
  }
  const perWeek = 7 / input.windowDays / reps;
  return {
    policy: policyLabel(input.policy), outsideRed: o, trainsWeekly: t.trains * perWeek,
    meanOccupancy: occupancy.reduce((sum, n, i) => sum + n * (i + 1), 0) / Math.max(1, t.trains),
    fullTrainShare: t.trains ? t.full / t.trains : 0, occupancy: occupancy.map(n => n / reps),
    gateAttemptsWeekly: t.gates * perWeek, bisectsWeekly: t.bisects * perWeek, attributedRebuildsWeekly: t.attributed * perWeek,
    rebuildOnceWeekly: t.rebuildOnce * perWeek, stallsWeekly: t.stalls * perWeek, readyToMerge: latencySummary(hours),
  };
}

/** A run's PR: its pull_requests field, else the PR whose head branch it ran on while that PR was open (GSTA-47's mapping). */
export function prForRun(run: { branch: string; createdAt: string; prNumbers: number[] },
  pulls: Array<{ number: number; ref: string; createdAt: string; mergedAt: string | null; closedAt: string | null }>): number | null {
  if (run.prNumbers.length) return run.prNumbers[0]!;
  const open = pulls.filter(p => p.ref === run.branch && p.createdAt <= run.createdAt
    && run.createdAt <= new Date(Date.parse(p.mergedAt ?? p.closedAt ?? '9999-12-31') + HOUR_MS).toISOString());
  return open.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.number ?? null;
}
