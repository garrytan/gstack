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
import { anchorSetDigest, checkDecisions, checkJudgeLabels, checkScoring, cohensKappa, JUDGE_LABELS_RAISED_SINCE, MODEL_LABELLER_DEFAULT, modelFamily, thirdModelLine } from '../lib/eval-plan-checks';
import { checkResults } from '../lib/eval-plan-report';

const BIN = path.resolve(import.meta.dir, '..', 'bin', 'gstack-eval-plan');
const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const DECISIONS = '## Decisions\nif the skill arm passes more items: keep the skill\nif there is no difference: cut the skill\n';
const LOOP = '\n## Pilot\nshare: 10%\ncounted: no\nran: the part under test shows in each arm\'s own transcripts\njudge: labels checked on each arm\'s pilot outputs\nsupply: three development rows per arm at the planned rate\nunits: every task type, one each\nseed: 7, independent of the number of workers\n\n## Cost\npaid: $200\nmeter: $0\nledger: the private spend ledger\n\n## Held-out exposure\n- filled in\nanswers: other git refs and build caches checked on each task machine\ngrader: none, the scorer runs no git in the agent\'s repo\n';
const SCORING = (judge = 'gpt-6-astra', extra = 'labels: 40\nagreement: 0.6\nper-arm: yes\neffort: high\npaired: yes\ninterval: 95%\nmdd: 3 of 20 items\n') => `## Scoring\njudge: ${judge}\n${extra}`;
/** A freeze date before the R78 amendment's 100-label bar (2026-11-22), so these fixtures keep testing the 40-label rules they were written for. */
const JUDGE_40_FROZEN = '2026-11-21';
const prereg = (o: { decisions?: string; scoring?: string; frozen?: string; diagnostics?: string } = {}) => [
  `frozen: ${o.frozen ?? JUDGE_40_FROZEN}\n`,
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
    expect(checkScoring(SCORING().split('\n').slice(1), arms, JUDGE_40_FROZEN).errors).toEqual([]);
  });

  test('a same-family judge, too few labels, a low kappa bar or missing statistics fail', () => {
    expect(checkScoring(SCORING('claude-fable-5-2').split('\n').slice(1), arms, JUDGE_40_FROZEN).errors.join()).toContain('same model family (anthropic)');
    expect(checkScoring(SCORING('gpt-6-astra', 'labels: 39\nagreement: 0.6\npaired: yes\ninterval: 95%\nmdd: 3\n').split('\n').slice(1), arms, JUDGE_40_FROZEN).errors[0]).toContain('at least 40');
    expect(checkScoring(SCORING('gpt-6-astra', 'labels: 40\nagreement: 0.5\npaired: yes\ninterval: 95%\nmdd: 3\n').split('\n').slice(1), arms, JUDGE_40_FROZEN).errors[0]).toContain('kappa bar');
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

describe(`R78 amendment: a plan frozen on or after ${JUDGE_LABELS_RAISED_SINCE} checks its judge on 100 labels`, () => {
  const scoring100 = 'labels: 100\nagreement: 0.6\nper-arm: yes\neffort: high\npaired: yes\ninterval: 95%\nmdd: 3 of 20 items\n';
  test('the day before keeps 40; the day itself and a plan with no frozen: line need 100', () => {
    expect(checkPrereg(prereg({ frozen: '2026-11-21' })).scoring).toMatchObject({ errors: [], min_labels: 40 });
    for (const frozen of [JUDGE_LABELS_RAISED_SINCE, '2026-12-01']) {
      const s = checkPrereg(prereg({ frozen })).scoring;
      expect(s.min_labels).toBe(100);
      expect(s.errors).toEqual(['labels: needs at least 100 hand-labelled outputs the judge is checked against (40 only for a plan frozen before 2026-11-22)']);
      expect(checkPrereg(prereg({ frozen, scoring: SCORING('gpt-6-astra', scoring100) })).ok).toBe(true);
    }
    expect(checkScoring(SCORING().split('\n').slice(1), ['claude-opus-5-5'], null).min_labels).toBe(100);
  });

  test('judge --check counts against the bar of the freeze date; kappa stays 0.6', () => {
    const labels100 = labels(100, 10);
    const late = checkPrereg(prereg({ frozen: JUDGE_LABELS_RAISED_SINCE, scoring: SCORING('gpt-6-astra', scoring100) })).scoring;
    expect(checkJudgeLabels(late, labels(40, 4)).problems).toEqual(['40 labelled outputs, needs 100']);
    expect(checkJudgeLabels(late, labels100)).toMatchObject({ ok: true, n: 100, need_n: 100, need_kappa: 0.6 });
    const early = checkPrereg(prereg({ frozen: '2026-11-21' })).scoring;
    expect(checkJudgeLabels(early, labels(40, 4))).toMatchObject({ ok: true, need_n: 40 });
    expect(checkJudgeLabels({ judge: 'gpt-6-astra', labels: 40, agreement: 0.6, errors: [] }, labels(40, 4)).need_n).toBe(100);
  });

  const cli = (args: string[], files: Record<string, string>) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-judge-bar-')); dirs.push(d);
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text);
    const r = spawnSync(BIN, args, { cwd: d, encoding: 'utf8', timeout: 60_000 });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };

  test('prereg --check on the command line: 40 labels pass the day before and fail from the date, where 100 pass', () => {
    expect(cli(['prereg', '--check', 'p.md'], { 'p.md': prereg({ frozen: '2026-11-21' }) }).code).toBe(0);
    const late = cli(['prereg', '--check', 'p.md'], { 'p.md': prereg({ frozen: JUDGE_LABELS_RAISED_SINCE }) });
    expect(late.code).toBe(1);
    expect(late.out).toContain('PREREG: incomplete');
    expect(late.err).toContain('PREREG_INCOMPLETE');
    expect(late.err).toContain('scoring: labels: needs at least 100 hand-labelled outputs the judge is checked against (40 only for a plan frozen before 2026-11-22)');
    expect(cli(['prereg', '--check', 'p.md'], { 'p.md': prereg({ frozen: JUDGE_LABELS_RAISED_SINCE, scoring: SCORING('gpt-6-astra', scoring100) }) }).code).toBe(0);
  });

  test('judge --check on the command line: a plan frozen from the date needs 100 labelled rows; one frozen before keeps 40', () => {
    const late = prereg({ frozen: JUDGE_LABELS_RAISED_SINCE, scoring: SCORING('gpt-6-astra', scoring100) });
    const short = cli(['judge', '--check', 'p.md', '--labels', 'l.jsonl'], { 'p.md': late, 'l.jsonl': labels(40, 4) });
    expect(short.code).toBe(1);
    expect(short.err).toContain('EVAL_JUDGE_UNCHECKED');
    expect(short.err).toContain('40 labelled outputs, needs 100');
    const full = cli(['judge', '--check', 'p.md', '--labels', 'l.jsonl', '--json'], { 'p.md': late, 'l.jsonl': labels(100, 10) });
    expect(full.code, full.err).toBe(0);
    expect(JSON.parse(full.out)).toMatchObject({ ok: true, n: 100, need_n: 100, need_kappa: 0.6 });
    const early = cli(['judge', '--check', 'p.md', '--labels', 'l.jsonl', '--json'], { 'p.md': prereg({ frozen: '2026-11-21' }), 'l.jsonl': labels(40, 4) });
    expect(early.code, early.err).toBe(0);
    expect(JSON.parse(early.out)).toMatchObject({ ok: true, n: 40, need_n: 40 });
  });
});

