/**
 * gate-cost — measurement-as-code for the paid PR gate's bill (GSTA-49 plan
 * lane T0; numbers in its MEASUREMENT.md). Pure logic: callers pass artifact
 * contents, changed-file lists and selector functions in; nothing here reads
 * files, runs git or calls GitHub. crew/scripts/gate-cost-replay.ts is the CLI.
 *
 * Four parts:
 *   1. Paid report artifacts -> per-case records, a gate's recorded cost by
 *      model and by token class (priced through lib/pricing.ts).
 *   2. A per-case mean cost table across several gates; a case with no
 *      recorded cost is estimated from its duration and marked estimated.
 *   3. Selection cost of one merged PR under today's selector, R4's shadow
 *      selection and the screening rule. The screening rule is labelled
 *      `screen-provisional` wherever it is printed: its preamble detector is
 *      a line-commonality heuristic, not T2's production hunk classifier.
 *   4. A seeded Monte Carlo of merge trains (every merged PR lands in a train;
 *      defects, outside flakes, bisects, requeues, one rebuild per
 *      unattributed red). It ports the measurement's sim.py and uses CPython's
 *      Mersenne Twister, so the same seed gives the same figures.
 */
import { pricingRow } from '../../lib/pricing';

export const SCREEN_LABEL = 'screen-provisional';
/** Anthropic bills 5-minute prompt-cache writes at 1.25x the model's input price (lib/pricing.ts excludes cache writes). */
export const CACHE_WRITE_INPUT_MULTIPLIER = 1.25;
export const TODAY_WEEKLY_USD = 9_950;
export const AFTER_GSTA48_WEEKLY_USD = 8_400;
/** Files that add the screening canary set (T2's full-gate list); package.json only when more than its version changed. */
export const SCREEN_FULL_GATE_FILES = [
  'setup', 'bun.lock', '.github/docker/Dockerfile.ci', '.github/workflows/evals.yml',
  'scripts/build.sh', 'scripts/gen-skill-docs.ts', 'package.json',
] as const;
/** The heuristic preamble detector runs only on diffs that change at least this many SKILL.md files. */
export const PREAMBLE_MIN_SKILL_FILES = 10;
/** A SKILL.md change counts as preamble-only when every changed line also changed in this share of the changed SKILL.md files. */
export const PREAMBLE_LINE_SHARE = 0.6;

// --- 1. Artifacts ---

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  thinkingTokens: number;
  costUSD: number;
}

export interface EvalTestRecord {
  shard: string;
  file: string | null;
  name: string;
  tier: string | null;
  model: string | null;
  costUsd: number;
  durationMs: number;
  /** Summed over every `result` event in the test's transcript. */
  modelUsage: Record<string, UsageTotals>;
}

export interface TrialRecord {
  caseId: string;
  file: string;
  kind: string;
  durationMs: number;
  runner: string | null;
}

export interface GateRecord {
  runId: string;
  tests: EvalTestRecord[];
  trials: TrialRecord[];
}

const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens', 'thinkingTokens', 'costUSD'] as const;
const emptyUsage = (): UsageTotals => ({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, thinkingTokens: 0, costUSD: 0 });
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** `skill-e2e-deploy--canary-workflow.t2` -> `test/skill-e2e-deploy.test.ts` (scripts/lib/paid-select.ts shardSlug, reversed). */
export function shardTestFile(shard: string): string | null {
  const base = shard.replace(/\.t\d+$/, '').split('--')[0];
  return base ? `test/${base}.test.ts` : null;
}

/** One eval JSON from a paid-slice shard directory; anything without a `tests` array yields no records. */
export function parseEvalReport(shard: string, report: unknown): EvalTestRecord[] {
  const tests = (report as { tests?: unknown } | null)?.tests;
  if (!Array.isArray(tests)) return [];
  return tests.filter((test): test is Record<string, unknown> => !!test && typeof test === 'object').map(test => {
    const modelUsage: Record<string, UsageTotals> = {};
    for (const event of Array.isArray(test.transcript) ? test.transcript : []) {
      if (event?.type !== 'result' || !event.modelUsage || typeof event.modelUsage !== 'object') continue;
      for (const [model, usage] of Object.entries(event.modelUsage as Record<string, Record<string, unknown>>)) {
        const totals = modelUsage[model] ??= emptyUsage();
        for (const key of USAGE_KEYS) totals[key] += num(usage?.[key]);
      }
    }
    return {
      shard, file: shardTestFile(shard), name: String(test.name ?? ''),
      tier: typeof test.tier === 'string' ? test.tier : null, model: typeof test.model === 'string' ? test.model : null,
      costUsd: num(test.cost_usd), durationMs: num(test.duration_ms), modelUsage,
    };
  });
}

