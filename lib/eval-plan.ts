/**
 * eval-plan — the tier-1 machinery behind /eval-plan (plan E1): the
 * preregistration check, eval arms from the model policy (with the repo
 * policy-document fallback) priced from lib/pricing.ts, the `$0` stub-model
 * dry run over the real input file with its checklist, and the priced pilot
 * (n≈3) that reserves through lib/spend-ledger.ts, settles actual cost, and
 * extrapolates to the full run with an error band before the approval ask.
 * Admission is an estimate: the price table excludes billing categories
 * (lib/pricing.ts), so the spend table always shows `unknown` charges and the
 * worst-case overrun (one in-flight call per worker) beside `spent`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { modelsMain } from './model-policy-cli';
import { EXCLUDED_BILLING_CATEGORIES, estimateCostUsd, hasPricing, PRICING, pricingRow } from './pricing';
import type { ResultCodeName } from './result-codes';
import { readLedger, release, reserve, settle, SpendCapExceeded, summarize, type SpendLedger, type SpendSummary } from './spend-ledger';

// ---------------------------------------------------------------------------
// preregistration
// ---------------------------------------------------------------------------
export const PREREG_SECTIONS = ['Bars', 'Arms', 'Decoys', 'Stop rules', 'Held-out exposure'] as const;
export interface PreregCheck { ok: boolean; present: string[]; missing: string[]; empty: string[] }

export function preregTemplate(title = 'Eval preregistration'): string {
  return `# ${title}

## Bars
<!-- One line per metric: name, the pass bar, the direction, and what a miss means for the decision. -->

## Arms
<!-- One line per arm: model id (must be in lib/pricing.ts), settings, and the per-item cost from \`gstack-eval-plan arms\`. -->

## Decoys
<!-- Inputs the scorer must reject or score low; how many, how they were made, what a decoy pass proves. -->

## Stop rules
<!-- When the run stops early: the spend cap, a bar missed on the pilot, a scorer below its bar, budget_exhausted. -->

## Held-out exposure
<!-- Every held-out set this plan touches: | set | prior exposure (which runs, which models) | reservation (what this run may read) | -->
`;
}

export function checkPrereg(text: string): PreregCheck {
  const lines = text.split('\n');
  const headings = lines.map((l, i) => ({ i, m: /^#{1,6}\s+(.+?)\s*$/.exec(l) })).filter(x => x.m) as Array<{ i: number; m: RegExpExecArray }>;
  const present: string[] = []; const missing: string[] = []; const empty: string[] = [];
  for (const name of PREREG_SECTIONS) {
    const idx = headings.findIndex(h => h.m[1]!.toLowerCase().replace(/[^a-z]/g, '') === name.toLowerCase().replace(/[^a-z]/g, ''));
    if (idx < 0) { missing.push(name); continue; }
    const start = headings[idx]!.i + 1;
    const end = idx + 1 < headings.length ? headings[idx + 1]!.i : lines.length;
    const body = lines.slice(start, end).filter(l => l.trim() && !/^\s*<!--.*-->\s*$/.test(l));
    if (body.length === 0) empty.push(name); else present.push(name);
  }
  return { ok: missing.length === 0 && empty.length === 0, present, missing, empty };
}

// ---------------------------------------------------------------------------
// arms
// ---------------------------------------------------------------------------
export interface Arm { model: string; provider: string | null; source: string; priced: boolean; input_per_mtok: number | null; output_per_mtok: number | null; per_item_usd: number | null }
export interface ArmsResult { arms: Arm[]; source: string; errors: Array<{ code: ResultCodeName; message: string }> }
export interface TokenEstimate { input: number; output: number }
export const DEFAULT_TOKENS: TokenEstimate = { input: 4_000, output: 2_000 };
const POLICY_DOCS = ['docs/model-policy.md', 'MODEL_POLICY.md', 'docs/MODELS.md'];

function priceArm(model: string, source: string, provider: string | null, tokens: TokenEstimate): Arm {
  const row = pricingRow(model);
  return { model, provider, source, priced: !!row, input_per_mtok: row?.input_per_mtok ?? null, output_per_mtok: row?.output_per_mtok ?? null, per_item_usd: row ? estimateCostUsd(tokens, model) : null };
}

/** Models named in the repo's policy document that the price table knows. */
export function armsFromPolicyDoc(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const found = new Set<string>();
  for (const model of Object.keys(PRICING)) {
    const re = new RegExp(`(^|[^A-Za-z0-9._-])${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9._-])`, 'm');
    if (re.test(text)) found.add(model);
  }
  return [...found];
}

