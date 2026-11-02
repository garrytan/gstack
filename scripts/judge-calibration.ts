#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * W2 judge calibration harness (comparison 1: schema transport, prose unchanged).
 *
 * For every corpus item of a request configuration it draws three independent
 * 3-sample panels: two with the current request ("old-a", "old-b") and one with
 * the schema-transport request ("new"). Each sample is one direct callJudge
 * call. Calibration never goes through judgePanel or the workflow passing-panel
 * cache: a replayed panel would make old-vs-old flips read zero.
 *
 * Each sample records a verdict-bearing value or an error kind (refusal,
 * truncation, parse, schema, transport), its latency and its priced usage.
 * Errors never count as verdicts; flip rates use items where both panels
 * completed (all three samples valid).
 *
 * Usage:
 *   bun run scripts/judge-calibration.ts manifest [--budget 90]
 *   bun run scripts/judge-calibration.ts run --config <id> --budget <usd> [--concurrency 6]
 *   bun run scripts/judge-calibration.ts resume --config <id> --budget <usd>   (only never-dispatched planned calls)
 *   bun run scripts/judge-calibration.ts analyze --config <id>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { callJudge, JudgeRefusalError, type CallJudgeOptions, type JudgeResponseMeta } from '../test/helpers/llm-judge';
import { JUDGE_MS } from '../test/helpers/eval-budgets';
import { estimateCostUsd } from '../test/helpers/pricing';

export const PANEL_SAMPLES = 3;
export const PHASES = ['old-a', 'old-b', 'new'] as const;
export type Phase = typeof PHASES[number];
export type Verdict = 'pass' | 'fail';
export type ErrorKind = 'refusal' | 'truncation' | 'parse' | 'schema' | 'transport';
export const LATENCY_CEILING_MS = 0.8 * JUDGE_MS;
export const CORPUS_ROOT = path.join(import.meta.dir, '..', 'test', 'fixtures', 'judge-calibration');

export interface CorpusItem {
  id: string;
  category: 'pass' | 'fail' | 'adjacent';
  expected: Verdict;
  split: 'dev' | 'heldout';
  rationale: string;
  inputs: Record<string, string>;
}

export interface CalibrationConfig {
  id: string;
  /** Dispatch order when the priced manifest exceeds the budget (armJudge, inline judges, workflow by case count). */
  priority: number;
  /** Eval cases that send this request configuration. */
  cases: string[];
  model: string;
  build(inputs: Record<string, string>): string;
  /** Today's request options. */
  oldOptions: CallJudgeOptions;
  /** Comparison (1): today's options plus the JSON schema; prose unchanged. */
  newOptions: CallJudgeOptions;
  /** Throws when production would reject the sample's shape. */
  validate(value: unknown): void;
  verdict(samples: unknown[]): Verdict;
  /** Manifest pricing estimate per call (output includes adaptive thinking). */
  estimatedOutputTokens: number;
}

export interface SampleRecord {
  config: string;
  item: string;
  split: CorpusItem['split'];
  phase: Phase;
  sample: number;
  status: 'ok' | 'error';
  error_kind?: ErrorKind;
  error?: string;
  value?: unknown;
  latency_ms: number;
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number } | null;
  cost_usd: number;
}

export type JudgeCall = (prompt: string, model: string, opts: CallJudgeOptions) => Promise<unknown>;

export function loadCorpus(configId: string, root = CORPUS_ROOT): CorpusItem[] {
  const dir = path.join(root, configId);
  const corpus = JSON.parse(fs.readFileSync(path.join(dir, 'corpus.json'), 'utf8'));
  return corpus.items.map((item: any) => ({
    ...item,
    inputs: Object.fromEntries(Object.entries(item.inputs as Record<string, string | { file: string }>).map(([key, value]) =>
      [key, typeof value === 'string' ? value : fs.readFileSync(path.join(dir, value.file), 'utf8')])),
  }));
}

export function classifyError(error: unknown): ErrorKind {
  if (error instanceof JudgeRefusalError) return 'refusal';
  const message = error instanceof Error ? error.message : String(error);
  if (/truncated at max_tokens|stop_reason=max_tokens/.test(message)) return 'truncation';
  if (error instanceof SyntaxError || /non-JSON|did not complete/.test(message)) return 'parse';
  return 'transport';
}

