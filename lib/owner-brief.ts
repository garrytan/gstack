/**
 * owner-brief — what the owner sees at the autoplan gate (plan E3). One page:
 * a plain-language summary, the `## URGENT, outside this plan` block (B12),
 * and the numbered decisions rendered through the gate list (B9): seven per
 * page with stable ids, `auto` items showing the default taken if unanswered,
 * `approval` items pending until answered. The full review stays in
 * `review-record.md`; the brief points at it. `closeDraftDirections` is the
 * phase-close operation that rewrites every `draft direction stands until the
 * owner decides` line in the plan to the decided option and date once the
 * gate is answered; a line whose decision is still pending is left as is and
 * reported (DRAFT_DIRECTION_UNRESOLVED).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PAGE_SIZE, renderGate, type GateList } from './gate-list';
import { readJsonl, renderUrgentBlock, type DecisionRow } from './headless-artifacts';
import type { ResultCodeName } from './result-codes';

export const DRAFT_DIRECTION_PHRASE = 'draft direction stands until the owner decides';
export const BRIEF_FILE = 'brief.md';

export interface BriefInputs { gate: GateList; decisions: DecisionRow[]; findings: Record<string, unknown>[]; run?: Record<string, any>; timing?: Record<string, any> }
export interface BriefError { code: ResultCodeName; message: string }

export function loadBriefInputs(outDir: string): { inputs: BriefInputs } | { error: BriefError } {
  const need = (name: string) => path.join(outDir, name);
  for (const name of ['gate.json', 'decisions.jsonl', 'findings.jsonl']) if (!fs.existsSync(need(name))) return { error: { code: 'BRIEF_INPUT_MISSING', message: `${name} not in ${outDir}` } };
  let gate: GateList;
  try { gate = JSON.parse(fs.readFileSync(need('gate.json'), 'utf8')) as GateList; } catch (e: any) { return { error: { code: 'ARTIFACT_INVALID_JSON', message: `gate.json: ${e.message}` } }; }
  const decisions = readJsonl(need('decisions.jsonl'));
  if (decisions.errors.length) return { error: { code: 'ARTIFACT_MALFORMED_JSONL', message: decisions.errors.map(e => e.message).join('; ') } };
  const findings = readJsonl(need('findings.jsonl'));
  if (findings.errors.length) return { error: { code: 'ARTIFACT_MALFORMED_JSONL', message: findings.errors.map(e => e.message).join('; ') } };
  const optional = (name: string) => { try { return fs.existsSync(need(name)) ? JSON.parse(fs.readFileSync(need(name), 'utf8')) : undefined; } catch { return undefined; } };
  return { inputs: { gate, decisions: decisions.rows as unknown as DecisionRow[], findings: findings.rows, run: optional('run.json'), timing: optional('timing.json') } };
}

/** The decision row for a gate item, at the gate's revision (the label is the item id in upper case). */
function rowFor(inputs: BriefInputs, id: string): DecisionRow | undefined {
  return inputs.decisions.filter(d => d.gate_rev === inputs.gate.gate_rev).find(d => (d.label ?? '').toLowerCase() === id || d.id === `${inputs.gate.run}-${id}`);
}

