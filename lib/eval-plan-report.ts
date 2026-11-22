/**
 * eval-plan-report: the results check behind `gstack-eval-plan results --check`.
 * A preregistration that says `stack: loaded` names its no-gstack arms; its
 * results file must hold one markdown table with a filled row for every Arms
 * identity, so each no-gstack row sits beside its variants
 * (docs/TESTING_INTERNALS.md#no-gstack-arm). The result checks
 * (docs/TESTING_INTERNALS.md#result-checks) hold back a model judge's numbers
 * until its hand labels pass, a zero from a counter never shown to find a
 * planted case, and a failures column with no answer-only reading beside it.
 * Reads text only; executes nothing.
 */
import { armIdentities, checkPrereg } from './eval-plan';
import { checkJudgeLabels, modelGenerationProblems, type JudgeLabelCheck } from './eval-plan-checks';
import type { ResultCodeName } from './result-codes';

export interface ResultsIssue { code: ResultCodeName; message: string }
export interface ResultsCheck { ok: boolean; required: string[]; no_gstack: string[]; found: string[]; missing: string[]; problems: string[]; issues: ResultsIssue[]; judge: JudgeLabelCheck | null }
export interface ResultTable { ids: Set<string>; header: string[]; rows: string[][] }

const PLACEHOLDER = /^(?:|-+|—|–|n\/a|tbd|todo|\?)$/i;
const ZERO = /^0(?:\.0+)?(?:%|\/\d+)?$/;
const plain = (c: string) => c.replace(/[`*]/g, '').trim();
const cellsOf = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const separator = (line: string | undefined) => !!line && /^\s*\|[\s:|-]+\|?\s*$/.test(line) && line.includes('-');

/** Each markdown table: its header cells, data rows, and filled-row identities (first cell, backticks stripped). */
export function resultTables(text: string): ResultTable[] {
  const lines = text.split('\n');
  const tables: ResultTable[] = [];
  let current: ResultTable | null = null;
  lines.forEach((line, i) => {
    if (!/^\s*\|/.test(line)) { current = null; return; }
    if (!current) { current = { ids: new Set(), header: [], rows: [] }; tables.push(current); }
    if (separator(line)) return;
    if (separator(lines[i + 1])) { current.header = cellsOf(line).map(plain); return; }
    const cells = cellsOf(line);
    current.rows.push(cells.map(plain));
    const id = (cells[0] ?? '').replace(/`/g, '').trim();
    if (id && cells.slice(1).some(c => !PLACEHOLDER.test(c.replace(/`/g, '').trim()))) current.ids.add(id);
  });
  return tables;
}

export function checkResults(preregText: string, resultsText: string, labelsText: string | null = null): ResultsCheck {
  const prereg = checkPrereg(preregText);
  const issues: ResultsIssue[] = [];
  const tables = resultTables(resultsText);
  const arms = [...new Set(armIdentities(preregText))];
  const required = prereg.comparison.stack === 'none' ? [] : arms;
  const best = tables.reduce<ResultTable | null>((b, t) => (!b || arms.filter(id => t.ids.has(id)).length > arms.filter(id => b.ids.has(id)).length ? t : b), null);
  const found = required.filter(id => best?.ids.has(id));
  const missing = required.filter(id => !best?.ids.has(id));
  if (prereg.comparison.stack !== 'none') {
    if (!prereg.ok) issues.push({ code: 'EVAL_REPORT_NO_GSTACK_ROW', message: 'the preregistration does not pass prereg --check' });
    if (!tables.length) issues.push({ code: 'EVAL_REPORT_NO_GSTACK_ROW', message: 'no markdown table in the results file' });
    else for (const id of missing) issues.push({ code: 'EVAL_REPORT_NO_GSTACK_ROW', message: `no filled row for ${id} in the table that holds the other arms` });
  }
  if (prereg.quick) issues.push({ code: 'EVAL_QUICK_LOOK_NO_NUMBER', message: 'the plan is a quick look (kind: quick look), which publishes no number; write a counted-run preregistration to publish one' });
  for (const s of prereg.missing) issues.push({ code: 'PREREG_INCOMPLETE', message: `## ${s}: missing` });
  for (const s of prereg.empty) issues.push({ code: 'PREREG_INCOMPLETE', message: `## ${s}: empty` });
  for (const e of prereg.loop.errors) issues.push({ code: 'PREREG_INCOMPLETE', message: `## ${e.section}: ${e.message}` });
  for (const p of modelGenerationProblems(prereg.models)) issues.push({ code: 'EVAL_MODEL_OLD_GENERATION', message: p });
  for (const e of prereg.models.exceptions) if (!resultsText.toLowerCase().includes(e.model.toLowerCase())) issues.push({ code: 'EVAL_MODEL_OLD_GENERATION', message: `the results never name ${e.model}, the vendor default kept for ${e.system}; the results row names it` });
  let judge: JudgeLabelCheck | null = null;
  if (!prereg.grandfathered) {
    for (const [section, errors] of [['Decisions', prereg.decisions.errors], ['Scoring', prereg.scoring.errors]] as const) {
      for (const e of errors) issues.push({ code: 'PREREG_INCOMPLETE', message: `## ${section}: ${e}` });
    }
    if (prereg.scoring.judge && prereg.scoring.judge.toLowerCase() !== 'none') {
      judge = labelsText === null ? null : checkJudgeLabels(prereg.scoring, labelsText, arms);
      if (!judge) issues.push({ code: 'EVAL_JUDGE_UNCHECKED', message: `the preregistration names judge ${prereg.scoring.judge}; pass --labels <hand labels.jsonl>` });
      else if (!judge.ok) issues.push({ code: 'EVAL_JUDGE_UNCHECKED', message: judge.problems.join('; ') });
    }
    const planted = new Set((prereg.diagnostics?.expected ?? []).filter(e => e.count >= 1).map(e => e.name.toLowerCase()));
    for (const t of tables) {
      t.header.forEach((name, col) => {
        if (col === 0 || planted.has(name.toLowerCase()) || !t.rows.some(r => ZERO.test(r[col] ?? ''))) return;
        issues.push({ code: 'EVAL_REPORT_UNPLANTED_ZERO', message: `column "${name}" reports a zero, and no Diagnostics counter by that name was shown to find a planted case` });
      });
      const failures = t.header.filter(h => /\bfail/i.test(h) && !/answer[- ]only/i.test(h));
      if (failures.length && !t.header.some(h => /answer[- ]only/i.test(h))) issues.push({ code: 'EVAL_REPORT_NO_ANSWER_ONLY', message: `column "${failures[0]}" counts failures with no answer-only column beside it in the same table` });
    }
  }
  return { ok: issues.length === 0, required, no_gstack: prereg.no_gstack.arms, found, missing, problems: issues.map(i => i.message), issues, judge };
}
