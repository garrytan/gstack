/**
 * evals.yml and evals-main-backstop.yml under merge trains (plan GSTA-49 T1b).
 *
 * The job graph is simulated with a small evaluator of the GitHub expression
 * subset these workflows use (literals, contexts, ==, !=, &&, ||, !, contains,
 * fromJSON, format, status functions), so each run mode is checked by which
 * jobs and steps actually run and what their expressions evaluate to. The
 * inert case: without a train block a PR push and a plain dispatch run today's
 * jobs and steps with today's values, plus the free route job.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { bisectArtifact } from '../lib/ship-queue-train-verdict';

const ROOT = path.resolve(import.meta.dir, '..');
type Step = { id?: string; name?: string; uses?: string; if?: string; run?: string; env?: Record<string, unknown>; with?: Record<string, unknown> };
type Job = { if?: string; needs?: string | string[]; outputs?: Record<string, string>; permissions?: Record<string, string>; steps: Step[]; strategy?: { matrix: Record<string, string> } };
type Workflow = { 'run-name'?: string; on: Record<string, any>; concurrency: { group: string; 'cancel-in-progress': boolean }; permissions?: unknown; jobs: Record<string, Job> };
const load = (rel: string) => Bun.YAML.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8')) as Workflow;
const evals = load('.github/workflows/evals.yml');
const backstopWf = load('.github/workflows/evals-main-backstop.yml');

// ── expression subset ────────────────────────────────────────────────────
const STAR = Symbol('star');
type Star = { [STAR]: unknown[] };
const isStar = (v: unknown): v is Star => typeof v === 'object' && v !== null && STAR in v;
const truthy = (v: unknown) => !(v === false || v === 0 || v === '' || v === null || v === undefined || Number.isNaN(v));
function looseEq(a: unknown, b: unknown): boolean {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if ((typeof a === 'object' && a !== null) || (typeof b === 'object' && b !== null)) return a === b;
  if (typeof a === typeof b) return a === b;
  const num = (v: unknown) => (v === null ? 0 : typeof v === 'boolean' ? Number(v) : typeof v === 'string' ? (v.trim() === '' ? 0 : Number(v)) : Number(v));
  return num(a) === num(b);
}
const str = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
function evaluate(expr: string, ctx: Record<string, unknown>, status: { success: boolean; failure: boolean }): unknown {
  const src = expr.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
  const re = /\s*(?:('(?:[^']|'')*')|(\d+(?:\.\d+)?)|(==|!=|&&|\|\||[!()[\],.*])|([A-Za-z_][A-Za-z0-9_-]*))/y;
  const tokens: string[] = [];
  while (re.lastIndex < src.length) {
    const at = re.lastIndex;
    const m = re.exec(src);
    if (!m) { if (/^\s*$/.test(src.slice(at))) break; throw new Error(`cannot tokenize ${src.slice(at)}`); }
    tokens.push(m[1] ?? m[2] ?? m[3] ?? m[4]!);
  }
  let i = 0;
  const take = (want?: string) => { const t = tokens[i++]; if (want !== undefined && t !== want) throw new Error(`expected ${want}, got ${t} in ${src}`); return t!; };
  const fns: Record<string, (...a: unknown[]) => unknown> = {
    always: () => true, cancelled: () => false, success: () => status.success, failure: () => status.failure,
    contains: (hay, needle) => (Array.isArray(hay) || isStar(hay) ? (isStar(hay) ? hay[STAR] : hay as unknown[]).some(v => looseEq(v, needle)) : str(hay).toLowerCase().includes(str(needle).toLowerCase())),
    fromJSON: (s) => JSON.parse(str(s)),
    format: (f, ...args) => str(f).replace(/\{(\d+)\}/g, (_, n) => str(args[Number(n)])),
    startsWith: (a, b) => str(a).toLowerCase().startsWith(str(b).toLowerCase()),
    hashFiles: () => 'hash',
  };
  const member = (v: unknown, key: string): unknown => {
    if (isStar(v)) return { [STAR]: v[STAR].map(item => member(item, key)) };
    return v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[key] ?? null : null;
  };
  const primary = (): unknown => {
    const t = take();
    if (t === '(') { const v = or(); take(')'); return v; }
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (/^\d/.test(t)) return Number(t);
    if (t === 'true' || t === 'false') return t === 'true';
    if (t === 'null') return null;
    if (tokens[i] === '(') {
      take('(');
      const args: unknown[] = [];
      while (tokens[i] !== ')') { args.push(or()); if (tokens[i] === ',') take(','); }
      take(')');
      if (!fns[t]) throw new Error(`unknown function ${t}`);
      return fns[t]!(...args);
    }
    return ctx[t] ?? null;
  };
  const postfix = (): unknown => {
    let v = primary();
    for (;;) {
      if (tokens[i] === '.') { take('.'); const key = take(); v = key === '*' ? { [STAR]: Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v) : [] } : member(v, key); }
      else if (tokens[i] === '[') { take('['); const k = or(); take(']'); v = member(v, str(k)); }
      else return v;
    }
  };
  const unary = (): unknown => (tokens[i] === '!' ? (take('!'), !truthy(unary())) : postfix());
  const eq = (): unknown => {
    let l = unary();
    while (tokens[i] === '==' || tokens[i] === '!=') { const op = take(); const r = unary(); l = op === '==' ? looseEq(l, r) : !looseEq(l, r); }
    return l;
  };
  const and = (): unknown => { let l = eq(); while (tokens[i] === '&&') { take(); const r = eq(); l = truthy(l) ? r : l; } return l; };
  const or = (): unknown => { let l = and(); while (tokens[i] === '||') { take(); const r = and(); l = truthy(l) ? l : r; } return l; };
  const value = or();
  if (i !== tokens.length) throw new Error(`trailing tokens in ${src}`);
  return value;
}
const interpolate = (text: unknown, ctx: Record<string, unknown>) =>
  typeof text === 'string' ? text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, e) => str(evaluate(e, ctx, { success: true, failure: false }))) : text;

// ── job graph ─────────────────────────────────────────────────────────────
const SHA = { main: 'm'.repeat(40), head: 'h'.repeat(40), base: 'b'.repeat(40), merge: 'c'.repeat(40), screenBase: 'e'.repeat(40), screenHead: 'f'.repeat(40) };
interface Scenario { github: Record<string, unknown>; inputs: Record<string, unknown>; outputs?: Record<string, Record<string, string>>; results?: Record<string, string> }
const ROUTE = { mode: '', record_artifact: '', full_gate_check: '', screen_head: '', screen_base: '', screen_branch: '', superseded: '', bisect_slices: '', bisect_timeouts: '', bisect_refs: '' };
function simulate(wf: Workflow, s: Scenario) {
  const result: Record<string, string> = {};
  const outputs: Record<string, Record<string, unknown>> = {};
  const ran: Record<string, { ctx: Record<string, unknown>; steps: Step[] }> = {};
  const pending = Object.keys(wf.jobs);
  while (pending.length) {
    const id = pending.find(j => [wf.jobs[j]!.needs ?? []].flat().every(n => n in result));
    if (!id) throw new Error('needs cycle');
    pending.splice(pending.indexOf(id), 1);
    const job = wf.jobs[id]!;
    const needs = [job.needs ?? []].flat();
    const ctx = { github: s.github, inputs: s.inputs, vars: {}, secrets: {}, env: {}, steps: {}, matrix: {}, runner: {},
      needs: Object.fromEntries(needs.map(n => [n, { result: result[n], outputs: outputs[n] ?? {} }])) };
    const allOk = needs.every(n => result[n] === 'success');
    const cond = job.if === undefined ? 'success()' : String(job.if);
    const value = truthy(evaluate(cond, ctx, { success: allOk, failure: needs.some(n => result[n] === 'failure') }));
    const runs = /\b(success|failure|always|cancelled)\(\)/.test(cond) ? value : allOk && value;
    result[id] = runs ? s.results?.[id] ?? 'success' : 'skipped';
    outputs[id] = runs ? Object.fromEntries(Object.entries(job.outputs ?? {}).map(([k, v]) => [k, s.outputs?.[id]?.[k] ?? interpolate(v, ctx)])) : {};
    if (runs) ran[id] = { ctx, steps: job.steps.filter(step => step.if === undefined || truthy(evaluate(String(step.if), ctx, { success: true, failure: false }))) };
  }
  const step = (job: string, name: string) => {
    const found = ran[job]?.steps.find(st => st.name === name);
    return found ? { env: Object.fromEntries(Object.entries(found.env ?? {}).map(([k, v]) => [k, interpolate(v, ran[job]!.ctx)])),
      with: Object.fromEntries(Object.entries(found.with ?? {}).map(([k, v]) => [k, interpolate(v, ran[job]!.ctx)])), run: found.run } : null;
  };
  const checkout = (job: string) => {
    const found = ran[job]?.steps.find(st => st.uses?.startsWith('actions/checkout@'));
    return found ? Object.fromEntries(Object.entries(found.with ?? {}).map(([k, v]) => [k, interpolate(v, ran[job]!.ctx)])) : null;
  };
  const top = { github: s.github, inputs: s.inputs };
  return { jobs: Object.keys(ran).sort(), steps: (job: string) => ran[job]?.steps.map(st => st.name ?? st.uses) ?? [], step, checkout, result,
    group: interpolate(wf.concurrency.group, top), runName: interpolate(wf['run-name'] ?? '', top) };
}
const pr = (labels: string[] = []) => ({ event_name: 'pull_request', actor: 'garrytan', repository: 'garrytan/gstack', repository_id: 1, sha: SHA.main, run_id: 7, run_attempt: 1, ref_name: '42/merge',
  event: { pull_request: { number: 42, head: { sha: SHA.head, ref: 'feature', repo: { full_name: 'garrytan/gstack' } }, base: { sha: SHA.base }, labels: labels.map(name => ({ name })) },
    repository: { default_branch: 'main' } } });
const dispatch = (ref = 'main') => ({ event_name: 'workflow_dispatch', actor: 'garrytan', repository: 'garrytan/gstack', repository_id: 1, sha: SHA.main, run_id: 7, run_attempt: 1, ref_name: ref,
  event: { repository: { default_branch: 'main' } } });
const INPUTS = { evals_all: true, base_ref: '', base_sha: '', expected_sha: '', nonce: '', pr_receipts: '', cases: '', prefix_shas: '', screen_pr: '', screen_merge_sha: '', screen_policy: '' };
// rerun-plan is the free rule-16 planner (F1); its paid eval-rerun runs only when it plans a rerun.
const TODAY_PR_JOBS = ['build-image', 'eval-slices', 'plan-slices', 'readiness', 'recover-receipts', 'rerun-plan', 'slices-comment', 'slices-report'];
const TODAY_DISPATCH_JOBS = ['build-image', 'eval-slices', 'plan-slices', 'rerun-plan', 'slices-report'];
const TRAIN_STEPS = ['Write the train record', 'Upload the train record', "Check the screen's PR head (Free Tests)", 'Plan the bisect (one executor per prefix)', 'Hand the bisect plan to its executors'];
const train = { record_artifact: 'gstack-train-record', full_gate_check: 'gstack/full-gate' };

describe('without a train block nothing changes (the inert proof)', () => {
  test("a PR push runs today's jobs and steps with today's values, plus the free route job", () => {
    const sim = simulate(evals, { github: pr(), inputs: {}, outputs: { route: { ...ROUTE, mode: 'pr' } } });
    expect(sim.jobs).toEqual([...TODAY_PR_JOBS, 'route'].sort());
    for (const job of sim.jobs) for (const name of TRAIN_STEPS) expect(sim.steps(job), job).not.toContain(name);
    expect(sim.group).toBe('evals-42');
    expect(sim.runName).toBe('');
    expect(sim.steps('recover-receipts')).toEqual(expect.arrayContaining(["Restore this PR's verified judge and E2E results", 'Recover receipts of cancelled runs (base-ref code)',
      'Find a gate verdict to reuse (R2a/R2, base-ref code)', 'Hand a gate reuse candidate to plan-slices', 'Hand the receipt store to plan-slices']));
    expect(sim.checkout('recover-receipts')?.ref).toBe(SHA.base);
    expect(sim.step('recover-receipts', 'Find a gate verdict to reuse (R2a/R2, base-ref code)')!.env).toMatchObject({
      PR_NUMBER: '42', HEAD_REPO: 'garrytan/gstack', HEAD_BRANCH: 'feature', HEAD_SHA: SHA.head, TESTED_SHA: SHA.main, SCREEN_POLICY: '' });
    for (const job of ['plan-slices', 'eval-slices', 'slices-report']) expect(sim.checkout(job)?.ref ?? '', job).toBe('');
    expect(sim.checkout('slices-report')?.['fetch-depth']).toBe('1');
    expect(sim.step('plan-slices', 'Emit run manifest')!.env.EVALS_BASE).toBe('');
    expect(sim.steps('plan-slices')).toEqual(expect.arrayContaining(['Download a gate reuse candidate', 'Confirm gate verdict reuse (R2a/R2)', 'Carry the receipt store to the report']));
    expect(sim.step('slices-report', "Bind this run's verdict for reuse (R2a/R2)")!.env).toMatchObject({ PR_NUMBER: '42', HEAD_SHA: SHA.head, TESTED_SHA: SHA.main, SCREEN_POLICY: '' });
    expect(sim.step('slices-comment', 'Post PR comment')!.env).toMatchObject({ PR_NUMBER: '42', SCREEN_POLICY: '' });
  });

  test("a plain dispatch (eval:bg, backstop) runs today's jobs, plus route", () => {
    const sim = simulate(evals, { github: dispatch('feature'), inputs: { ...INPUTS, nonce: 'pr-x', evals_all: false, expected_sha: SHA.main }, outputs: { route: { ...ROUTE, mode: 'dispatch' } } });
    expect(sim.jobs).toEqual([...TODAY_DISPATCH_JOBS, 'route'].sort());
    expect(sim.group).toBe('evals-7');
    expect(sim.runName).toBe('E2E Evals [eval-bg pr-x]');
    for (const job of ['plan-slices', 'eval-slices', 'slices-report']) expect(sim.checkout(job)?.ref ?? '', job).toBe('');
    expect(sim.steps('slices-report')).not.toContain("Bind this run's verdict for reuse (R2a/R2)");
    const receipts = simulate(evals, { github: dispatch('feature'), inputs: { ...INPUTS, nonce: 'pr-x', evals_all: false, pr_receipts: '42' }, outputs: { route: { ...ROUTE, mode: 'dispatch' } } });
    expect(receipts.jobs).toContain('recover-receipts');
    expect(receipts.steps('recover-receipts')).toContain('Recover receipts of cancelled runs (base-ref code)');
  });

  test('a fork PR and a Dependabot PR still start nothing paid', () => {
    const fork = pr();
    (fork.event.pull_request.head.repo as { full_name: string }).full_name = 'fork/gstack';
    expect(simulate(evals, { github: fork, inputs: {}, outputs: { route: { ...ROUTE, mode: 'pr' } } }).jobs).toEqual(['build-image', 'route']);
    expect(simulate(evals, { github: { ...pr(), actor: 'dependabot[bot]' }, inputs: {} }).jobs).toEqual([]);
  });
});

describe('under a train block (the gate edits, each only on its mode)', () => {
  test('a PR push starts no paid slice and waits for nothing: route, the image and the free screening summary only', () => {
    const sim = simulate(evals, { github: pr(), inputs: {}, outputs: { route: { ...ROUTE, ...train, mode: 'pr-summary' } } });
    expect(sim.jobs).toEqual(['build-image', 'route', 'screen-summary']);
    expect(simulate(evals, { github: pr(), inputs: {}, outputs: { route: { ...ROUTE, mode: 'pr' } } }).jobs).toContain('readiness');
    const summary = evals.jobs['screen-summary']!;
    expect(summary.permissions).toEqual({ contents: 'read' });
    expect(JSON.stringify(summary)).not.toMatch(/secrets\.|restore-deps|bun install/);
    expect(summary.steps.at(-1)!.run).toContain('--emit-plan /tmp/paid-plan/manifest.json --slices 1');
    expect(summary.steps.at(-1)!.run).toContain('scripts/train-gate.ts screen-summary /tmp/paid-plan/manifest.json --pr "$PR_NUMBER"');
  });

  test('a dispatched screen tests its pinned merge commit, reuses and binds as a screen, comments on its PR, and is keyed on the PR', () => {
    const inputs = { ...INPUTS, evals_all: false, nonce: 'pr.screen.narrow-x', expected_sha: SHA.merge, base_ref: 'main', base_sha: SHA.base, screen_pr: '42', screen_merge_sha: SHA.merge, screen_policy: 'narrow' };
    const route = { ...ROUTE, ...train, mode: 'screen', screen_head: SHA.screenHead, screen_base: SHA.screenBase, screen_branch: 'feature' };
    const sim = simulate(evals, { github: dispatch(), inputs, outputs: { route } });
    expect(sim.jobs).toEqual(['build-image', 'eval-slices', 'plan-slices', 'recover-receipts', 'rerun-plan', 'route', 'slices-comment', 'slices-report']);
    expect(sim.group).toBe('evals-screen-42');
    expect(sim.runName).toBe('E2E Evals [eval-bg pr.screen.narrow-x] screen #42');
    expect(sim.steps('recover-receipts')).not.toContain('Recover receipts of cancelled runs (base-ref code)');
    expect(sim.checkout('recover-receipts')?.ref).toBe(SHA.screenBase);
    expect(sim.step('recover-receipts', 'Find a gate verdict to reuse (R2a/R2, base-ref code)')!.env).toMatchObject({
      PR_NUMBER: '42', HEAD_REPO: 'garrytan/gstack', HEAD_BRANCH: 'feature', HEAD_SHA: SHA.screenHead, TESTED_SHA: SHA.merge, SCREEN_POLICY: 'narrow' });
    for (const job of ['plan-slices', 'eval-slices', 'slices-report']) expect(sim.checkout(job)?.ref, job).toBe(SHA.merge);
    expect(sim.step('plan-slices', 'Emit run manifest')!.env.EVALS_BASE).toBe(SHA.screenBase);
    expect(sim.steps('plan-slices')).toContain('Confirm gate verdict reuse (R2a/R2)');
    const bind = sim.step('slices-report', "Bind this run's verdict for reuse (R2a/R2)")!;
    expect(bind.env).toMatchObject({ PR_NUMBER: '42', HEAD_SHA: SHA.screenHead, TESTED_SHA: SHA.merge, SCREEN_POLICY: 'narrow' });
    expect(bind.run).toContain('${SCREEN_POLICY:+--purpose screen --screen-policy "$SCREEN_POLICY"}');
    expect(sim.steps('slices-report')).not.toContain('Write the train record');
    expect(sim.step('slices-comment', 'Post PR comment')!.env).toMatchObject({ PR_NUMBER: '42', SCREEN_POLICY: 'narrow', SCREEN_MERGE_SHA: SHA.merge });
    const superseded = simulate(evals, { github: dispatch(), inputs, outputs: { route: { ...route, superseded: 'true' } } });
    expect(superseded.jobs).toEqual(['build-image', 'route']);
  });

  test('a train gate runs the full gate, writes its record from the report and publishes the check; it never reuses or binds', () => {
    const inputs = { ...INPUTS, nonce: 'gate.train-x', expected_sha: SHA.head };
    const sim = simulate(evals, { github: dispatch('train/t1'), inputs, outputs: { route: { ...ROUTE, ...train, mode: 'train' } } });
    expect(sim.jobs).toEqual(['build-image', 'eval-slices', 'plan-slices', 'rerun-plan', 'route', 'slices-report', 'train-check']);
    expect(sim.steps('plan-slices')).not.toContain('Confirm gate verdict reuse (R2a/R2)');
    expect(sim.steps('slices-report')).not.toContain("Bind this run's verdict for reuse (R2a/R2)");
    expect(sim.steps('slices-report')).toEqual(expect.arrayContaining(['Write the train record', 'Upload the train record']));
    expect(sim.checkout('slices-report')?.['fetch-depth']).toBe('0');
    expect(sim.step('slices-report', 'Write the train record')!.run).toContain('scripts/train-gate.ts train-record /tmp/paid-report --nonce "$NONCE" --head "$HEAD_SHA"');
    expect(sim.step('slices-report', 'Upload the train record')!.with).toMatchObject({ name: 'gstack-train-record', path: '/tmp/train-record', overwrite: true });
    expect(simulate(evals, { github: dispatch('train/t1'), inputs, outputs: { route: { ...ROUTE, ...train, mode: 'train' } }, results: { 'slices-report': 'failure' } }).jobs).not.toContain('train-check');
  });

  test('the check run is published only for a complete GREEN census of the train head, by a job with checks: write and no repository code', () => {
    const check = evals.jobs['train-check']!;
    expect(check.permissions).toEqual({ checks: 'write' });
    expect(check.steps.some(st => st.uses?.startsWith('actions/checkout@') || st.uses?.startsWith('oven-sh/setup-bun@'))).toBe(false);
    const publish = check.steps.find(st => st.name === 'Publish the full-gate check on the train head')!;
    expect(publish.run).toContain('.verdict == "GREEN" and .census.complete == true and .nonce == $nonce and .head_sha == $head');
    expect(publish.run).toContain('-f status=completed -f conclusion=success');
    expect(publish.env).toMatchObject({ CHECK: '${{ needs.plan-slices.outputs.full_gate_check }}', HEAD_SHA: '${{ inputs.expected_sha }}' });
  });

  test("a bisect runs one executor per prefix only, uploading each prefix's record under the name T1 reads", () => {
    const inputs = { ...INPUTS, nonce: 'gate.bisect-x', expected_sha: SHA.head, cases: 'case-a', prefix_shas: SHA.base };
    const sim = simulate(evals, { github: dispatch('train/t1'), inputs, outputs: { route: { ...ROUTE, ...train, mode: 'bisect' } } });
    expect(sim.jobs).toEqual(['build-image', 'route', 'train-bisect']);
    const job = evals.jobs['train-bisect']!;
    expect(job.strategy!.matrix.slice).toBe('${{ fromJSON(needs.route.outputs.bisect_slices) }}');
    const upload = job.steps.find(st => st.name === 'Upload the prefix record')!;
    const name = String(upload.with!.name).replace('${{ needs.route.outputs.record_artifact }}', 'gstack-train-record').replace('${{ steps.prefix.outputs.short }}', SHA.base.slice(0, 12));
    expect(name).toBe(bisectArtifact('gstack-train-record', SHA.base));
    expect(job.steps.find(st => st.name === 'Verify the prefix checkout')!.run).toContain('echo "short=${PREFIX_SHA:0:12}"');
  });

  test('a refused dispatch starts nothing paid', () => {
    const sim = simulate(evals, { github: dispatch('train/t1'), inputs: { ...INPUTS, nonce: 'gate.bisect-x' }, outputs: { route: { ...ROUTE, mode: '' } }, results: { route: 'failure' } });
    expect(sim.jobs).toEqual(['build-image', 'route']);
  });
});

describe('GSTA-48 open items', () => {
  test('a head the readiness job blocked replaces the stale verdict comment and plans nothing (P3-1)', () => {
    const sim = simulate(evals, { github: pr(), inputs: {}, outputs: { route: { ...ROUTE, mode: 'pr' } }, results: { readiness: 'failure' } });
    expect(sim.jobs).toEqual(['build-image', 'readiness', 'readiness-comment', 'route']);
    const comment = evals.jobs['readiness-comment']!;
    expect(comment.steps.some(st => st.uses)).toBe(false);
    expect(comment.steps[0]!.run).toContain('if [ -z "$COMMENT_ID" ]; then exit 0; fi');
    expect(comment.steps[0]!.run).toContain('## E2E Evals: ⛔ NOT RUN on');
    expect(comment.steps[0]!.run).not.toContain('PASS');
    expect(simulate(evals, { github: pr(), inputs: {}, outputs: { route: { ...ROUTE, mode: 'pr' } } }).jobs).not.toContain('readiness-comment');
  });
});

describe('rule-16 rerun wiring (F1)', () => {
  const planned = { planned: 'true', slices: '[1]', slice_timeouts: '[0,40]' };
  test('the paid rerun runs only when rerun-plan planned one, on the same checkout as the slices, and the report waits for it', () => {
    const quiet = simulate(evals, { github: pr(), inputs: {}, outputs: { route: { ...ROUTE, mode: 'pr' }, 'rerun-plan': { planned: 'false', slices: '', slice_timeouts: '' } } });
    expect(quiet.jobs).not.toContain('eval-rerun');
    const sim = simulate(evals, { github: pr(), inputs: {}, outputs: { route: { ...ROUTE, mode: 'pr' }, 'rerun-plan': planned } });
    expect(sim.jobs).toEqual([...TODAY_PR_JOBS, 'eval-rerun', 'route'].sort());
    for (const job of ['rerun-plan', 'eval-rerun']) expect(sim.checkout(job)?.ref ?? '', job).toBe(sim.checkout('eval-slices')?.ref ?? '');
    expect([evals.jobs['slices-report']!.needs].flat()).toEqual(expect.arrayContaining(['rerun-plan', 'eval-rerun']));
    const screen = simulate(evals, { github: dispatch(), inputs: { ...INPUTS, evals_all: false, nonce: 'pr.screen.narrow-x', expected_sha: SHA.merge, base_ref: 'main', base_sha: SHA.base, screen_pr: '42', screen_merge_sha: SHA.merge, screen_policy: 'narrow' },
      outputs: { route: { ...ROUTE, ...train, mode: 'screen', screen_head: SHA.screenHead, screen_base: SHA.screenBase, screen_branch: 'feature' }, 'rerun-plan': planned } });
    for (const job of ['rerun-plan', 'eval-rerun']) expect(screen.checkout(job)?.ref, job).toBe(SHA.merge);
    const trainRun = simulate(evals, { github: dispatch('train/t1'), inputs: { ...INPUTS, nonce: 'gate.train-x', expected_sha: SHA.head }, outputs: { route: { ...ROUTE, ...train, mode: 'train' }, 'rerun-plan': planned } });
    expect(trainRun.jobs).toEqual(expect.arrayContaining(['rerun-plan', 'eval-rerun', 'slices-report', 'train-check']));
  });

  test('a real red (reconcile exit 1, e.g. a case red twice) fails slices-report and so the run, after every rerun path', () => {
    // slices-report runs whether the slices and the rerun passed, failed or were skipped, and no job may swallow its failure.
    for (const results of [{}, { 'eval-slices': 'failure' }, { 'eval-rerun': 'failure' }, { 'eval-rerun': 'skipped' }] as Array<Record<string, string>>) {
      const sim = simulate(evals, { github: pr(), inputs: {}, outputs: { route: { ...ROUTE, mode: 'pr' }, 'rerun-plan': planned }, results });
      expect(sim.jobs, JSON.stringify(results)).toContain('slices-report');
    }
    for (const [id, job] of Object.entries(evals.jobs)) expect((job as Record<string, unknown>)['continue-on-error'], id).toBeUndefined();
    const report = evals.jobs['slices-report']!;
    const reconcile = report.steps.find(st => st.id === 'reconcile')!;
    expect(reconcile.run).toContain('echo "exit=${PIPESTATUS[0]}"');
    const fail = report.steps.at(-1)!;
    expect(fail.name).toBe('Fail the workflow when reconciliation failed');
    expect(fail.run).toBe('exit 1');
    const fires = (exit: string | null, reused: string | null = null) => truthy(evaluate(String(fail.if), { steps: { reconcile: { outputs: { exit } }, reused: { outputs: { exit: reused } } } }, { success: true, failure: false }));
    expect(fires('1')).toBe(true);
    expect(fires('0')).toBe(false);
    // A red report also withholds the train check (the train verdict reads the run's failure too).
    const trainRun = simulate(evals, { github: dispatch('train/t1'), inputs: { ...INPUTS, nonce: 'gate.train-x', expected_sha: SHA.head }, outputs: { route: { ...ROUTE, ...train, mode: 'train' }, 'rerun-plan': planned }, results: { 'slices-report': 'failure' } });
    expect(trainRun.jobs).not.toContain('train-check');
  });

  test('a confirmed verdict reuse plans and runs no rerun', () => {
    const sim = simulate(evals, { github: pr(), inputs: {}, outputs: { route: { ...ROUTE, mode: 'pr' }, 'plan-slices': { gate_reuse: 'true' }, 'rerun-plan': planned } });
    expect(sim.jobs).not.toContain('rerun-plan');
    expect(sim.jobs).not.toContain('eval-rerun');
    expect(sim.jobs).not.toContain('eval-slices');
  });

  test('the rerun runs its own attempt-scoped manifest fresh: no receipts in, none out, results under paid-rerun-*', () => {
    const job = evals.jobs['eval-rerun']!;
    expect(job.strategy!.matrix.slice).toBe('${{ fromJSON(needs.rerun-plan.outputs.slices) }}');
    expect(job.steps.find(st => st.uses?.startsWith('actions/download-artifact@'))!.with).toEqual({ name: 'rerun-plan-a${{ github.run_attempt }}', path: '/tmp/paid-rerun-plan' });
    const run = job.steps.find(st => st.name === 'Rerun slice ${{ matrix.slice }} (rule 16, once)')!;
    expect(run.run).toContain('--plan /tmp/paid-rerun-plan/rerun-plan-a${{ github.run_attempt }}/manifest.json --slice ${{ matrix.slice }}');
    expect(Object.keys(run.env!).filter(key => key.startsWith('EVALS_CACHE'))).toEqual([]);
    expect(JSON.stringify(job)).not.toContain('receipts');
    expect(job.steps.find(st => st.name === 'Upload rerun results')!.with).toMatchObject({ name: 'paid-rerun-${{ matrix.slice }}-a${{ github.run_attempt }}', path: run.env!.GSTACK_EVAL_DIR });
    const uploads = Object.values(evals.jobs).flatMap(j => j.steps).map(st => String(st.with?.name ?? '')).filter(Boolean);
    expect(uploads.filter(name => name.startsWith('paid-rerun-'))).toEqual(['paid-rerun-${{ matrix.slice }}-a${{ github.run_attempt }}']);
    const plan = evals.jobs['rerun-plan']!;
    expect(plan.permissions).toEqual({ contents: 'read' });
    expect(JSON.stringify(plan)).not.toMatch(/secrets\.|restore-deps|bun install/);
    expect(plan.steps.find(st => st.name === "Plan the rule-16 rerun of this attempt's failed cases")!.run!.replace(/\s*\\\n\s*/g, ' '))
      .toContain('--report /tmp/paid-report --rerun-plan "/tmp/paid-rerun-plan/rerun-plan-a$GITHUB_RUN_ATTEMPT"');
    expect(plan.steps.find(st => st.name === 'Hand the rerun manifest to its executors and the report')!.with).toMatchObject({ name: 'rerun-plan-a${{ github.run_attempt }}', path: '/tmp/paid-rerun-plan' });
  });

  test('a lone rerun artifact never unpacks over the report root or the plan manifest (run 39363705692 did)', () => {
    for (const id of ['rerun-plan', 'slices-report']) {
      const downloads = evals.jobs[id]!.steps.filter(st => st.uses?.startsWith('actions/download-artifact@') && /^(paid-rerun|rerun-plan)-/.test(String(st.with?.pattern ?? '')));
      expect(downloads.map(st => st.with), id).toEqual([{ pattern: 'paid-rerun-*', path: '/tmp/paid-report/reruns' }, { pattern: 'rerun-plan-a*', path: '/tmp/paid-report' }]);
    }
    // The plan artifact's root is a directory holding rerun-plan-a<attempt>/manifest.json, written there by the planner.
    const plan = evals.jobs['rerun-plan']!;
    expect(plan.steps.find(st => st.name === 'Hand the rerun manifest to its executors and the report')!.with!.path).toBe('/tmp/paid-rerun-plan');
    expect(plan.steps.find(st => st.name === "Plan the rule-16 rerun of this attempt's failed cases")!.run).toContain('PLAN="/tmp/paid-rerun-plan/rerun-plan-a$GITHUB_RUN_ATTEMPT/manifest.json"');
  });

  test('the report reads every attempt and rerun, publishes flake records, and the comment never hides a non-flaky failed record', () => {
    const report = evals.jobs['slices-report']!;
    const patterns = report.steps.filter(st => st.uses?.startsWith('actions/download-artifact@')).map(st => st.with?.pattern ?? st.with?.name);
    expect(patterns).toEqual(expect.arrayContaining(['paid-slice-*', 'paid-rerun-*', 'rerun-plan-a*']));
    expect(report.steps.find(st => st.name === 'Upload flake records for the daily flaky-fix pass')!.with).toMatchObject({ name: 'flake-records-a${{ github.run_attempt }}', path: '/tmp/paid-report/flake-records.jsonl' });
    const comment = evals.jobs['slices-comment']!.steps.find(st => st.name === 'Post PR comment')!.run!;
    expect(comment).toContain('[ "$FAILED" -gt "$FLAKY_FAILED" ]');
    expect(comment).toContain("FLAKY_FAILED=$(jq -r '.flakyCollectorFailures // 0' \"$VERIFIED\")");
    expect(comment).toContain('((.flakyCollectorFailures // 0) <= .totals.failed)');
  });
});

