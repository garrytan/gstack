/**
 * eval-plan-checks: the result checks /eval-plan runs on top of the section
 * check (docs/TESTING_INTERNALS.md#result-checks). `## Decisions` names what
 * each possible result changes before anything is spent; `## Scoring` names
 * the judge and the statistics before the run; `judge --check` scores the
 * judge against hand labels before its numbers count. A preregistration whose
 * `frozen:` date is before RESULT_CHECKS_SINCE keeps the rules it was frozen
 * under. Reads text only; executes nothing.
 */
export const RESULT_CHECKS_SINCE = '2026-11-15';
export const JUDGE_MIN_LABELS = 40;
export const JUDGE_MIN_KAPPA = 0.6;

const PLACEHOLDER = /^(?:|-+|—|n\/a|none|tbd|todo|\?)\.?$/i;
const keyValues = (body: string[]) => {
  const kv: Record<string, string> = {};
  for (const line of body) {
    const m = /^\s*(?:[-*]\s+)?([a-z]+):(.*)$/i.exec(line);
    if (m) kv[m[1]!.toLowerCase()] = m[2]!.trim().replace(/^`(.*)`$/, '$1');
  }
  return kv;
};
const firstNumber = (v: string | undefined) => { const m = /\d+(?:\.\d+)?/.exec(v ?? ''); return m ? Number(m[0]) : null; };

/** The `frozen: YYYY-MM-DD` line, when the preregistration states its freeze date. */
export function frozenDate(text: string): string | null {
  return /^\s*frozen:\s*(\d{4}-\d{2}-\d{2})\s*$/im.exec(text)?.[1] ?? null;
}
export const grandfathered = (text: string) => { const d = frozenDate(text); return d !== null && d < RESULT_CHECKS_SINCE; };

/** Model family for the judge rule: the lab behind a model id, else the id's first word. */
export function modelFamily(model: string): string {
  const id = model.split('#')[0]!.toLowerCase().split('/').pop()!;
  const head = id.split(/[-_.:\s]|(?<=[a-z])(?=\d)/)[0]!;
  const labs: Record<string, string> = { claude: 'anthropic', gpt: 'openai', o: 'openai', codex: 'openai', gemini: 'google', gemma: 'google', grok: 'xai', llama: 'meta', muse: 'meta' };
  return labs[head] ?? head;
}

export interface DecisionsCheck { outcomes: Array<{ result: string; action: string }>; errors: string[] }
/** `## Decisions`: one `if <result>: <what we do>` line per possible result, at least two, and not all the same action. */
export function checkDecisions(body: string[] | null): DecisionsCheck {
  const outcomes: DecisionsCheck['outcomes'] = [];
  for (const line of body ?? []) {
    const m = /^\s*(?:[-*]\s+)?if\s+(.+?):\s*(.*)$/i.exec(line);
    if (m) outcomes.push({ result: m[1]!.trim(), action: m[2]!.trim() });
  }
  if (!body?.length) return { outcomes, errors: [] };
  const errors: string[] = [];
  if (outcomes.length < 2) errors.push('needs one "if <result>: <what we do>" line per possible result, at least two');
  for (const o of outcomes) if (PLACEHOLDER.test(o.action)) errors.push(`if ${o.result}: names no action`);
  const actions = new Set(outcomes.map(o => o.action.toLowerCase().replace(/\s+/g, ' ')));
  if (outcomes.length >= 2 && actions.size === 1) errors.push('every result leads to the same action, so the eval changes nothing; do not run it');
  return { outcomes, errors };
}

export interface ScoringCheck { judge: string | null; labels: number | null; agreement: number | null; errors: string[] }
/**
 * `## Scoring`: `judge: none` or the judge model; a model judge needs `labels:`
 * (at least 40) and `agreement:` (a kappa bar of at least 0.6) and a family no
 * arm shares. Two or more arms need `paired: yes`, `interval: 95%` and `mdd:`,
 * the smallest difference the run can detect.
 */