/** The fixed request identity: what must not move between dispatch and analysis. */
export function requestHash(config: CalibrationConfig, phase: Phase): string {
  const { onResponse: _ignored, signal: _signal, ...options } = phase === 'new' ? config.newOptions : config.oldOptions;
  return createHash('sha256').update(JSON.stringify({ model: config.model, options })).digest('hex');
}

export interface PlannedCall { item: CorpusItem; phase: Phase; sample: number }

/** Every paid call for one configuration, interleaved by a fixed seed so phases share time-of-day drift. */
export function planCalls(items: CorpusItem[], split: CorpusItem['split']): PlannedCall[] {
  const calls = items.filter(item => item.split === split)
    .flatMap(item => PHASES.flatMap(phase => Array.from({ length: PANEL_SAMPLES }, (_, sample) => ({ item, phase, sample }))));
  let seed = 0x5eed;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let i = calls.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [calls[i], calls[j]] = [calls[j]!, calls[i]!];
  }
  return calls;
}

/** Planned calls never dispatched (a budget or infrastructure stop); completing them is not a resample. */
export function undispatched(calls: PlannedCall[], records: SampleRecord[]): PlannedCall[] {
  const done = new Set(records.map(record => `${record.item}/${record.phase}/${record.sample}`));
  return calls.filter(call => !done.has(`${call.item.id}/${call.phase}/${call.sample}`));
}

export async function runSample(config: CalibrationConfig, planned: PlannedCall, call: JudgeCall = callJudge as JudgeCall,
  clock: () => number = () => performance.now()): Promise<SampleRecord> {
  let meta: JudgeResponseMeta | null = null;
  const options = { ...(planned.phase === 'new' ? config.newOptions : config.oldOptions), onResponse: (m: JudgeResponseMeta) => { meta = m; } };
  const base = { config: config.id, item: planned.item.id, split: planned.item.split, phase: planned.phase, sample: planned.sample };
  const started = clock();
  let value: unknown;
  let failure: { kind: ErrorKind; message: string } | null = null;
  try {
    value = await call(config.build(planned.item.inputs), config.model, options);
    try { config.validate(value); }
    catch (error) { failure = { kind: 'schema', message: error instanceof Error ? error.message : String(error) }; }
  } catch (error) {
    failure = { kind: classifyError(error), message: error instanceof Error ? error.message : String(error) };
  }
  const latency_ms = Math.round(clock() - started);
  const response = meta as JudgeResponseMeta | null;
  const usage = response?.usage ?? null;
  const cost_usd = usage ? estimateCostUsd({ input: usage.input_tokens, output: usage.output_tokens }, config.model) : 0;
  const shared = { latency_ms, stop_reason: response?.stop_reason ?? null, usage, cost_usd };
  return failure
    ? { ...base, status: 'error', error_kind: failure.kind, error: failure.message.slice(0, 500), ...shared }
    : { ...base, status: 'ok', value, ...shared };
}

export interface RunOptions {
  budgetUsd: number;
  concurrency?: number;
  call?: JudgeCall;
  clock?: () => number;
  onRecord?: (record: SampleRecord) => void;
}

/**
 * Dispatch planned calls with bounded concurrency. Stops dispatching when the
 * actual spend plus one in-flight estimate per open slot would pass the budget,
 * or after two consecutive transport failures (infrastructure, not a verdict).
 */
export async function runCalls(config: CalibrationConfig, calls: PlannedCall[], opts: RunOptions): Promise<{ records: SampleRecord[]; stopped: string | null }> {
  const records: SampleRecord[] = [];
  const perCall = estimateCostUsd({ input: 0, output: config.estimatedOutputTokens }, config.model);
  let spent = 0, next = 0, consecutiveTransport = 0, inFlight = 0;
  let stopped: string | null = null;
  const worker = async () => {
    while (!stopped && next < calls.length) {
      if (spent + (inFlight + 1) * perCall * 2 > opts.budgetUsd) { stopped = `budget: spent $${spent.toFixed(2)} of $${opts.budgetUsd.toFixed(2)}`; break; }
      const planned = calls[next++]!;
      inFlight++;
      const record = await runSample(config, planned, opts.call, opts.clock);
      inFlight--;
      spent += record.cost_usd;
      consecutiveTransport = record.error_kind === 'transport' ? consecutiveTransport + 1 : 0;
      records.push(record);
      opts.onRecord?.(record);
      if (consecutiveTransport >= 2) stopped = `infrastructure: two consecutive transport failures (${record.error})`;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 6) }, worker));
  return { records, stopped };
}

