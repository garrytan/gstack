/**
 * The result checks behind /eval-plan (docs/TESTING_INTERNALS.md#result-checks):
 * a preregistration names the decision each result changes and its judge and
 * statistics before anything is spent; a model judge's numbers count only after
 * its hand labels pass; a zero comes only from a counter shown to find a planted
 * case; a failures column sits beside its answer-only reading.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { checkPrereg } from '../lib/eval-plan';
import { checkDecisions, checkJudgeLabels, checkScoring, cohensKappa, modelFamily } from '../lib/eval-plan-checks';
import { checkResults } from '../lib/eval-plan-report';

const BIN = path.resolve(import.meta.dir, '..', 'bin', 'gstack-eval-plan');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const DECISIONS = '## Decisions\nif the skill arm passes more items: keep the skill\nif there is no difference: cut the skill\n';
const LOOP = '\n## Pilot\nshare: 10%\ncounted: no\nran: the part under test shows in each arm\'s own transcripts\njudge: labels checked on each arm\'s pilot outputs\nsupply: three development rows per arm at the planned rate\nunits: every task type, one each\nseed: 7, independent of the number of workers\n\n## Cost\npaid: $200\nmeter: $0\nledger: the private spend ledger\n\n## Held-out exposure\n- filled in\nanswers: other git refs and build caches checked on each task machine\n';
const SCORING = (judge = 'gpt-6-astra', extra = 'labels: 40\nagreement: 0.6\nper-arm: yes\neffort: high\npaired: yes\ninterval: 95%\nmdd: 3 of 20 items\n') => `## Scoring\njudge: ${judge}\n${extra}`;
const prereg = (o: { decisions?: string; scoring?: string; frozen?: string; diagnostics?: string } = {}) => [
  o.frozen ? `frozen: ${o.frozen}\n` : '',
  '## Bars\n- pass rate, higher is better\n',
  o.decisions ?? DECISIONS,
  '## Arms\n- claude-opus-5-5 the skill installed\n- claude-opus-5-5#plain no skill\n',
  '## Comparison\nstack: none\nwhy: the scorer calibration compares prompts, not skill stacks\n',
  o.scoring ?? SCORING(),
  ...['Decoys', 'Stop rules'].map(s => `## ${s}\n- filled in\n`),
  LOOP,
  o.diagnostics ?? '',
].join('\n');
const labels = (n: number, disagree = 0, cls = (i: number) => (i % 2 ? 'pass' : 'fail')) =>
  Array.from({ length: n }, (_, i) => JSON.stringify({ id: `item-${i}`, arm: i < n / 2 ? 'claude-opus-5-5' : 'claude-opus-5-5#plain', human: cls(i), judge: i < disagree ? (cls(i) === 'pass' ? 'fail' : 'pass') : cls(i) })).join('\n') + '\n';
const table = (header: string, ...rows: string[]) => [header, header.replace(/[^|]+/g, '---'), ...rows].join('\n') + '\n';

describe('## Decisions', () => {
  test('a passing plan names at least two results with different actions', () => {
    expect(checkPrereg(prereg())).toMatchObject({ ok: true, missing: [], empty: [] });
    expect(checkDecisions(['if a: do x', 'if b: do y']).errors).toEqual([]);
  });

  test('missing, one result, an empty action, or the same action for every result fails', () => {
    expect(checkPrereg(prereg({ decisions: '' })).missing).toContain('Decisions');
    expect(checkDecisions(['if it passes: ship it']).errors[0]).toContain('at least two');
    expect(checkDecisions(['if it passes: ship it', 'if it fails: tbd']).errors).toEqual(['if it fails: names no action']);
    expect(checkDecisions(['if it passes: ship it', 'if it fails: Ship  it']).errors[0]).toContain('changes nothing');
    expect(checkPrereg(prereg({ decisions: '## Decisions\n- we will learn a lot\n' })).ok).toBe(false);
  });
});

describe('## Scoring', () => {
  const arms = ['claude-opus-5-5', 'claude-opus-5-5#plain'];
  test('a judge from another family with 40 labels, kappa 0.6 and the paired statistics passes', () => {
    expect(checkScoring(SCORING().split('\n').slice(1), arms).errors).toEqual([]);
  });

  test('a same-family judge, too few labels, a low kappa bar or missing statistics fail', () => {
    expect(checkScoring(SCORING('claude-fable-5-2').split('\n').slice(1), arms).errors.join()).toContain('same model family (anthropic)');
    expect(checkScoring(SCORING('gpt-6-astra', 'labels: 39\nagreement: 0.6\npaired: yes\ninterval: 95%\nmdd: 3\n').split('\n').slice(1), arms).errors[0]).toContain('at least 40');
    expect(checkScoring(SCORING('gpt-6-astra', 'labels: 40\nagreement: 0.5\npaired: yes\ninterval: 95%\nmdd: 3\n').split('\n').slice(1), arms).errors[0]).toContain('kappa bar');
    expect(checkScoring(['judge: none'], arms).errors).toEqual(['paired: yes (every comparison is reported on paired items)', 'interval: 95% (the interval every comparison is reported with)', 'mdd: the smallest difference this run can detect, stated before the run']);
    expect(checkScoring(['judge: none'], ['claude-opus-5-5']).errors).toEqual([]);
    expect(checkScoring(['labels: 40'], arms).errors[0]).toContain('no judge: line');
  });

  test('model families: labs by name, provider prefixes and loadouts dropped, else the first word', () => {
    expect(['claude-opus-5-5', 'anthropic/claude-haiku-5-5', 'claude-opus-5-5#no-gstack'].map(modelFamily)).toEqual(['anthropic', 'anthropic', 'anthropic']);
    expect(['gpt-6.1-sol', 'openai/gpt-6-astra', 'o3'].map(modelFamily)).toEqual(['openai', 'openai', 'openai']);
    expect(['gemini-4-carbon', 'grok-4.7', 'deepseek/deepseek-v4-pro', 'particle-ai/particle-1'].map(modelFamily)).toEqual(['google', 'xai', 'deepseek', 'particle']);
  });

  test('a preregistration frozen before the result checks keeps its rules; a later freeze date does not', () => {
    const old = prereg({ decisions: '', scoring: '', frozen: '2026-10-31' });
    expect(checkPrereg(old)).toMatchObject({ ok: true, grandfathered: true, frozen: '2026-10-31', missing: [] });
    expect(checkPrereg(prereg({ decisions: '', scoring: '', frozen: '2026-11-15' })).missing).toEqual(['Decisions', 'Scoring']);
  });
});

describe('judge labels', () => {
  const scoring = { judge: 'gpt-6-astra', labels: 40, agreement: 0.6, errors: [] };
  test("Cohen's kappa: perfect, chance and undefined agreement", () => {
    expect(cohensKappa([['a', 'a'], ['b', 'b']])).toBe(1);
    expect(cohensKappa([['a', 'a'], ['a', 'b'], ['b', 'a'], ['b', 'b']])).toBe(0);
    expect(cohensKappa([['a', 'a'], ['a', 'a']])).toBeNull();
  });

  test('40 labels at or above the bar pass; fewer labels, a low kappa, one class or a repeated id fail', () => {
    expect(checkJudgeLabels(scoring, labels(40, 4))).toMatchObject({ ok: true, n: 40, kappa: 0.8 });
    expect(checkJudgeLabels(scoring, labels(39)).problems).toEqual(['39 labelled outputs, needs 40']);
    expect(checkJudgeLabels(scoring, labels(40, 10)).problems).toEqual(['kappa 0.50 is below the bar 0.6']);
    expect(checkJudgeLabels({ ...scoring, per_arm: true }, labels(40, 10)).problems.map(p => p.split(':')[0])).toEqual(['kappa 0.50 is below the bar 0.6', 'arm claude-opus-5-5']);
    expect(checkJudgeLabels(scoring, labels(40, 0, () => 'pass')).problems[0]).toContain('one class');
    expect(checkJudgeLabels(scoring, labels(40) + labels(1)).problems).toContain('id item-0 is labelled twice');
    expect(checkJudgeLabels({ ...scoring, labels: 60 }, labels(40)).problems).toEqual(['40 labelled outputs, needs 60']);
  });

  test('a row whose id, human or judge value is null, an object or empty does not count toward the bar', () => {
    const bad = ['{"id": "x-1", "human": null, "judge": "pass"}', '{"id": "x-2", "human": "pass", "judge": {"v": 1}}', '{"id": {}, "human": "pass", "judge": "pass"}', '{"id": "x-4", "human": "", "judge": "pass"}'];
    const r = checkJudgeLabels(scoring, labels(39) + bad.join('\n') + '\n');
    expect(r).toMatchObject({ ok: false, n: 39 });
    expect(r.problems.filter(p => p.includes('each a string, number or boolean'))).toHaveLength(4);
  });
});

describe('results --check: the result checks', () => {
  const ROWS = table('| arm | passed | answer-only failures | failures |', '| claude-opus-5-5 | 7/9 | 2 | 3 |', '| claude-opus-5-5#plain | 5/9 | 4 | 4 |');
  test('a judged result counts only with passing labels', () => {
    expect(checkResults(prereg(), ROWS).issues).toEqual([{ code: 'EVAL_JUDGE_UNCHECKED', message: 'the preregistration names judge gpt-6-astra; pass --labels <hand labels.jsonl>' }]);
    expect(checkResults(prereg(), ROWS, labels(40, 10)).issues[0]!.code).toBe('EVAL_JUDGE_UNCHECKED');
    expect(checkResults(prereg(), ROWS, labels(40))).toMatchObject({ ok: true, issues: [] });
    expect(checkResults(prereg({ scoring: SCORING('none') }), ROWS).ok).toBe(true);
  });

  test('a zero in the arm table needs a Diagnostics counter shown to find a planted case', () => {
    const zero = table('| arm | skill opens |', '| claude-opus-5-5 | 4 |', '| claude-opus-5-5#plain | 0 |');
    const diag = (n: number) => `## Diagnostics\nsummarizer: sh count.sh {fixture}\nfixture: planted.jsonl\n\n| diagnostic | expected |\n|---|---|\n| skill opens | ${n} |\n`;
    expect(checkResults(prereg({ scoring: SCORING('none') }), zero).issues.map(i => i.code)).toEqual(['EVAL_REPORT_UNPLANTED_ZERO']);
    expect(checkResults(prereg({ scoring: SCORING('none'), diagnostics: diag(0) }), zero).issues.map(i => i.code)).toEqual(['EVAL_REPORT_UNPLANTED_ZERO']);
    expect(checkResults(prereg({ scoring: SCORING('none'), diagnostics: diag(5) }), zero).ok).toBe(true);
    for (const cell of ['0%', '0/9', '0.0']) expect(checkResults(prereg({ scoring: SCORING('none') }), zero.replace('| 0 |', `| ${cell} |`)).ok, cell).toBe(false);
    expect(checkResults(prereg({ scoring: SCORING('none') }), zero.replace('| 0 |', '| 0/6/3 |')).ok).toBe(true);
  });

  test('a zero in any table counts, not only the table that holds the arms', () => {
    const arms = table('| arm | skill opens |', '| claude-opus-5-5 | 4 |', '| claude-opus-5-5#plain | 2 |');
    const other = table('| task | timeouts |', '| t1 | 0 |');
    expect(checkResults(prereg({ scoring: SCORING('none') }), arms + '\n' + other).issues).toEqual([{ code: 'EVAL_REPORT_UNPLANTED_ZERO', message: 'column "timeouts" reports a zero, and no Diagnostics counter by that name was shown to find a planted case' }]);
  });

  test('with stack: none, Decisions and Scoring errors still refuse the results', () => {
    const r = checkResults(prereg({ scoring: SCORING('claude-fable-5-2') }), ROWS, labels(40));
    expect(r.ok).toBe(false);
    expect(r.issues.filter(i => i.code === 'PREREG_INCOMPLETE').map(i => i.message)).toEqual(['## Scoring: judge claude-fable-5-2 is the same model family (anthropic) as arm claude-opus-5-5; use a judge from another family', '## Scoring: judge claude-fable-5-2 is the same model family (anthropic) as arm claude-opus-5-5#plain; use a judge from another family']);
    expect(checkResults(prereg({ decisions: '## Decisions\n- we will learn a lot\n' }), ROWS, labels(40)).issues.map(i => i.code)).toContain('PREREG_INCOMPLETE');
  });

  test('a failures column needs an answer-only column in the same table', () => {
    const bare = table('| arm | failures |', '| claude-opus-5-5 | 3 |', '| claude-opus-5-5#plain | 4 |');
    expect(checkResults(prereg({ scoring: SCORING('none') }), bare).issues).toEqual([{ code: 'EVAL_REPORT_NO_ANSWER_ONLY', message: 'column "failures" counts failures with no answer-only column beside it in the same table' }]);
    expect(checkResults(prereg({ scoring: SCORING('none') }), ROWS).ok).toBe(true);
  });

  test('a grandfathered preregistration skips the result checks', () => {
    const bare = table('| arm | failures |', '| claude-opus-5-5 | 0 |', '| claude-opus-5-5#plain | 4 |');
    expect(checkResults(prereg({ decisions: '', scoring: '', frozen: '2026-10-31' }), bare).ok).toBe(true);
  });
});

describe('gstack-eval-plan judge --check and results --labels', () => {
  const run = (args: string[], files: Record<string, string>) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-result-checks-'));
    dirs.push(d);
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text);
    const r = spawnSync(BIN, args, { cwd: d, encoding: 'utf8', timeout: 60_000 });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };

  test('judge --check prints JUDGE_AGREEMENT and exits 1 with EVAL_JUDGE_UNCHECKED below the bar', () => {
    const ok = run(['judge', '--check', 'prereg.md', '--labels', 'labels.jsonl'], { 'prereg.md': prereg(), 'labels.jsonl': labels(40, 4) });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toBe('JUDGE_ARM: claude-opus-5-5 n=20 kappa=0.60 bar=0.6\nJUDGE_ARM: claude-opus-5-5#plain n=20 kappa=1.00 bar=0.6\nJUDGE_AGREEMENT: ok judge=gpt-6-astra n=40/40 kappa=0.80 bar=0.6\n');
    const low = run(['judge', '--check', 'prereg.md', '--labels', 'labels.jsonl'], { 'prereg.md': prereg(), 'labels.jsonl': labels(20) });
    expect(low.code).toBe(1);
    expect(low.out).toBe('JUDGE_ARM: claude-opus-5-5 n=10 kappa=1.00 bar=0.6\nJUDGE_ARM: claude-opus-5-5#plain n=10 kappa=1.00 bar=0.6\nJUDGE_AGREEMENT: unchecked judge=gpt-6-astra n=20/40 kappa=1.00 bar=0.6\n');
    expect(low.err).toContain('(EVAL_JUDGE_UNCHECKED)');
    expect(run(['judge', '--check', 'prereg.md', '--labels', 'labels.jsonl'], { 'prereg.md': prereg({ scoring: SCORING('none') }), 'labels.jsonl': labels(40) }).code).toBe(2);
  });

  test('results --check takes --labels before or after the results file and prints one code per kind', () => {
    const files = { 'prereg.md': prereg(), 'results.md': table('| arm | failures |', '| claude-opus-5-5 | 3 |', '| claude-opus-5-5#plain | 0 |'), 'labels.jsonl': labels(40) };
    const r = run(['results', '--check', 'prereg.md', '--labels', 'labels.jsonl', 'results.md'], files);
    expect(r.code).toBe(1);
    expect(r.out).toBe('RESULTS: incomplete no_gstack_rows=0/0 rows=0/0 file=results.md\nJUDGE_ARM: claude-opus-5-5 n=20 kappa=1.00 bar=0.6\nJUDGE_ARM: claude-opus-5-5#plain n=20 kappa=1.00 bar=0.6\nJUDGE_AGREEMENT: ok judge=gpt-6-astra n=40/40 kappa=1.00 bar=0.6\n');
    expect(r.err).toContain('(EVAL_REPORT_UNPLANTED_ZERO)');
    expect(r.err).toContain('(EVAL_REPORT_NO_ANSWER_ONLY)');
    expect(r.err).not.toContain('(EVAL_REPORT_NO_GSTACK_ROW)');
    const noLabels = run(['results', '--check', 'prereg.md', 'results.md'], files);
    expect(noLabels.err).toContain('(EVAL_JUDGE_UNCHECKED)');
  });
});
