/**
 * R116 (Garry, 2026-11-21): /eval-plan refuses gpt-4o and every model
 * lib/pricing.ts marks superseded_by, in every role a plan chooses (arm,
 * judge, reader, simulator), naming the role and the current replacement. A
 * competitor system's vendor default is an explicit, recorded exception
 * (docs/TESTING_INTERNALS.md#frontier-models-under-test).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkPrereg, dryRun, renderDryRun, startPilot } from '../lib/eval-plan';
import { checkModelGenerations, MODEL_GENERATIONS_SINCE } from '../lib/eval-plan-checks';
import { checkResults } from '../lib/eval-plan-report';
import { currentReplacement, PRICING } from '../lib/pricing';

const BIN = path.resolve(import.meta.dir, '..', 'bin', 'gstack-eval-plan');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-model-gen-')); dirs.push(d); return d; };

const LOOP = '\n## Pilot\nshare: 10%\ncounted: no\nran: the part under test shows in each arm\'s own transcripts\njudge: labels checked on each arm\'s pilot outputs\nsupply: three development rows per arm at the planned rate\nunits: every task type, one each\nseed: 7, independent of the number of workers\n\n## Cost\npaid: $200\nmeter: $0\nledger: the private spend ledger\n\n## Held-out exposure\n- filled in\nanswers: other git refs and build caches checked on each task machine\ngrader: none, the scorer runs no git in the agent\'s repo\n';
const prereg = (o: { arms?: string[]; judge?: string; models?: string; frozen?: string } = {}) => [
  o.frozen ? `frozen: ${o.frozen}\n` : '',
  '## Bars\n- pass rate, higher is better\n',
  '## Decisions\nif the skill arm passes more items: keep the skill\nif there is no difference: cut the skill\n',
  `## Arms\n${(o.arms ?? ['claude-opus-5-5', 'claude-opus-5-5#plain']).map(a => `- ${a} settings`).join('\n')}\n`,
  '## Comparison\nstack: none\nwhy: the scorer calibration compares prompts, not skill stacks\n',
  `## Scoring\njudge: ${o.judge ?? 'gpt-6-astra'}\nlabels: 100\nagreement: 0.6\nper-arm: yes\neffort: high\npaired: yes\ninterval: 95%\nmdd: 3 of 20 items\n`,
  o.models ? `## Models\n${o.models}\n` : '',
  ...['Decoys', 'Stop rules'].map(s => `## ${s}\n- filled in\n`),
  LOOP,
].join('\n');
const cli = (args: string[], files: Record<string, string>) => {
  const d = tmp();
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text);
  const r = spawnSync(BIN, args, { cwd: d, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
};

describe('lib/pricing.ts generation marks', () => {
  test('every superseded_by names a priced row that is itself current', () => {
    const marked = Object.entries(PRICING).filter(([, row]) => row.superseded_by);
    expect(marked.length).toBeGreaterThan(0);
    for (const [model, row] of marked) {
      const next = PRICING[row.superseded_by!];
      expect(next, `${model} -> ${row.superseded_by}`).toBeDefined();
      expect(next!.superseded_by, `${row.superseded_by} is itself superseded`).toBeUndefined();
    }
  });

  test('gpt-4o in every form, and dated or prefixed older ids, resolve to their replacement; point releases stay current', () => {
    expect(currentReplacement('gpt-4o')).toBe('gpt-6.2-sol');
    expect(currentReplacement('openrouter:openai/gpt-4o')).toBe('gpt-6.2-sol');
    expect(currentReplacement('chatgpt-4o-latest')).toBe('gpt-6.2-sol');
    expect(currentReplacement('gpt-4o-2024-05-13')).toBe('gpt-6.2-sol');
    expect(currentReplacement('openai/gpt-4o-mini')).toBe('gpt-6-luna');
    expect(currentReplacement('ft:gpt-4o-mini-2024-07-18:org::id')).toBe('gpt-6-luna');
    expect(currentReplacement('claude-haiku-4-5-20251001')).toBe('claude-haiku-5-5');
    expect(currentReplacement('anthropic/claude-opus-4-7')).toBe('claude-opus-5-5');
    for (const current of ['claude-opus-5-5', 'gpt-6.2-sol', 'gpt-6-astra', 'gpt-6.2-astra', 'gpt-6.1-sol', 'claude-fable-5-1', 'gemini-3.6-flash', 'gpt-6-luna', 'particle-1', 'no-such-model', 'gpt-40-turbo']) expect(currentReplacement(current), current).toBeNull();
  });

  test('an unpriced older generation of a priced family is refused like its marked rows; unpriced current and newer ids are not', () => {
    const older: Record<string, string> = {
      'claude-opus-4-5': 'claude-opus-5-5', 'anthropic/claude-opus-4-6': 'claude-opus-5-5', 'claude-3-opus-20240229': 'claude-opus-5-5',
      'claude-sonnet-4-5-20250929': 'claude-sonnet-5-5', 'claude-3-5-sonnet-20241022': 'claude-sonnet-5-5', 'claude-3-5-haiku': 'claude-haiku-5-5',
      'gpt-5.5': 'gpt-6.2-sol', 'openai/gpt-5.3-codex': 'gpt-6.2-sol', 'gpt-4.1': 'gpt-6.2-sol', 'gpt-4.1-mini': 'gpt-6-luna', 'gpt-5-nano': 'gpt-6-luna',
      'o1': 'gpt-6.2-sol', 'o3-pro': 'gpt-6.2-sol', 'o3-mini': 'gpt-6-luna',
      'gemini-2.0-flash': 'gemini-3.8-flash', 'google/gemini-1.5-pro-002': 'gemini-4-argon', 'gemini-3-pro': 'gemini-4-argon',
    };
    for (const [model, replacement] of Object.entries(older)) expect(currentReplacement(model), model).toBe(replacement);
    for (const current of ['claude-fable-5-2', 'claude-opus-5', 'gpt-6-terra', 'gpt-7', 'gemini-4-neon', 'gemini-3.7-flash', 'claude-haiku-6-0', 'deepseek-v3', 'gemini-embedding-2']) expect(currentReplacement(current), current).toBeNull();
    expect(checkModelGenerations({ arms: ['claude-opus-5-5', 'claude-opus-4-5#plain'], judge: 'gpt-5.5' }).refused).toEqual([
      { model: 'claude-opus-4-5', role: 'arm', replacement: 'claude-opus-5-5' },
      { model: 'gpt-5.5', role: 'judge', replacement: 'gpt-6.2-sol' },
    ]);
  });
});

describe('checkModelGenerations', () => {
  test('negative control: Opus 5.5 and GPT-6.2 Sol arms with a GPT-6 Astra judge pass', () => {
    const c = checkModelGenerations({ arms: ['claude-opus-5-5', 'gpt-6.2-sol#no-gstack'], judge: 'gpt-6-astra', models: ['reader: claude-opus-5-5', 'simulator: gpt-6.2-sol'] });
    expect(c).toEqual({ ok: true, exempt: false, refused: [], exceptions: [], errors: [] });
  });

  test('refuses each role and names the replacement', () => {
    const c = checkModelGenerations({ arms: ['claude-sonnet-4-6', 'claude-sonnet-4-6#no-gstack'], judge: 'gpt-4o', models: ['- reader: claude-haiku-4-5-20251001, claude-opus-5-5', 'simulators: openai/gpt-4o-mini'] });
    expect(c.ok).toBe(false);
    expect(c.refused).toEqual([
      { model: 'claude-sonnet-4-6', role: 'arm', replacement: 'claude-sonnet-5-5' },
      { model: 'gpt-4o', role: 'judge', replacement: 'gpt-6.2-sol' },
      { model: 'claude-haiku-4-5-20251001', role: 'reader', replacement: 'claude-haiku-5-5' },
      { model: 'openai/gpt-4o-mini', role: 'simulator', replacement: 'gpt-6-luna' },
    ]);
  });

  test('a vendor default covers the competitor arm only, and needs the system it ships with', () => {
    const c = checkModelGenerations({ arms: ['claude-opus-5-5', 'gpt-4o-mini#mem0'], judge: 'gpt-4o-mini', models: ['vendor-default: gpt-4o-mini — Mem0 1.2 as its vendor ships it'] });
    expect(c.exceptions).toEqual([{ model: 'gpt-4o-mini', system: 'Mem0 1.2 as its vendor ships it', roles: ['arm'] }]);
    expect(c.refused).toEqual([{ model: 'gpt-4o-mini', role: 'judge', replacement: 'gpt-6-luna' }]);
    const others = checkModelGenerations({ arms: ['openrouter:openai/gpt-4o-mini#mem0', 'gpt-4o-mini', 'gpt-4o-mini#no-gstack'], models: ['vendor-default: gpt-4o-mini Mem0 1.2 as shipped'] });
    expect(others.refused).toEqual([{ model: 'gpt-4o-mini', role: 'arm', replacement: 'gpt-6-luna' }]);
    expect(others.exceptions[0]!.roles).toEqual(['arm']);
    const bare = checkModelGenerations({ arms: ['gpt-4o#mem0'], models: ['vendor-default: gpt-4o'] });
    expect(bare.ok).toBe(false);
    expect(bare.errors[0]).toContain('competitor system');
  });

  test(`a plan frozen before ${MODEL_GENERATIONS_SINCE} keeps its models`, () => {
    expect(checkModelGenerations({ arms: ['gpt-4o'], judge: 'gpt-4o', frozen: '2026-11-20' })).toMatchObject({ ok: true, exempt: true });
    expect(checkModelGenerations({ arms: ['gpt-4o'], frozen: MODEL_GENERATIONS_SINCE }).ok).toBe(false);
  });
});

describe('gstack-eval-plan prereg --check', () => {
  test('negative control: a current plan prints no MODEL lines and passes', () => {
    const r = cli(['prereg', '--check', 'prereg.md'], { 'prereg.md': prereg() });
    expect(r.code, r.err).toBe(0);
    expect(r.out).not.toContain('MODEL_');
    expect(checkPrereg(prereg()).models.ok).toBe(true);
  });

  test('a gpt-4o judge is refused with the role and the replacement', () => {
    const r = cli(['prereg', '--check', 'prereg.md'], { 'prereg.md': prereg({ judge: 'gpt-4o' }) });
    expect(r.code).toBe(1);
    expect(r.out).toContain(' models=refused ');
    expect(r.out).toContain('MODEL_GENERATION: refused gpt-4o role=judge replacement=gpt-6.2-sol');
    expect(r.err).toContain('EVAL_MODEL_OLD_GENERATION');
    expect(r.err).toContain('gpt-4o as judge is an older generation; use gpt-6.2-sol (R116)');
  });

  test('a vendor-default exception passes and is recorded; the results must name it', () => {
    const text = prereg({ arms: ['claude-opus-5-5', 'gpt-4o-mini#mem0'], judge: 'gemini-4-argon', models: 'reader: claude-opus-5-5\nvendor-default: gpt-4o-mini Mem0 1.2 as its vendor ships it' });
    const r = cli(['prereg', '--check', 'prereg.md', '--json'], { 'prereg.md': text });
    expect(r.code, r.err).toBe(0);
    expect(JSON.parse(r.out).models.exceptions).toEqual([{ model: 'gpt-4o-mini', system: 'Mem0 1.2 as its vendor ships it', roles: ['arm'] }]);
    const plain = cli(['prereg', '--check', 'prereg.md'], { 'prereg.md': text });
    expect(plain.out).toContain('MODEL_EXCEPTION: gpt-4o-mini vendor-default system="Mem0 1.2 as its vendor ships it" roles=arm');
    const issues = (results: string) => checkResults(text, results).issues.filter(i => i.code === 'EVAL_MODEL_OLD_GENERATION');
    expect(issues('| arm | pass |\n|---|---|\n| claude-opus-5-5 | 12/20 |\n')[0]!.message).toContain('never name gpt-4o-mini');
    expect(issues('| arm | pass |\n|---|---|\n| claude-opus-5-5 | 12/20 |\n| gpt-4o-mini#mem0 (vendor default gpt-4o-mini) | 9/20 |\n')).toEqual([]);
  });
});

describe('dry run and pilot start', () => {
  test('a gpt-4o arm fails the dry run, and pilot start refuses an older-generation arm', () => {
    const d = tmp();
    const rows = path.join(d, 'rows.jsonl'); fs.writeFileSync(rows, JSON.stringify({ prompt: 'hello world' }) + '\n');
    const retry = path.join(d, 'retry.txt'); fs.writeFileSync(retry, 'retry\n');
    const stale = dryRun({ input: rows, arms: ['claude-opus-5-5', 'gpt-4o'], retryPrompt: retry });
    expect(stale.pass).toBe(false);
    expect(renderDryRun(stale)).toContain('CHECK: model-generation refused gpt-4o (use gpt-6.2-sol)');
    const current = dryRun({ input: rows, arms: ['claude-opus-5-5', 'gpt-6.2-sol'], retryPrompt: retry });
    expect(current.pass).toBe(true);
    expect(renderDryRun(current)).not.toContain('model-generation');
    const dry = path.join(d, 'dry.json'); fs.writeFileSync(dry, JSON.stringify(current));
    const pilot = startPilot({ out: path.join(d, 'pilot'), cap: 5, n: 1, arms: ['claude-opus-4-7'], dryRun: dry });
    expect(pilot.error).toEqual({ code: 'EVAL_MODEL_OLD_GENERATION', message: 'claude-opus-4-7 is an older generation; use claude-opus-5-5 (R116)' });
  });

  const files = (plan: string) => ({ 'prereg.md': plan, 'rows.jsonl': JSON.stringify({ prompt: 'hello world' }) + '\n', 'retry.txt': 'retry\n' });
  const dryArgs = (arms: string, ...more: string[]) => ['dry-run', '--input', 'rows.jsonl', '--arms', arms, '--retry-prompt', 'retry.txt', ...more];

  test('dry-run --prereg keeps a vendor-default arm the plan declares, and still refuses every other older arm', () => {
    const plan = prereg({ arms: ['claude-opus-5-5', 'gpt-4o#mem0'], judge: 'gemini-4-argon', models: 'vendor-default: gpt-4o Mem0 1.2 as its vendor ships it' });
    expect(cli(['prereg', '--check', 'prereg.md'], { 'prereg.md': plan }).code).toBe(0);
    const bare = cli(dryArgs('claude-opus-5-5,gpt-4o#mem0'), files(plan));
    expect(bare.code).toBe(1);
    expect(bare.err).toContain('pass --prereg <file> when the plan has a vendor-default line');
    const kept = cli(dryArgs('claude-opus-5-5,gpt-4o#mem0', '--prereg', 'prereg.md'), files(plan));
    expect(kept.code, kept.err).toBe(0);
    expect(kept.out).toContain('DRY_RUN_RESULT: pass');
    expect(kept.out).toContain('MODEL_EXCEPTION: gpt-4o vendor-default system="Mem0 1.2 as its vendor ships it" roles=arm');
    const other = cli(dryArgs('claude-opus-5-5,gpt-4o#mem0,gpt-4o', '--prereg', 'prereg.md'), files(plan));
    expect(other.code).toBe(1);
    expect(other.out).toContain('CHECK: model-generation refused gpt-4o (use gpt-6.2-sol)');
  });

  test('dry-run --prereg honours a plan frozen before R116, and pilot start reads both from dry-run.json', () => {
    const frozen = prereg({ arms: ['claude-opus-5-5', 'claude-opus-4-7#plain'], frozen: '2026-11-20' });
    const d = tmp();
    for (const [name, text] of Object.entries(files(frozen))) fs.writeFileSync(path.join(d, name), text);
    const run = (args: string[]) => spawnSync(BIN, args, { cwd: d, encoding: 'utf8', timeout: 60_000 });
    const kept = run(dryArgs('claude-opus-5-5,claude-opus-4-7#plain', '--prereg', 'prereg.md', '--out', 'dry'));
    expect(kept.status, kept.stderr).toBe(0);
    expect(kept.stdout).toContain('MODEL_GENERATION: exempt (frozen 2026-11-20 in prereg.md, before R116)');
    const pilot = startPilot({ out: path.join(d, 'pilot'), cap: 5, n: 1, arms: ['claude-opus-5-5', 'claude-opus-4-7#plain'], dryRun: path.join(d, 'dry', 'dry-run.json') });
    expect(pilot.error).toBeUndefined();
    const vendor = prereg({ arms: ['claude-opus-5-5', 'gpt-4o#mem0'], judge: 'gemini-4-argon', models: 'vendor-default: gpt-4o Mem0 1.2 as shipped' });
    fs.writeFileSync(path.join(d, 'prereg.md'), vendor);
    expect(run(dryArgs('claude-opus-5-5,gpt-4o#mem0', '--prereg', 'prereg.md', '--out', 'dry2')).status).toBe(0);
    const dry2 = path.join(d, 'dry2', 'dry-run.json');
    expect(startPilot({ out: path.join(d, 'p2'), cap: 5, n: 1, arms: ['claude-opus-5-5', 'gpt-4o#mem0'], dryRun: dry2 }).error).toBeUndefined();
    expect(startPilot({ out: path.join(d, 'p3'), cap: 5, n: 1, arms: ['gpt-4o'], dryRun: dry2 }).error?.code).toBe('EVAL_MODEL_OLD_GENERATION');
  });

  test('dry-run --prereg names a malformed vendor-default line instead of blaming an arm', () => {
    const r = cli(dryArgs('claude-opus-5-5,gpt-6.2-sol', '--prereg', 'prereg.md'), files(prereg({ arms: ['claude-opus-5-5', 'gpt-6.2-sol'], models: 'vendor-default: gpt-4o' })));
    expect(r.code).toBe(1);
    expect(r.err).toContain('vendor-default: gpt-4o needs the model and the competitor system');
    expect(r.err).not.toContain('an arm is gpt-4o');
  });

  test('a frozen: date exempts only arms the plan names, in dry-run and in pilot start', () => {
    const forged = cli(dryArgs('gpt-4o,claude-opus-5-5', '--prereg', 'p.md'), { ...files(''), 'p.md': 'frozen: 2026-11-01\n' });
    expect(forged.code).toBe(1);
    expect(forged.out).toContain('CHECK: model-generation refused gpt-4o (use gpt-6.2-sol)');
    expect(forged.err).toContain('p.md does not name gpt-4o,claude-opus-5-5');
    const d = tmp();
    for (const [name, text] of Object.entries(files(prereg({ arms: ['claude-opus-5-5', 'claude-opus-4-7#plain'], frozen: '2026-11-20' })))) fs.writeFileSync(path.join(d, name), text);
    expect(spawnSync(BIN, dryArgs('claude-opus-5-5,claude-opus-4-7#plain', '--prereg', 'prereg.md', '--out', 'dry'), { cwd: d, encoding: 'utf8', timeout: 60_000 }).status).toBe(0);
    expect(startPilot({ out: path.join(d, 'pilot'), cap: 5, n: 1, arms: ['claude-opus-5-5', 'gpt-4o'], dryRun: path.join(d, 'dry', 'dry-run.json') }).error?.code).toBe('EVAL_MODEL_OLD_GENERATION');
  });
});