/** Plain words, counted from the artifacts; `summary` (a file the run or the parent wrote) replaces the generated sentence. */
export function plainSummary(inputs: BriefInputs, summary?: string): string {
  if (summary?.trim()) return summary.trim().replace(/^#{1,6}[^\n]*\n+/, '').trim() || summary.trim();
  const phases = inputs.run?.required_phases ?? Object.keys(inputs.run?.phases ?? {});
  const closed = phases.filter((p: string) => inputs.run?.phases?.[p]?.closed_at);
  const f = inputs.findings;
  const accepted = f.filter(r => ['accepted', 'partially_accepted', 'fixed'].includes(String(r.resolution ?? r.disposition ?? ''))).length;
  const auto = inputs.gate.items.filter(i => i.kind === 'auto').length;
  const approval = inputs.gate.items.filter(i => i.kind === 'approval');
  const pending = approval.filter(i => (rowFor(inputs, i.id)?.status ?? 'pending') === 'pending').length;
  const cycle = inputs.timing?.total_s ?? inputs.timing?.cycle_s;
  return [
    `${closed.length ? `${closed.length} review phase${closed.length === 1 ? '' : 's'} closed (${closed.join(', ')})` : `${phases.length} review phases`}; ${f.length} finding${f.length === 1 ? '' : 's'}${f.length ? ` (${accepted} accepted into the plan)` : ''}.`,
    `${inputs.gate.items.length} decision${inputs.gate.items.length === 1 ? '' : 's'} below: ${auto} take their default if you do not answer; ${approval.length} need your answer (${pending} still pending).`,
    cycle ? `Whole cycle: ${Math.round(Number(cycle) / 60)} min.` : '',
  ].filter(Boolean).join(' ');
}

/** The gate list through B9's renderer, each item line annotated with its status from decisions.jsonl. */
export function renderDecisions(inputs: BriefInputs, page = 1): string {
  const rendered = renderGate(inputs.gate, page, PAGE_SIZE);
  return rendered.split('\n').map(line => {
    const m = /^(\d+)\. \[([a-z]*[0-9]+)\] /.exec(line);
    if (!m) return line;
    const item = inputs.gate.items.find(i => i.id === m[2]);
    const row = rowFor(inputs, m[2]!);
    if (!item) return line;
    if (row && row.status !== 'pending' && row.chosen) return `${line} → decided ${item.id}${row.chosen}${row.answered_at ? ` on ${String(row.answered_at).slice(0, 10)}` : ''}`;
    return item.kind === 'auto' ? `${line} → default ${item.id}${item.recommended} taken if unanswered` : `${line} → pending until you answer`;
  }).join('\n');
}

export function renderBrief(inputs: BriefInputs, o: { page?: number; summary?: string; outDir?: string } = {}): string {
  const pages = Math.max(1, Math.ceil(inputs.gate.items.length / PAGE_SIZE));
  const page = Math.min(Math.max(1, o.page ?? 1), pages);
  const record = o.outDir ? path.join(o.outDir, 'review-record.md') : 'review-record.md';
  const recordNote = o.outDir && fs.existsSync(record) ? ` (${fs.statSync(record).size} bytes)` : '';
  return [
    `# /autoplan owner brief — run ${inputs.gate.run} (gate_rev ${inputs.gate.gate_rev}, page ${page}/${pages})`,
    '',
    renderUrgentBlock(inputs.findings).trimEnd(),
    '',
    '### Summary',
    '',
    plainSummary(inputs, o.summary),
    '',
    '### Decisions',
    '',
    renderDecisions(inputs, page).trimEnd(),
    '',
    `Full review: ${record}${recordNote}. Answer with \`gstack-autoplan answer --out <dir> --gate-rev ${inputs.gate.gate_rev} --reply "<all | d3b uc1a | all except d3b>"\`.`,
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// phase close: rewrite the draft-direction lines
// ---------------------------------------------------------------------------
export interface DraftRewrite { line: number; id: string | null; status: 'rewritten' | 'pending' | 'unknown_id'; text: string }
export interface DraftCloseResult { text: string; rewrites: DraftRewrite[]; unresolved: DraftRewrite[] }

function decisionIdIn(line: string, ids: Set<string>): string | null {
  for (const m of line.matchAll(/\b([a-z]{0,3}[0-9]{1,3})\b/gi)) { const id = m[1]!.toLowerCase(); if (ids.has(id)) return id; }
  return null;
}

/**
 * Every line containing the phrase is rewritten to `decided: <id><option> — <option text> (<date>)`
 * when its decision (an id on the line, else the plan approval `p1`) is answered; pending lines stay.
 */
export function closeDraftDirections(planText: string, inputs: BriefInputs, date: string): DraftCloseResult {
  const ids = new Set(inputs.gate.items.map(i => i.id));
  const rewrites: DraftRewrite[] = [];
  const lines = planText.split('\n').map((line, i) => {
    if (!line.toLowerCase().includes(DRAFT_DIRECTION_PHRASE)) return line;
    const id = decisionIdIn(line, ids) ?? (ids.has('p1') ? 'p1' : null);
    if (!id) { rewrites.push({ line: i + 1, id: null, status: 'unknown_id', text: line }); return line; }
    const item = inputs.gate.items.find(x => x.id === id)!;
    const row = rowFor(inputs, id);
    if (!row || row.status === 'pending' || !row.chosen) { rewrites.push({ line: i + 1, id, status: 'pending', text: line }); return line; }
    const option = item.options.find(o => o.key === row.chosen);
    const replacement = `decided ${id}${row.chosen} (${date}): ${option?.text ?? row.chosen}`;
    const re = new RegExp(DRAFT_DIRECTION_PHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const out = line.replace(re, replacement);
    rewrites.push({ line: i + 1, id, status: 'rewritten', text: out });
    return out;
  });
  return { text: lines.join('\n'), rewrites, unresolved: rewrites.filter(r => r.status !== 'rewritten') };
}

/** Rewrite the plan file in place; returns what changed. */
export function closeDraftDirectionsFile(planFile: string, inputs: BriefInputs, date = new Date().toISOString().slice(0, 10)): DraftCloseResult {
  const text = fs.readFileSync(planFile, 'utf8');
  const result = closeDraftDirections(text, inputs, date);
  if (result.text !== text) {
    const tmp = `${planFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, result.text);
    fs.renameSync(tmp, planFile);
  }
  return result;
}