describe('judge labels', () => {
  const scoring = { judge: 'gpt-6-astra', labels: 40, agreement: 0.6, errors: [], min_labels: 40 };
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

describe('R126: a code judge may be checked against blind labels a third-family model made, with frozen anchors', () => {
  const arms = ['claude-opus-5-5', 'claude-opus-5-5#plain'];
  const FROZEN = anchorSetDigest(Array.from({ length: 12 }, (_, i) => ({ id: `anchor-${i}`, expected: 'bug' })));
  const NEON = `labels-by: google/gemini-4-neon\nlabel-kind: code\nblind: yes\nanchors: 12 frozen in anchors.jsonl\nanchor-pass: 11\nanchors-digest: ${FROZEN}\n`;
  const scoring100 = (extra: string, judge = 'gpt-6-astra') => SCORING(judge, 'labels: 100\nagreement: 0.6\nper-arm: yes\neffort: high\npaired: yes\ninterval: 95%\nmdd: 3 of 20 items\n' + extra);
  const late = (extra: string, judge?: string) => prereg({ frozen: '2026-11-25', scoring: scoring100(extra, judge) });
  const errs = (extra: string, judge?: string) => checkPrereg(late(extra, judge)).scoring.errors;
  const anchors = (n: number, right: number, start = 0) => Array.from({ length: n }, (_, i) => JSON.stringify({ id: `anchor-${start + i}`, expected: 'bug', label: i < right ? 'bug' : "can't tell" })).join('\n') + '\n';

  test('Gemini 4 Neon labelling code, blind, with frozen anchors and a pass line passes, and is recorded as the labeller', () => {
    const s = checkPrereg(late(NEON)).scoring;
    expect(s.errors).toEqual([]);
    expect(s.labeller).toEqual({ model: MODEL_LABELLER_DEFAULT, anchors: 12, anchor_pass: 11, anchors_digest: FROZEN });
    expect(checkPrereg(late(`labels-by: \`google/gemini-4-neon\`\nlabel-kind: code\nblind: yes\nanchors: 12\nanchor-pass: 12\nanchors-digest: ${FROZEN}\n`)).ok).toBe(true);
  });

  test('people, construction, rule or no labels-by line keep the hand-label rules unchanged', () => {
    for (const by of ['', 'labels-by: people\n', 'labels-by: construction\n', 'labels-by: Rule\n']) {
      const s = checkPrereg(late(by)).scoring;
      expect(s.errors, by).toEqual([]);
      expect(s.labeller, by).toBeNull();
    }
    expect(errs('', 'gpt-6-astra').length).toBe(0);
    expect(checkPrereg(prereg({ frozen: JUDGE_LABELS_RAISED_SINCE })).scoring.errors).toEqual(['labels: needs at least 100 hand-labelled outputs the judge is checked against (40 only for a plan frozen before 2026-11-22)']);
  });

  test('a model labeller for anything but code is refused, quality and taste included', () => {
    const kind = 'label-kind: code (model-made labels count only for a judge that grades code; labels for anything else, quality and taste included, come from people, construction or a rule) (R126, R124)';
    expect(errs(NEON.replace('label-kind: code\n', ''))).toEqual([kind]);
    for (const k of ['prose', 'quality', 'taste', 'ui']) expect(errs(NEON.replace('label-kind: code', `label-kind: ${k}`)), k).toEqual([kind]);
  });

  test('the labeller comes from a family neither the judge nor any arm shares', () => {
    expect(errs(NEON, 'google/gemini-4-carbon')).toEqual(['labels-by: google/gemini-4-neon is the same model family (google) as the judge or an arm; the labeller comes from a third family']);
    expect(errs(NEON.replace('google/gemini-4-neon', 'openai/gpt-6.2-sol'))).toContain('labels-by: openai/gpt-6.2-sol is the same model family (openai) as the judge or an arm; the labeller comes from a third family');
    expect(errs(NEON.replace('google/gemini-4-neon', 'anthropic/claude-sonnet-5-5'))).toContain('labels-by: anthropic/claude-sonnet-5-5 is the same model family (anthropic) as the judge or an arm; the labeller comes from a third family');
  });

  test('Grok 4.7 or another third family labels only when Gemini is the judge or an arm, or Neon missed its anchors', () => {
    const grok = NEON.replace('google/gemini-4-neon', 'x-ai/grok-4.7');
    expect(errs(grok)).toEqual(['labels-by: google/gemini-4-neon labels unless Gemini is the judge or an arm, or a labeller-fallback: line names the run where it missed its anchor pass line']);
    expect(errs(grok, 'google/gemini-4-carbon')).toEqual([]);
    expect(errs(grok + 'labeller-fallback: run neon-anchors-1 answered 2 of 12\n')).toEqual([]);
    expect(errs(grok + 'labeller-fallback: tbd\n').length).toBe(1);
  });

  test('anchors, a pass line, blind labelling and a <provider>/<model> id are each required', () => {
    expect(errs(NEON.replace('blind: yes\n', ''))).toEqual(['blind: yes (the labeller sees each output with no judge verdict and no arm name)']);
    const anchorsErr = 'anchors: <n> frozen known-answer anchors (items whose label is fixed by construction) the labeller answers before its labels count, and where they are frozen';
    const passErr = 'anchor-pass: <k>, how many anchors the labeller must answer right before its labels count (1 to the anchors: count)';
    expect(errs(NEON.replace('anchors: 12 frozen in anchors.jsonl\n', ''))).toEqual([anchorsErr]);
    expect(errs(NEON.replace('anchors: 12 frozen in anchors.jsonl', 'anchors: 0'))).toEqual([anchorsErr, passErr]);
    expect(errs(NEON.replace('anchor-pass: 11\n', ''))).toEqual([passErr]);
    expect(errs(NEON.replace('anchor-pass: 11', 'anchor-pass: 13'))).toEqual([passErr]);
    const shaErr = 'anchors-digest: the 64-hex digest gstack-eval-plan anchors --hash prints for the frozen anchor ids and expected answers, so the answers are scored against the set frozen with the plan';
    expect(errs(NEON.replace(`anchors-digest: ${FROZEN}\n`, ''))).toEqual([shaErr]);
    expect(errs(NEON.replace(FROZEN, FROZEN.slice(0, 40)))).toEqual([shaErr]);
    for (const by of ['gemini-4-neon', 'neon', 'people, final ties by a model', 'models']) {
      expect(errs(NEON.replace('google/gemini-4-neon', by)), by).toEqual(['labels-by: says people, construction or rule, or for a judge that grades code names a third-family model as <provider>/<model>, such as google/gemini-4-neon (R126)']);
    }
  });

  test('judge --check counts a model labeller only once its anchor answers meet the pass line', () => {
    const s = checkPrereg(late(NEON)).scoring;
    expect(checkJudgeLabels(s, labels(100, 10), arms).problems).toEqual(["labels-by: google/gemini-4-neon is a model; pass --anchors <file> with its answers on the 12 frozen known-answer anchors, and its labels count only at anchor-pass: 11 or better (R126)"]);
    expect(checkJudgeLabels(s, labels(100, 10), arms, anchors(12, 11))).toMatchObject({ ok: true, labels_by: MODEL_LABELLER_DEFAULT, anchors: { right: 11, n: 12, need_right: 11 } });
    expect(checkJudgeLabels(s, labels(100, 10), arms, anchors(12, 2)).problems).toEqual(['google/gemini-4-neon answered 2 of 12 anchors right, below the pass line 11; its labels do not count']);
    expect(checkJudgeLabels(s, labels(100, 10), arms, anchors(11, 11)).problems).toContain('11 anchors answered, the plan froze 12');
    expect(checkJudgeLabels(s, labels(100, 10), arms, anchors(12, 12, 0).replace(/anchor-0/, 'item-0')).problems).toContain('anchor item-0 is also a label row; anchors do not count toward the labels');
    expect(checkJudgeLabels(s, labels(40, 4), arms, anchors(12, 12)).problems).toEqual(['40 labelled outputs, needs 100']);
  });

  test('anchor answers are scored against the set frozen with the plan, and bad rows are refused', () => {
    const s = checkPrereg(late(NEON)).scoring;
    const rewritten = anchors(12, 2).replace(/"expected":"bug","label":"can't tell"/g, '"expected":"can\'t tell","label":"can\'t tell"');
    const r = checkJudgeLabels(s, labels(100, 10), arms, rewritten);
    expect(r.ok).toBe(false);
    expect(r.anchors).toMatchObject({ right: 12, frozen: false });
    expect(r.problems).toEqual([`the anchor ids and expected answers hash to ${anchorSetDigest(rewritten.trim().split('\n').map(l => JSON.parse(l)))}, not the frozen anchors-digest ${FROZEN}; score the labeller on the anchors frozen with the plan`]);
    const dup = anchors(12, 12) + JSON.stringify({ id: 'anchor-0', expected: 'bug', label: 'bug' }) + '\n';
    expect(checkJudgeLabels(s, labels(100, 10), arms, dup).problems).toEqual(['anchor anchor-0 appears twice']);
    const bad = anchors(12, 12) + 'not json\n' + JSON.stringify({ id: 'anchor-x', expected: 'bug' }) + '\n';
    expect(checkJudgeLabels(s, labels(100, 10), arms, bad).problems).toEqual(['anchors line 13: needs {"id", "expected", "label"}, each a string, number or boolean', 'anchors line 14: needs {"id", "expected", "label"}, each a string, number or boolean']);
  });

  test('results --check wants the third-model line in the results file', () => {
    const rows = table('| arm | passed |', '| claude-opus-5-5 | 7/9 |', '| claude-opus-5-5#plain | 5/9 |');
    const line = thirdModelLine(MODEL_LABELLER_DEFAULT);
    expect(line).toBe('judge checked against google/gemini-4-neon, a third model, not against people');
    expect(checkResults(late(NEON), rows, labels(100, 10), anchors(12, 12)).issues).toEqual([{ code: 'EVAL_REPORT_THIRD_MODEL_UNNAMED', message: `the judge's labels came from google/gemini-4-neon; the results say "${line}"` }]);
    expect(checkResults(late(NEON), rows + '\nThe ' + line + '.\n', labels(100, 10), anchors(12, 12))).toMatchObject({ ok: true, issues: [] });
    expect(checkResults(late(NEON), rows + '\n' + line + '\n', labels(100, 10)).issues.map(i => i.code)).toEqual(['EVAL_JUDGE_UNCHECKED']);
    expect(checkResults(late(''), rows, labels(100, 10)).ok).toBe(true);
  });

  const cli = (args: string[], files: Record<string, string>) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'gstack-third-model-')); dirs.push(d);
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(d, name), text);
    const r = spawnSync(BIN, args, { cwd: d, encoding: 'utf8', timeout: 60_000 });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };

  test('on the command line: judge --check reads --anchors and prints the results line; results --check reads --anchors too', () => {
    const files = { 'p.md': late(NEON), 'l.jsonl': labels(100, 10), 'a.jsonl': anchors(12, 11), 'r.md': table('| arm | passed |', '| claude-opus-5-5 | 7/9 |', '| claude-opus-5-5#plain | 5/9 |') + '\n' + thirdModelLine(MODEL_LABELLER_DEFAULT) + '\n' };
    const ok = cli(['judge', '--check', 'p.md', '--labels', 'l.jsonl', '--anchors', 'a.jsonl'], files);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out.split('\n')[0]).toBe('JUDGE_ANCHORS: ok labeller=google/gemini-4-neon right=11/12 pass=11 frozen=match');
    expect(ok.out).toContain('JUDGE_AGREEMENT: ok judge=gpt-6-astra n=100/100 kappa=0.80 bar=0.6 labels_by=google/gemini-4-neon\n');
    expect(ok.out).toContain('JUDGE_RESULTS_LINE: judge checked against google/gemini-4-neon, a third model, not against people\n');
    const missed = cli(['judge', '--check', 'p.md', '--labels', 'l.jsonl', '--anchors', 'a.jsonl'], { ...files, 'a.jsonl': anchors(12, 2) });
    expect(missed.code).toBe(1);
    expect(missed.out.split('\n')[0]).toBe('JUDGE_ANCHORS: missed labeller=google/gemini-4-neon right=2/12 pass=11 frozen=match');
    expect(missed.err).toContain('(EVAL_JUDGE_UNCHECKED)');
    expect(cli(['judge', '--check', 'p.md', '--labels', 'l.jsonl'], files).code).toBe(1);
    const results = cli(['results', '--check', 'p.md', 'r.md', '--labels', 'l.jsonl', '--anchors', 'a.jsonl'], files);
    expect(results.code, results.err).toBe(0);
    expect(results.out.split('\n')[0]).toBe('RESULTS: ok no_gstack_rows=0/0 rows=0/0 file=r.md');
    const unnamed = cli(['results', '--check', 'p.md', 'r.md', '--labels', 'l.jsonl', '--anchors', 'a.jsonl'], { ...files, 'r.md': table('| arm | passed |', '| claude-opus-5-5 | 7/9 |', '| claude-opus-5-5#plain | 5/9 |') });
    expect(unnamed.code).toBe(1);
    expect(unnamed.err).toContain('(EVAL_REPORT_THIRD_MODEL_UNNAMED)');
    expect(cli(['judge', '--check', 'p.md', '--labels', 'l.jsonl', '--anchors', 'none.jsonl'], files).code).toBe(2);
    expect(cli(['results', '--check', 'p.md', 'r.md', '--labels', 'l.jsonl', '--anchors', 'none.jsonl'], files).code).toBe(2);
    const frozen = cli(['anchors', '--hash', 'f.jsonl'], { 'f.jsonl': Array.from({ length: 12 }, (_, i) => JSON.stringify({ id: `anchor-${11 - i}`, expected: 'bug' })).join('\n') + '\n' });
    expect(frozen.code, frozen.err).toBe(0);
    expect(frozen.out).toBe(`ANCHORS: n=12 sha256=${FROZEN}\n`);
    expect(cli(['anchors', '--hash', 'f.jsonl'], { 'f.jsonl': 'not json\n' }).code).toBe(1);
  });
});

