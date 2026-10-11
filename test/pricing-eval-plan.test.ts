/**
 * PR E1: lib/pricing.ts (the table test/helpers/pricing.ts re-exports) and the
 * /eval-plan machinery in lib/eval-plan.ts: preregistration check, priced arms,
 * the $0 dry run, and the priced pilot ledger with its spend table.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXCLUDED_BILLING_CATEGORIES, PRICING, estimateCostUsd, hasPricing, pricingRow } from '../lib/pricing';
import * as helperPricing from './helpers/pricing';
import {
  PREREG_SECTIONS, checkPrereg, dryRun, pilotReport, preregTemplate, renderArms, renderDryRun, renderPilotReport, renderSpendTable,
  resolveArms, settlePilot, startPilot,
} from '../lib/eval-plan';

const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-eval-plan-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('lib/pricing', () => {
  test('the helper re-exports the lib table unchanged and documents the excluded billing categories', () => {
    expect(helperPricing.PRICING).toBe(PRICING);
    expect(helperPricing.estimateCostUsd).toBe(estimateCostUsd);
    expect(EXCLUDED_BILLING_CATEGORIES.length).toBeGreaterThan(0);
    for (const row of Object.values(PRICING)) { expect(row.input_per_mtok).toBeGreaterThan(0); expect(row.output_per_mtok).toBeGreaterThan(0); expect(row.as_of).toMatch(/^\d{4}-\d{2}$/); }
  });

  test('provider-prefixed ids resolve to their row; unknown models price at 0 and report missing', () => {
    expect(pricingRow('openai/gpt-6-astra')).toBe(PRICING['gpt-6-astra']);
    expect(hasPricing('anthropic/claude-fable-5-1')).toBe(true);
    expect(hasPricing('nobody/made-this-up')).toBe(false);
    expect(estimateCostUsd({ input: 1_000_000, output: 1_000_000 }, 'gpt-6-astra')).toBe(60);
    expect(estimateCostUsd({ input: 1_000_000, output: 0, cached: 1_000_000 }, 'claude-fable-5-1')).toBe(10.25);
    expect(estimateCostUsd({ input: 10, output: 10 }, 'nobody/made-this-up')).toBe(0);
  });
});

describe('preregistration', () => {
  test('the template has every required section and an empty section fails the check', () => {
    const t = preregTemplate('x');
    const check = checkPrereg(t);
    expect(check.missing).toEqual([]);
    expect(check.empty.length).toBe(PREREG_SECTIONS.length);
    expect(check.ok).toBe(false);
    const filled = t.replace(/^(##\s+.+)$/gm, '$1\n- filled in');
    expect(checkPrereg(filled)).toMatchObject({ ok: true, missing: [], empty: [] });
    expect(checkPrereg('# nothing here\n').missing).toEqual([...PREREG_SECTIONS]);
  });
});

describe('arms', () => {
  test('explicit arms are priced from the table; an unpriced arm is EVAL_PRICE_MISSING', () => {
    const d = tmp();
    const priced = resolveArms({ cwd: d, explicit: ['gpt-6-astra', 'claude-fable-5-1'] });
    expect(priced.errors).toEqual([]);
    expect(priced.arms.map(a => a.priced)).toEqual([true, true]);
    expect(renderArms(priced, { input: 1000, output: 1000 })).toContain('ARM: gpt-6-astra');
    const unpriced = resolveArms({ cwd: d, explicit: ['gpt-6-astra', 'made-up-model'] });
    expect(unpriced.errors.map(e => e.code)).toEqual(['EVAL_PRICE_MISSING']);
    expect(renderArms(unpriced, { input: 1000, output: 1000 })).toContain('price=MISSING');
  });

  test('the eval-arms role is read through the models CLI seam, never the network', () => {
    const d = tmp();
    const calls: string[][] = [];
    const selections = [
      { provider: 'openai', requestedModel: 'gpt-6-astra', status: 'selected', tier: 'implementation' },
      { provider: 'anthropic', requestedModel: 'claude-fable-5-1', status: 'selected', tier: 'implementation' },
      { provider: 'google', requestedModel: 'gemini-x', status: 'unavailable' },
    ];
    const r = resolveArms({ cwd: d, modelsCli: args => { calls.push(args); return { code: 0, stdout: JSON.stringify({ selections }) }; } });
    expect(calls).toEqual([['resolve', '--role', 'eval-arms', '--json']]);
    expect(r.source).toBe('policy:eval-arms');
    expect(r.arms.map(a => [a.model, a.provider, a.source])).toEqual([
      ['gpt-6-astra', 'openai', 'policy:eval-arms/implementation'],
      ['claude-fable-5-1', 'anthropic', 'policy:eval-arms/implementation'],
    ]);
    const none = resolveArms({ cwd: d, modelsCli: () => ({ code: 1, stdout: '' }) });
    expect(none.errors.map(e => e.code)).toEqual(['EVAL_ARMS_UNRESOLVED']);
  });
});

describe('dry run', () => {
  test('flags malformed rows and missing fields, requires the retry prompt and the output floor, and prices per item', () => {
    const d = tmp();
    const rows = path.join(d, 'rows.jsonl');
    fs.writeFileSync(rows, [JSON.stringify({ id: 1, prompt: 'hello world' }), 'not json', JSON.stringify({ id: 3 }), ''].join('\n'));
    const retry = path.join(d, 'retry.txt');
    fs.writeFileSync(retry, 'Try again with the schema.\n');
    const r = dryRun({ input: rows, arms: ['gpt-6-astra'], retryPrompt: retry });
    expect(r.rows).toBe(3);
    expect(r.bad_rows.map(b => b.line)).toEqual([2, 3]);
    expect(r.bad_rows[0]!.missing).toEqual(['<not a JSON object>']);
    expect(r.bad_rows[1]!.missing).toEqual(['prompt']);
    expect(r.pass).toBe(false);
    expect(r.per_item_usd['gpt-6-astra']).toBeGreaterThan(0);
    expect(renderDryRun(r)).toContain('DRY_RUN:');
    fs.writeFileSync(rows, JSON.stringify({ prompt: 'hello world' }) + '\n');
    expect(dryRun({ input: rows, arms: ['gpt-6-astra'], retryPrompt: retry }).pass).toBe(true);
    expect(dryRun({ input: rows, arms: ['gpt-6-astra'] }).checks.retry_prompt.ok).toBe(false);
    expect(dryRun({ input: rows, arms: ['gpt-6-astra'], retryPrompt: retry, outputBudget: 100 }).checks.output_budget.ok).toBe(false);
    expect(dryRun({ input: rows, arms: ['made-up'], retryPrompt: retry }).checks.price_table.missing).toEqual(['made-up']);
  });
});

describe('priced pilot', () => {
  function passingDryRun(d: string): string {
    const rows = path.join(d, 'rows.jsonl');
    fs.writeFileSync(rows, JSON.stringify({ prompt: 'x'.repeat(400) }) + '\n');
    const retry = path.join(d, 'retry.txt'); fs.writeFileSync(retry, 'retry\n');
    const file = path.join(d, 'dry-run.json');
    fs.writeFileSync(file, JSON.stringify(dryRun({ input: rows, arms: ['gpt-6-astra'], retryPrompt: retry })));
    return file;
  }

  test('reserves n attempts per arm under the cap, settles actual spend, and projects the full run with a band', () => {
    const d = tmp();
    const out = path.join(d, 'run');
    const started = startPilot({ out, cap: 10, n: 3, arms: ['gpt-6-astra'], dryRun: passingDryRun(d), now: new Date('2026-10-10T00:00:00Z') });
    expect(started.error).toBeUndefined();
    expect(started.record.attempts).toHaveLength(3);
    expect(started.record.status).toBe('reserved');
    for (const [i, a] of started.record.attempts.entries()) settlePilot(out, a.attempt, 0.4 + i * 0.01);
    const report = pilotReport(out, { total: 20, workers: 2 });
    expect(report.settled_known).toBe(3);
    expect(report.projection.per_item_usd).toBeCloseTo(0.41, 6);
    expect(report.projection.projected_usd).toBeCloseTo(8.2, 6);
    expect(report.projection.band_usd![0]).toBeLessThan(report.projection.projected_usd!);
    expect(report.projection.verdict).toBe('within');
    const text = renderPilotReport(report);
    expect(text).toContain('PILOT:');
    expect(renderSpendTable(report.spend, 10)).toContain('cap');
  });

  test('a reservation past the cap ends the pilot EVAL_BUDGET_EXHAUSTED; a failed dry run never starts it; unknown spend keeps the verdict unknown', () => {
    const d = tmp();
    const dry = passingDryRun(d);
    const exhausted = startPilot({ out: path.join(d, 'tight'), cap: 0.0001, n: 3, arms: ['gpt-6-astra'], dryRun: dry });
    expect(exhausted.error?.code).toBe('EVAL_BUDGET_EXHAUSTED');
    expect(exhausted.record.status).toBe('budget_exhausted');
    const failed = path.join(d, 'failed.json');
    fs.writeFileSync(failed, JSON.stringify({ ...JSON.parse(fs.readFileSync(dry, 'utf8')), pass: false }));
    expect(startPilot({ out: path.join(d, 'never'), cap: 10, n: 3, arms: ['gpt-6-astra'], dryRun: failed }).error?.code).toBe('EVAL_DRY_RUN_FAILED');
    expect(fs.existsSync(path.join(d, 'never', 'pilot.json'))).toBe(false);
    const out = path.join(d, 'unknown');
    const s = startPilot({ out, cap: 10, n: 2, arms: ['gpt-6-astra'], dryRun: dry });
    settlePilot(out, s.record.attempts[0]!.attempt, 0.3);
    settlePilot(out, s.record.attempts[1]!.attempt, 'unknown');
    const r = pilotReport(out, { total: 5 });
    expect(r.settled_unknown).toBe(1);
    expect(r.projection.verdict).toBe('unknown');
  });
});
