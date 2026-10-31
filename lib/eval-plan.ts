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
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { modelsMain } from './model-policy-cli';
import { isConfigUnavailable, loadConfigFromBase } from './pregate/config';
import { EXCLUDED_BILLING_CATEGORIES, estimateCostUsd, hasPricing, PRICING, pricingRow } from './pricing';
import type { ResultCodeName } from './result-codes';
import type { ModelRulesCheck } from './eval-models';
import { readLedger, release, reserve, settle, SpendCapExceeded, summarize, type SpendLedger, type SpendSummary } from './spend-ledger';

// ---------------------------------------------------------------------------
// preregistration
// ---------------------------------------------------------------------------
export const PREREG_SECTIONS = ['Bars', 'Arms', 'Comparison', 'Decoys', 'Stop rules', 'Held-out exposure'] as const;
/** `## Comparison`: `stack: loaded` when any arm loads gstack or another skill stack, `stack: none` with a `why:` otherwise. */
export interface ComparisonCheck { stack: 'loaded' | 'none' | null; why: string | null; errors: string[] }
/** `## No-gstack arm`, required when `stack: loaded`: one `<model>#no-gstack` Arms line per model, and the inputs, prompt, panel and report it shares with the variants. */
export interface NoGstackArmCheck { required: boolean; ok: boolean; arms: string[]; problems: string[] }
export interface PreregCheck { ok: boolean; present: string[]; missing: string[]; empty: string[]; comparison: ComparisonCheck; no_gstack: NoGstackArmCheck; diagnostics: PreregDiagnostics | null }
export const NO_GSTACK_LOADOUT = 'no-gstack';
export const NO_GSTACK_KEYS = ['arms', 'inputs', 'prompt', 'panel', 'report'] as const;

export function preregTemplate(title = 'Eval preregistration'): string {
  return `# ${title}

## Bars
<!-- One line per metric: name, the pass bar, the direction, and what a miss means for the decision. -->

## Arms
<!-- One line per arm: the arm identity first (\`<model>\` or \`<model>#<loadout>\`, the model in lib/pricing.ts, e.g. \`claude-opus-5-5#no-gstack\`), settings, and the per-item cost from \`gstack-eval-plan arms\`. -->

## Comparison
<!-- \`stack: loaded\` when any arm loads gstack or another skill stack (review variants, preamble loadouts, skill diets, a model panel under a stack); otherwise \`stack: none\` and a \`why:\` line. -->

## No-gstack arm
<!-- Required with \`stack: loaded\`: \`arms:\` one \`<model>#no-gstack\` Arms line per model; \`inputs:\` the same rows and fixture; \`prompt:\` the task only (no SKILL.md, preamble, hooks or installed skills); \`panel:\` the same E2E kind, trials and judge; \`report:\` its row beside the variants. -->

## Decoys
<!-- Inputs the scorer must reject or score low; how many, how they were made, what a decoy pass proves. -->

## Stop rules
<!-- When the run stops early: the spend cap, a bar missed on the pilot, a scorer below its bar, budget_exhausted. -->

## Held-out exposure
<!-- Every held-out set this plan touches: | set | prior exposure (which runs, which models) | reservation (what this run may read) | -->
<!-- Optional: a \`## Diagnostics\` section declares the summarizer (\`summarizer: <command naming {fixture}>\`), its synthetic records (\`fixture: <path>\`) and one | diagnostic | expected | row per diagnostic; \`prereg --check --allow-repo-commands\` runs it. -->
`;
}