describe.skipIf(!Bun.which('jq') || !Bun.which('bash'))('the route job reads the train policy from the base revision with git and jq only', () => {
  const route = evals.jobs.route!;
  const policyStep = route.steps.find(st => st.name === 'Read the train policy (base revision)')!;
  const routeStep = route.steps.find(st => st.name === 'Route this run')!;
  function fixture(policy: unknown): { dir: string; base: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evals-route-'));
    const git = (...args: string[]) => spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', timeout: 30_000 });
    git('init', '-q', '-b', 'main');
    if (policy !== undefined) { fs.mkdirSync(path.join(dir, '.gstack')); fs.writeFileSync(path.join(dir, '.gstack/ship-policy.json'), typeof policy === 'string' ? policy : JSON.stringify(policy)); }
    fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    return { dir, base: git('rev-parse', 'HEAD').stdout.trim() };
  }
  function run(script: string, dir: string, env: Record<string, string>): Record<string, string> {
    const out = path.join(dir, '.github-output');
    fs.writeFileSync(out, '');
    const r = spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8', timeout: 30_000,
      env: { PATH: process.env.PATH ?? '', HOME: dir, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(dir, '.summary'), ...env } });
    if (r.status !== 0) throw new Error(r.stderr);
    return Object.fromEntries(fs.readFileSync(out, 'utf8').split('\n').filter(Boolean).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  }
  const block = { gate_workflow: 'evals.yml', free_workflow: 'free-tests.yml', full_gate_check: 'gstack/full-gate', record_artifact: 'gstack-train-record', max_size: 5, fill_hours: 3, screen_selection: 'none', trial_reservation_usd: 1.5 };

  test('no policy, no train block, or an invalid one: train=false, and a PR push routes pr', () => {
    for (const policy of [undefined, { bump: 'patch' }, { bump: 'patch', train: null }, { train: { ...block, record_artifact: 'bad name!' } }, '{not json']) {
      const fx = fixture(policy);
      const out = run(policyStep.run!, fx.dir, { BASE_SHA: fx.base, DEFAULT_BRANCH: 'main' });
      expect(out, JSON.stringify(policy)).toEqual({ train: 'false' });
      expect(run(routeStep.run!, fx.dir, { GITHUB_EVENT_NAME: 'pull_request', TRAIN_POLICY: out.train! })).toEqual({ mode: 'pr' });
      fs.rmSync(fx.dir, { recursive: true, force: true });
    }
  });

  test('a train block names the record artifact and check, and a PR push routes pr-summary', () => {
    const fx = fixture({ bump: 'patch', train: block });
    const out = run(policyStep.run!, fx.dir, { BASE_SHA: fx.base, DEFAULT_BRANCH: 'main' });
    expect(out).toEqual({ train: 'true', record_artifact: 'gstack-train-record', full_gate_check: 'gstack/full-gate' });
    expect(run(routeStep.run!, fx.dir, { GITHUB_EVENT_NAME: 'pull_request', TRAIN_POLICY: 'true' })).toEqual({ mode: 'pr-summary' });
    fs.rmSync(fx.dir, { recursive: true, force: true });
  });

  test('a ref without scripts/train-gate.ts routes a plain dispatch as before and refuses train or screen inputs', () => {
    const fx = fixture(undefined);
    expect(run(routeStep.run!, fx.dir, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'old-branch' })).toEqual({ mode: 'dispatch' });
    expect(() => run(routeStep.run!, fx.dir, { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'old-branch', SCREEN_PR: '42' })).toThrow();
    fs.rmSync(fx.dir, { recursive: true, force: true });
  });

  test('the policy is read before any repository code runs', () => {
    const steps = route.steps.map(st => st.name ?? st.uses ?? '');
    expect(steps.indexOf('Read the train policy (base revision)')).toBeLessThan(steps.indexOf('Route this run'));
    expect(policyStep.run).not.toContain('bun');
    expect(route.permissions).toEqual({ contents: 'read', actions: 'read', 'pull-requests': 'read' });
  });
});

