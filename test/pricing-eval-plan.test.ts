/**
 * PR E1: lib/pricing.ts (the table test/helpers/pricing.ts re-exports) and the
 * /eval-plan machinery in lib/eval-plan.ts: preregistration check, priced arms,
 * the $0 dry run, and the priced pilot ledger with its spend table.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EXCLUDED_BILLING_CATEGORIES, PRICING, estimateCostUsd, hasPricing, pricingRow } from '../lib/pricing';
import * as helperPricing from './helpers/pricing';
import {
  PREREG_SECTIONS, checkPrereg, dryRun, formatEvalCalls, parseEvalCalls, pilotReport, preregTemplate, renderArms, renderDryRun, renderPilotReport, renderSpendTable,
  resolveArms, settlePilot, startPilot,
} from '../lib/eval-plan';
import { capyHost, type CapyHost } from './helpers/capy-host';

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

  test('the default eval-arms tier (smart) is priced out of the box', () => {
    for (const model of ['claude-opus-5-5', 'gpt-6.1-sol']) expect(hasPricing(model)).toBe(true);
  });
});

describe('preregistration', () => {
  test('the template has every required section and an empty section fails the check', () => {
    const t = preregTemplate('x');
    const check = checkPrereg(t);
    expect(check.missing).toEqual([]);
    expect(check.empty.length).toBe(PREREG_SECTIONS.length);
    expect(check.ok).toBe(false);
    expect(PREREG_SECTIONS).toContain('Comparison');
    const filled = t.replace(/^(##\s+.+)$/gm, '$1\n- filled in').replace('## Comparison\n- filled in', '## Comparison\nstack: none\nwhy: one arm, no skill stack');
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

// ---------------------------------------------------------------------------
// CD2 (field wave item 15): paid gates priced from a call-plan DATA file.
// `price-gate` never executes anything: it validates the file's binding (gate
// command, head, input hashes at HEAD) and prices the GSTACK_EVAL_CALLS v1 rows.
// ---------------------------------------------------------------------------
const ROOT = path.resolve(import.meta.dir, '..');
const BIN = path.join(ROOT, 'bin', 'gstack-eval-plan');

function scratchRepo(env: Record<string, string>): { repo: string; head: string; rowsSha: string } {
  const repo = path.join(env.TMPDIR!, 'repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, env, encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'rows.jsonl'), JSON.stringify({ prompt: 'q1' }) + '\n');
  git('add', 'rows.jsonl');
  git('commit', '-q', '-m', 'rows');
  return { repo, head: git('rev-parse', 'HEAD'), rowsSha: createHash('sha256').update(fs.readFileSync(path.join(repo, 'rows.jsonl'))).digest('hex') };
}

const GATE = 'bun run eval:synopsis --questions 50 --arms opus,sol';
const twoRows = [
  { purpose: 'answer', model: 'anthropic/claude-opus-5-5', calls: 100, in_tokens: 400_000, out_tokens: 200_000, max_out_tokens: 8_192, scope: 'full' as const },
  { purpose: 'judge', model: 'gpt-6.1-sol', calls: 100, in_tokens: 300_000, out_tokens: 50_000, max_out_tokens: 2_048, scope: 'full' as const },
];

function runGate(host: CapyHost, cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  const r = spawnSync(BIN, ['price-gate', ...args], { cwd, env: { ...host.env, ...extraEnv }, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('price-gate: the call-plan file format (formatEvalCalls / parseEvalCalls)', () => {
  test('the reference emitter round-trips: binding lines, preconditions, call lines and the end line', () => {
    const plan = { gate: GATE, head: 'a'.repeat(40), inputs: [{ path: 'rows.jsonl', sha256: 'b'.repeat(64) }], preconditions: ['ANTHROPIC_API_KEY set at run time'], rows: twoRows };
    const text = formatEvalCalls(plan);
    expect(text).toContain(`GSTACK_EVAL_GATE v1: ${GATE}\n`);
    expect(text).toContain('GSTACK_EVAL_CALLS v1: purpose=answer model=anthropic/claude-opus-5-5 calls=100 in_tokens=400000 out_tokens=200000 max_out_tokens=8192 scope=full\n');
    expect(text.trimEnd().split('\n').at(-1)).toBe('GSTACK_EVAL_CALLS v1 end: lines=2');
    const parsed = parseEvalCalls(text);
    expect('plan' in parsed && parsed.plan).toEqual(plan);
  });

  test('a malformed, partial or unknown-version file refuses and names the line', () => {
    const good = formatEvalCalls({ gate: GATE, head: 'a'.repeat(40), inputs: [], preconditions: [], rows: twoRows });
    const err = (text: string) => { const r = parseEvalCalls(text); return 'error' in r ? r.error : ''; };
    expect(err(good.replace(/\nGSTACK_EVAL_CALLS v1 end: lines=2\n$/, '\n'))).toMatch(/end line/);
    expect(err(good.replace('end: lines=2', 'end: lines=3'))).toMatch(/lines=3.*2 call lines/);
    expect(err(good.replace('calls=100 in_tokens=400000', 'calls=1e2 in_tokens=400000'))).toMatch(/line 4.*calls/);
    expect(err(good.replace('scope=full\nGSTACK_EVAL_CALLS v1: purpose=judge', 'scope=full extra=1\nGSTACK_EVAL_CALLS v1: purpose=judge'))).toMatch(/line 4.*extra/);
    expect(err(good.replace(' max_out_tokens=8192', ''))).toMatch(/line 4.*max_out_tokens/);
    expect(err(good.replace('GSTACK_EVAL_CALLS v1: purpose=judge', 'GSTACK_EVAL_CALLS v2: purpose=judge'))).toMatch(/line 5.*version/);
    expect(err(good + 'GSTACK_EVAL_PRECONDITION: after the end\n')).toMatch(/after the end line/);
    expect(err(good.replace(/^GSTACK_EVAL_HEAD.*\n/m, ''))).toMatch(/GSTACK_EVAL_HEAD/);
  });
});

describe('price-gate: binding, pricing and the receipt (bin, simulated Capy host)', () => {
  let host: CapyHost;
  beforeEach(() => { host = capyHost(); });
  afterEach(() => host.cleanup());

  function writePlan(repo: string, plan: Parameters<typeof formatEvalCalls>[0]): string {
    const file = path.join(host.base, 'plan.calls');
    fs.writeFileSync(file, formatEvalCalls(plan));
    return file;
  }

  test('two call lines and one precondition are priced and listed, and the receipt binds price to gate, head, inputs and plan bytes', () => {
    const { repo, head, rowsSha } = scratchRepo(host.env);
    const file = writePlan(repo, { gate: GATE, head, inputs: [{ path: 'rows.jsonl', sha256: rowsSha }], preconditions: ['ANTHROPIC_API_KEY and OPENAI_API_KEY set at run time'], rows: twoRows });
    const out = path.join(host.base, 'receipts');
    const r = runGate(host, repo, ['--plan-file', file, '--gate', GATE, '--cap-usd', '20', '--out', out]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    // opus-5-5: 0.4 MTok × $4 + 0.2 MTok × $20 = $5.60; sol: 0.3 × $2 + 0.05 × $10 = $1.10
    expect(r.out).toContain('GATE_CALLS: purpose=answer model=anthropic/claude-opus-5-5 calls=100 usd=5.6 reservation_usd=0.17984 scope=full');
    expect(r.out).toContain('GATE_CALLS: purpose=judge model=gpt-6.1-sol calls=100 usd=1.1 reservation_usd=0.02648 scope=full');
    expect(r.out).toContain('GATE_PRECONDITION: ANTHROPIC_API_KEY and OPENAI_API_KEY set at run time');
    const price = r.out.split('\n').find(l => l.startsWith('GATE_PRICE: '))!;
    expect(price).toMatch(/^GATE_PRICE: total=6\.7 calls=200 purposes=answer,judge receipt=\S+$/);
    const receiptPath = price.split('receipt=')[1]!;
    expect(path.dirname(receiptPath)).toBe(out);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    expect(receipt).toMatchObject({
      schema_version: 1, result: 'priced', code: null, gate_command: GATE, gate_sha256: createHash('sha256').update(GATE).digest('hex'),
      head_sha: head, plan: { file, source: 'flag', declared_head: head, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') },
      inputs: [{ path: 'rows.jsonl', sha256: rowsSha }], total_usd: 6.7, calls: 200, cap_usd: 20, unpriced_override: null,
    });
    expect(typeof receipt.gstack_revision).toBe('string');
  });

  test('--gate-file prices the gate command the agent wrote to a file, byte for byte as --gate does; empty, missing or both refuse', () => {
    const { repo, head, rowsSha } = scratchRepo(host.env);
    const quoted = `${GATE} --label "it's \\"quoted\\" \\$HOME"`;
    const file = writePlan(repo, { gate: quoted, head, inputs: [{ path: 'rows.jsonl', sha256: rowsSha }], preconditions: [], rows: twoRows });
    const gateFile = path.join(host.base, 'gate-command.txt');
    fs.writeFileSync(gateFile, quoted + '\n');
    const viaFile = runGate(host, repo, ['--plan-file', file, '--gate-file', gateFile, '--out', path.join(host.base, 'a')]);
    expect(viaFile.err).toBe('');
    expect(viaFile.code).toBe(0);
    const viaFlag = runGate(host, repo, ['--plan-file', file, '--gate', quoted, '--out', path.join(host.base, 'b')]);
    const total = (out: string) => out.split('\n').find(l => l.startsWith('GATE_PRICE: '))!.replace(/ receipt=.*/, '');
    expect(total(viaFile.out)).toBe(total(viaFlag.out));
    const receipt = JSON.parse(fs.readFileSync(viaFile.out.split('receipt=')[1]!.split('\n')[0]!, 'utf8'));
    expect(receipt.gate_command).toBe(quoted);
    fs.writeFileSync(gateFile, '\n');
    expect(runGate(host, repo, ['--plan-file', file, '--gate-file', gateFile]).code).toBe(2);
    expect(runGate(host, repo, ['--plan-file', file, '--gate-file', path.join(host.base, 'absent')]).code).toBe(2);
    expect(runGate(host, repo, ['--plan-file', file, '--gate', quoted, '--gate-file', gateFile]).code).toBe(2);
  });

  test('the base policy price_file is read from the HEAD commit; a plan committed on top of its own head stays fresh until another file changes', () => {
    const { repo, rowsSha } = scratchRepo(host.env);
    const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, env: host.env, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
    fs.mkdirSync(path.join(repo, '.gstack'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.gstack', 'pregate.json'), JSON.stringify({ price_file: 'evals/gate.calls' }));
    git('add', '.gstack/pregate.json'); git('commit', '-q', '-m', 'policy');
    const produced = git('rev-parse', 'HEAD');
    git('update-ref', 'refs/remotes/origin/main', produced);
    fs.mkdirSync(path.join(repo, 'evals'));
    fs.writeFileSync(path.join(repo, 'evals', 'gate.calls'), formatEvalCalls({ gate: GATE, head: produced, inputs: [{ path: 'rows.jsonl', sha256: rowsSha }], preconditions: [], rows: twoRows }));
    git('add', 'evals/gate.calls'); git('commit', '-q', '-m', 'call plan');
    const out = path.join(host.base, 'receipts');
    let r = runGate(host, repo, ['--gate', GATE, '--base', 'main', '--out', out]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain(`GATE_PLAN: file=evals/gate.calls source=price_file`);
    expect(r.out).toContain('only the plan file changed since');
    const receipt = JSON.parse(fs.readFileSync(r.out.split('receipt=')[1]!.split('\n')[0]!, 'utf8'));
    expect(receipt).toMatchObject({ plan: { source: 'price_file', declared_head: produced }, head_sha: git('rev-parse', 'HEAD'), total_usd: 6.7 });
    fs.writeFileSync(path.join(repo, 'README.md'), 'later\n');
    git('add', 'README.md'); git('commit', '-q', '-m', 'later');
    r = runGate(host, repo, ['--gate', GATE, '--base', 'main', '--out', out]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/behind HEAD.*README\.md.*\(EVAL_PLAN_STALE\)/);
  });

  test('a declared price_file missing at HEAD refuses EVAL_PLAN_STALE (not overridable); an unresolvable base or an invalid pregate.json exits 3', () => {
    const { repo } = scratchRepo(host.env);
    const git = (...args: string[]) => spawnSync('git', args, { cwd: repo, env: host.env, encoding: 'utf8', timeout: 30_000 }).stdout.trim();
    const out = path.join(host.base, 'receipts');
    let r = runGate(host, repo, ['--gate', GATE, '--base', 'main', '--out', out, '--allow-unpriced', 'owner said so']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('(POLICY_SOURCE_UNAVAILABLE)');
    fs.mkdirSync(path.join(repo, '.gstack'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.gstack', 'pregate.json'), JSON.stringify({ price_file: 'evals/missing.calls' }));
    git('add', '.gstack/pregate.json'); git('commit', '-q', '-m', 'policy');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    r = runGate(host, repo, ['--gate', GATE, '--base', 'main', '--out', out, '--allow-unpriced', 'owner said so']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/evals\/missing\.calls.*\(EVAL_PLAN_STALE\)/);
    expect(r.out).not.toContain('GATE_UNPRICED_OVERRIDE');
    fs.writeFileSync(path.join(repo, '.gstack', 'pregate.json'), JSON.stringify({ price_file: '../outside.calls' }));
    git('add', '.gstack/pregate.json'); git('commit', '-q', '-m', 'bad policy');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'HEAD'));
    r = runGate(host, repo, ['--gate', GATE, '--base', 'main', '--out', out, '--allow-unpriced', 'owner said so']);
    expect(r.code).toBe(3);
    expect(r.err).toContain('(PREGATE_CONFIG_INVALID)');
    expect(fs.existsSync(out)).toBe(false);
  });

  test('an unknown or misspelled flag exits 2 instead of pricing without it', () => {
    const { repo } = scratchRepo(host.env);
    expect(runGate(host, repo, ['--gate', GATE, '--cap', '5']).code).toBe(2);
    expect(runGate(host, repo, ['--cap-usd', '5']).code).toBe(2);
  });

  test('nothing in the plan file is executed: a gate command and precondition that would create markers leave none', () => {
    const { repo, head, rowsSha } = scratchRepo(host.env);
    const marker = path.join(host.base, 'gate-ran');
    const gate = `touch ${marker}`;
    const file = writePlan(repo, { gate, head, inputs: [{ path: 'rows.jsonl', sha256: rowsSha }], preconditions: [`$(touch ${marker}-pre)`], rows: twoRows });
    const r = runGate(host, repo, ['--plan-file', file, '--gate', gate]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(`${marker}-pre`)).toBe(false);
  });

  test('a stale head, an input-hash mismatch and a gate-command mismatch each refuse EVAL_PLAN_STALE with no receipt', () => {
    const { repo, head, rowsSha } = scratchRepo(host.env);
    const out = path.join(host.base, 'receipts');
    const staleHead = writePlan(repo, { gate: GATE, head: 'f'.repeat(40), inputs: [{ path: 'rows.jsonl', sha256: rowsSha }], preconditions: [], rows: twoRows });
    let r = runGate(host, repo, ['--plan-file', staleHead, '--gate', GATE, '--out', out]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/head .*ffffffffffff.*\(EVAL_PLAN_STALE\)/);
    const badInput = writePlan(repo, { gate: GATE, head, inputs: [{ path: 'rows.jsonl', sha256: '0'.repeat(64) }], preconditions: [], rows: twoRows });
    r = runGate(host, repo, ['--plan-file', badInput, '--gate', GATE, '--out', out]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/rows\.jsonl.*sha256.*\(EVAL_PLAN_STALE\)/);
    const good = writePlan(repo, { gate: GATE, head, inputs: [{ path: 'rows.jsonl', sha256: rowsSha }], preconditions: [], rows: twoRows });
    r = runGate(host, repo, ['--plan-file', good, '--gate', `${GATE} --questions 500`, '--out', out]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/gate command.*\(EVAL_PLAN_STALE\)/);
    expect(fs.existsSync(out)).toBe(false);
  });

  test('malformed, partial (no end line) and empty-of-binding files refuse EVAL_DRY_RUN_FAILED naming the line', () => {
    const { repo, head } = scratchRepo(host.env);
    const file = writePlan(repo, { gate: GATE, head, inputs: [], preconditions: [], rows: twoRows });
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/GSTACK_EVAL_CALLS v1 end: lines=2\n$/, ''));
    let r = runGate(host, repo, ['--plan-file', file, '--gate', GATE]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/end line.*\(EVAL_DRY_RUN_FAILED\)/);
    fs.writeFileSync(file, formatEvalCalls({ gate: GATE, head, inputs: [], preconditions: [], rows: twoRows }).replace('calls=100', 'calls=lots'));
    r = runGate(host, repo, ['--plan-file', file, '--gate', GATE]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/line \d+.*calls.*\(EVAL_DRY_RUN_FAILED\)/);
  });

  test('no plan file, or a file with no call lines, is EVAL_GATE_UNPRICED exit 1; --allow-unpriced exits 0 with a recorded override', () => {
    const { repo, head, rowsSha } = scratchRepo(host.env);
    spawnSync('git', ['update-ref', 'refs/remotes/origin/main', head], { cwd: repo, env: host.env, timeout: 30_000 });
    const out = path.join(host.base, 'receipts');
    let r = runGate(host, repo, ['--gate', GATE, '--base', 'main', '--out', out]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('(EVAL_GATE_UNPRICED)');
    const empty = writePlan(repo, { gate: GATE, head, inputs: [{ path: 'rows.jsonl', sha256: rowsSha }], preconditions: [], rows: [] });
    r = runGate(host, repo, ['--plan-file', empty, '--gate', GATE, '--out', out]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('(EVAL_GATE_UNPRICED)');
    expect(r.out).toContain('GATE_PRICE: total=unknown calls=0 purposes=none');
    r = runGate(host, repo, ['--plan-file', empty, '--gate', GATE, '--out', out, '--allow-unpriced', 'owner accepts a bounded smoke on a seat']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('GATE_UNPRICED_OVERRIDE: owner accepts a bounded smoke on a seat (owner-authorized override; not authorization to spend)');
    const receipt = JSON.parse(fs.readFileSync(r.out.split('receipt=')[1]!.split('\n')[0]!, 'utf8'));
    expect(receipt).toMatchObject({ result: 'unpriced_override', code: 'EVAL_GATE_UNPRICED', unpriced_override: 'owner accepts a bounded smoke on a seat', total_usd: null });
  });

  test('an unpriced model makes its row and the total unknown, never zero, and fails EVAL_PRICE_MISSING', () => {
    const { repo, head } = scratchRepo(host.env);
    const file = writePlan(repo, { gate: GATE, head, inputs: [], preconditions: [], rows: [twoRows[0]!, { ...twoRows[1]!, model: 'acme/made-up-model' }] });
    const r = runGate(host, repo, ['--plan-file', file, '--gate', GATE]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('GATE_CALLS: purpose=judge model=acme/made-up-model calls=100 usd=unknown reservation_usd=unknown scope=full');
    expect(r.out).toMatch(/GATE_PRICE: total=unknown calls=200 /);
    expect(r.err).toContain('(EVAL_PRICE_MISSING)');
  });

  test('a total above --cap-usd is EVAL_GATE_OVER_CAP; a single-call reservation above the cap or the smoke cap fails reservation-fits-cap', () => {
    const { repo, head } = scratchRepo(host.env);
    const file = writePlan(repo, { gate: GATE, head, inputs: [], preconditions: [], rows: twoRows });
    let r = runGate(host, repo, ['--plan-file', file, '--gate', GATE, '--cap-usd', '5']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/6\.7.*cap \$5.*\(EVAL_GATE_OVER_CAP\)/);
    const smoke = writePlan(repo, { gate: GATE, head, inputs: [], preconditions: [], rows: [{ purpose: 'smoke-answer', model: 'claude-opus-5-5', calls: 2, in_tokens: 20_000, out_tokens: 4_000, max_out_tokens: 64_000, scope: 'smoke' }] });
    // one call: 10,000 in × $4 + 64,000 out × $20 per MTok = $1.32, under the $10 cap but over the $1 smoke cap
    r = runGate(host, repo, ['--plan-file', smoke, '--gate', GATE, '--cap-usd', '10', '--smoke-cap-usd', '1']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('CHECK: reservation-fits-cap exceeds ($1.3200 > smoke cap $1.00) purpose=smoke-answer');
    expect(r.err).toContain('(EVAL_GATE_OVER_CAP)');
    r = runGate(host, repo, ['--plan-file', smoke, '--gate', GATE, '--cap-usd', '1.2']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('CHECK: reservation-fits-cap exceeds ($1.3200 > cap $1.20) purpose=smoke-answer');
  });
});

describe('dry-run reservation-fits-cap', () => {
  test('with --cap, one call per arm (largest row input + output budget), priced, must fit under the cap', () => {
    const d = tmp();
    const rows = path.join(d, 'rows.jsonl');
    fs.writeFileSync(rows, [JSON.stringify({ prompt: 'x'.repeat(4_000) }), JSON.stringify({ prompt: 'x'.repeat(40_000) })].join('\n') + '\n');
    const retry = path.join(d, 'retry.txt'); fs.writeFileSync(retry, 'retry\n');
    // largest row 10,000 tokens; one gpt-6-astra call = 10,000 × $10 + 8,192 × $50 per MTok = $0.5096
    const tight = dryRun({ input: rows, arms: ['gpt-6-astra'], retryPrompt: retry, cap: 0.5 });
    expect(tight.checks.reservation_fits_cap).toMatchObject({ ok: false, cap: 0.5, max_input_tokens: 10_000 });
    expect(tight.checks.reservation_fits_cap!.per_arm['gpt-6-astra']).toBeCloseTo(0.5096, 6);
    expect(tight.pass).toBe(false);
    expect(renderDryRun(tight)).toContain('CHECK: reservation-fits-cap exceeds ($0.5096 > cap $0.50)');
    const roomy = dryRun({ input: rows, arms: ['gpt-6-astra'], retryPrompt: retry, cap: 1 });
    expect(roomy.checks.reservation_fits_cap!.ok).toBe(true);
    expect(roomy.pass).toBe(true);
    expect(dryRun({ input: rows, arms: ['gpt-6-astra'], retryPrompt: retry }).checks.reservation_fits_cap).toBeUndefined();
  });
});

describe('pricing rows with fetched sources (2026-10-12)', () => {
  test('the newest Sonnet, the newest Gemini Flash and gbrain embedding models are priced; Opus 4.7 is at its current list price', () => {
    expect(hasPricing('anthropic/claude-sonnet-5-5')).toBe(true);
    expect(estimateCostUsd({ input: 1_000_000, output: 1_000_000 }, 'claude-sonnet-5-5')).toBe(12);
    expect(estimateCostUsd({ input: 1_000_000, output: 1_000_000 }, 'claude-opus-4-7')).toBe(30);
    expect(hasPricing('google/gemini-3.8-flash')).toBe(true);
    for (const m of ['voyage:voyage-4', 'openai:text-embedding-3-large', 'text-embedding-3-small', 'gemini-embedding-2']) expect(hasPricing(m)).toBe(true);
    expect(estimateCostUsd({ input: 1_000_000, output: 0 }, 'voyage:voyage-4')).toBe(0.06);
    expect(hasPricing('voyage-4-nano')).toBe(false);
  });

  test('every model in a gbrain `eval longmemeval --call-plan` file is priced: dated Claude snapshots, the judge and the reranker', () => {
    expect(pricingRow('anthropic:claude-haiku-4-5-20251001')).toBe(PRICING['claude-haiku-4-5']);
    expect(estimateCostUsd({ input: 1_000_000, output: 1_000_000 }, 'openai:gpt-4o')).toBe(12.5);
    expect(hasPricing('gpt-4o-2024-05-13')).toBe(false);
    expect(estimateCostUsd({ input: 1_000_000, output: 0 }, 'voyage:rerank-2.5')).toBe(0.05);
    expect(estimateCostUsd({ input: 1_000_000, output: 0 }, 'rerank-2.5-lite')).toBe(0.02);
    expect(hasPricing('claude-haiku-4-5-2025100')).toBe(false);
  });
});