export interface ArmsOptions { cwd: string; explicit?: string[]; policyDoc?: string; tokens?: TokenEstimate; env?: NodeJS.ProcessEnv; modelsCli?: (args: string[]) => { code: number; stdout: string } }

/** `gstack-models resolve --role eval-arms --json`, else the repo policy doc, else `--arms`. Every arm carries its source. */
export function resolveArms(o: ArmsOptions): ArmsResult {
  const tokens = o.tokens ?? DEFAULT_TOKENS;
  const errors: ArmsResult['errors'] = [];
  if (o.explicit?.length) {
    const arms = o.explicit.map(m => priceArm(m, 'flag:--arms', null, tokens));
    for (const a of arms) if (!a.priced) errors.push({ code: 'EVAL_PRICE_MISSING', message: `${a.model} has no row in lib/pricing.ts` });
    return { arms, source: 'flag:--arms', errors };
  }
  const cli = o.modelsCli ?? ((args: string[]) => modelsMain(args, o.env ?? process.env, process.platform, o.cwd));
  const r = cli(['resolve', '--role', 'eval-arms', '--json']);
  if (r.code === 0) {
    try {
      const doc = JSON.parse(r.stdout) as { selections?: Array<{ provider?: string; requestedModel?: string | null; status?: string; tier?: string }> };
      const selected = (doc.selections ?? []).filter(s => s.status === 'selected' && s.requestedModel);
      if (selected.length) {
        const arms = selected.map(s => priceArm(s.requestedModel!, `policy:eval-arms/${s.tier ?? 'tier'}`, s.provider ?? null, tokens));
        for (const a of arms) if (!a.priced) errors.push({ code: 'EVAL_PRICE_MISSING', message: `${a.model} has no row in lib/pricing.ts` });
        return { arms, source: 'policy:eval-arms', errors };
      }
    } catch { /* fall through to the policy document */ }
  }
  const doc = o.policyDoc ?? POLICY_DOCS.map(p => path.join(o.cwd, p)).find(p => fs.existsSync(p));
  if (doc && fs.existsSync(doc)) {
    const models = armsFromPolicyDoc(doc);
    if (models.length) return { arms: models.map(m => priceArm(m, `policy-doc:${path.relative(o.cwd, doc) || doc}`, null, tokens)), source: `policy-doc:${path.relative(o.cwd, doc) || doc}`, errors };
    errors.push({ code: 'EVAL_ARMS_UNRESOLVED', message: `${doc} names no model in the price table` });
  } else errors.push({ code: 'EVAL_ARMS_UNRESOLVED', message: `model policy returned no arm and no policy document found (${POLICY_DOCS.join(', ')})` });
  return { arms: [], source: 'none', errors };
}

export function renderArms(r: ArmsResult, tokens: TokenEstimate): string {
  const lines = r.arms.map(a => `ARM: ${a.model} provider=${a.provider ?? 'unknown'} source=${a.source} price=${a.priced ? `${a.input_per_mtok}/${a.output_per_mtok} per MTok` : 'MISSING'} per_item=${a.per_item_usd === null ? 'unknown' : `$${a.per_item_usd.toFixed(4)}`} (${tokens.input} in / ${tokens.output} out tokens)`);
  lines.push(`ARMS: n=${r.arms.length} priced=${r.arms.filter(a => a.priced).length} source=${r.source}`);
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// $0 stub-model dry run
// ---------------------------------------------------------------------------
/** Reasoning models spend output tokens on thinking; a budget under this truncates the answer the scorer reads. */
export const REASONING_OUTPUT_FLOOR = 8_192;
export interface DryRunRow { line: number; ok: boolean; missing: string[]; input_tokens: number }
export interface DryRunResult {
  schema_version: 1; input: string; rows: number; bad_rows: DryRunRow[]; est_input_tokens: number; est_output_tokens: number;
  arms: string[]; checks: { price_table: { ok: boolean; missing: string[] }; output_budget: { ok: boolean; budget: number; floor: number }; retry_prompt: { ok: boolean; text: string | null } };
  per_item_usd: Record<string, number | null>; excluded_billing: readonly string[]; pass: boolean; stub: 'stub-model (no network, $0)';
}
export interface DryRunOptions { input: string; arms: string[]; fields?: string[]; outputBudget?: number; retryPrompt?: string; maxRows?: number }

/** Four bytes per token, the estimator every gstack admission uses. */
export const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);