/** trial-outcomes.jsonl; a torn or foreign line is skipped. */
export function parseTrialOutcomes(text: string): TrialRecord[] {
  const trials: TrialRecord[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row?.case !== 'string' || typeof row.file !== 'string') continue;
    const sessions = Array.isArray(row.sessions) ? row.sessions as Array<{ runner?: unknown }> : [];
    trials.push({
      caseId: row.case, file: row.file, kind: typeof row.kind === 'string' ? row.kind : 'rule',
      durationMs: num(row.duration_ms), runner: typeof sessions[0]?.runner === 'string' ? sessions[0].runner : null,
    });
  }
  return trials;
}

export interface TokenClass { tokens: number; usd: number }
export interface ModelTokenClasses {
  cacheWrite: TokenClass;
  output: TokenClass & { thinkingTokens: number };
  cacheRead: TokenClass;
  uncachedInput: TokenClass;
  pricedUsd: number;
  recordedUsd: number;
  priced: boolean;
}

export interface GateCostBreakdown {
  recordedUsd: number;
  /** modelUsage costUSD per model; a test's cost that modelUsage does not cover goes to its row model (judges: `llm-judge`). */
  byModel: Record<string, number>;
  tokenClasses: Record<string, ModelTokenClasses>;
}

/** Price one model's tokens with lib/pricing.ts; output tokens include thinking tokens. */
export function priceTokenClasses(model: string, usage: UsageTotals): ModelTokenClasses {
  const row = pricingRow(model);
  const input = row?.input_per_mtok ?? 0;
  const cls = (tokens: number, perMtok: number): TokenClass => ({ tokens, usd: tokens * perMtok / 1_000_000 });
  const cacheWrite = cls(usage.cacheCreationInputTokens, input * CACHE_WRITE_INPUT_MULTIPLIER);
  const output = { ...cls(usage.outputTokens, row?.output_per_mtok ?? 0), thinkingTokens: usage.thinkingTokens };
  const cacheRead = cls(usage.cacheReadInputTokens, row?.cached_input_per_mtok ?? input * 0.1);
  const uncachedInput = cls(usage.inputTokens, input);
  return { cacheWrite, output, cacheRead, uncachedInput, pricedUsd: cacheWrite.usd + output.usd + cacheRead.usd + uncachedInput.usd,
    recordedUsd: usage.costUSD, priced: row !== undefined };
}

export function gateCostBreakdown(gate: Pick<GateRecord, 'tests'>): GateCostBreakdown {
  const byModel: Record<string, number> = {};
  const usageByModel: Record<string, UsageTotals> = {};
  let recordedUsd = 0;
  for (const test of gate.tests) {
    recordedUsd += test.costUsd;
    let covered = 0;
    for (const [model, usage] of Object.entries(test.modelUsage)) {
      byModel[model] = (byModel[model] ?? 0) + usage.costUSD;
      covered += usage.costUSD;
      const totals = usageByModel[model] ??= emptyUsage();
      for (const key of USAGE_KEYS) totals[key] += usage[key];
    }
    const rest = test.costUsd - covered;
    if (Math.abs(rest) < 0.005) continue;
    const label = test.tier === 'llm-judge' ? 'llm-judge' : `${test.model ?? 'model not recorded'} (no modelUsage)`;
    byModel[label] = (byModel[label] ?? 0) + rest;
  }
  const tokenClasses = Object.fromEntries(Object.entries(usageByModel).map(([model, usage]) => [model, priceTokenClasses(model, usage)]));
  return { recordedUsd, byModel, tokenClasses };
}

export interface GateSummary {
  gates: number;
  recordedUsd: { mean: number; min: number; max: number };
  byModel: Record<string, number>;
  tokenClasses: Record<string, ModelTokenClasses>;
}

