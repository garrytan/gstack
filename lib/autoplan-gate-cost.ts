/**
 * autoplan-gate-cost — what a gate costs so far and what taking every
 * recommendation would add (plan E16). Every gate-producing command prints the
 * two lines, and the owner brief carries the same figures, so an approval is
 * never asked without its price. gstack prices what it reserved and settled in
 * `<out>/spend.json` (lib/spend-ledger.ts); a host subagent's actual spend is
 * `unknown` to it (kept at its reservation in worst_case), so the line says so
 * and points at the host's own cost view instead of inventing a credit figure.
 * The reopen estimate is an upper bound (`recReopens`): two voices per reopened
 * or newly added phase when the outside voice is on, at the per-voice estimate
 * the run has been reserving.
 */
import * as path from 'node:path';
import { PHASES } from './autoplan-prompts';
import { readDecisions } from './autoplan-state';
import type { GateList } from './gate-list';
import { readLedger, summarize, type SpendSummary } from './spend-ledger';

export interface GateCost {
  summary: SpendSummary;
  /** Reviewer attempts the ledger has seen: settled plus still reserved, shadow calls excluded. */
  attempts: number;
  /** What shadow calls (ledger label `shadow`, lib/autoplan-shadow.ts) spent or hold: in summary and the cap, never in the per-voice price. */
  shadow_usd: number;
  /** Phases a `rec` reply would reopen through its plan-changing recommendations, in run order; empty when none changes the plan. */
  reopens: string[];
  voices: number;
  per_voice_usd: number;
  /** The reopen estimate: voices × per-voice. */
  rec_more_usd: number;
}

export interface GateCostRun { phase_order: string[]; outside_enabled: boolean; spend_cap_usd: number | null; scope_flags?: Record<string, boolean | undefined> }

const usd = (n: number) => n.toFixed(2);

/**
 * The phases a `rec` can reopen, as an upper bound from the answer and revise rules. The effective
 * choice per item is what `rec` would record (parseReply's order): an answer already given at this
 * gate revision (`prior`, as answerGate reads it from decisions.jsonl), else the carried choice,
 * else the recommendation. A recorded plan rerun (`p1d`) reopens every phase; a reject or stop
 * (`p1c`/`p1e`) reopens nothing; an override of the recommendation counts as answerGate counts it. A plan
 * change is absorbed by `revise`, which reopens every phase whose snapshot the edited plan changes
 * and re-detects scope, so it can add a phase the run skipped: every phase the scope flags do not
 * pin off is counted (`--no-ui` keeps Design out, `--no-dx` keeps DX out). A round grant (`cap`
 * item, option `b`) reopens its phase and Eng. Phases already at their cap are not reopened by
 * revise, but the bound does not subtract them: the gate lists their delta as its own item instead.
 */
export function recReopens(list: GateList, run: Pick<GateCostRun, 'phase_order' | 'scope_flags'>, prior: Record<string, string> = {}): string[] {
  const flags = run.scope_flags ?? {};
  const bound = PHASES.filter(p => run.phase_order.includes(p) || (p === 'design' ? flags.ui !== false : p === 'dx' ? flags.dx !== false : true));
  // The effective choice is parseReply's: an answer recorded at this gate, else the carried choice, else the recommendation.
  const choiceOf = (item: GateList['items'][number]) => prior[item.id] ?? item.carried?.chosen ?? item.recommended;
  const plan = list.items.find(i => i.id === 'p1');
  const planChoice = plan ? choiceOf(plan) : undefined;
  if (planChoice === 'c' || planChoice === 'e') return [];
  const named = new Set<string>(planChoice === 'd' ? run.phase_order : []);
  for (const item of list.items) {
    if (item.id === 'p1') continue;
    const choice = choiceOf(item);
    if (item.carried && choice === item.carried.chosen) continue;
    if (item.cap && choice === 'b') { named.add(item.cap.phase); if (run.phase_order.includes('eng')) named.add('eng'); continue; }
    if (item.reopens === false) continue;
    if (item.options.find(o => o.key === choice)?.changes_plan ?? choice !== item.recommended) for (const p of bound) named.add(p);
  }
  return PHASES.filter(p => named.has(p));
}

/** The answers already recorded at this gate revision, keyed as parseReply's `prior` is (item id → option). */
export function priorChoices(outDir: string, gateRev: number): Record<string, string> {
  return Object.fromEntries(readDecisions(outDir).filter(r => r.gate_rev === gateRev && r.chosen != null && r.status !== 'pending' && r.label).map(r => [r.label!.toLowerCase(), r.chosen!]));
}