/** A section's content lines (blank lines and `<!-- -->` guidance, one-line or multi-line, dropped); null when the heading is absent. */
function sectionBody(text: string, name: string): string[] | null {
  const lines = text.split('\n');
  const headings = lines.map((l, i) => ({ i, m: /^#{1,6}\s+(.+?)\s*$/.exec(l) })).filter(x => x.m) as Array<{ i: number; m: RegExpExecArray }>;
  const idx = headings.findIndex(h => h.m[1]!.toLowerCase().replace(/[^a-z]/g, '') === name.toLowerCase().replace(/[^a-z]/g, ''));
  if (idx < 0) return null;
  const end = idx + 1 < headings.length ? headings[idx + 1]!.i : lines.length;
  return lines.slice(headings[idx]!.i + 1, end).join('\n').replace(/<!--[\s\S]*?-->/g, '').split('\n').filter(l => l.trim());
}

/** The model an arm identity `<model>[#<loadout>]` is priced by. */
export const armModel = (id: string) => id.split('#')[0]!;
const armLoadout = (id: string) => (id.includes('#') ? id.slice(id.indexOf('#') + 1) : null);

/** The first token of each Arms line (bullets, table pipes and backticks stripped; a table's header row skipped). */
export function armIdentities(text: string): string[] {
  const body = sectionBody(text, 'Arms') ?? [];
  const row = (l: string) => /^\s*\|/.test(l);
  const separator = (l: string | undefined) => !!l && /^[\s:|-]+$/.test(l) && l.includes('-');
  const ids: string[] = [];
  body.forEach((line, i) => {
    if (separator(line) || (row(line) && separator(body[i + 1]))) return;
    const token = line.replace(/^\s*(?:[-*+]|\d+[.)])?\s*\|?\s*/, '').split(/[\s|]+/)[0]!.replace(/[`,;:]+$/g, '').replace(/^`/, '');
    if (token) ids.push(token);
  });
  return ids;
}

const keyValues = (body: string[]) => {
  const kv: Record<string, string> = {};
  for (const line of body) {
    const m = /^\s*(?:[-*]\s+)?([a-z]+):(.*)$/i.exec(line);
    if (m) kv[m[1]!.toLowerCase()] = m[2]!.trim();
  }
  return kv;
};

function checkComparison(text: string): ComparisonCheck {
  const body = sectionBody(text, 'Comparison');
  if (!body?.length) return { stack: null, why: null, errors: [] };
  const kv = keyValues(body);
  const why = kv.why || null;
  if (kv.stack === undefined) return { stack: null, why, errors: ['no stack: line (stack: loaded or stack: none)'] };
  if (kv.stack !== 'loaded' && kv.stack !== 'none') return { stack: null, why, errors: [`stack: ${kv.stack} is neither loaded nor none`] };
  return { stack: kv.stack, why, errors: kv.stack === 'none' && !why ? ['stack: none needs a why: line saying why no arm loads a skill stack'] : [] };
}

function checkNoGstackArm(text: string, stack: ComparisonCheck['stack']): NoGstackArmCheck {
  if (stack !== 'loaded') return { required: false, ok: true, arms: [], problems: [] };
  const body = sectionBody(text, 'No-gstack arm');
  if (!body?.length) return { required: true, ok: false, arms: [], problems: ['missing section'] };
  const kv = keyValues(body);
  const problems = NO_GSTACK_KEYS.filter(k => !kv[k]).map(k => `missing ${k}`);
  const listed = (kv.arms ?? '').split(/[\s,]+/).map(a => a.replace(/^`|`$/g, '')).filter(Boolean);
  const ids = armIdentities(text);
  for (const a of listed) {
    if (armLoadout(a) !== NO_GSTACK_LOADOUT) problems.push(`${a} is not a <model>#${NO_GSTACK_LOADOUT} identity`);
    else if (!ids.includes(a)) problems.push(`${a} is not an Arms line`);
  }
  const loaded = [...new Set(ids.filter(id => armLoadout(id) !== NO_GSTACK_LOADOUT).map(armModel))];
  for (const m of loaded) {
    const arm = `${m}#${NO_GSTACK_LOADOUT}`;
    if (!ids.includes(arm) || !listed.includes(arm)) problems.push(`no no-gstack arm for ${m}`);
  }
  return { required: true, ok: problems.length === 0, arms: listed, problems };
}

export function checkPrereg(text: string): PreregCheck {
  const present: string[] = []; const missing: string[] = []; const empty: string[] = [];
  for (const name of PREREG_SECTIONS) {
    const body = sectionBody(text, name);
    if (body === null) missing.push(name); else if (body.length === 0) empty.push(name); else present.push(name);
  }
  const comparison = checkComparison(text);
  const no_gstack = checkNoGstackArm(text, comparison.stack);
  const diagnostics = parsePreregDiagnostics(text);
  return { ok: missing.length === 0 && empty.length === 0 && !comparison.errors.length && no_gstack.ok && !diagnostics?.errors.length, present, missing, empty, comparison, no_gstack, diagnostics };
}

// ---------------------------------------------------------------------------
// preregistered diagnostics: the declared summarizer on a declared synthetic fixture
// ---------------------------------------------------------------------------
/** Placeholder the summarizer command names the fixture by; it runs as "$GSTACK_PREREG_FIXTURE", never spliced into the shell text. */
export const PREREG_FIXTURE_PLACEHOLDER = '{fixture}';
export const PREREG_SUMMARIZER_TIMEOUT_MS = 300_000;
export interface PreregDiagnostics { summarizer: string | null; fixture: string | null; expected: Array<{ name: string; count: number }>; errors: string[] }
export interface DiagnosticRow { name: string; expected: number | null; got: number | null; status: 'ok' | 'mismatch' | 'missing' | 'undeclared' }
export interface PreregDiagnosticRun { ok: boolean; command: string; fixture: string; fixture_sha256: string | null; exit: number | null; rows: DiagnosticRow[]; error: string | null }

/**
 * The optional `## Diagnostics` section: `summarizer: <command naming {fixture}>`,
 * `fixture: <repo-relative path>` and a `| diagnostic | expected |` table with one
 * row per preregistered diagnostic. Absent or empty: nothing declared (null).
 */
export function parsePreregDiagnostics(text: string): PreregDiagnostics | null {
  const body = sectionBody(text, 'Diagnostics');
  if (!body?.length) return null;
  const d: PreregDiagnostics = { summarizer: null, fixture: null, expected: [], errors: [] };
  const value = (raw: string) => raw.trim().replace(/^`(.+)`$/, '$1').trim();
  for (const line of body) {
    const kv = /^\s*(?:[-*]\s+)?(summarizer|fixture):\s*(.+)$/i.exec(line);
    if (kv) { d[kv[1]!.toLowerCase() as 'summarizer' | 'fixture'] = value(kv[2]!); continue; }
    const row = /^\s*\|(.+)\|\s*$/.exec(line);
    if (!row || /^[\s:|-]+$/.test(row[1]!)) continue;
    const cells = row[1]!.split('|').map(value);
    if (cells[0]!.toLowerCase() === 'diagnostic') continue;
    if (cells.length < 2 || !cells[0] || !/^\d+$/.test(cells[1]!)) { d.errors.push(`row ${JSON.stringify(line.trim())}: needs | <diagnostic> | <expected count, a non-negative integer> |`); continue; }
    if (d.expected.some(e => e.name === cells[0])) { d.errors.push(`diagnostic ${cells[0]} is declared twice`); continue; }
    d.expected.push({ name: cells[0]!, count: Number(cells[1]) });
  }
  if (!d.summarizer) d.errors.push('no summarizer: line (the command that summarizes the run records)');
  else if (!d.summarizer.includes(PREREG_FIXTURE_PLACEHOLDER)) d.errors.push(`the summarizer command never names the fixture (${PREREG_FIXTURE_PLACEHOLDER})`);
  if (!d.fixture) d.errors.push('no fixture: line (the synthetic records file the summarizer runs on)');
  if (!d.expected.length) d.errors.push('no | diagnostic | expected | rows');
  return d;
}

/**
 * Run the declared summarizer on the declared fixture (a repo command: the
 * caller gates it on --allow-repo-commands). Its last non-empty stdout line is
 * one JSON object of diagnostic name to count; every declared diagnostic must
 * appear with its expected count and nothing undeclared may appear.
 */
export function runPreregDiagnostics(d: PreregDiagnostics, repoRoot: string, env: NodeJS.ProcessEnv = process.env): PreregDiagnosticRun {
  const command = d.summarizer!.split(PREREG_FIXTURE_PLACEHOLDER).join('"$GSTACK_PREREG_FIXTURE"');
  const fixture = path.resolve(repoRoot, d.fixture!);
  const run: PreregDiagnosticRun = { ok: false, command, fixture: d.fixture!, fixture_sha256: null, exit: null, rows: [], error: null };
  if (!fs.existsSync(fixture) || !fs.statSync(fixture).isFile()) return { ...run, error: `declared fixture ${d.fixture} is not a file under ${repoRoot}` };
  run.fixture_sha256 = createHash('sha256').update(fs.readFileSync(fixture)).digest('hex');
  const r = spawnSync('sh', ['-c', command], { cwd: repoRoot, env: { ...env, GSTACK_PREREG_FIXTURE: fixture }, encoding: 'utf8', timeout: PREREG_SUMMARIZER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
  run.exit = r.status;
  if (r.status === null) return { ...run, error: r.signal ? `summarizer did not finish within ${PREREG_SUMMARIZER_TIMEOUT_MS / 1000} s (${r.signal})` : `summarizer did not start: ${r.error?.message ?? 'unknown error'}` };
  const tail = (r.stderr ?? '').trim().split('\n').slice(-1)[0] ?? '';
  if (r.status !== 0) return { ...run, error: `summarizer exited ${r.status}${tail ? `: ${tail}` : ''}` };
  const last = (r.stdout ?? '').trim().split('\n').filter(l => l.trim()).slice(-1)[0] ?? '';
  let counts: Record<string, unknown> | null = null;
  try { const v = JSON.parse(last); counts = v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { counts = null; }
  if (!counts) return { ...run, error: `the summarizer's last stdout line is not a JSON object of diagnostic counts (${JSON.stringify(last.slice(0, 120))})` };
  const bad = Object.entries(counts).filter(([, v]) => !Number.isInteger(v) || (v as number) < 0).map(([k]) => k);
  if (bad.length) return { ...run, error: `the summarizer reported non-count values for ${bad.join(', ')}` };
  for (const e of d.expected) {
    const got = counts[e.name] === undefined ? null : counts[e.name] as number;
    run.rows.push({ name: e.name, expected: e.count, got, status: got === null ? 'missing' : got === e.count ? 'ok' : 'mismatch' });
  }
  for (const [name, got] of Object.entries(counts)) if (!d.expected.some(e => e.name === name)) run.rows.push({ name, expected: null, got: got as number, status: 'undeclared' });
  return { ...run, ok: run.rows.every(row => row.status === 'ok') };
}

export function renderPreregDiagnostics(run: PreregDiagnosticRun): string {
  const rows = run.rows.map(r => `PREREG_DIAGNOSTIC: ${r.name} expected=${r.expected ?? 'undeclared'} got=${r.got ?? 'none'} ${r.status}`);
  rows.push(`PREREG_DIAGNOSTICS: ${run.ok ? 'ok' : 'untested'} n=${run.rows.filter(r => r.status !== 'undeclared').length} fixture=${run.fixture}${run.fixture_sha256 ? ` sha256=${run.fixture_sha256.slice(0, 12)}` : ''}${run.error ? ` error=${JSON.stringify(run.error)}` : ''}`);
  return rows.join('\n') + '\n';
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
  const row = pricingRow(armModel(model));
  return { model, provider, source, priced: !!row, input_per_mtok: row?.input_per_mtok ?? null, output_per_mtok: row?.output_per_mtok ?? null, per_item_usd: row ? estimateCostUsd(tokens, armModel(model)) : null };
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
  arms: string[];
  checks: {
    price_table: { ok: boolean; missing: string[] }; output_budget: { ok: boolean; budget: number; floor: number }; retry_prompt: { ok: boolean; text: string | null };
    /** Present with `cap`: one call per arm (the largest row's input plus the output budget), priced, fits under the cap. */
    reservation_fits_cap?: { ok: boolean; cap: number; max_input_tokens: number; per_arm: Record<string, number | null> };
    /** Present when the caller linted the arms against .gstack/eval-models.json (lib/eval-models.ts). */
    model_rules?: { ok: boolean; source: string; refused: string[] };
  };
  per_item_usd: Record<string, number | null>; excluded_billing: readonly string[]; pass: boolean; stub: 'stub-model (no network, $0)';
}
export interface DryRunOptions { input: string; arms: string[]; fields?: string[]; outputBudget?: number; retryPrompt?: string; maxRows?: number; cap?: number; modelRules?: ModelRulesCheck }

/** Four bytes per token, the estimator every gstack admission uses. */
export const estimateTokens = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);

export function dryRun(o: DryRunOptions): DryRunResult {
  const fields = o.fields?.length ? o.fields : ['prompt'];
  const budget = o.outputBudget ?? REASONING_OUTPUT_FLOOR;
  const text = fs.readFileSync(o.input, 'utf8');
  const lines = text.split('\n');
  const bad: DryRunRow[] = []; let rows = 0; let inputTokens = 0; let maxInput = 0;
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
    maxInput = Math.max(maxInput, t);
    if (missing.length) bad.push({ line: i + 1, ok: false, missing, input_tokens: t });
  });
  const retryText = o.retryPrompt && fs.existsSync(o.retryPrompt) ? fs.readFileSync(o.retryPrompt, 'utf8').trim() : null;
  const missingPrice = o.arms.filter(a => !hasPricing(armModel(a)));
  const perItem: Record<string, number | null> = {};
  const avgIn = rows ? Math.ceil(inputTokens / rows) : 0;
  for (const a of o.arms) perItem[a] = hasPricing(armModel(a)) ? estimateCostUsd({ input: avgIn, output: budget }, armModel(a)) : null;
  const checks = {
    price_table: { ok: missingPrice.length === 0 && o.arms.length > 0, missing: missingPrice },
    output_budget: { ok: budget >= REASONING_OUTPUT_FLOOR, budget, floor: REASONING_OUTPUT_FLOOR },
    retry_prompt: { ok: !!retryText, text: retryText },
  } as DryRunResult['checks'];
  if (o.cap !== undefined) {
    const perArm: Record<string, number | null> = {};
    for (const a of o.arms) perArm[a] = hasPricing(armModel(a)) ? estimateCostUsd({ input: maxInput, output: budget }, armModel(a)) : null;
    checks.reservation_fits_cap = { ok: Object.values(perArm).every(v => v === null || v <= o.cap!), cap: o.cap, max_input_tokens: maxInput, per_arm: perArm };
  }
  if (o.modelRules) checks.model_rules = { ok: o.modelRules.ok, source: o.modelRules.source, refused: o.modelRules.errors.map(e => e.message) };
  return {
    schema_version: 1, input: o.input, rows, bad_rows: bad, est_input_tokens: inputTokens, est_output_tokens: rows * budget, arms: o.arms, checks, per_item_usd: perItem,
    excluded_billing: EXCLUDED_BILLING_CATEGORIES, pass: rows > 0 && bad.length === 0 && checks.price_table.ok && checks.output_budget.ok && checks.retry_prompt.ok && (checks.reservation_fits_cap?.ok ?? true) && (checks.model_rules?.ok ?? true), stub: 'stub-model (no network, $0)',
  };
}

export function renderDryRun(r: DryRunResult): string {
  const lines = [
    `DRY_RUN: ${r.stub} input=${r.input} rows=${r.rows} bad_rows=${r.bad_rows.length} est_input_tokens=${r.est_input_tokens} est_output_tokens=${r.est_output_tokens}`,
    ...r.bad_rows.slice(0, 20).map(b => `DRY_RUN_ROW: line ${b.line} missing=${b.missing.join(',')}`),
    `CHECK: price-table ${r.checks.price_table.ok ? 'ok' : `missing ${r.checks.price_table.missing.join(',') || '(no arms)'}`}`,
    `CHECK: output-budget ${r.checks.output_budget.ok ? 'ok' : 'too small'} (${r.checks.output_budget.budget} tokens; reasoning floor ${r.checks.output_budget.floor})`,
    `CHECK: retry-prompt ${r.checks.retry_prompt.ok ? `ok — ${JSON.stringify(r.checks.retry_prompt.text)}` : 'missing (pass --retry-prompt <file> with the exact text the run will send)'}`,
    ...(r.checks.reservation_fits_cap ? [renderReservationCheck(r.checks.reservation_fits_cap, r.checks.output_budget.budget)] : []),
    ...(r.checks.model_rules ? [`CHECK: model-rules ${r.checks.model_rules.ok ? 'ok' : `refused ${r.checks.model_rules.refused.join('; ') || 'invalid rules'}`} (source ${r.checks.model_rules.source})`] : []),
    ...Object.entries(r.per_item_usd).map(([m, usd]) => `ESTIMATE: ${m} per_item=${usd === null ? 'unknown (no price)' : `$${usd.toFixed(4)}`} (estimate: excludes ${r.excluded_billing.length} billing categories, see lib/pricing.ts)`),
    `DRY_RUN_RESULT: ${r.pass ? 'pass' : 'fail'}`,
  ];
  return lines.join('\n') + '\n';
}

function renderReservationCheck(c: NonNullable<DryRunResult['checks']['reservation_fits_cap']>, budget: number): string {
  const worst = Math.max(0, ...Object.values(c.per_arm).filter((v): v is number => v !== null));
  return `CHECK: reservation-fits-cap ${c.ok ? 'ok' : 'exceeds'} ($${worst.toFixed(4)} ${c.ok ? '<=' : '>'} cap $${c.cap.toFixed(2)}) one call = ${c.max_input_tokens} in + ${budget} out tokens`;
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
  const record: PilotRecord = { schema_version: 1, n: o.n, arms: o.arms, cap_usd: o.cap, dry_run: o.dryRun, attempts: [], started_at: (o.now ?? new Date()).toISOString(), status: 'reserved' };
  const keyOf = (a: string) => `${armModel(a).replace(/[^A-Za-z0-9.-]/g, '_')}${armLoadout(a) !== null ? `.${armLoadout(a)!.replace(/[^A-Za-z0-9.-]/g, '_')}` : ''}`;
  const keys = o.arms.map(keyOf);
  const duplicates = [...new Set(o.arms.filter((_, i) => keys.indexOf(keys[i]!) !== i).map(a => o.arms.filter(b => keyOf(b) === keyOf(a)).join(' = ')))];
  if (duplicates.length) return { record, error: { code: 'EVAL_ARM_DUPLICATE', message: `arm ${duplicates.join(', ')} is listed more than once or shares one ledger attempt name; give each arm its own <model>#<loadout> identity` } };
  fs.mkdirSync(o.out, { recursive: true });
  const ledgerFile = path.join(o.out, PILOT_FILES.spend);
  let error: { code: ResultCodeName; message: string } | undefined;
  outer: for (const model of o.arms) {
    if (!hasPricing(armModel(model))) { error = { code: 'EVAL_PRICE_MISSING', message: `${armModel(model)} has no row in lib/pricing.ts` }; break; }
    for (let i = 1; i <= o.n; i++) {
      const estimate = estimateCostUsd(tokens, armModel(model));
      const attempt = `pilot-${keyOf(model)}-${i}`;
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

// ---------------------------------------------------------------------------
// paid gates priced from a call-plan data file (docs/eval-calls.md)
// ---------------------------------------------------------------------------
/**
 * The plan file is DATA: `price-gate` reads it, checks its binding (the exact
 * gate command, the head it was produced at, each input's sha256 at HEAD) and
 * prices its `GSTACK_EVAL_CALLS v1` rows. Nothing in it is ever executed.
 */
export const EVAL_CALL_KEYS = ['purpose', 'model', 'calls', 'in_tokens', 'out_tokens', 'max_out_tokens', 'scope'] as const;
export interface EvalCallRow { purpose: string; model: string; calls: number; in_tokens: number; out_tokens: number; max_out_tokens: number; scope: 'full' | 'smoke' }
export interface EvalPlanInput { path: string; sha256: string }
export interface EvalCallPlan { gate: string; head: string; inputs: EvalPlanInput[]; preconditions: string[]; rows: EvalCallRow[] }

/** The reference emitter a consuming repo copies: binding lines, preconditions, one line per call purpose, the end line. */
export function formatEvalCalls(p: EvalCallPlan): string {
  return [
    '# gstack eval call plan, wire format v1 (docs/eval-calls.md); priced by `gstack-eval-plan price-gate`, never executed',
    `GSTACK_EVAL_GATE v1: ${p.gate}`,
    `GSTACK_EVAL_HEAD v1: ${p.head}`,
    ...p.inputs.map(i => `GSTACK_EVAL_INPUT v1: sha256=${i.sha256} path=${i.path}`),
    ...p.preconditions.map(t => `GSTACK_EVAL_PRECONDITION: ${t}`),
    ...p.rows.map(r => `GSTACK_EVAL_CALLS v1: ${EVAL_CALL_KEYS.map(k => `${k}=${r[k]}`).join(' ')}`),
    `GSTACK_EVAL_CALLS v1 end: lines=${p.rows.length}`,
  ].join('\n') + '\n';
}

const INT_KEYS = ['calls', 'in_tokens', 'out_tokens', 'max_out_tokens'] as const;

function parseCallRow(body: string, at: string): EvalCallRow | string {
  const fields: Record<string, string> = {};
  for (const tok of body.trim().split(/ +/)) {
    const eq = tok.indexOf('=');
    if (eq <= 0) return `${at}: ${JSON.stringify(tok)} is not key=value`;
    const key = tok.slice(0, eq);
    if (!(EVAL_CALL_KEYS as readonly string[]).includes(key)) return `${at}: unknown key ${key}`;
    if (key in fields) return `${at}: duplicate key ${key}`;
    fields[key] = tok.slice(eq + 1);
  }
  for (const key of EVAL_CALL_KEYS) if (!(key in fields)) return `${at}: missing key ${key}`;
  for (const key of INT_KEYS) if (!/^\d+$/.test(fields[key]!)) return `${at}: ${key} must be a non-negative integer (got ${JSON.stringify(fields[key])})`;
  if (Number(fields.calls) < 1) return `${at}: calls must be at least 1`;
  if (fields.scope !== 'full' && fields.scope !== 'smoke') return `${at}: scope must be full or smoke (got ${JSON.stringify(fields.scope)})`;
  if (!/^[A-Za-z0-9._:-]+$/.test(fields.purpose!)) return `${at}: purpose must match [A-Za-z0-9._:-]+`;
  if (!fields.model) return `${at}: model is empty`;
  return { purpose: fields.purpose!, model: fields.model, calls: Number(fields.calls), in_tokens: Number(fields.in_tokens), out_tokens: Number(fields.out_tokens), max_out_tokens: Number(fields.max_out_tokens), scope: fields.scope };
}

/** Strict v1 parser: a malformed line, an unknown kind or version, a missing binding or a missing or miscounted end line refuses, naming the line. */
export function parseEvalCalls(text: string): { plan: EvalCallPlan } | { error: string } {
  const plan: EvalCallPlan = { gate: '', head: '', inputs: [], preconditions: [], rows: [] };
  const seen = new Set<string>();
  let gate: string | null = null; let head: string | null = null; let ended = false;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.replace(/\r$/, ''); const at = `line ${i + 1}`;
    if (!raw.trim() || raw.startsWith('#')) continue;
    if (ended) return { error: `${at}: content after the end line` };
    const m = /^(GSTACK_EVAL_[A-Z_]+?)(?: (v\d+))?( end)?: (.*)$/.exec(raw);
    if (!m) return { error: `${at}: not a GSTACK_EVAL_ line (${JSON.stringify(raw.slice(0, 80))})` };
    const [, kind, version, end, body] = m as unknown as [string, string, string | undefined, string | undefined, string];
    if (kind === 'GSTACK_EVAL_PRECONDITION' && !version && !end) { plan.preconditions.push(body.trim()); continue; }
    if (!['GSTACK_EVAL_GATE', 'GSTACK_EVAL_HEAD', 'GSTACK_EVAL_INPUT', 'GSTACK_EVAL_CALLS'].includes(kind)) return { error: `${at}: unknown line kind ${kind}` };
    if (version !== 'v1') return { error: `${at}: ${kind} version ${version ?? '(none)'} is not supported (this gstack reads v1)` };
    if (end) {
      const n = kind === 'GSTACK_EVAL_CALLS' ? /^lines=(\d+)$/.exec(body.trim()) : null;
      if (!n) return { error: `${at}: malformed end line (expected GSTACK_EVAL_CALLS v1 end: lines=<n>)` };
      if (Number(n[1]) !== plan.rows.length) return { error: `${at}: end line says lines=${n[1]} but the file has ${plan.rows.length} call lines` };
      ended = true; continue;
    }
    if (kind === 'GSTACK_EVAL_GATE') {
      if (gate !== null) return { error: `${at}: second GSTACK_EVAL_GATE line` };
      if (!body.trim()) return { error: `${at}: empty gate command` };
      gate = body; continue;
    }
    if (kind === 'GSTACK_EVAL_HEAD') {
      if (head !== null) return { error: `${at}: second GSTACK_EVAL_HEAD line` };
      if (!/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(body.trim())) return { error: `${at}: head must be a full commit sha` };
      head = body.trim(); continue;
    }
    if (kind === 'GSTACK_EVAL_INPUT') {
      const inp = /^sha256=([0-9a-f]{64}) path=(.+)$/.exec(body);
      if (!inp) return { error: `${at}: expected GSTACK_EVAL_INPUT v1: sha256=<64 hex> path=<repo-relative path>` };
      if (path.isAbsolute(inp[2]!) || inp[2]!.split(/[\\/]/).includes('..')) return { error: `${at}: input path must be repo-relative without .. (${inp[2]})` };
      plan.inputs.push({ path: inp[2]!, sha256: inp[1]! }); continue;
    }
    const row = parseCallRow(body, at);
    if (typeof row === 'string') return { error: row };
    if (seen.has(`${row.purpose}\0${row.model}`)) return { error: `${at}: duplicate purpose=${row.purpose} model=${row.model}` };
    seen.add(`${row.purpose}\0${row.model}`);
    plan.rows.push(row);
  }
  if (gate === null) return { error: 'missing GSTACK_EVAL_GATE v1 line (the exact gate command this plan prices)' };
  if (head === null) return { error: 'missing GSTACK_EVAL_HEAD v1 line (the commit the plan was produced at)' };
  if (!ended) return { error: 'missing end line (GSTACK_EVAL_CALLS v1 end: lines=<n>); a partial file is refused' };
  return { plan: { ...plan, gate, head } };
}

export interface PricedCallRow extends EvalCallRow { usd: number | null; reservation_usd: number | null }
export interface GateReceipt {
  schema_version: 1; kind: 'gstack-eval-price-gate'; created_at: string; gstack_revision: string;
  gate_command: string; gate_sha256: string; head_sha: string;
  plan: { file: string | null; source: 'flag' | 'price_file' | 'none'; sha256: string | null; declared_head: string | null };
  inputs: EvalPlanInput[]; preconditions: string[]; rows: PricedCallRow[];
  total_usd: number | null; calls: number; purposes: string[]; cap_usd: number | null; smoke_cap_usd: number | null;
  result: 'priced' | 'price_missing' | 'over_cap' | 'unpriced' | 'unpriced_override'; code: ResultCodeName | null;
  unpriced_reason: string | null; unpriced_override: string | null; excluded_billing: readonly string[];
}
export interface PlanSource { text: Buffer | null; file: string | null; source: GateReceipt['plan']['source']; repoPath: string | null; why: string | null }
export interface PriceGateOptions { repoRoot: string; gate: string; plan: PlanSource; capUsd?: number; smokeCapUsd?: number; allowUnpriced?: string; now?: Date }
export interface PriceGateResult { lines: string[]; receipt: GateReceipt | null; error?: { code: ResultCodeName; message: string } }

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
function gitOut(repoRoot: string, args: string[]): Buffer | null {
  const r = spawnSync('git', args, { cwd: repoRoot, timeout: 30_000 });
  return r.status === 0 ? r.stdout : null;
}

export interface PlanSourceRefusal { code: ResultCodeName; message: string; refused: boolean }

/**
 * `--plan-file` wins; else the base policy's `price_file`, read from the HEAD
 * commit's bytes. Only "no plan declared" is unpriced (overridable); a declared
 * file missing at HEAD is stale, an unresolvable base or an invalid policy refuses.
 */
export function resolvePlanSource(repoRoot: string, o: { planFile?: string; base: string }): PlanSource | PlanSourceRefusal {
  if (o.planFile) {
    const file = path.resolve(o.planFile);
    const rel = path.relative(repoRoot, file);
    return { text: fs.readFileSync(file), file, source: 'flag', repoPath: rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null, why: null };
  }
  const load = loadConfigFromBase(repoRoot, o.base);
  if (isConfigUnavailable(load)) return { code: 'POLICY_SOURCE_UNAVAILABLE', message: `no --plan-file and the base policy cannot be read (${load.detail})`, refused: true };
  if (load.errors.length) return { code: 'PREGATE_CONFIG_INVALID', message: `${load.label}: ${load.errors.map(e => `${e.path}: ${e.message}`).join('; ')}`, refused: true };
  const rel = load.config.price_file;
  if (!rel) return { text: null, file: null, source: 'none', repoPath: null, why: `no --plan-file and ${load.label} declares no price_file` };
  const text = gitOut(repoRoot, ['show', `HEAD:${rel}`]);
  if (!text) return { code: 'EVAL_PLAN_STALE', message: `price_file ${rel} (declared in ${load.label}) is not in the HEAD commit`, refused: false };
  return { text, file: rel, source: 'price_file', repoPath: rel, why: null };
}

/** Stale binding: the gate command, the head (only the plan file itself may change after it) and every input hash at HEAD. */
function checkBinding(o: PriceGateOptions, plan: EvalCallPlan, headSha: string): string | null {
  if (plan.gate !== o.gate) return `gate command differs: --gate ${JSON.stringify(o.gate)} vs plan ${JSON.stringify(plan.gate)}`;
  if (plan.head !== headSha) {
    const diff = gitOut(o.repoRoot, ['diff', '--name-only', plan.head, headSha]);
    if (diff === null) return `declared head ${plan.head.slice(0, 12)} is not a commit in this repository (HEAD ${headSha.slice(0, 12)})`;
    const changed = diff.toString('utf8').split('\n').filter(Boolean);
    if (changed.some(f => f !== o.plan.repoPath)) return `declared head ${plan.head.slice(0, 12)} is behind HEAD ${headSha.slice(0, 12)}: ${changed.length} file(s) changed since (${changed.slice(0, 3).join(', ')})`;
  }
  for (const input of plan.inputs) {
    const bytes = gitOut(o.repoRoot, ['show', `HEAD:${input.path}`]);
    if (!bytes) return `input ${input.path} is not in the HEAD commit`;
    const got = sha256(bytes);
    if (got !== input.sha256) return `input ${input.path} sha256 ${got.slice(0, 12)} at HEAD != declared ${input.sha256.slice(0, 12)}`;
  }
  return null;
}

export function gstackRevision(): string {
  const root = path.resolve(import.meta.dir, '..');
  const version = fs.existsSync(path.join(root, 'VERSION')) ? fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim() : 'unknown';
  const sha = gitOut(root, ['rev-parse', '--short', 'HEAD'])?.toString('utf8').trim();
  return sha ? `${version} (${sha})` : version;
}

const amount = (v: number | null) => (v === null ? 'unknown' : String(+v.toFixed(6)));

function priceRows(rows: EvalCallRow[]): PricedCallRow[] {
  return rows.map(r => {
    if (!hasPricing(r.model)) return { ...r, usd: null, reservation_usd: null };
    return { ...r, usd: estimateCostUsd({ input: r.in_tokens, output: r.out_tokens }, r.model), reservation_usd: estimateCostUsd({ input: Math.ceil(r.in_tokens / r.calls), output: r.max_out_tokens }, r.model) };
  });
}

/** Price a paid gate from its call-plan file. Malformed or stale files return an error and no receipt; every other outcome returns a receipt. */
export function priceGate(o: PriceGateOptions): PriceGateResult {
  const headSha = gitOut(o.repoRoot, ['rev-parse', 'HEAD'])?.toString('utf8').trim() ?? '';
  let plan: EvalCallPlan | null = null;
  if (o.plan.text) {
    const parsed = parseEvalCalls(o.plan.text.toString('utf8'));
    if ('error' in parsed) return { lines: [], receipt: null, error: { code: 'EVAL_DRY_RUN_FAILED', message: `${o.plan.file}: ${parsed.error}` } };
    const stale = checkBinding(o, parsed.plan, headSha);
    if (stale) return { lines: [], receipt: null, error: { code: 'EVAL_PLAN_STALE', message: `${o.plan.file}: ${stale}` } };
    plan = parsed.plan;
  }
  const rows = priceRows(plan?.rows ?? []);
  const total = rows.some(r => r.usd === null) ? null : +rows.reduce((s, r) => s + r.usd!, 0).toFixed(6);
  const lines = [
    ...(plan ? [`GATE_PLAN: file=${o.plan.file} source=${o.plan.source} sha256=${sha256(o.plan.text!)} head=${plan.head.slice(0, 12)}${plan.head === headSha ? '' : ` (HEAD ${headSha.slice(0, 12)}; only the plan file changed since)`} inputs=${plan.inputs.length} verified`] : []),
    ...(plan?.preconditions ?? []).map(t => `GATE_PRECONDITION: ${t}`),
    ...rows.map(r => `GATE_CALLS: purpose=${r.purpose} model=${r.model} calls=${r.calls} usd=${amount(r.usd)} reservation_usd=${amount(r.reservation_usd)} scope=${r.scope}`),
  ];
  let error: PriceGateResult['error'];
  let result: GateReceipt['result'] = 'priced';
  const unpricedWhy = !plan ? o.plan.why ?? 'no call-plan file' : rows.length === 0 ? `${o.plan.file} has no GSTACK_EVAL_CALLS lines` : null;
  if (unpricedWhy) {
    result = o.allowUnpriced ? 'unpriced_override' : 'unpriced';
    if (o.allowUnpriced) lines.push(`GATE_UNPRICED_OVERRIDE: ${o.allowUnpriced} (owner-authorized override; not authorization to spend)`);
    else error = { code: 'EVAL_GATE_UNPRICED', message: unpricedWhy };
  } else if (total === null) {
    result = 'price_missing';
    error = { code: 'EVAL_PRICE_MISSING', message: `no price row for ${rows.filter(r => r.usd === null).map(r => r.model).join(', ')}; the total is unknown, never zero` };
  } else {
    const over: string[] = [];
    if (o.capUsd !== undefined || o.smokeCapUsd !== undefined) {
      for (const r of rows) {
        const smoke = r.scope === 'smoke' && o.smokeCapUsd !== undefined && r.reservation_usd! > o.smokeCapUsd;
        const full = o.capUsd !== undefined && r.reservation_usd! > o.capUsd;
        if (!smoke && !full) continue;
        const why = `$${r.reservation_usd!.toFixed(4)} > ${smoke ? `smoke cap $${o.smokeCapUsd!.toFixed(2)}` : `cap $${o.capUsd!.toFixed(2)}`}`;
        lines.push(`CHECK: reservation-fits-cap exceeds (${why}) purpose=${r.purpose}`);
        over.push(`reservation-fits-cap: purpose=${r.purpose} one call ${why}`);
      }
      if (!over.length) lines.push(`CHECK: reservation-fits-cap ok (largest one-call reservation $${Math.max(0, ...rows.map(r => r.reservation_usd!)).toFixed(4)})`);
    }
    if (o.capUsd !== undefined && total > o.capUsd) over.unshift(`total $${total.toFixed(4)} > cap $${o.capUsd.toFixed(2)}`);
    if (over.length) { result = 'over_cap'; error = { code: 'EVAL_GATE_OVER_CAP', message: over.join('; ') }; }
  }
  const receipt: GateReceipt = {
    schema_version: 1, kind: 'gstack-eval-price-gate', created_at: (o.now ?? new Date()).toISOString(), gstack_revision: gstackRevision(),
    gate_command: o.gate, gate_sha256: sha256(o.gate), head_sha: headSha,
    plan: { file: o.plan.file, source: o.plan.source, sha256: o.plan.text ? sha256(o.plan.text) : null, declared_head: plan?.head ?? null },
    inputs: plan?.inputs ?? [], preconditions: plan?.preconditions ?? [], rows,
    total_usd: unpricedWhy ? null : total, calls: rows.reduce((s, r) => s + r.calls, 0), purposes: rows.map(r => r.purpose),
    cap_usd: o.capUsd ?? null, smoke_cap_usd: o.smokeCapUsd ?? null, result, code: error?.code ?? (unpricedWhy ? 'EVAL_GATE_UNPRICED' : null),
    unpriced_reason: unpricedWhy, unpriced_override: unpricedWhy ? o.allowUnpriced ?? null : null, excluded_billing: EXCLUDED_BILLING_CATEGORIES,
  };
  return { lines, receipt, error };
}

export function renderGatePrice(r: GateReceipt, receiptPath: string): string {
  return `GATE_PRICE: total=${amount(r.total_usd)} calls=${r.calls} purposes=${r.purposes.join(',') || 'none'} receipt=${receiptPath}`;
}