export function dryRun(o: DryRunOptions): DryRunResult {
  const fields = o.fields?.length ? o.fields : ['prompt'];
  const budget = o.outputBudget ?? REASONING_OUTPUT_FLOOR;
  const text = fs.readFileSync(o.input, 'utf8');
  const lines = text.split('\n');
  const bad: DryRunRow[] = []; let rows = 0; let inputTokens = 0;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    if (o.maxRows && rows >= o.maxRows) return;
    rows += 1;
    let parsed: Record<string, unknown> | null = null;
    try { const v = JSON.parse(line); parsed = v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { parsed = null; }
    if (!parsed) { bad.push({ line: i + 1, ok: false, missing: ['<not a JSON object>'], input_tokens: 0 }); return; }
    const missing = fields.filter(f => parsed![f] === undefined || parsed![f] === null || parsed![f] === '');
    const t = estimateTokens(fields.map(f => typeof parsed![f] === 'string' ? parsed![f] as string : JSON.stringify(parsed![f] ?? '')).join('\n'));
    inputTokens += t;
    if (missing.length) bad.push({ line: i + 1, ok: false, missing, input_tokens: t });
  });
  const retryText = o.retryPrompt && fs.existsSync(o.retryPrompt) ? fs.readFileSync(o.retryPrompt, 'utf8').trim() : null;
  const missingPrice = o.arms.filter(a => !hasPricing(a));
  const perItem: Record<string, number | null> = {};
  const avgIn = rows ? Math.ceil(inputTokens / rows) : 0;
  for (const a of o.arms) perItem[a] = hasPricing(a) ? estimateCostUsd({ input: avgIn, output: budget }, a) : null;
  const checks = {
    price_table: { ok: missingPrice.length === 0 && o.arms.length > 0, missing: missingPrice },
    output_budget: { ok: budget >= REASONING_OUTPUT_FLOOR, budget, floor: REASONING_OUTPUT_FLOOR },
    retry_prompt: { ok: !!retryText, text: retryText },
  };
  return {
    schema_version: 1, input: o.input, rows, bad_rows: bad, est_input_tokens: inputTokens, est_output_tokens: rows * budget, arms: o.arms, checks, per_item_usd: perItem,
    excluded_billing: EXCLUDED_BILLING_CATEGORIES, pass: rows > 0 && bad.length === 0 && checks.price_table.ok && checks.output_budget.ok && checks.retry_prompt.ok, stub: 'stub-model (no network, $0)',
  };
}

