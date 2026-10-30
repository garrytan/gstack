/**
 * captain-brief — the plan-approval ask in the shape Capy Captains relay to
 * their person (capy/skill/gstack/captain.md): a two-line header with the
 * one-word reply, then Before → after, Why it matters, What caused this work,
 * Big decisions (each read from the reviewed plan through the shared heading
 * parser) and What we need from you (built from gate.json: every choice `rec`
 * takes, in words, closed by the "do it" reply: rec at full scope, follow-ons
 * included, carried through with no further ask). Gate ids, gate_rev and rec_hash appear only on the last
 * line, which is for the relaying agent. A plan missing a section yields a
 * brief that says it is not ready for approval and has no reply invitation
 * (CAPTAIN_BRIEF_INCOMPLETE). Called by bin/gstack-owner-brief render --captain.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { gateCost, gateCostSentence, priorChoices } from './autoplan-gate-cost';
import { parseReply, recHash, type GateEli5, type GateItem } from './gate-list';
import { renderUrgentBlock } from './headless-artifacts';
import { findSection, firstTitle } from './markdown-sections';
import type { BriefInputs } from './owner-brief';

export const BRIEF_SECTIONS = [
  { title: 'Before → after', aliases: ['Before → after', 'Before -> after', 'Before and after', 'Before/after'] },
  { title: 'Why it matters', aliases: ['Why it matters', 'Why this matters'] },
  { title: 'What caused this work', aliases: ['What caused this work', 'What caused us to work on this', 'What caused this', 'Trigger'] },
  { title: 'Big decisions', aliases: ['Big decisions', 'Big decisions we made', 'Key decisions'] },
] as const;
/** The 5-10 plain sentences a plan opens its ask with; required in a captain brief only when the gate carries `eli5` (written by gstack 1.91.305+). */
export const ELI5_SECTION = { title: 'ELI5', aliases: ['ELI5', 'In plain words'] } as const;
const SECTION_LINES = 24;
const SECTION_CHARS = 3000;

/** The plan text the gate approves: the run's active (reviewed) plan unless an amendment is pending, else the export. */
export function reviewedPlan(outDir: string, run?: Record<string, any>): { file?: string; text: string; sha: string } {
  const active = typeof run?.active_plan === 'string' && run?.status !== 'amend_pending' ? run.active_plan : undefined;
  const candidates = [active, path.join(outDir, 'plan-active.md'), path.join(outDir, 'plan.md')].filter((f): f is string => !!f);
  const file = candidates.find(f => fs.existsSync(f));
  const text = file ? fs.readFileSync(file, 'utf8') : '';
  const sha = typeof run?.plan_reality?.plan_sha256 === 'string' ? run.plan_reality.plan_sha256.slice(0, 12) : text ? createHash('sha256').update(text).digest('hex').slice(0, 12) : 'unknown';
  return { file, text, sha };
}

const stripRef = (t: string) => t.replace(/\s*\[[^\]]*\]\s*$/, '').trim();
const OPTION_WORDS: Record<string, string> = {
  'keep your direction': 'keep the plan as written (a reviewer suggested changing it)',
  'accept the change': "make the reviewer's change",
};
const plainOption = (t: string) => {
  const s = t.replace(/\s*\([^)]*gstack-autoplan[^)]*\)/g, '').trim();
  if (/^approve with the recommended changes\b/.test(s)) return 'approve, with the plan changes marked below';
  if (s === 'approve as-is') return 'approve the plan as reviewed';
  return OPTION_WORDS[s] ?? s;
};
const P1_DONE: Record<string, string> = { a: 'approved as reviewed', b: 'approved with the recommended plan changes', c: 'questions asked, still open', d: 'sent back for another review round', e: 'rejected' };
const clip = (t: string, n: number) => (t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '') + '…');

function capped(body: string, planPath: string): string {
  const lines = body.split('\n');
  let out = lines.slice(0, SECTION_LINES).join('\n');
  if (out.length > SECTION_CHARS) out = out.slice(0, SECTION_CHARS).replace(/\s+\S*$/, '') + ' …';
  const hidden = lines.length - Math.min(lines.length, SECTION_LINES);
  return hidden > 0 || out.length < body.length ? `${out}\n\n_+ more in the plan (${path.basename(planPath)})._` : out;
}

