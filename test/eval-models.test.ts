/**
 * Field list 2, W9: .gstack/eval-models.json and the lint gstack-eval-plan runs
 * over every arm (arms, dry-run, pilot start, price-gate). gbrain's rules
 * ("Fable in smoke only", "no gpt-5.4-mini", "the newest model of each family")
 * as data; literal allow/deny independent of MODEL_CATALOG; unknown ids fail
 * closed; the reviewed copy comes from origin/<base>.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatEvalCalls } from '../lib/eval-plan';
import { lintArmModels, parseEvalModels, type ArmUse, type EvalModelRules } from '../lib/eval-models';
import { RESULT_CODES } from '../lib/result-codes';
import { capyHost, type CapyHost } from './helpers/capy-host';

const BIN = path.resolve(import.meta.dir, '..', 'bin', 'gstack-eval-plan');
const GBRAIN_RULES = {
  schema_version: 1,
  allow: ['claude-*', 'gpt-*'],
  deny: ['gpt-5.4-mini'],
  scopes: { full: { deny: ['claude-fable-*'] } },
  families: {
    'claude-opus': ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8'],
    'claude-fable': ['claude-fable-5-1', 'claude-fable-5'],
    'gpt-sol': ['gpt-6.1-sol', 'gpt-6-sol'],
  },
};

function rules(doc: unknown): EvalModelRules {
  const parsed = parseEvalModels(JSON.stringify(doc));
  if ('errors' in parsed) throw new Error(parsed.errors.join('; '));
  return parsed.rules;
}
const verdicts = (r: EvalModelRules, uses: Array<[string, ArmUse['scope']]>) => lintArmModels(r, uses.map(([model, scope]) => ({ model, scope, where: 't' }))).map(f => `${f.model}/${f.scope}: ${f.verdict} (${f.reason})`);

describe('lintArmModels', () => {
  test('gbrain\'s rules: Fable smoke-only, gpt-5.4-mini denied in any form, older generations refused, unknown ids fail closed', () => {
    expect(verdicts(rules(GBRAIN_RULES), [
      ['claude-fable-5-1', 'smoke'], ['claude-fable-5-1', 'full'], ['gpt-5.4-mini', 'smoke'], ['openai/gpt-5.4-mini', 'full'],
      ['claude-opus-4-8', 'full'], ['anthropic/claude-opus-5-5-20261001', 'full'], ['gpt-6.1-sol', 'full'], ['gemini-3.8-flash', 'smoke'], ['claude-haiku-5-5', 'full'],
    ])).toEqual([
      'claude-fable-5-1/smoke: ok (allow claude-*; newest in families.claude-fable)',
      'claude-fable-5-1/full: denied (scopes.full.deny claude-fable-*)',
      'gpt-5.4-mini/smoke: denied (deny gpt-5.4-mini)',
      'openai/gpt-5.4-mini/full: denied (deny gpt-5.4-mini)',
      'claude-opus-4-8/full: old-generation (families.claude-opus newest is claude-opus-5-5)',
      'anthropic/claude-opus-5-5-20261001/full: ok (allow claude-*; newest in families.claude-opus)',
      'gpt-6.1-sol/full: ok (allow gpt-*; newest in families.gpt-sol)',
      'gemini-3.8-flash/smoke: denied (matches no allow entry (unknown ids fail closed))',
      'claude-haiku-5-5/full: generation-unresolved (in no families entry, so the newest-generation rule cannot be checked)',
    ]);
  });

  test('literal allow/deny ignore catalog membership: uncatalogued ids are allowed or denied by the file alone; scope allow lists narrow', () => {
    const r = rules({ schema_version: 1, allow: ['voyage-4-large', 'claude-sonnet-5-5', 'claude-opus-5-5'], deny: ['claude-opus-5-5'], scopes: { smoke: { allow: ['claude-sonnet-*'] } } });
    expect(verdicts(r, [['voyage-4-large', 'full'], ['claude-opus-5-5', 'full'], ['claude-sonnet-5-5', 'smoke'], ['voyage-4-large', 'smoke']])).toEqual([
      'voyage-4-large/full: ok (allow voyage-4-large)',
      'claude-opus-5-5/full: denied (deny claude-opus-5-5)',
      'claude-sonnet-5-5/smoke: ok (allow claude-sonnet-5-5)',
      'voyage-4-large/smoke: denied (matches no scopes.smoke.allow entry)',
    ]);
  });
});

describe('parseEvalModels', () => {
  test('the file fails closed on a missing allow, unknown keys and scopes, globs in families, duplicates and a malformed id', () => {
    const errors = (doc: unknown) => { const p = parseEvalModels(JSON.stringify(doc)); return 'errors' in p ? p.errors : []; };
    expect(errors({ schema_version: 1 })).toEqual(['allow must be a non-empty array of model ids or globs']);
    expect(errors({ schema_version: 2, allow: ['*'], newest: true })).toEqual(['unknown key "newest" (known: schema_version, allow, deny, scopes, families)', 'schema_version must be 1']);
    expect(errors({ schema_version: 1, allow: ['*'], scopes: { release: { deny: [] }, smoke: { only: [] } } })).toEqual(['scopes.release: unknown eval scope (known: smoke, full)', 'scopes.smoke: unknown key(s) only (known: allow, deny)']);
    expect(errors({ schema_version: 1, allow: ['*'], families: { a: ['claude-*'], b: ['x-1', 'x-2'], c: ['x-2'] } })).toEqual([
      'families.a[0] "claude-*" is not a model id (family entries are literal ids, newest first)', 'families: x-2 is listed in both b and c',
    ]);
    expect(errors({ schema_version: 1, allow: ['claude-[a-z]+'] })[0]).toContain('allow[0] "claude-[a-z]+" is not a model id or glob');
    expect(parseEvalModels('{ allow: [] }')).toMatchObject({ errors: [expect.stringContaining('not valid JSON')] });
  });

  test('MODEL_CATALOG checks only currency: a family listing gstack\'s current smart model after an older id is stale', () => {
    const p = parseEvalModels(JSON.stringify({ schema_version: 1, allow: ['*'], families: { 'claude-opus': ['claude-opus-5', 'claude-opus-5-5'] } }));
    expect('errors' in p && p.errors).toEqual([expect.stringMatching(/^families\.claude-opus lists claude-opus-5 before claude-opus-5-5, gstack's current anthropic smart model \(lib\/model-catalog\.ts, verified \d{4}-\d{2}-\d{2}\); list newest first$/)]);
    expect('rules' in parseEvalModels(JSON.stringify(GBRAIN_RULES))).toBe(true);
  });
});

describe('eval-plan/SKILL.md', () => {
  test('names only result codes the table defines and flags the bin accepts for the diagnostics run and the model rules', () => {
    const skill = fs.readFileSync(path.resolve(import.meta.dir, '..', 'eval-plan', 'SKILL.md'), 'utf8');
    const codes = [...new Set([...skill.matchAll(/\b(PREREG_[A-Z_]+|EVAL_MODELS?_[A-Z_]+)\b/g)].map(m => m[1]!))];
    expect(codes).toEqual(expect.arrayContaining(['PREREG_DIAGNOSTIC_UNTESTED', 'EVAL_MODEL_DENIED', 'EVAL_MODEL_OLD_GENERATION', 'EVAL_MODEL_GENERATION_UNRESOLVED']));
    expect(codes.filter(c => !(c in RESULT_CODES) && !['PREREG_DIAGNOSTIC', 'EVAL_MODEL'].includes(c))).toEqual([]);
    expect(skill).toContain('prereg --check <path> --allow-repo-commands');
    expect(skill).toContain('--scope smoke');
    const help = spawnSync(BIN, ['--help'], { encoding: 'utf8', timeout: 30_000 }).stdout;
    expect(help).toContain('prereg --check <file> [--allow-repo-commands]');
    expect(help).toContain('--scope smoke|full');
  });
});

describe('gstack-eval-plan lints every arm (bin, fixture repo with an origin)', () => {
  let host: CapyHost;
  let repo: string;
  const git = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, env: host.env, encoding: 'utf8', timeout: 30_000 });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const run = (args: string[]) => {
    const r = spawnSync(BIN, args, { cwd: repo, env: host.env, encoding: 'utf8', timeout: 60_000 });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  function seed(doc: unknown | null) {
    const origin = path.join(host.base, 'origin.git');
    spawnSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: host.env, timeout: 30_000 });
    repo = path.join(host.base, 'repo');
    fs.mkdirSync(path.join(repo, '.gstack'), { recursive: true });
    git('init', '-q', '-b', 'main');
    git('remote', 'add', 'origin', origin);
    fs.writeFileSync(path.join(repo, 'rows.jsonl'), JSON.stringify({ prompt: 'q1' }) + '\n');
    fs.writeFileSync(path.join(repo, 'retry.txt'), 'Answer again in the required JSON shape.\n');
    if (doc) fs.writeFileSync(path.join(repo, '.gstack', 'eval-models.json'), JSON.stringify(doc, null, 2) + '\n');
    git('add', '-A'); git('commit', '-q', '-m', 'seed'); git('push', '-q', 'origin', 'main');
  }
  beforeEach(() => { host = capyHost(); });
  afterEach(() => host.cleanup());

  test('arms: the reviewed rules from origin/main refuse a denied arm; a working-tree edit does not loosen them unless --models-from head', () => {
    seed(GBRAIN_RULES);
    const r = run(['arms', '--arms', 'claude-opus-5-5,gpt-5.4-mini']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('EVAL_MODEL: claude-opus-5-5 scope=full ok (allow claude-*; newest in families.claude-opus) where=flag:--arms');
    expect(r.out).toContain('EVAL_MODEL: gpt-5.4-mini scope=full denied (deny gpt-5.4-mini) where=flag:--arms');
    expect(r.out).toMatch(/EVAL_MODELS: fail refused=1\/2 source=origin\/main@[0-9a-f]{12}:\.gstack\/eval-models\.json/);
    expect(r.err).toContain('(EVAL_MODEL_DENIED)');
    fs.writeFileSync(path.join(repo, '.gstack', 'eval-models.json'), JSON.stringify({ ...GBRAIN_RULES, deny: [] }));
    const edited = run(['arms', '--arms', 'gpt-5.4-mini']);
    expect(edited.code).toBe(1);
    expect(edited.out).toContain('EVAL_MODELS_NOTE: the working-tree .gstack/eval-models.json differs from the reviewed copy; linting with origin/main');
    const head = run(['arms', '--arms', 'gpt-5.4-mini', '--models-from', 'head']);
    expect(head.out).toContain('EVAL_MODEL: gpt-5.4-mini scope=full generation-unresolved');
    expect(head.out).toContain('source=head (unreviewed) .gstack/eval-models.json');
    expect(head.err).toContain('(EVAL_MODEL_GENERATION_UNRESOLVED)');
  });

  test('a <model>#<loadout> arm is linted as its model: a deny still refuses it and an exact allow accepts it', () => {
    seed(GBRAIN_RULES);
    const r = run(['arms', '--arms', 'claude-opus-5-5#no-gstack,gpt-5.4-mini#no-gstack']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('EVAL_MODEL: claude-opus-5-5 scope=full ok (allow claude-*; newest in families.claude-opus) where=flag:--arms (claude-opus-5-5#no-gstack)');
    expect(r.out).toContain('EVAL_MODEL: gpt-5.4-mini scope=full denied (deny gpt-5.4-mini) where=flag:--arms (gpt-5.4-mini#no-gstack)');
    expect(r.err).toContain('(EVAL_MODEL_DENIED)');
    fs.writeFileSync(path.join(repo, '.gstack', 'eval-models.json'), JSON.stringify({ schema_version: 1, allow: ['claude-opus-5-5'], deny: [] }));
    const exact = run(['arms', '--arms', 'claude-opus-5-5,claude-opus-5-5#no-gstack', '--models-from', 'head']);
    expect(exact.code).toBe(0);
    expect(exact.out).toContain('where=flag:--arms (claude-opus-5-5#no-gstack)');
  });

  test('dry-run and pilot start: Fable fails the full scope (no reservation), passes --scope smoke; the dry-run record carries the check', () => {
    seed(GBRAIN_RULES);
    const out = path.join(host.base, 'out');
    const base = ['dry-run', '--input', 'rows.jsonl', '--arms', 'claude-fable-5-1', '--retry-prompt', 'retry.txt', '--out', out];
    const full = run(base);
    expect(full.code).toBe(1);
    expect(full.out).toContain('CHECK: model-rules refused claude-fable-5-1 (scope full, dry-run --arms): scopes.full.deny claude-fable-*');
    expect(full.out).toContain('DRY_RUN_RESULT: fail');
    const smoke = run([...base, '--scope', 'smoke']);
    expect(smoke.code).toBe(0);
    expect(smoke.out).toMatch(/CHECK: model-rules ok \(source origin\/main@[0-9a-f]{12}:\.gstack\/eval-models\.json\)/);
    expect(JSON.parse(fs.readFileSync(path.join(out, 'dry-run.json'), 'utf8')).checks.model_rules).toMatchObject({ ok: true, refused: [] });
    const pilotOut = path.join(host.base, 'pilot');
    const pilot = run(['pilot', 'start', '--out', pilotOut, '--cap', '5', '--arms', 'claude-fable-5-1', '--dry-run', path.join(out, 'dry-run.json')]);
    expect(pilot.code).toBe(1);
    expect(pilot.err).toContain('(EVAL_MODEL_DENIED)');
    expect(fs.existsSync(path.join(pilotOut, 'spend.json'))).toBe(false);
    expect(run(['pilot', 'start', '--out', pilotOut, '--cap', '5', '--arms', 'claude-fable-5-1', '--dry-run', path.join(out, 'dry-run.json'), '--scope', 'smoke']).code).toBe(0);
    expect(run([...base, '--scope', 'release']).code).toBe(2);
  });

  test('price-gate lints each call row at its own scope and writes no receipt on a refusal', () => {
    seed(GBRAIN_RULES);
    const head = git('rev-parse', 'HEAD');
    const gate = 'bun run eval:smoke';
    const plan = path.join(host.base, 'plan.calls');
    const rows = [
      { purpose: 'smoke', model: 'claude-fable-5-1', calls: 3, in_tokens: 3_000, out_tokens: 1_000, max_out_tokens: 8_192, scope: 'smoke' as const },
      { purpose: 'judge', model: 'claude-opus-4-8', calls: 3, in_tokens: 3_000, out_tokens: 1_000, max_out_tokens: 2_048, scope: 'full' as const },
    ];
    fs.writeFileSync(plan, formatEvalCalls({ gate, head, inputs: [], preconditions: [], rows }));
    const receipts = path.join(host.base, 'receipts');
    const r = run(['price-gate', '--gate', gate, '--plan-file', plan, '--out', receipts]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('EVAL_MODEL: claude-fable-5-1 scope=smoke ok');
    expect(r.out).toContain('EVAL_MODEL: claude-opus-4-8 scope=full old-generation (families.claude-opus newest is claude-opus-5-5) where=purpose=judge');
    expect(r.err).toContain('(EVAL_MODEL_OLD_GENERATION)');
    expect(fs.existsSync(receipts)).toBe(false);
    fs.writeFileSync(plan, formatEvalCalls({ gate, head, inputs: [], preconditions: [], rows: [rows[0]!] }));
    const ok = run(['price-gate', '--gate', gate, '--plan-file', plan, '--out', receipts]);
    expect(ok.code).toBe(0);
    expect(fs.readdirSync(receipts).length).toBe(1);
  });

  test('no rules file changes nothing; an invalid reviewed file fails EVAL_MODELS_INVALID for every arm', () => {
    seed(null);
    const none = run(['arms', '--arms', 'gpt-5.4-mini']);
    expect(none.code).toBe(0);
    expect(none.out).toMatch(/EVAL_MODELS: none at origin\/main@[0-9a-f]{12}\n/);
    fs.writeFileSync(path.join(repo, '.gstack', 'eval-models.json'), JSON.stringify({ schema_version: 1, allow: ['claude-*'], deny: 'gpt-5.4-mini' }));
    git('add', '-A'); git('commit', '-q', '-m', 'rules'); git('push', '-q', 'origin', 'main');
    const invalid = run(['arms', '--arms', 'claude-opus-5-5']);
    expect(invalid.code).toBe(1);
    expect(invalid.out).toMatch(/EVAL_MODELS: invalid source=origin\/main@/);
    expect(invalid.err).toContain('deny must be an array of model ids or globs');
    expect(invalid.err).toContain('(EVAL_MODELS_INVALID)');
  });
});