describe('evals-main-backstop.yml', () => {
  test('push to main only, one at a time without cancelling, inert unless main declares a train block', () => {
    expect(Object.keys(backstopWf.on)).toEqual(['push']);
    expect(backstopWf.on.push).toEqual({ branches: ['main'] });
    expect(backstopWf.concurrency).toEqual({ group: 'evals-main-backstop', 'cancel-in-progress': false });
    expect(backstopWf.permissions).toEqual({});
    const job = backstopWf.jobs.backstop!;
    expect(job.permissions).toEqual({ contents: 'write', actions: 'write', checks: 'read', issues: 'write' });
    const policy = job.steps.find(st => st.name === 'Read the train policy (main)')!;
    expect(policy.run).not.toContain('bun');
    const gate = job.steps.find(st => st.name === 'Gate main unless a green train covers its tree')!;
    expect(gate.if).toBe("steps.policy.outputs.train == 'true'");
    expect(gate.id).toBe('gate');
    expect(gate.run).toContain('scripts/train-backstop.ts run --repo "$GITHUB_REPOSITORY" --branch "$GITHUB_REF_NAME" --sha "$GITHUB_SHA"');
    expect(gate.run).toContain('--outputs "$GITHUB_OUTPUT"');
    expect(job.outputs).toEqual({ action: '${{ steps.gate.outputs.action }}' });
  });

  // The weekly release (scripts/release-cut.ts) reads the per-commit verdict as
  // the main-backstop check run: a superseded push exits 0 but is neutral there.
  test('the main-backstop check run is published from its own code-free job: success for covered|gated, neutral for inert|superseded|deferred, failure otherwise', () => {
    const job = backstopWf.jobs['backstop-check']!;
    expect(job.needs).toBe('backstop');
    expect(job.if).toBe("${{ !cancelled() && needs.backstop.outputs.action != '' }}");
    expect(job.permissions).toEqual({ checks: 'write' });
    expect(job.steps.map(st => st.uses).filter(Boolean)).toEqual([]);
    expect(job.steps).toHaveLength(1);
    const publish = job.steps[0]!;
    expect(publish.env).toEqual({ GH_TOKEN: '${{ github.token }}', ACTION: '${{ needs.backstop.outputs.action }}' });
    expect(publish.run).toContain('covered|gated) conclusion=success ;;');
    expect(publish.run).toContain('inert|superseded|deferred) conclusion=neutral ;;');
    expect(publish.run).toContain('frozen|failed) conclusion=failure ;;');
    expect(publish.run).toContain('*) echo "::error::unknown backstop action');
    expect(publish.run).toContain('-f name=main-backstop -f head_sha="$GITHUB_SHA" -f status=completed -f conclusion="$conclusion"');
    expect(publish.run).not.toContain('bun');
  });
});
