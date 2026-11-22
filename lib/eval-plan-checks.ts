/**
 * eval-plan-checks: the result checks /eval-plan runs on top of the section
 * check (docs/TESTING_INTERNALS.md#result-checks). `## Decisions` names what
 * each possible result changes before anything is spent; `## Scoring` names
 * the judge and the statistics before the run; `judge --check` scores the
 * judge against hand labels before its numbers count. A preregistration whose
 * `frozen:` date is before RESULT_CHECKS_SINCE keeps the rules it was frozen
 * under. Reads text only; executes nothing.
 */
import { currentReplacement } from './pricing';

export const RESULT_CHECKS_SINCE = '2026-11-15';
export const JUDGE_MIN_LABELS = 40;
/** R78 amendment (Garry, 2026-11-21): a plan frozen on or after this date (or with no frozen: line) checks its judge on at least JUDGE_RAISED_MIN_LABELS labels; earlier plans keep JUDGE_MIN_LABELS. */
export const JUDGE_LABELS_RAISED_SINCE = '2026-11-22';
export const JUDGE_RAISED_MIN_LABELS = 100;
export const judgeMinLabels = (frozen: string | null) => (frozen !== null && frozen < JUDGE_LABELS_RAISED_SINCE ? JUDGE_MIN_LABELS : JUDGE_RAISED_MIN_LABELS);
export const JUDGE_MIN_KAPPA = 0.6;