export interface PanelResult { verdict: Verdict | null; errors: number }

export function panels(config: CalibrationConfig, records: SampleRecord[]): Map<string, Record<Phase, PanelResult>> {
  const byItem = new Map<string, Record<Phase, PanelResult>>();
  for (const item of new Set(records.map(record => record.item))) {
    const entry = {} as Record<Phase, PanelResult>;
    for (const phase of PHASES) {
      const samples = records.filter(record => record.item === item && record.phase === phase);
      const ok = samples.filter(record => record.status === 'ok');
      entry[phase] = { verdict: ok.length === PANEL_SAMPLES && samples.length === PANEL_SAMPLES ? config.verdict(ok.map(record => record.value)) : null,
        errors: samples.length - ok.length };
    }
    byItem.set(item, entry);
  }
  return byItem;
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
}

export interface ComparisonSummary {
  items: number;
  old_flips: { flips: number; compared: number };
  new_flips: { flips: number; compared: number };
  agreement: Record<Phase, number>;
  false_passes: Record<Phase, string[]>;
  new_false_passes: string[];
}

export function compare(config: CalibrationConfig, items: CorpusItem[], records: SampleRecord[]): ComparisonSummary {
  const byItem = panels(config, records);
  const flips = (a: Phase, b: Phase) => {
    const both = items.map(item => byItem.get(item.id)).filter(entry => entry?.[a].verdict && entry[b].verdict);
    return { flips: both.filter(entry => entry![a].verdict !== entry![b].verdict).length, compared: both.length };
  };
  const agreement = Object.fromEntries(PHASES.map(phase =>
    [phase, items.filter(item => byItem.get(item.id)?.[phase].verdict === item.expected).length])) as Record<Phase, number>;
  const falsePasses = Object.fromEntries(PHASES.map(phase =>
    [phase, items.filter(item => item.expected === 'fail' && byItem.get(item.id)?.[phase].verdict === 'pass').map(item => item.id)])) as Record<Phase, string[]>;
  return { items: items.length, old_flips: flips('old-a', 'old-b'), new_flips: flips('new', 'old-a'), agreement,
    false_passes: falsePasses, new_false_passes: falsePasses.new.filter(id => !falsePasses['old-a'].includes(id)) };
}

export interface CalibrationResult {
  config: string;
  model: string;
  request_hash: Record<'old' | 'new', string>;
  complete: boolean;
  stopped: string | null;
  calls: number;
  cost_usd: number;
  errors: Record<'old' | 'new', Record<ErrorKind, number> & { samples: number; rate: number }>;
  latency_p95_ms: Record<'old' | 'new', number | null>;
  all: ComparisonSummary;
  heldout: ComparisonSummary;
  landing: { lands: boolean; reasons: string[]; strict_no_flip_increase: boolean };
  prose_step_triggered: { triggered: boolean; reasons: string[] };
}