/** gate.json `eli5`: the plan's ELI5 and the four approvals-shape sections, capped as the brief caps them. */
export function buildEli5(planText: string, planFile: string): GateEli5 {
  const body = (aliases: readonly string[]) => { const s = findSection(planText, [...aliases]); return s?.body.trim() ? capped(s.body.trim(), planFile) : ''; };
  const [before, why, cause, decisions] = BRIEF_SECTIONS.map(s => body(s.aliases));
  return { summary: body(ELI5_SECTION.aliases), before_after: before!, why: why!, cause: cause!, decisions: decisions!, plan_file_sha256: createHash('sha256').update(planText).digest('hex') };
}

export interface CaptainBrief { text: string; missing: string[]; pending: boolean; recHash: string }

export function renderCaptainBrief(inputs: BriefInputs, o: { outDir: string }): CaptainBrief {
  const plan = reviewedPlan(o.outDir, inputs.run);
  const title = firstTitle(plan.text) ?? 'this plan';
  const list = inputs.gate;
  const hash = recHash(list);
  const p1 = list.items.find(i => i.id === 'p1');
  const rowOf = (id: string) => inputs.decisions.filter(d => d.gate_rev === list.gate_rev).find(d => (d.label ?? '').toLowerCase() === id);
  const p1Row = p1 ? rowOf('p1') : undefined;
  const pending = !p1Row || p1Row.status === 'pending';
  const eli5 = list.eli5 ? buildEli5(plan.text, plan.file ?? 'plan.md') : undefined;
  const fromGate = eli5 ? [eli5.before_after, eli5.why, eli5.cause, eli5.decisions] : [];
  const sections = BRIEF_SECTIONS.map((s, i) => ({ title: s.title, found: eli5 ? { body: fromGate[i]! } : findSection(plan.text, [...s.aliases]) }));
  const missing = [...(eli5 && !eli5.summary.trim() ? [ELI5_SECTION.title] : []), ...sections.filter(s => !s.found || !s.found.body.trim()).map(s => s.title)];
  const urgent = inputs.findings.some(r => r.urgent === true || r.outside_plan === true) ? [renderUrgentBlock(inputs.findings).trimEnd(), ''] : [];
  const items = list.items.filter(i => i.id !== 'p1');
  const prior = priorChoices(o.outDir, list.gate_rev);
  const rec = parseReply('rec', list, undefined, prior).choices;
  const recKey = (i: GateItem) => rec.find(c => c.id === i.id)?.chosen ?? i.recommended;
  const recOption = (i: GateItem) => i.options.find(x => x.key === recKey(i));
  const kept = items.filter(i => rec.find(c => c.id === i.id)?.prior);
  const keptNote = (i: GateItem) => i.carried?.chosen === recKey(i) ? ` (your answer at gate_rev ${i.carried.gate_rev}, carried forward)` : ' (your answer at this gate)';

  let header: string[];
  if (!pending && p1Row?.carried_gate_from) {
    const unseen = inputs.decisions.filter(d => d.gate_rev === list.gate_rev && d.carried_under).map(d => (d.title ?? '').replace(/\s*\[[^\]]*\]\s*$/, ''));
    header = [`**Nothing pending.** Carried forward from gate_rev ${p1Row.carried_gate_rev}: ${P1_DONE[p1Row?.chosen ?? ''] ?? 'answered'} under the owner's words “${p1Row?.owner_reply ?? ''}”, because nothing new needed deciding.`,
      ...(unseen.length ? ['', `Taken under "do it" without being shown to the owner: ${unseen.join('; ')}.`] : [])];
  } else if (!pending) {
    header = [`**Nothing pending.** Already decided${p1Row?.answered_at ? ` on ${p1Row.answered_at.slice(0, 10)}` : ''}: ${P1_DONE[p1Row?.chosen ?? ''] ?? 'answered'}${p1Row?.owner_reply ?? p1Row?.reply ? ` (“${p1Row?.owner_reply ?? p1Row?.reply}”)` : ''}.`];
  } else if (missing.length) {
    header = [`**Not ready for approval:** the plan "${title}" is missing ${missing.join(', ')}. The thread will add them and send this again; do not approve from this draft.`];
  } else {
    header = [
      `**Decision needed:** approve the plan "${title}". Reply **rec** to ${kept.length ? 'keep the answers you already gave and take every other recommendation' : 'take every recommendation'} (recommended), or say in words what to change.`,
      `${items.length ? `${items.length} choice${items.length === 1 ? '' : 's'} below; rec ${kept.length ? `keeps the ${kept.length} you already answered and takes the recommended answer for the rest` : 'takes the recommended answer for each'}.` : 'No open choices besides the approval itself.'} Nothing is built until you answer.`,
    ];
  }

  const summary = eli5?.summary.trim() ? [`### ${ELI5_SECTION.title}`, '', eli5.summary.trim(), ''] : [];
  const body = [...summary, ...sections.flatMap(s => [`### ${s.title}`, '', s.found?.body.trim() ? (eli5 ? s.found.body.trim() : capped(s.found.body.trim(), plan.file ?? 'plan.md')) : '_Not written for this plan yet._', ''])];
  const need: string[] = ['### What we need from you', ''];
  if (!pending) need.push('Nothing. This gate is answered.', '');
  else {
    need.push(`One decision: approve the plan.`, '');
    need.push(`- **rec (recommended):** ${p1 ? plainOption(recOption(p1)?.text ?? 'approve') : 'approve'}${items.length ? `, taking these ${kept.length ? 'answers' : 'recommendations'}:` : '.'}`);
    items.forEach((i, n) => need.push(`  ${n + 1}. ${stripRef(i.title)}: ${plainOption(recOption(i)?.text ?? recKey(i))}${kept.includes(i) ? keptNote(i) : recOption(i)?.changes_plan ? ' (changes the plan)' : ''}.`));
    const example = items.find(i => i.options.length > 1);
    const alt = example?.options.find(x => x.key !== recKey(example));
    need.push(`- **Change something:** say which choice and what you want instead, in words${example && alt ? ` (for example "${clip(stripRef(example.title), 60)}: ${plainOption(alt.text)}")` : ''}. A change that alters the plan reopens its review before anything is built.`);
    need.push('- **Reject:** nothing is built.', '');
    if (!missing.length) need.push(`- **do it:** rec at full scope: every ${kept.length ? 'choice' : 'recommendation'} above, the follow-ons the plan names (docs, trains, cleanups) included, carried through to done with no further ask.`, '', 'Reply: **rec**, or **do it**', '');
  }
  const tokens = rec.map(c => `${c.id}${c.chosen}`).join(' ');
  const trailer = `_For the relaying agent, not the person:_ run ${list.run}, gate_rev=${list.gate_rev}, rec_hash=${hash}; rec resolves to ${tokens}; plan ${plan.file ?? '(missing)'} (sha256 ${plan.sha}). Answer with ` +
    `\`gstack-autoplan answer --out ${o.outDir} --gate-rev ${list.gate_rev} --reply rec --rec-hash ${hash} --by agent:<id> --owner-reply "<their exact words>"\`, then \`gstack-approvals import --autoplan ${o.outDir} --by <name>\`.`;
  // The price sits above the trailer: the relaying agent sends everything above that line, so the person approving sees it.
  const cost = inputs.run ? ['### Cost', '', gateCostSentence(gateCost(o.outDir, list, { phase_order: inputs.run.phase_order ?? [], outside_enabled: inputs.run.outside_enabled !== false, spend_cap_usd: inputs.run.spend_cap_usd ?? null, scope_flags: inputs.run.scope_flags })), ''] : [];
  const text = [...urgent, ...header, '', ...body, ...need, ...cost, '---', '', trailer, ''].join('\n');
  return { text, missing, pending, recHash: hash };
}

/** The extra line a gate-producing command prints under Capy (GSTACK_CAPY=1): the owner-facing render to relay. */
export function capyRelayLine(outDir: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.GSTACK_CAPY !== '1') return undefined;
  return `RELAY: gstack-owner-brief render --captain --out ${outDir} (Capy: send it to your Captain, or to the person when you report to none; it carries the rec_hash to answer with)`;
}