/** Mean over gates of each breakdown figure. */
export function summarizeGates(gates: Array<Pick<GateRecord, 'tests'>>): GateSummary {
  const breakdowns = gates.map(gateCostBreakdown);
  const n = Math.max(1, breakdowns.length);
  const totals = breakdowns.map(b => b.recordedUsd);
  const byModel: Record<string, number> = {};
  const tokenClasses: Record<string, ModelTokenClasses> = {};
  for (const b of breakdowns) {
    for (const [model, usd] of Object.entries(b.byModel)) byModel[model] = (byModel[model] ?? 0) + usd / n;
    for (const [model, c] of Object.entries(b.tokenClasses)) {
      const t = tokenClasses[model] ??= {
        cacheWrite: { tokens: 0, usd: 0 }, output: { tokens: 0, usd: 0, thinkingTokens: 0 }, cacheRead: { tokens: 0, usd: 0 },
        uncachedInput: { tokens: 0, usd: 0 }, pricedUsd: 0, recordedUsd: 0, priced: c.priced,
      };
      for (const key of ['cacheWrite', 'output', 'cacheRead', 'uncachedInput'] as const) {
        t[key].tokens += c[key].tokens / n;
        t[key].usd += c[key].usd / n;
      }
      t.output.thinkingTokens += c.output.thinkingTokens / n;
      t.pricedUsd += c.pricedUsd / n;
      t.recordedUsd += c.recordedUsd / n;
    }
  }
  return {
    gates: breakdowns.length,
    recordedUsd: totals.length ? { mean: totals.reduce((a, b) => a + b, 0) / n, min: Math.min(...totals), max: Math.max(...totals) } : { mean: 0, min: 0, max: 0 },
    byModel, tokenClasses,
  };
}

// --- 2. Per-case cost table ---

/**
 * Bind each trial outcome to the eval test entry that recorded its cost: an
 * unused entry named like the case first, else the unused entry of the same
 * test file nearest in duration (within 5 s or 10%). `null` = no recorded
 * cost (PTY sessions and the few runners that do not report one).
 */
export function recordedCaseCosts(gate: GateRecord): Array<{ trial: TrialRecord; costUsd: number | null }> {
  const used = new Set<number>();
  return gate.trials.map(trial => {
    const unused = gate.tests.map((test, index) => ({ test, index })).filter(({ index }) => !used.has(index));
    const named = unused.filter(({ test }) => test.name === trial.caseId);
    const pool = named.length ? named : unused.filter(({ test }) => test.file === trial.file);
    const best = pool.sort((a, b) => Math.abs(a.test.durationMs - trial.durationMs) - Math.abs(b.test.durationMs - trial.durationMs))[0];
    if (!best || (!named.length && Math.abs(best.test.durationMs - trial.durationMs) >= Math.max(5_000, 0.1 * trial.durationMs))) {
      return { trial, costUsd: null };
    }
    used.add(best.index);
    return { trial, costUsd: best.test.costUsd };
  });
}

export interface CaseCostEntry {
  caseId: string;
  file: string;
  kind: string;
  runner: string | null;
  costUsd: number;
  estimated: boolean;
  /** Gates that recorded a cost for the case (0 when estimated). */
  recordedGates: number;
  meanDurationMs: number;
}

export interface CaseCostTable {
  cases: Record<string, CaseCostEntry>;
  /** $ per session-second used for estimates: recorded cost over the duration of the trials that recorded a nonzero cost. */
  usdPerSecond: number;
}

export function caseCostTable(gates: GateRecord[], options: { usdPerSecond?: number } = {}): CaseCostTable {
  const seen = new Map<string, { trial: TrialRecord; costs: number[]; durations: number[] }>();
  let recordedUsd = 0, recordedMs = 0;
  for (const gate of gates) {
    for (const { trial, costUsd } of recordedCaseCosts(gate)) {
      const entry = seen.get(trial.caseId) ?? { trial, costs: [], durations: [] };
      seen.set(trial.caseId, entry);
      entry.durations.push(trial.durationMs);
      if (costUsd === null) continue;
      entry.costs.push(costUsd);
      if (costUsd > 0) { recordedUsd += costUsd; recordedMs += trial.durationMs; }
    }
  }
  const usdPerSecond = options.usdPerSecond ?? (recordedMs ? recordedUsd / (recordedMs / 1000) : 0);
  const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / Math.max(1, values.length);
  const cases: Record<string, CaseCostEntry> = {};
  for (const [caseId, { trial, costs, durations }] of seen) {
    const meanDurationMs = mean(durations);
    cases[caseId] = {
      caseId, file: trial.file, kind: trial.kind, runner: trial.runner, meanDurationMs, recordedGates: costs.length,
      estimated: costs.length === 0, costUsd: costs.length ? mean(costs) : meanDurationMs / 1000 * usdPerSecond,
    };
  }
  return { cases, usdPerSecond };
}