export function analyze(config: CalibrationConfig, items: CorpusItem[], records: SampleRecord[], stopped: string | null = null): CalibrationResult {
  const prompt = (phase: Phase) => phase === 'new' ? 'new' : 'old';
  const errors = Object.fromEntries((['old', 'new'] as const).map(which => {
    const samples = records.filter(record => prompt(record.phase) === which);
    const counts = Object.fromEntries((['refusal', 'truncation', 'parse', 'schema', 'transport'] as const)
      .map(kind => [kind, samples.filter(record => record.error_kind === kind).length])) as Record<ErrorKind, number>;
    const errored = samples.filter(record => record.status === 'error').length;
    return [which, { ...counts, samples: samples.length, rate: samples.length ? errored / samples.length : 0 }];
  })) as CalibrationResult['errors'];
  const latency = Object.fromEntries((['old', 'new'] as const).map(which =>
    [which, p95(records.filter(record => prompt(record.phase) === which && record.status === 'ok').map(record => record.latency_ms))])) as CalibrationResult['latency_p95_ms'];
  const expectedCalls = items.length * PHASES.length * PANEL_SAMPLES;
  const complete = records.length === expectedCalls && !stopped;
  const all = compare(config, items, records);
  const heldout = compare(config, items.filter(item => item.split === 'heldout'), records);

  const reasons: string[] = [];
  if (!complete) reasons.push(`incomplete: ${records.length}/${expectedCalls} calls${stopped ? ` (${stopped})` : ''}`);
  if (all.new_flips.flips > all.old_flips.flips + 1) reasons.push(`new flips ${all.new_flips.flips}/${all.new_flips.compared} > old flips ${all.old_flips.flips}/${all.old_flips.compared} + 1`);
  if (all.agreement.new < all.agreement['old-a']) reasons.push(`expected-verdict agreement dropped: new ${all.agreement.new} < old ${all.agreement['old-a']}`);
  if (all.new_false_passes.length > 0) reasons.push(`new false passes: ${all.new_false_passes.join(', ')}`);
  if (latency.new !== null && latency.new > LATENCY_CEILING_MS) reasons.push(`new p95 latency ${latency.new} ms > ${LATENCY_CEILING_MS} ms (80% of JUDGE_MS)`);

  const trigger: string[] = [];
  if (records.some(record => record.phase === 'new' && record.status === 'error')) trigger.push('new prompt has errored samples');
  if (reasons.length > 0) trigger.push('a landing condition failed');
  if (all.old_flips.flips >= 3) trigger.push(`old-vs-old flips ${all.old_flips.flips} >= 3`);

  return {
    config: config.id, model: config.model,
    request_hash: { old: requestHash(config, 'old-a'), new: requestHash(config, 'new') },
    complete, stopped, calls: records.length,
    cost_usd: +records.reduce((sum, record) => sum + record.cost_usd, 0).toFixed(4),
    errors, latency_p95_ms: latency, all, heldout,
    landing: { lands: reasons.length === 0, reasons, strict_no_flip_increase: all.new_flips.flips <= all.old_flips.flips },
    prose_step_triggered: { triggered: trigger.length > 0, reasons: trigger },
  };
}

export interface ManifestEntry {
  config: string;
  priority: number;
  cases: number;
  model: string;
  items: number;
  calls: number;
  input_tokens: number;
  estimated_output_tokens_per_call: number;
  estimated_cost_usd: number;
}

