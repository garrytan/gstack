/**
 * The no-gstack arm (Garry, 2026-10-31: "all of our head to head tests have to
 * test no gstack from here"). A preregistration says in `## Comparison` whether
 * any arm loads gstack or another skill stack (`stack: loaded`) or none does
 * (`stack: none` with a `why:`). A loaded comparison needs a `## No-gstack arm`
 * section naming one `<model>#no-gstack` arm per model, each also an Arms line,
 * plus the inputs, prompt, panel and report it shares with the variants. Arms are
 * identities `<model>[#<loadout>]`, priced by the model, so the no-gstack arm on
 * the same model gets its own pilot reservations.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { armModel, checkPrereg, dryRun, preregTemplate, resolveArms, startPilot } from '../lib/eval-plan';

const BIN = path.resolve(import.meta.dir, '..', 'bin', 'gstack-eval-plan');
const dirs: string[] = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-no-gstack-arm-')); dirs.push(d); return d; };
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const BASE = ['Bars', 'Decoys', 'Stop rules', 'Held-out exposure'].map(s => `## ${s}\n- filled in\n`).join('\n');
const ARMS = (...ids: string[]) => `\n## Arms\n${ids.map(id => `- ${id} default settings, $0.01 per item`).join('\n')}\n`;
const LOADED = '\n## Comparison\nstack: loaded\n';
const NO_GSTACK = (o: Partial<Record<'arms' | 'inputs' | 'prompt' | 'panel' | 'report', string>> = {}) => {
  const v = { arms: 'claude-opus-5-5#no-gstack', inputs: 'the same rows and fixture as the variants', prompt: 'the task text only; no SKILL.md, preamble, hooks or installed skills', panel: 'behavior, 3 trials, the same judge and labels', report: 'one row beside the variants in the results table', ...o };
  return `\n## No-gstack arm\n${Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => `${k}: ${x}`).join('\n')}\n`;
};
const VARIANTS = ARMS('claude-opus-5-5#review-g', 'claude-opus-5-5#review-h', 'claude-opus-5-5#no-gstack');

describe('the Comparison declaration', () => {
  test('Comparison is a required section; the blank template fails and multi-line guidance never counts as content', () => {
    const t = preregTemplate('x');
    expect(t).toContain('## Comparison');
    expect(t).toContain('## No-gstack arm');
    const blank = checkPrereg(t);
    expect(blank.empty).toContain('Comparison');
    expect(checkPrereg(BASE + VARIANTS + '\n## Comparison\n<!-- stack: loaded\n     more guidance -->\n').empty).toContain('Comparison');
  });

  test('stack: none needs a why: line and passes without the arm; an unknown value fails', () => {
    const none = checkPrereg(BASE + ARMS('claude-opus-5-5') + '\n## Comparison\nstack: none\nwhy: scorer calibration; no arm loads a skill stack\n');
    expect(none.ok).toBe(true);
    expect(none.comparison.stack).toBe('none');
    expect(none.no_gstack.required).toBe(false);
    const noWhy = checkPrereg(BASE + ARMS('claude-opus-5-5') + '\n## Comparison\nstack: none\n');
    expect(noWhy.ok).toBe(false);
    expect(noWhy.comparison.errors.join(';')).toContain('why:');
    const odd = checkPrereg(BASE + ARMS('claude-opus-5-5') + '\n## Comparison\nstack: maybe\n');
    expect(odd.ok).toBe(false);
    expect(odd.comparison.errors.join(';')).toContain('stack: maybe');
  });
});

describe('the No-gstack arm section', () => {
  test('a loaded comparison passes with a complete section and fails without it', () => {
    expect(checkPrereg(BASE + VARIANTS + LOADED + NO_GSTACK()).ok).toBe(true);
    const missing = checkPrereg(BASE + VARIANTS + LOADED);
    expect(missing.ok).toBe(false);
    expect(missing.no_gstack).toMatchObject({ required: true, ok: false });
    expect(missing.no_gstack.problems).toEqual(['missing section']);
  });

  for (const key of ['arms', 'inputs', 'prompt', 'panel', 'report'] as const) {
    test(`a missing or blank ${key}: line fails naming it`, () => {
      for (const v of [undefined, ' ']) {
        const r = checkPrereg(BASE + VARIANTS + LOADED + NO_GSTACK({ [key]: v } as Record<string, string>));
        expect(r.ok).toBe(false);
        expect(r.no_gstack.problems).toContain(`missing ${key}`);
      }
    });
  }

  test('every model that loads a stack needs its own <model>#no-gstack arm: a two-model panel needs two', () => {
    const panel = ARMS('claude-opus-5-5', 'gpt-6.1-sol', 'claude-opus-5-5#no-gstack');
    const one = checkPrereg(BASE + panel + LOADED + NO_GSTACK());
    expect(one.ok).toBe(false);
    expect(one.no_gstack.problems).toEqual(['no no-gstack arm for gpt-6.1-sol']);
    const both = checkPrereg(BASE + ARMS('claude-opus-5-5', 'gpt-6.1-sol', 'claude-opus-5-5#no-gstack', 'gpt-6.1-sol#no-gstack') + LOADED + NO_GSTACK({ arms: 'claude-opus-5-5#no-gstack, gpt-6.1-sol#no-gstack' }));
    expect(both.ok).toBe(true);
  });

  test('a model panel under another skill stack (not gstack) is loaded too and needs the same arms', () => {
    const other = ARMS('claude-opus-5-5#other-stack', 'gpt-6.1-sol#other-stack');
    const r = checkPrereg(BASE + other + LOADED + NO_GSTACK({ arms: 'claude-opus-5-5#no-gstack' }));
    expect(r.ok).toBe(false);
    expect(r.no_gstack.problems).toEqual(['claude-opus-5-5#no-gstack is not an Arms line', 'no no-gstack arm for claude-opus-5-5', 'no no-gstack arm for gpt-6.1-sol']);
  });

  test('a listed arm must be an Arms line and a <model>#no-gstack identity, matched on whole identities', () => {
    const notListed = checkPrereg(BASE + ARMS('claude-opus-5-5#review-g') + LOADED + NO_GSTACK());
    expect(notListed.no_gstack.problems).toContain('claude-opus-5-5#no-gstack is not an Arms line');
    const prefix = checkPrereg(BASE + ARMS('claude-opus-5-5#review-g', 'claude-opus-5#no-gstack') + LOADED + NO_GSTACK({ arms: 'claude-opus-5#no-gstack' }));
    expect(prefix.no_gstack.problems).toContain('no no-gstack arm for claude-opus-5-5');
    const wrongLoadout = checkPrereg(BASE + ARMS('claude-opus-5-5#review-g', 'claude-opus-5-5#plain') + LOADED + NO_GSTACK({ arms: 'claude-opus-5-5#plain' }));
    expect(wrongLoadout.no_gstack.problems).toContain('claude-opus-5-5#plain is not a <model>#no-gstack identity');
    const prose = checkPrereg(BASE + '\n## Arms\n- claude-opus-5-5#review-g, compared with claude-opus-5-5#no-gstack in prose\n' + LOADED + NO_GSTACK());
    expect(prose.no_gstack.problems).toContain('claude-opus-5-5#no-gstack is not an Arms line');
  });

  test('a table in Arms: the header row is not an arm', () => {
    const table = '\n## Arms\n| model | settings |\n|---|---|\n| claude-opus-5-5#review-g | default |\n| claude-opus-5-5#no-gstack | default |\n';
    expect(checkPrereg(BASE + table + LOADED + NO_GSTACK()).ok).toBe(true);
  });
});

describe('arm identities in pricing and the pilot', () => {
  test('armModel strips the loadout; arms and the dry run price <model>#no-gstack by its model', () => {
    expect(armModel('anthropic/claude-opus-5-5#no-gstack')).toBe('anthropic/claude-opus-5-5');
    expect(armModel('gpt-6.1-sol')).toBe('gpt-6.1-sol');
    const d = tmp();
    const arms = resolveArms({ cwd: d, explicit: ['claude-opus-5-5#no-gstack'] });
    expect(arms.errors).toEqual([]);
    expect(arms.arms[0]).toMatchObject({ model: 'claude-opus-5-5#no-gstack', priced: true });
    const rows = path.join(d, 'rows.jsonl');
    fs.writeFileSync(rows, JSON.stringify({ prompt: 'hello there' }) + '\n');
    const dry = dryRun({ input: rows, arms: ['claude-opus-5-5', 'claude-opus-5-5#no-gstack'] });
    expect(dry.checks.price_table.ok).toBe(true);
    expect(dry.per_item_usd['claude-opus-5-5#no-gstack']).toBe(dry.per_item_usd['claude-opus-5-5']);
  });

  const passingDryRun = (d: string) => {
    const rows = path.join(d, 'rows.jsonl');
    fs.writeFileSync(rows, JSON.stringify({ prompt: 'hello there' }) + '\n');
    const file = path.join(d, 'dry-run.json');
    const r = dryRun({ input: rows, arms: ['claude-opus-5-5'], retryPrompt: (fs.writeFileSync(path.join(d, 'retry.md'), 'try again\n'), path.join(d, 'retry.md')) });
    fs.writeFileSync(file, JSON.stringify(r));
    expect(r.pass, JSON.stringify(r.checks)).toBe(true);
    return file;
  };

  test('the pilot reserves a variant and its no-gstack arm on the same model under distinct attempts; the total is the sum', () => {
    const d = tmp();
    const r = startPilot({ out: path.join(d, 'pilot'), cap: 100, n: 2, arms: ['claude-opus-5-5', 'claude-opus-5-5#no-gstack'], dryRun: passingDryRun(d) });
    expect(r.error).toBeUndefined();
    const ids = r.record.attempts.map(a => a.attempt);
    expect(new Set(ids).size).toBe(4);
    const ledger = JSON.parse(fs.readFileSync(path.join(d, 'pilot', fs.readdirSync(path.join(d, 'pilot')).find(f => f.includes('spend'))!), 'utf8'));
    const reserved = JSON.stringify(ledger);
    for (const id of ids) expect(reserved).toContain(id);
    const each = r.record.attempts[0]!.estimate_usd;
    expect(r.record.attempts.every(a => a.estimate_usd === each)).toBe(true);
  });

  test('a duplicate arm identity is refused before anything is reserved (EVAL_ARM_DUPLICATE)', () => {
    const d = tmp();
    const r = startPilot({ out: path.join(d, 'pilot'), cap: 100, n: 1, arms: ['claude-opus-5-5', 'claude-opus-5-5'], dryRun: passingDryRun(d) });
    expect(r.error?.code).toBe('EVAL_ARM_DUPLICATE');
    expect(r.record.attempts).toEqual([]);
  });

  test('distinct identities that share one ledger attempt name are refused before anything is reserved', () => {
    for (const arms of [['claude-opus-5-5#review/a', 'claude-opus-5-5#review_a'], ['gpt-6#1-sol', 'gpt-6.1-sol']]) {
      const d = tmp();
      const r = startPilot({ out: path.join(d, 'pilot'), cap: 100, n: 1, arms, dryRun: passingDryRun(d) });
      expect(r.error?.code).toBe('EVAL_ARM_DUPLICATE');
      expect(r.error?.message).toContain(arms.join(' = '));
      expect(r.record.attempts).toEqual([]);
      expect(fs.existsSync(path.join(d, 'pilot'))).toBe(false);
    }
  });
});

describe('gstack-eval-plan prereg --check', () => {
  const run = (text: string) => {
    const d = tmp();
    const file = path.join(d, 'prereg.md');
    fs.writeFileSync(file, text);
    const r = spawnSync(BIN, ['prereg', '--check', file], { cwd: d, encoding: 'utf8', timeout: 60_000 });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };

  test('a loaded comparison without the arm: one PREREG line out of 6, PREREG_NO_GSTACK_ARM on stderr, exit 1', () => {
    const r = run(BASE + VARIANTS + LOADED);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^PREREG: incomplete present=6\/6 stack=loaded no_gstack_arm=missing file=/m);
    expect(r.err).toContain('missing section');
    expect(r.err).toContain('(PREREG_NO_GSTACK_ARM)');
    expect(r.err).not.toContain('(PREREG_INCOMPLETE)');
  });

  test('missing sections and arm problems both print, PREREG_INCOMPLETE first', () => {
    const r = run(VARIANTS + LOADED);
    expect(r.code).toBe(1);
    const a = r.err.indexOf('(PREREG_INCOMPLETE)'), b = r.err.indexOf('(PREREG_NO_GSTACK_ARM)');
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
  });

  test('complete: PREREG: ok with stack=loaded no_gstack_arm=ok; an opt-out prints stack=none', () => {
    const ok = run(BASE + VARIANTS + LOADED + NO_GSTACK());
    expect(ok.code, ok.out + ok.err).toBe(0);
    expect(ok.out).toMatch(/^PREREG: ok present=6\/6 stack=loaded no_gstack_arm=ok file=/m);
    const none = run(BASE + ARMS('claude-opus-5-5') + '\n## Comparison\nstack: none\nwhy: scorer calibration\n');
    expect(none.code, none.out + none.err).toBe(0);
    expect(none.out).toMatch(/^PREREG: ok present=6\/6 stack=none file=/m);
  });
});