// --- 3. Selection cost of a merged PR ---

export interface PrDiff {
  pr: number;
  sha: string;
  files: string[];
  /** package.json differs from the parent only in `version` (scripts/test-pr-profile.ts packageChangeOnlyVersion). */
  packageVersionOnly: boolean;
  /** Distinct trimmed changed lines per SKILL.md file; read only when the diff changes PREAMBLE_MIN_SKILL_FILES or more. */
  skillMdChangedLines: Record<string, string[]>;
}

export interface TodaySelection {
  e2e: string[];
  judges: string[];
  /** R4's exercised-map shadow (PrProfileSelection.shadow.e2e); null when none was computed. */
  shadowE2e: string[] | null;
  mode: string;
}

export interface SelectionDeps {
  gateCases: readonly string[];
  judgeCases: readonly string[];
  /** Today's PR-profile selector (computePaidCaseSelection, profile pr). */
  today(files: string[], packageVersionOnly: boolean): TodaySelection;
  /** Declared touchfiles plus harness globals only (profile full); `global` = a harness global file changed. */
  touchfiles(files: string[]): { e2e: string[]; global: boolean };
}

export interface ScreenSelection {
  /** Gate cases the declared touchfiles and harness globals select (all of them when a global changed). */
  e2e: string[];
  global: boolean;
  canary: boolean;
  canaryReasons: string[];
  preambleOnly: string[];
}

export interface SelectorCost { cases: number; judges: number; usd: number }
export interface PrSelectionCost {
  pr: number;
  sha: string;
  files: number;
  mode: string;
  today: SelectorCost;
  shadow: SelectorCost;
  screenProvisional: SelectorCost & { canary: boolean; canaryReasons: string[]; preambleOnly: string[] };
}

/**
 * `git diff -U0` text -> distinct trimmed changed lines per file. Lines that
 * start with `++`, `+-`, `-+` or `--` (the file headers among them) are skipped,
 * as in the measurement's heuristic.
 */
export function changedLinesByFile(diff: string): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  let current: string | null = null;
  for (const line of diff.split('\n')) {
    const header = line.match(/^diff --git a\/.* b\/(.*)$/);
    if (header) { current = header[1]!; out[current] ??= new Set(); continue; }
    if (current && /^[+-][^+-]/.test(line)) out[current]!.add(line.trim());
  }
  return Object.fromEntries(Object.entries(out).map(([file, lines]) => [file, [...lines]]));
}

/** The line-commonality heuristic standing in for T2's hunk classifier (provisional). */
export function heuristicPreambleOnly(changed: Record<string, string[]>): string[] {
  const files = Object.keys(changed);
  if (files.length < PREAMBLE_MIN_SKILL_FILES) return [];
  const count = new Map<string, number>();
  for (const lines of Object.values(changed)) for (const line of new Set(lines)) count.set(line, (count.get(line) ?? 0) + 1);
  return files.filter(file => changed[file]!.every(line => (count.get(line) ?? 0) >= PREAMBLE_LINE_SHARE * files.length));
}

export const isSkillMd = (file: string) => /(^|\/)SKILL\.md$/.test(file);

function costOf(ids: Iterable<string>, table: CaseCostTable): number {
  let usd = 0;
  for (const id of ids) usd += table.cases[id]?.costUsd ?? 0;
  return usd;
}

export function fullGateUsd(deps: Pick<SelectionDeps, 'gateCases' | 'judgeCases'>, table: CaseCostTable): number {
  return costOf(deps.gateCases, table) + costOf(deps.judgeCases, table);
}

export const todaySelection = (diff: PrDiff, deps: SelectionDeps): TodaySelection =>
  (diff.files.length ? deps.today(diff.files, diff.packageVersionOnly) : { e2e: [], judges: [], shadowE2e: null, mode: 'none' });