/** Price every planned call before dispatch; count_tokens is free. */
export async function priceManifest(configs: CalibrationConfig[], countTokens: (model: string, prompt: string) => Promise<number>,
  root = CORPUS_ROOT): Promise<ManifestEntry[]> {
  const entries: ManifestEntry[] = [];
  for (const config of [...configs].sort((a, b) => a.priority - b.priority)) {
    if (!fs.existsSync(path.join(root, config.id, 'corpus.json'))) continue;
    const items = loadCorpus(config.id, root);
    let input = 0;
    for (const item of items) input += await countTokens(config.model, config.build(item.inputs)) * PHASES.length * PANEL_SAMPLES;
    const calls = items.length * PHASES.length * PANEL_SAMPLES;
    entries.push({ config: config.id, priority: config.priority, cases: config.cases.length, model: config.model, items: items.length, calls,
      input_tokens: input, estimated_output_tokens_per_call: config.estimatedOutputTokens,
      estimated_cost_usd: estimateCostUsd({ input, output: calls * config.estimatedOutputTokens }, config.model) });
  }
  return entries;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

/** The W2 per-judge table plus the arm benchmark's paired judge (run by --config only; the manifest prices the W2 table). */
export async function loadCalibrationConfigs(): Promise<{ w2: CalibrationConfig[]; all: CalibrationConfig[] }> {
  // The per-judge table (builders, schemas, verdict rules) is committed separately from this harness.
  const { CALIBRATION_CONFIGS } = await import(path.join(import.meta.dir, 'judge-calibration-configs.ts')) as { CALIBRATION_CONFIGS: CalibrationConfig[] };
  const { ARM_PAIR_CALIBRATION } = await import(path.join(import.meta.dir, '..', 'test', 'helpers', 'arm-pair-judge.ts')) as { ARM_PAIR_CALIBRATION: CalibrationConfig };
  return { w2: CALIBRATION_CONFIGS, all: [...CALIBRATION_CONFIGS, ARM_PAIR_CALIBRATION] };
}

async function main(args: string[]): Promise<void> {
  const { w2: CALIBRATION_CONFIGS, all: configs } = await loadCalibrationConfigs();
  const command = args[0];
  if (command === 'manifest') {
    const client = new Anthropic();
    const entries = await priceManifest(CALIBRATION_CONFIGS, async (model, prompt) =>
      (await client.messages.countTokens({ model, messages: [{ role: 'user', content: prompt }] })).input_tokens);
    const budget = Number(flag(args, 'budget') ?? 90);
    let running = 0;
    const manifest = { generated_at: new Date().toISOString(), budget_usd: budget,
      entries: entries.map(entry => ({ ...entry, cumulative_usd: +(running += entry.estimated_cost_usd).toFixed(4), within_budget: running <= budget })) };
    fs.writeFileSync(path.join(CORPUS_ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    console.table(manifest.entries);
    return;
  }
  const config = configs.find(candidate => candidate.id === flag(args, 'config'));
  if (!config) throw new Error(`unknown --config; expected one of ${configs.map(candidate => candidate.id).join(', ')}`);
  const items = loadCorpus(config.id);
  const runsDir = path.join(CORPUS_ROOT, config.id, 'runs');
  const samplesPath = path.join(runsDir, 'comparison-1.samples.jsonl');
  const resultPath = path.join(runsDir, 'comparison-1.result.json');
  if (command === 'run' || command === 'resume') {
    // resume dispatches only planned calls a stop left undispatched; recorded samples are never redrawn.
    if (command === 'run' && fs.existsSync(samplesPath)) throw new Error(`${samplesPath} exists; calibration runs are never repeated`);
    if (command === 'resume' && !fs.existsSync(samplesPath)) throw new Error(`${samplesPath} is missing; nothing to resume`);
    const prior: SampleRecord[] = command === 'resume' ? fs.readFileSync(samplesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    fs.mkdirSync(runsDir, { recursive: true });
    const budgetUsd = Number(flag(args, 'budget'));
    if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error('--budget <usd> is required');
    const concurrency = Number(flag(args, 'concurrency') ?? 6);
    const onRecord = (record: SampleRecord) => fs.appendFileSync(samplesPath, JSON.stringify(record) + '\n');
    let spent = 0, stopped: string | null = null;
    // Development items first; the held-out third is dispatched only after, with the same frozen requests.
    for (const split of ['dev', 'heldout'] as const) {
      const outcome = await runCalls(config, undispatched(planCalls(items, split), prior), { budgetUsd: budgetUsd - spent, concurrency, onRecord });
      spent += outcome.records.reduce((sum, record) => sum + record.cost_usd, 0);
      console.log(`[calibration] ${config.id} ${split}: ${outcome.records.length} calls, $${spent.toFixed(2)} cumulative${outcome.stopped ? `, stopped: ${outcome.stopped}` : ''}`);
      if ((stopped = outcome.stopped)) break;
    }
    fs.writeFileSync(path.join(runsDir, 'comparison-1.stop.json'), JSON.stringify({ stopped }) + '\n');
  } else if (command !== 'analyze') {
    throw new Error(`unknown command ${command}; expected manifest, run, resume or analyze`);
  }
  const records: SampleRecord[] = fs.readFileSync(samplesPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  const stopPath = path.join(runsDir, 'comparison-1.stop.json');
  const stopped = fs.existsSync(stopPath) ? JSON.parse(fs.readFileSync(stopPath, 'utf8')).stopped : null;
  const result = analyze(config, items, records, stopped);
  fs.writeFileSync(resultPath, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch(error => { console.error(error); process.exit(1); });
}