export function gateCost(outDir: string, list: GateList, run: GateCostRun, o: { defaultPerVoiceUsd?: number } = {}): GateCost {
  const ledger = readLedger(path.join(outDir, 'spend.json'), run.spend_cap_usd);
  const summary = summarize(ledger);
  const voice = (r: { label?: string }) => r.label !== 'shadow';
  const settled = ledger.settled.filter(voice), reserved = ledger.reserved.filter(voice);
  const seen = [...settled.map(s => s.reserved_usd), ...reserved.map(r => r.estimate_usd)].filter(n => n > 0);
  const per_voice_usd = seen.length ? seen[seen.length - 1]! : o.defaultPerVoiceUsd ?? 0;
  const reopens = recReopens(list, run, priorChoices(outDir, list.gate_rev));
  const voices = reopens.length * (run.outside_enabled ? 2 : 1);
  const shadow_usd = Math.round([...ledger.settled.filter(s => !voice(s)).map(s => (s.usd === 'unknown' ? s.reserved_usd : s.usd)), ...ledger.reserved.filter(r => !voice(r)).map(r => r.estimate_usd)].reduce((a, b) => a + b, 0) * 1e6) / 1e6;
  return { summary, attempts: settled.length + reserved.length, shadow_usd, reopens, voices, per_voice_usd, rec_more_usd: Math.round(voices * per_voice_usd * 100) / 100 };
}

/** The two printed lines: the ledger at this gate, and the price of `rec`. */
export function renderGateCost(c: GateCost): string[] {
  const s = c.summary;
  const cap = s.cap_usd === null ? 'none' : usd(s.cap_usd);
  const headroom = s.headroom_usd === null ? 'none' : usd(s.headroom_usd);
  const unknown = s.unknown_count ? `; ${s.unknown_count} host-subagent attempt(s) priced unknown, counted at their reservation (read the actual figure in the host's cost view)` : '';
  const after = s.headroom_usd === null ? '' : ` → headroom ${usd(s.headroom_usd - c.rec_more_usd)}${s.headroom_usd - c.rec_more_usd < 0 ? ' (over the cap: raise it with gstack-autoplan budget before answering rec)' : ''}`;
  return [
    `GATE_SPEND: spent=${usd(s.spent_usd)} worst_case=${usd(s.worst_case_usd)} cap=${cap} headroom=${headroom} attempts=${c.attempts}${c.shadow_usd ? ` shadow=${c.shadow_usd.toFixed(4)}` : ''}${unknown}`,
    c.reopens.length
      ? `GATE_REC_COST: rec reopens up to ${c.reopens.join(',')} ≈ ${c.voices} voice(s) × ${usd(c.per_voice_usd)} = +${usd(c.rec_more_usd)} at most (the run's per-voice reservation)${after}`
      : 'GATE_REC_COST: rec reopens nothing (no recommended option changes the plan): +0.00',
  ];
}

/** The JSON payload beside the printed lines. */
export function gateCostPayload(c: GateCost): Record<string, unknown> {
  const s = c.summary;
  return { spent_usd: s.spent_usd, worst_case_usd: s.worst_case_usd, cap_usd: s.cap_usd, headroom_usd: s.headroom_usd, attempts: c.attempts, ...(c.shadow_usd ? { shadow_usd: c.shadow_usd } : {}), unknown_count: s.unknown_count, rec_reopens: c.reopens, rec_voices: c.voices, per_voice_usd: c.per_voice_usd, rec_more_usd: c.rec_more_usd };
}

/** One sentence for the owner brief. */
export function gateCostSentence(c: GateCost): string {
  const s = c.summary;
  const cap = s.cap_usd === null ? 'no cap set' : `cap ${usd(s.cap_usd)}, headroom ${usd(s.headroom_usd!)}`;
  const unknown = s.unknown_count ? `, ${s.unknown_count} host attempt(s) unknown and counted at reservation` : '';
  const rec = c.reopens.length ? `Taking every recommendation reopens up to ${c.reopens.join(', ')}: at most +${usd(c.rec_more_usd)} more.` : 'Taking every recommendation reopens nothing: no further spend.';
  return `Cost so far: spent ${usd(s.spent_usd)}, worst case ${usd(s.worst_case_usd)} (${cap}${unknown}; ${c.attempts} reviewer attempt(s)). ${rec}`;
}