/**
 * The screen-provisional rule: declared touchfiles and harness globals of the
 * files that are not heuristically preamble-only, every judge, and a canary
 * set when the diff has preamble-only SKILL.md files, a full-gate file, a
 * resolver, or files that reach cases only transitively. A package.json whose
 * only change is the version stamp is neither selected nor a canary trigger.
 */
export function screenSelection(diff: PrDiff, deps: SelectionDeps, today: TodaySelection): ScreenSelection {
  const gate = new Set(deps.gateCases);
  const stampOnly = (file: string) => file === 'package.json' && diff.packageVersionOnly;
  const preambleOnly = heuristicPreambleOnly(Object.fromEntries(Object.entries(diff.skillMdChangedLines).filter(([file]) => diff.files.includes(file))));
  const screenFiles = diff.files.filter(file => !preambleOnly.includes(file) && !stampOnly(file));
  const touch = screenFiles.length ? deps.touchfiles(screenFiles) : { e2e: [], global: false };
  const screenE2e = touch.e2e.filter(id => gate.has(id));
  const canaryReasons = [
    ...(preambleOnly.length ? [`${preambleOnly.length} preamble-only SKILL.md file(s) (heuristic)`] : []),
    ...diff.files.filter(file => (SCREEN_FULL_GATE_FILES as readonly string[]).includes(file) && !stampOnly(file)).map(file => `full-gate file ${file}`),
    ...diff.files.filter(file => file.startsWith('scripts/resolvers/')).map(file => `resolver ${file}`),
    ...(today.e2e.length > screenE2e.length ? ['transitive-only files (today selects more cases than declared touchfiles)'] : []),
  ];
  return { e2e: screenE2e, global: touch.global, canary: canaryReasons.length > 0, canaryReasons, preambleOnly };
}

export function prSelectionCost(diff: PrDiff, deps: SelectionDeps, table: CaseCostTable, options: { canaryUsd?: number } = {}): PrSelectionCost {
  const today = todaySelection(diff, deps);
  const shadowE2e = today.shadowE2e ?? today.e2e;
  const { e2e, global, canary, canaryReasons, preambleOnly } = screenSelection(diff, deps, today);
  const screenUsd = costOf(e2e, table) + (canary && !global ? options.canaryUsd ?? 12 : 0) + costOf(deps.judgeCases, table);
  return {
    pr: diff.pr, sha: diff.sha, files: diff.files.length, mode: today.mode,
    today: { cases: today.e2e.length, judges: today.judges.length, usd: costOf(today.e2e, table) + costOf(today.judges, table) },
    shadow: { cases: shadowE2e.length, judges: today.judges.length, usd: costOf(shadowE2e, table) + costOf(today.judges, table) },
    screenProvisional: { cases: e2e.length, judges: deps.judgeCases.length, usd: Math.min(screenUsd, fullGateUsd(deps, table)), canary, canaryReasons, preambleOnly },
  };
}

export interface SelectorSummary { meanUsd: number; medianUsd: number; meanCases: number; nearFull: number }

/** One cohort: every merged PR counts, zero-cost PRs included. The median is the upper middle value. */
export function summarizeSelector(rows: SelectorCost[], fullUsd: number): SelectorSummary {
  const usd = rows.map(row => row.usd).sort((a, b) => a - b);
  const n = Math.max(1, rows.length);
  return {
    meanUsd: usd.reduce((a, b) => a + b, 0) / n,
    medianUsd: usd[usd.length >> 1] ?? 0,
    meanCases: rows.reduce((sum, row) => sum + row.cases, 0) / n,
    nearFull: usd.filter(value => value >= 0.9 * fullUsd).length,
  };
}

// --- 4. Merge-train model ---