export function renderDryRun(r: DryRunResult): string {
  const lines = [
    `DRY_RUN: ${r.stub} input=${r.input} rows=${r.rows} bad_rows=${r.bad_rows.length} est_input_tokens=${r.est_input_tokens} est_output_tokens=${r.est_output_tokens}`,
    ...r.bad_rows.slice(0, 20).map(b => `DRY_RUN_ROW: line ${b.line} missing=${b.missing.join(',')}`),
    `CHECK: price-table ${r.checks.price_table.ok ? 'ok' : `missing ${r.checks.price_table.missing.join(',') || '(no arms)'}`}`,
    `CHECK: output-budget ${r.checks.output_budget.ok ? 'ok' : 'too small'} (${r.checks.output_budget.budget} tokens; reasoning floor ${r.checks.output_budget.floor})`,
    `CHECK: retry-prompt ${r.checks.retry_prompt.ok ? `ok — ${JSON.stringify(r.checks.retry_prompt.text)}` : 'missing (pass --retry-prompt <file> with the exact text the run will send)'}`,
    ...Object.entries(r.per_item_usd).map(([m, usd]) => `ESTIMATE: ${m} per_item=${usd === null ? 'unknown (no price)' : `$${usd.toFixed(4)}`} (estimate: excludes ${r.excluded_billing.length} billing categories, see lib/pricing.ts)`),
    `DRY_RUN_RESULT: ${r.pass ? 'pass' : 'fail'}`,
  ];
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// priced pilot over lib/spend-ledger.ts
// ---------------------------------------------------------------------------
export const PILOT_FILES = { spend: 'spend.json', pilot: 'pilot.json' } as const;
export interface PilotAttempt { attempt: string; model: string; row: number; estimate_usd: number }
export interface PilotRecord { schema_version: 1; n: number; arms: string[]; cap_usd: number; dry_run: string; attempts: PilotAttempt[]; started_at: string; status: 'reserved' | 'budget_exhausted' }
export interface PilotStartOptions { out: string; cap: number; n: number; arms: string[]; dryRun: string; tokens?: TokenEstimate; now?: Date }

/** Reserve n attempts per arm under the cap; a refused reservation ends the pilot `budget_exhausted` with nothing else reserved. */
export function startPilot(o: PilotStartOptions): { record: PilotRecord; error?: { code: ResultCodeName; message: string } } {
  const dry = JSON.parse(fs.readFileSync(o.dryRun, 'utf8')) as DryRunResult;
  if (!dry.pass) return { record: null as unknown as PilotRecord, error: { code: 'EVAL_DRY_RUN_FAILED', message: `${o.dryRun} did not pass; the pilot never starts on a failed dry run` } };
  const tokens = o.tokens ?? { input: dry.rows ? Math.ceil(dry.est_input_tokens / dry.rows) : DEFAULT_TOKENS.input, output: dry.checks.output_budget.budget };
  fs.mkdirSync(o.out, { recursive: true });
  const ledgerFile = path.join(o.out, PILOT_FILES.spend);
  const record: PilotRecord = { schema_version: 1, n: o.n, arms: o.arms, cap_usd: o.cap, dry_run: o.dryRun, attempts: [], started_at: (o.now ?? new Date()).toISOString(), status: 'reserved' };
  let error: { code: ResultCodeName; message: string } | undefined;
  outer: for (const model of o.arms) {
    if (!hasPricing(model)) { error = { code: 'EVAL_PRICE_MISSING', message: `${model} has no row in lib/pricing.ts` }; break; }
    for (let i = 1; i <= o.n; i++) {
      const estimate = estimateCostUsd(tokens, model);
      const attempt = `pilot-${model.replace(/[^A-Za-z0-9.-]/g, '_')}-${i}`;
      try { reserve(ledgerFile, attempt, estimate, { cap: o.cap, label: `pilot ${model} #${i}`, now: o.now }); }
      catch (e) {
        if (e instanceof SpendCapExceeded) { record.status = 'budget_exhausted'; error = { code: 'EVAL_BUDGET_EXHAUSTED', message: e.message }; break outer; }
        throw e;
      }
      record.attempts.push({ attempt, model, row: i, estimate_usd: estimate });
    }
  }
  fs.writeFileSync(path.join(o.out, PILOT_FILES.pilot), JSON.stringify(record, null, 2) + '\n');
  return { record, error };
}

export function settlePilot(out: string, attempt: string, usd: number | 'unknown'): SpendLedger {
  return settle(path.join(out, PILOT_FILES.spend), attempt, usd);
}
export function releasePilot(out: string, attempt: string): SpendLedger {
  return release(path.join(out, PILOT_FILES.spend), attempt);
}

/** Two-sided 95% Student t for n-1 degrees of freedom (n settled items); 2.0 past the table. */
const T95: Record<number, number> = { 2: 12.706, 3: 4.303, 4: 3.182, 5: 2.776, 6: 2.571, 7: 2.447, 8: 2.365, 9: 2.306, 10: 2.262 };
export interface Projection { n: number; per_item_usd: number | null; sd_usd: number | null; total: number; projected_usd: number | null; band_usd: [number, number] | null; verdict: 'within' | 'exceeds' | 'unknown' }
export interface SpendTable { summary: SpendSummary; workers: number; max_estimate_usd: number; worst_case_usd: number; worst_case_overrun_usd: number }
export interface PilotReport { record: PilotRecord; spend: SpendTable; projection: Projection; settled_known: number; settled_unknown: number }

export function pilotReport(out: string, o: { total: number; workers?: number }): PilotReport {
  const record = JSON.parse(fs.readFileSync(path.join(out, PILOT_FILES.pilot), 'utf8')) as PilotRecord;
  const ledger = readLedger(path.join(out, PILOT_FILES.spend), record.cap_usd);
  const summary = summarize(ledger);
  const known = ledger.settled.filter(s => typeof s.usd === 'number').map(s => s.usd as number);
  const unknown = ledger.settled.length - known.length;
  const workers = Math.max(1, o.workers ?? 1);
  const maxEstimate = Math.max(0, ...record.attempts.map(a => a.estimate_usd));
  const worst = summary.worst_case_usd + workers * maxEstimate;
  const n = known.length;
  const mean = n ? known.reduce((s, x) => s + x, 0) / n : null;
  const sd = n > 1 && mean !== null ? Math.sqrt(known.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : null;
  const perArmTotal = o.total * Math.max(1, record.arms.length);
  const projected = mean === null ? null : mean * perArmTotal;
  const half = sd !== null && mean !== null ? (T95[n] ?? 2.0) * (sd / Math.sqrt(n)) * perArmTotal : null;
  const band: [number, number] | null = projected !== null && half !== null ? [Math.max(0, projected - half), projected + half] : null;
  const verdict: Projection['verdict'] = projected === null || band === null || unknown > 0 ? 'unknown' : band[1] + summary.worst_case_usd <= record.cap_usd ? 'within' : 'exceeds';
  return {
    record, settled_known: n, settled_unknown: unknown,
    spend: { summary, workers, max_estimate_usd: maxEstimate, worst_case_usd: worst, worst_case_overrun_usd: Math.max(0, worst - record.cap_usd) },
    projection: { n, per_item_usd: mean, sd_usd: sd, total: o.total, projected_usd: projected, band_usd: band, verdict },
  };
}

const usd = (v: number | null) => (v === null ? 'unknown' : `$${v.toFixed(4)}`);

export function renderSpendTable(t: SpendTable, cap: number): string {
  const s = t.summary;
  return [
    '| spent | reserved | unknown charges | worst case (+1 in-flight call × workers) | cap | worst-case overrun |',
    '|---|---|---|---|---|---|',
    `| $${s.spent_usd.toFixed(4)} | $${s.reserved_usd.toFixed(4)} (${s.open_attempts.length} open) | ${s.unknown_count} ($${s.unknown_usd.toFixed(4)} at reservation) | $${t.worst_case_usd.toFixed(4)} (${t.workers} worker${t.workers === 1 ? '' : 's'} × $${t.max_estimate_usd.toFixed(4)}) | $${cap.toFixed(2)} | $${t.worst_case_overrun_usd.toFixed(4)} |`,
  ].join('\n');
}

export function renderPilotReport(r: PilotReport): string {
  const p = r.projection;
  return [
    `PILOT: n=${r.record.n} arms=${r.record.arms.join(',')} settled=${r.settled_known} unknown=${r.settled_unknown} status=${r.record.status}`,
    renderSpendTable(r.spend, r.record.cap_usd),
    `PILOT_PROJECTION: items=${p.total} per_item=${usd(p.per_item_usd)} sd=${usd(p.sd_usd)} projected=${usd(p.projected_usd)} band=${p.band_usd ? `[${usd(p.band_usd[0])}, ${usd(p.band_usd[1])}]` : 'unknown'} cap=$${r.record.cap_usd.toFixed(2)} verdict=${p.verdict}`,
    p.verdict === 'unknown' ? `APPROVAL: not ready — ${r.settled_known < 2 ? 'settle at least 2 pilot attempts with actual cost' : 'unknown charges make the band meaningless'}; settle, then rerun report` : `APPROVAL: run ${p.total} items at projected ${usd(p.projected_usd)} (95% band ${usd(p.band_usd![0])}–${usd(p.band_usd![1])}) under cap $${r.record.cap_usd.toFixed(2)}: ${p.verdict === 'within' ? 'fits; ask the owner before any further priced call' : 'EXCEEDS the cap; stop, raise the cap on purpose or cut arms or items'}`,
  ].join('\n') + '\n';
}