export function checkScoring(body: string[] | null, arms: string[]): ScoringCheck {
  if (!body?.length) return { judge: null, labels: null, agreement: null, errors: [] };
  const kv = keyValues(body);
  const judge = kv.judge || null;
  const labels = firstNumber(kv.labels);
  const agreement = firstNumber(kv.agreement);
  const errors: string[] = [];
  if (!judge) errors.push('no judge: line (judge: none, or the judge model)');
  else if (judge.toLowerCase() !== 'none') {
    if (labels === null || labels < JUDGE_MIN_LABELS) errors.push(`labels: needs at least ${JUDGE_MIN_LABELS} hand-labelled outputs the judge is checked against`);
    if (agreement === null || agreement < JUDGE_MIN_KAPPA || agreement > 1) errors.push(`agreement: needs a kappa bar from ${JUDGE_MIN_KAPPA} to 1`);
    const family = modelFamily(judge);
    for (const arm of [...new Set(arms)]) if (modelFamily(arm) === family) errors.push(`judge ${judge} is the same model family (${family}) as arm ${arm}; use a judge from another family`);
  }
  if (new Set(arms).size >= 2) {
    if (!/^yes\b/i.test(kv.paired ?? '')) errors.push('paired: yes (every comparison is reported on paired items)');
    if (firstNumber(kv.interval) !== 95) errors.push('interval: 95% (the interval every comparison is reported with)');
    if (PLACEHOLDER.test(kv.mdd ?? '')) errors.push('mdd: the smallest difference this run can detect, stated before the run');
  }
  return { judge, labels, agreement, errors };
}

export interface JudgeLabelCheck { ok: boolean; judge: string; n: number; kappa: number | null; need_n: number; need_kappa: number; problems: string[] }

/** Cohen's kappa over paired categorical labels; null when chance agreement is total (every label one class). */
export function cohensKappa(pairs: Array<[string, string]>): number | null {
  if (!pairs.length) return null;
  const n = pairs.length;
  const a = new Map<string, number>(); const b = new Map<string, number>();
  let agree = 0;
  for (const [h, j] of pairs) { a.set(h, (a.get(h) ?? 0) + 1); b.set(j, (b.get(j) ?? 0) + 1); if (h === j) agree++; }
  const pe = [...a.keys()].reduce((s, k) => s + (a.get(k)! / n) * ((b.get(k) ?? 0) / n), 0);
  return pe === 1 ? null : (agree / n - pe) / (1 - pe);
}

/** Score the preregistered judge against a JSONL file of `{"id", "human", "judge"}` rows. */
export function checkJudgeLabels(scoring: ScoringCheck, labelsText: string): JudgeLabelCheck {
  const need_n = Math.max(JUDGE_MIN_LABELS, scoring.labels ?? 0);
  const need_kappa = Math.max(JUDGE_MIN_KAPPA, scoring.agreement ?? 0);
  const problems: string[] = [];
  const pairs: Array<[string, string]> = [];
  const ids = new Set<string>();
  labelsText.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let row: { id?: unknown; human?: unknown; judge?: unknown } | null = null;
    try { row = JSON.parse(line); } catch { row = null; }
    if (!row || typeof row !== 'object' || ![row.id, row.human, row.judge].every(v => (typeof v === 'string' && v.trim() !== '') || typeof v === 'number' || typeof v === 'boolean')) { problems.push(`line ${i + 1}: needs {"id", "human", "judge"}, each a string, number or boolean`); return; }
    if (ids.has(String(row.id))) { problems.push(`id ${String(row.id)} is labelled twice`); return; }
    ids.add(String(row.id));
    pairs.push([String(row.human), String(row.judge)]);
  });
  const kappa = cohensKappa(pairs);
  if (pairs.length < need_n) problems.push(`${pairs.length} labelled outputs, needs ${need_n}`);
  if (pairs.length && kappa === null) problems.push('every label is one class, so agreement is undefined; label outputs of every kind the judge scores');
  else if (kappa !== null && kappa < need_kappa) problems.push(`kappa ${kappa.toFixed(2)} is below the bar ${need_kappa}`);
  return { ok: problems.length === 0, judge: scoring.judge ?? 'none', n: pairs.length, kappa, need_n, need_kappa, problems };
}

export const renderJudgeLabels = (c: JudgeLabelCheck) => `JUDGE_AGREEMENT: ${c.ok ? 'ok' : 'unchecked'} judge=${c.judge} n=${c.n}/${c.need_n} kappa=${c.kappa === null ? 'undefined' : c.kappa.toFixed(2)} bar=${c.need_kappa}\n`;