/** CPython's random.Random (MT19937 with init_by_array seeding, random(), shuffle(), sample()), so a seed reproduces sim.py. */
export class PyRandom {
  private readonly mt = new Uint32Array(624);
  private index = 624;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0) throw new Error('seed must be a non-negative safe integer');
    const key: number[] = [];
    for (let rest = seed; key.length === 0 || rest > 0; rest = Math.floor(rest / 2 ** 32)) key.push(rest % 2 ** 32);
    const mt = this.mt;
    mt[0] = 19650218;
    for (let i = 1; i < 624; i += 1) mt[i] = Math.imul(0x6c078965, mt[i - 1]! ^ (mt[i - 1]! >>> 30)) + i;
    let i = 1, j = 0;
    for (let k = Math.max(624, key.length); k > 0; k -= 1) {
      mt[i] = (mt[i]! ^ Math.imul(mt[i - 1]! ^ (mt[i - 1]! >>> 30), 0x0019660d)) + key[j]! + j;
      i += 1; j += 1;
      if (i >= 624) { mt[0] = mt[623]!; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = 623; k > 0; k -= 1) {
      mt[i] = (mt[i]! ^ Math.imul(mt[i - 1]! ^ (mt[i - 1]! >>> 30), 0x5d588b65)) - i;
      i += 1;
      if (i >= 624) { mt[0] = mt[623]!; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  private next32(): number {
    const mt = this.mt;
    if (this.index >= 624) {
      for (let k = 0; k < 624; k += 1) {
        const y = (mt[k]! & 0x80000000) | (mt[(k + 1) % 624]! & 0x7fffffff);
        mt[k] = mt[(k + 397) % 624]! ^ (y >>> 1) ^ (y & 1 ? 0x9908b0df : 0);
      }
      this.index = 0;
    }
    let y = mt[this.index++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  random(): number {
    const a = this.next32() >>> 5, b = this.next32() >>> 6;
    return (a * 67108864 + b) / 9007199254740992;
  }

  /** CPython's _randbelow: rejection sampling on n.bit_length() random bits. */
  private below(n: number): number {
    const bits = n.toString(2).length;
    let r = this.next32() >>> (32 - bits);
    while (r >= n) r = this.next32() >>> (32 - bits);
    return r;
  }

  shuffle<T>(items: T[]): void {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = this.below(i + 1);
      [items[i], items[j]] = [items[j]!, items[i]!];
    }
  }

  sample<T>(population: readonly T[], k: number): T[] {
    const n = population.length;
    if (!Number.isInteger(k) || k < 0 || k > n) throw new Error('sample larger than population or negative');
    const setsize = 21 + (k > 5 ? 4 ** Math.ceil(Math.log(k * 3) / Math.log(4)) : 0);
    const result: T[] = [];
    if (n <= setsize) {
      const pool = [...population];
      for (let i = 0; i < k; i += 1) {
        const j = this.below(n - i);
        result.push(pool[j]!);
        pool[j] = pool[n - i - 1]!;
      }
      return result;
    }
    const picked = new Set<number>();
    for (let i = 0; i < k; i += 1) {
      let j = this.below(n);
      while (picked.has(j)) j = this.below(n);
      picked.add(j);
      result.push(population[j]!);
    }
    return result;
  }
}

export type ScreenPolicy =
  | { kind: 'all' } | { kind: 'none' } | { kind: 'random'; fraction: number }
  | { kind: 'cheapest-half' } | { kind: 'expensive-half' };

export function policyLabel(policy: ScreenPolicy): string {
  return policy.kind === 'random' ? `random ${Math.round(policy.fraction * 100)}%` : policy.kind;
}

export interface TrainModelInput {
  /** Every merged PR of the window; `screenUsd` is its replayed screen cost on the recorded full-gate scale. */
  prs: Array<{ paidRelevant: boolean; screenUsd: number }>;
  policy: ScreenPolicy;
  windowDays: number;
  trainSize?: number;
  outsideRed?: number;
  redScreened?: number;
  redUnscreened?: number;
  fullGateUsd?: number;
  bisectUsd?: number;
  rescreenFactor?: number;
  reps?: number;
  seed?: number;
  todayWeeklyUsd?: number;
  afterGsta48WeeklyUsd?: number;
}

export interface TrainModelResult {
  policy: string;
  trainSize: number;
  outsideRed: number;
  weeklyUsd: number;
  perMergedPrUsd: number;
  multipleVsToday: number;
  multipleVsAfterGsta48: number;
  screenWeeklyUsd: number;
  initialTrainsWeekly: number;
  gateAttemptsWeekly: number;
  bisectsWeekly: number;
  rebuildOnceWeekly: number;
  stallsWeekly: number;
  firstCandidateRedShare: number;
  attemptRedShare: number;
}

/** Indexes of the PRs a policy screens: only paid-relevant PRs can screen; `random` draws from rnd. */
export function screenedIndexes(prs: ReadonlyArray<{ paidRelevant: boolean; screenUsd: number }>, policy: ScreenPolicy, rnd: PyRandom): Set<number> {
  const relevant = prs.map((pr, index) => ({ ...pr, index })).filter(pr => pr.paidRelevant);
  const byCost = [...relevant].sort((a, b) => a.screenUsd - b.screenUsd);
  const half = relevant.length >> 1;
  const chosen = policy.kind === 'all' ? relevant : policy.kind === 'none' ? []
    : policy.kind === 'random' ? rnd.sample(relevant, Math.floor(relevant.length * policy.fraction))
    : policy.kind === 'cheapest-half' ? byCost.slice(0, half) : byCost.slice(half);
  return new Set(chosen.map(pr => pr.index));
}

/**
 * Every merged PR lands in a train. Each paid-relevant PR carries a defect at
 * the screened or unscreened rate, and each gate attempt can also flake
 * (outside red). A red attempt pays a bisect. A defect is attributed to the
 * train's first defective PR, which is dropped, repaired and requeued at the
 * back; a red with no defect gets one unchanged rebuild, and a second such
 * red counts as a stall (and is rebuilt again).
 */
export function simulateTrains(input: TrainModelInput): TrainModelResult {
  const { prs, policy, windowDays } = input;
  const k = input.trainSize ?? 5, o = input.outsideRed ?? 0.15, rs = input.redScreened ?? 0.06, ru = input.redUnscreened ?? 0.25;
  const full = input.fullGateUsd ?? 93.14, bisect = input.bisectUsd ?? 6, rescreen = input.rescreenFactor ?? 1.3;
  const reps = input.reps ?? 400;
  const rnd = new PyRandom(input.seed ?? 1);
  const t = { screen: 0, gates: 0, init: 0, initRed: 0, attRed: 0, bisects: 0, rebuildOnce: 0, stalls: 0 };
  for (let rep = 0; rep < reps; rep += 1) {
    const screened = screenedIndexes(prs, policy, rnd);
    const queue = prs.map((pr, index) => {
      const s = screened.has(index);
      if (s) t.screen += pr.screenUsd * rescreen;
      return { defect: pr.paidRelevant && rnd.random() < (s ? rs : ru) };
    });
    rnd.shuffle(queue);
    while (queue.length) {
      let train = queue.splice(0, k);
      t.init += 1;
      let first = true, rebuilt = false;
      while (true) {
        t.gates += 1;
        const flake = rnd.random() < o;
        const bad = train.filter(item => item.defect);
        const red = flake || bad.length > 0;
        if (first && red) t.initRed += 1;
        first = false;
        if (!red) break;
        t.attRed += 1;
        t.bisects += 1;
        if (bad.length) {
          const culprit = bad[0]!;
          train = train.filter(item => item !== culprit);
          culprit.defect = false;
          queue.push(culprit);
          rebuilt = false;
          if (!train.length) break;
        } else if (!rebuilt) {
          rebuilt = true;
          t.rebuildOnce += 1;
        } else {
          t.stalls += 1;
          rebuilt = false;
        }
      }
    }
  }
  const perWeek = 7 / windowDays / reps;
  const weeklyUsd = (t.screen + t.gates * full + t.bisects * bisect) * perWeek;
  return {
    policy: policyLabel(policy), trainSize: k, outsideRed: o, weeklyUsd,
    perMergedPrUsd: weeklyUsd / (prs.length * 7 / windowDays),
    multipleVsToday: (input.todayWeeklyUsd ?? TODAY_WEEKLY_USD) / weeklyUsd,
    multipleVsAfterGsta48: (input.afterGsta48WeeklyUsd ?? AFTER_GSTA48_WEEKLY_USD) / weeklyUsd,
    screenWeeklyUsd: t.screen * perWeek, initialTrainsWeekly: t.init * perWeek, gateAttemptsWeekly: t.gates * perWeek,
    bisectsWeekly: t.bisects * perWeek, rebuildOnceWeekly: t.rebuildOnce * perWeek, stallsWeekly: t.stalls * perWeek,
    firstCandidateRedShare: t.init ? t.initRed / t.init : 0, attemptRedShare: t.gates ? t.attRed / t.gates : 0,
  };
}