const PLACEHOLDER = /^(?:|-+|—|n\/a|none|tbd|todo|\?)\.?$/i;
const keyValues = (body: string[]) => {
  const kv: Record<string, string> = {};
  for (const line of body) {
    const m = /^\s*(?:[-*]\s+)?([a-z][a-z-]*):(.*)$/i.exec(line);
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

/**
 * The eval-loop checks (docs/TESTING_INTERNALS.md#eval-loop-checks), dated
 * LOOP_CHECKS_SINCE: an uncounted pilot per arm of at most a tenth of its
 * budget that draws every unit type in a seeded order, a judge read per arm at
 * a stated effort, a cost line, one preregistered look at half the units for a
 * counted run above INTERIM_LOOK_ABOVE_USD, "smaller" scored with tests, and a
 * check that the task machine holds no answers. A quick look (`kind: quick
 * look`) is a three-line plan capped at QUICK_LOOK_MAX_USD that publishes no
 * number. A preregistration frozen before LOOP_CHECKS_SINCE keeps its rules.
 */
export const LOOP_CHECKS_SINCE = '2026-11-21';
/** The Held-out exposure `grader:` line (H2): a plan frozen before this date keeps the rules it was frozen under. */
export const GRADER_CHECK_SINCE = '2026-11-23';
export const PILOT_MAX_SHARE_PCT = 10;
export const INTERIM_LOOK_ABOVE_USD = 500;
export const QUICK_LOOK_MAX_USD = 100;
export const loopGrandfathered = (text: string) => { const d = frozenDate(text); return d !== null && d < LOOP_CHECKS_SINCE; };
export const isQuickLook = (text: string) => /^\s*kind:\s*quick[- ]look\s*$/im.test(text);
const filled = (v: string | undefined) => v !== undefined && !PLACEHOLDER.test(v.trim()) && !/^<.*>$/.test(v.trim());
const dollars = (v: string | undefined) => { const m = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?$/.exec((v ?? '').trim()); return m ? Number(m[1]!.replace(/,/g, '') + (m[2] ?? '')) : null; };
const SMALLER = /\b(smaller (?:change|diff|patch)|less code|fewer lines|shorter diff|minimal diff|diff size)\b/i;

export interface QuickLookCheck { cap: number | null; errors: string[] }
/** `kind: quick look`: `question:`, `decision:`, `stop:` and `cap:` at most QUICK_LOOK_MAX_USD paid. It publishes no number. */
export function checkQuickLook(text: string): QuickLookCheck {
  const kv = keyValues(text.split('\n'));
  const errors = (['question', 'decision', 'stop'] as const).filter(k => !filled(kv[k])).map(k => `no ${k}: line (a quick look is three lines: question, decision, stop rule)`);
  const cap = dollars(kv.cap);
  if (cap === null || cap > QUICK_LOOK_MAX_USD) errors.push(`cap: needs a plain dollar amount (such as $100) of at most $${QUICK_LOOK_MAX_USD}; anything bigger is a counted run with a full preregistration`);
  return { cap, errors };
}

export interface LoopCheck { paid: number | null; interim_required: boolean; errors: Array<{ section: string; message: string }> }
export interface LoopSections { pilot: string[] | null; cost: string[] | null; interim: string[] | null; scoring: string[] | null; bars: string[] | null; arms: string[] | null; heldOut: string[] | null; frozen?: string | null }
/** The dated eval-loop checks over a counted run's preregistration sections. */
export function checkLoop(s: LoopSections): LoopCheck {
  const errors: LoopCheck['errors'] = [];
  const add = (section: string, message: string) => errors.push({ section, message });
  const scoring = keyValues(s.scoring ?? []);
  const modelJudge = filled(scoring.judge);
  if (s.pilot?.length) {
    const kv = keyValues(s.pilot);
    const share = firstNumber(kv.share);
    if (share === null || share <= 0 || share > PILOT_MAX_SHARE_PCT) add('Pilot', `share: each arm's pilot spends at most ${PILOT_MAX_SHARE_PCT}% of that arm's budget`);
    if (!/^no\b/i.test(kv.counted ?? '')) add('Pilot', 'counted: no (pilot items never count toward the result)');
    for (const [k, what] of [['ran', 'how the pilot shows, on each arm\'s own outputs, that the part under test ran'], ['supply', 'how the pilot shows the units can be supplied at the planned rate'], ['units', 'every unit type the counted run uses, each drawn at least once in the pilot'], ['seed', 'the fixed seed for the draw order, which does not depend on the number of workers']] as const) if (!filled(kv[k])) add('Pilot', `${k}: ${what}`);
    if (modelJudge && !filled(kv.judge)) add('Pilot', 'judge: how the judge is checked against labels on each arm\'s pilot outputs');
  }
  if (modelJudge) {
    if (!/^yes\b/i.test(scoring['per-arm'] ?? '')) add('Scoring', 'per-arm: yes (the judge\'s agreement is read on each arm\'s outputs, not pooled)');
    if (!filled(scoring.effort)) add('Scoring', 'effort: the reasoning effort set in the judge\'s start (left unset, it inherits its parent\'s)');
  }
  const cost = keyValues(s.cost ?? []);
  const paid = dollars(cost.paid);
  if (s.cost?.length) {
    if (paid === null) add('Cost', 'paid: the counted run\'s paid budget as a plain dollar amount, such as $1,200 (no k, ranges, units or arithmetic)');
    if (!filled(cost.meter)) add('Cost', 'meter: the expected meter spend (agent and machine time), or $0');
    if (!filled(cost.ledger)) add('Cost', 'ledger: the private file where the actual cost and the decision it settled are written');
  }
  const interim_required = paid !== null && paid > INTERIM_LOOK_ABOVE_USD;
  if (interim_required) {
    const kv = keyValues(s.interim ?? []);
    if (!s.interim?.length) add('Interim look', `missing: a counted run above $${INTERIM_LOOK_ABOVE_USD} preregisters one look at half its units`);
    else {
      if (firstNumber(kv.at) !== 50) add('Interim look', 'at: 50% (the one look comes at half the units)');
      if (firstNumber(kv.looks) !== 1) add('Interim look', 'looks: 1 (no other look is taken)');
      if (!/o['’]?brien[- ]fleming/i.test(kv.bounds ?? '')) add('Interim look', 'bounds: O\'Brien-Fleming stop bounds, with their values');
      if (!filled(kv.futility)) add('Interim look', 'futility: the result at the look that stops the run as unable to reach its bar');
    }
  }
  if (SMALLER.test([...(s.arms ?? []), ...(s.bars ?? [])].join('\n')) && !(s.bars ?? []).some(l => /regression test/i.test(l))) add('Bars', 'an arm asks for a smaller change or less code, so "regression test added" is a co-primary bar (a shorter diff can come from skipping the test)');
  const answers = (s.heldOut ?? []).map(l => /^\s*(?:[-*]\s+)?answers(?: on the task machine)?:(.*)$/i.exec(l)?.[1]).find(v => v !== undefined);
  if (s.heldOut?.length && !filled(answers?.trim().replace(/^`(.*)`$/, '$1'))) add('Held-out exposure', 'answers: how each task machine was checked, before any session, for answers the agent could read there');
  const grader = (s.heldOut ?? []).map(l => /^\s*(?:[-*]\s+)?grader:(.*)$/i.exec(l)?.[1]?.trim().replace(/^`(.*)`$/, '$1')).find(v => v !== undefined);
  if (s.heldOut?.length && !(s.frozen && s.frozen < GRADER_CHECK_SINCE) && !(grader && (/^none\b/i.test(grader) || filled(grader)))) add('Held-out exposure', 'grader: how a grader that runs git in the agent\'s repo treats that repo as hostile (eval-plan/SKILL.md, "A grader treats the agent\'s repo as hostile"), or none when no grader runs git there');
  return { paid, interim_required, errors };
}

/**
 * R116 (Garry, 2026-11-21): no gpt-4o, and no model lib/pricing.ts marks
 * `superseded_by`, in any role a plan chooses: an arm, the judge, a reader or
 * a simulator (docs/TESTING_INTERNALS.md#frontier-models-under-test). A
 * competitor system tested as its vendor ships it keeps its built-in model
 * through a `vendor-default: <model> <system>` line in `## Models`; the
 * check records it and results --check wants the results to name it. A
 * preregistration frozen before MODEL_GENERATIONS_SINCE keeps its models.
 */
export const MODEL_GENERATIONS_SINCE = '2026-11-21';
export type ModelRole = 'arm' | 'judge' | 'reader' | 'simulator';
export interface ModelUse { model: string; role: ModelRole; loadout?: string }
/** What dry-run and pilot start read from `--prereg <file>`: its `## Models` lines and `frozen:` date, so a vendor-default line and a freeze date count there as in prereg --check. */
export interface PlanModels { file: string; frozen: string | null; models: string[] | null }
export interface ModelGenerationCheck { ok: boolean; exempt: boolean; refused: Array<{ model: string; role: ModelRole; replacement: string }>; exceptions: Array<{ model: string; system: string; roles: ModelRole[] }>; errors: string[] }
export function checkModelGenerations(o: { arms: string[]; judge?: string | null; models?: string[] | null; frozen?: string | null }): ModelGenerationCheck {
  if (o.frozen && o.frozen < MODEL_GENERATIONS_SINCE) return { ok: true, exempt: true, refused: [], exceptions: [], errors: [] };
  const list = (v: string) => v.split(/[\s,]+/).map(m => m.replace(/^`|`$/g, '')).filter(m => m && !PLACEHOLDER.test(m));
  const uses: ModelUse[] = [...o.arms.map(a => ({ model: a.split('#')[0]!, loadout: a.split('#')[1], role: 'arm' as const })), ...list(o.judge ?? '').map(model => ({ model, role: 'judge' as const }))];
  const errors: string[] = [];
  const exceptions: ModelGenerationCheck['exceptions'] = [];
  for (const line of o.models ?? []) {
    const m = /^\s*(?:[-*]\s+)?(readers?|simulators?|vendor-default):(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase().replace(/s$/, '');
    if (key !== 'vendor-default') { uses.push(...list(m[2]!).map(model => ({ model, role: key as ModelRole }))); continue; }
    const [model = '', ...rest] = m[2]!.trim().split(/\s+/);
    const system = rest.join(' ').replace(/^(?:[—–:|-]+|in|for)\s+/i, '').trim();
    if (!model || !filled(system)) errors.push(`vendor-default: ${m[2]!.trim() || '(empty)'} needs the model and the competitor system that ships it as its default, such as "vendor-default: gpt-4o-mini Mem0 1.2 as shipped"`);
    else exceptions.push({ model: model.replace(/^`|`$/g, '').split('#')[0]!, system, roles: [] });
  }
  const bare = (m: string) => m.toLowerCase().replace(/^(?:[a-z-]+[/:])+/, '');
  const word = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const refused: ModelGenerationCheck['refused'] = [];
  for (const use of uses) {
    const replacement = currentReplacement(use.model);
    if (!replacement) continue;
    const exception = use.role === 'arm' && use.loadout ? exceptions.find(e => bare(e.model) === bare(use.model) && word(e.system).startsWith(word(use.loadout!)) && word(use.loadout!) !== '') : undefined;
    if (exception) { if (!exception.roles.includes('arm')) exception.roles.push('arm'); continue; }
    if (!refused.some(r => r.model === use.model && r.role === use.role)) refused.push({ model: use.model, role: use.role, replacement });
  }
  return { ok: !refused.length && !errors.length, exempt: false, refused, exceptions, errors };
}
export const modelGenerationProblems = (c: ModelGenerationCheck) => [...c.refused.map(r => `${r.model} as ${r.role} is an older generation; use ${r.replacement} (R116)`), ...c.errors];
export const renderModelGenerations = (c: ModelGenerationCheck) => [
  ...c.refused.map(r => `MODEL_GENERATION: refused ${r.model} role=${r.role} replacement=${r.replacement} (R116, docs/TESTING_INTERNALS.md#frontier-models-under-test)`),
  ...c.exceptions.map(e => `MODEL_EXCEPTION: ${e.model} vendor-default system=${JSON.stringify(e.system)} roles=${e.roles.join(',') || 'declared'} (the results must name it)`),
].map(l => `${l}\n`).join('');

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

export interface ScoringCheck { judge: string | null; labels: number | null; agreement: number | null; errors: string[]; per_arm?: boolean; min_labels?: number }
/**
 * `## Scoring`: `judge: none` or the judge model; a model judge needs `labels:`
 * (at least judgeMinLabels(frozen): 100, or 40 for a plan frozen before 2026-11-22) and `agreement:` (a kappa bar of at least 0.6) and a family no
 * arm shares. Two or more arms need `paired: yes`, `interval: 95%` and `mdd:`,
 * the smallest difference the run can detect.
 */
export function checkScoring(body: string[] | null, arms: string[], frozen: string | null = null): ScoringCheck {
  const min_labels = judgeMinLabels(frozen);
  if (!body?.length) return { judge: null, labels: null, agreement: null, errors: [], min_labels };
  const kv = keyValues(body);
  const judge = kv.judge || null;
  const labels = firstNumber(kv.labels);
  const agreement = firstNumber(kv.agreement);
  const errors: string[] = [];
  if (!judge) errors.push('no judge: line (judge: none, or the judge model)');
  else if (judge.toLowerCase() !== 'none') {
    if (labels === null || labels < min_labels) errors.push(`labels: needs at least ${min_labels} hand-labelled outputs the judge is checked against${min_labels > JUDGE_MIN_LABELS ? ` (${JUDGE_MIN_LABELS} only for a plan frozen before ${JUDGE_LABELS_RAISED_SINCE})` : ''}`);
    if (agreement === null || agreement < JUDGE_MIN_KAPPA || agreement > 1) errors.push(`agreement: needs a kappa bar from ${JUDGE_MIN_KAPPA} to 1`);
    const family = modelFamily(judge);
    for (const arm of [...new Set(arms)]) if (modelFamily(arm) === family) errors.push(`judge ${judge} is the same model family (${family}) as arm ${arm}; use a judge from another family`);
  }
  if (new Set(arms).size >= 2) {
    if (!/^yes\b/i.test(kv.paired ?? '')) errors.push('paired: yes (every comparison is reported on paired items)');
    if (firstNumber(kv.interval) !== 95) errors.push('interval: 95% (the interval every comparison is reported with)');
    if (PLACEHOLDER.test(kv.mdd ?? '')) errors.push('mdd: the smallest difference this run can detect, stated before the run');
  }
  return { judge, labels, agreement, errors, per_arm: /^yes\b/i.test(kv['per-arm'] ?? ''), min_labels };
}

export interface JudgeLabelCheck { ok: boolean; judge: string; n: number; kappa: number | null; need_n: number; need_kappa: number; problems: string[]; arms: Array<{ arm: string; n: number; kappa: number | null }> }

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
export function checkJudgeLabels(scoring: ScoringCheck, labelsText: string, planArms: string[] = []): JudgeLabelCheck {
  const need_n = Math.max(scoring.min_labels ?? JUDGE_RAISED_MIN_LABELS, scoring.labels ?? 0);
  const need_kappa = Math.max(JUDGE_MIN_KAPPA, scoring.agreement ?? 0);
  const problems: string[] = [];
  const pairs: Array<[string, string]> = [];
  const ids = new Set<string>();
  const byArm = new Map<string, Array<[string, string]>>();
  let unarmed = 0;
  labelsText.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let row: { id?: unknown; human?: unknown; judge?: unknown; arm?: unknown } | null = null;
    try { row = JSON.parse(line); } catch { row = null; }
    if (!row || typeof row !== 'object' || ![row.id, row.human, row.judge].every(v => (typeof v === 'string' && v.trim() !== '') || typeof v === 'number' || typeof v === 'boolean')) { problems.push(`line ${i + 1}: needs {"id", "human", "judge"}, each a string, number or boolean`); return; }
    if (ids.has(String(row.id))) { problems.push(`id ${String(row.id)} is labelled twice`); return; }
    ids.add(String(row.id));
    pairs.push([String(row.human), String(row.judge)]);
    const arm = typeof row.arm === 'string' && row.arm.trim() ? row.arm.trim() : null;
    if (arm) byArm.set(arm, [...(byArm.get(arm) ?? []), [String(row.human), String(row.judge)]]); else unarmed++;
  });
  const kappa = cohensKappa(pairs);
  if (pairs.length < need_n) problems.push(`${pairs.length} labelled outputs, needs ${need_n}`);
  if (pairs.length && kappa === null) problems.push('every label is one class, so agreement is undefined; label outputs of every kind the judge scores');
  else if (kappa !== null && kappa < need_kappa) problems.push(`kappa ${kappa.toFixed(2)} is below the bar ${need_kappa}`);
  const arms = [...byArm].map(([arm, p]) => ({ arm, n: p.length, kappa: cohensKappa(p) }));
  if (scoring.per_arm && unarmed) problems.push(`per-arm: yes needs an "arm" on every label row; ${unarmed} have none`);
  const planned = [...new Set(planArms)];
  if (scoring.per_arm) {
    const unlabelled = planned.filter(a => !byArm.has(a));
    const unknown = [...byArm.keys()].filter(a => planned.length && !planned.includes(a));
    if (unlabelled.length) problems.push(`per-arm: yes needs labels from every arm in ## Arms; no rows for ${unlabelled.join(', ')}`);
    if (unknown.length) problems.push(`label rows name arms that are not in ## Arms: ${unknown.join(', ')}`);
  }
  if (scoring.per_arm) for (const a of arms) if (a.kappa === null || a.kappa < need_kappa) problems.push(`arm ${a.arm}: kappa ${a.kappa === null ? 'undefined' : a.kappa.toFixed(2)} on its ${a.n} labels is below the bar ${need_kappa}; the judge does not pass on this arm's outputs`);
  return { ok: problems.length === 0, judge: scoring.judge ?? 'none', n: pairs.length, kappa, need_n, need_kappa, problems, arms };
}

export const renderJudgeLabels = (c: JudgeLabelCheck) => c.arms.map(a => `JUDGE_ARM: ${a.arm} n=${a.n} kappa=${a.kappa === null ? 'undefined' : a.kappa.toFixed(2)} bar=${c.need_kappa}\n`).join('') + `JUDGE_AGREEMENT: ${c.ok ? 'ok' : 'unchecked'} judge=${c.judge} n=${c.n}/${c.need_n} kappa=${c.kappa === null ? 'undefined' : c.kappa.toFixed(2)} bar=${c.need_kappa}\n`;
