/**
 * autoplan-ceo-only — the driver's CEO-only run (`gstack-autoplan next
 * --ceo-only`, GST-537), the twin of `/autoplan --ceo-only` (the skill's
 * CEO-only section, docs/unattended.md#ceo-only-runs). The flag is a command-line choice for one run:
 * it conflicts with the flags that add a phase, a plan's scope marker may not
 * name it, and a run directory keeps the mode it started with. The run opens
 * only the CEO phase. `finishRun` is the one finish path next, phase close,
 * resume and close share: a full run writes the gate (`finishGate`); a
 * CEO-only run writes `ceo-review.md`, records each would-be gate item as a
 * decision row of kind `auto` and status `auto_kept` (nobody answered: the
 * plan's direction is kept, and an item only the owner can accept stays
 * undecided), and ends `reviewed`. It never writes gate.json,
 * never calls approve() and never edits the plan, so the commands that need a
 * gate or an approvable run refuse it (CEO_ONLY_NO_GATE); `budget` and
 * `close --deferred` still recover a run stopped by its spend cap.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildGate, finishGate } from './autoplan-gate';
import { carryLines } from './autoplan-carry';
import { aggregateFindings, exportRun } from './autoplan-export';
import { decisionRows, keepDirection, type GateItem } from './gate-list';
import { MARKER_RE } from './autoplan-scope';
import { RunError, journal, voiceRows, writeDecisions, type RunState } from './autoplan-state';
import type { DecisionRow, FindingRow } from './headless-artifacts';
import { sha256File } from './headless-artifacts';

export const CEO_ONLY_FLAG = '--ceo-only';
export const CEO_ONLY_CONFLICTS = ['--ui', '--developer-tool', '--agent-primary'] as const;
export const CEO_ONLY_REPORT = 'ceo-review.md';

/**
 * The first next's checks: true when this next asks for a CEO-only run. A marker naming the flag refuses whether or not
 * the flag was passed; the flag refuses beside a phase-adding flag (argument or marker), on a plan at the report path,
 * or on a directory that holds a full run.
 */
export function checkCeoOnlyFlags(args: readonly string[], plan: string | undefined, existing: RunState | undefined, out?: string): boolean {
  const marker = plan && fs.existsSync(plan) ? MARKER_RE.exec(fs.readFileSync(plan, 'utf8').split('\n', 1)[0]!.replace(/^\uFEFF/, '').trimEnd()) : null;
  const tokens = marker?.[1]!.trim().split(/\s+/) ?? [];
  if (tokens.includes(CEO_ONLY_FLAG)) throw new RunError('CEO_ONLY_CONFLICT', `the scope marker in ${plan} names ${CEO_ONLY_FLAG}`, 3);
  if (!args.includes(CEO_ONLY_FLAG)) return false;
  const conflicts = CEO_ONLY_CONFLICTS.filter(f => args.includes(f) || tokens.includes(f));
  if (conflicts.length) throw new RunError('CEO_ONLY_CONFLICT', `${CEO_ONLY_FLAG} with ${conflicts.join(', ')}`, 3);
  if (plan && out && path.resolve(plan) === path.resolve(out, CEO_ONLY_REPORT)) throw new RunError('CEO_ONLY_CONFLICT', `the plan ${plan} is the report path`, 3);
  if (existing && !existing.ceo_only) throw new RunError('CEO_ONLY_AFTER_INIT', `${existing.out} holds full run ${existing.run} (status ${existing.status})`, 3);
  return true;
}

/** answer, recommend and revise need a gate or an approvable run: a CEO-only run has neither (budget and close stay: they recover a budget stop). */
export function refuseCeoOnly(state: RunState, verb: string): void {
  if (state.ceo_only) throw new RunError('CEO_ONLY_NO_GATE', `${verb} on CEO-only run ${state.run} (status ${state.status}); report: ${path.join(state.out, CEO_ONLY_REPORT)}`, 3);
}

/** Every phase closed: a full run writes its gate (carry lines follow); a CEO-only run writes its report and ends reviewed. */
export function finishRun(state: RunState): string[] {
  if (!state.ceo_only) { finishGate(state); return carryLines(state); }
  const list = buildGate(state, 1);
  const items = list.items.filter(i => i.id !== 'p1');
  const kept = (item: GateItem) => (item.cap && item.kind === 'approval' ? null : keepDirection(item));
  const rows: DecisionRow[] = decisionRows({ ...list, items }).map((row, i) => ({ ...row, kind: 'auto', status: 'auto_kept', chosen: kept(items[i]!), default_if_unanswered: kept(items[i]!), source: 'ceo-only' }));
  writeDecisions(state.out, rows);
  state.status = 'reviewed';
  exportRun(state);
  const findings = aggregateFindings(state);
  const report = path.join(state.out, CEO_ONLY_REPORT);
  const tmp = `${report}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, renderReport(state, items, rows, findings), { flag: 'wx' });
  fs.renameSync(tmp, report);
  state.artifacts[CEO_ONLY_REPORT] = { path: CEO_ONLY_REPORT, sha256: sha256File(report) };
  journal(state.out, { event: 'ceo_only_reviewed', decisions: rows.length, findings: findings.length, report: CEO_ONLY_REPORT });
  return [`REVIEWED: ceo-only run=${state.run} decisions=${rows.length} (auto_kept) findings=${findings.length} report=${report} (not approved; no gate)`];
}

type Challenge = FindingRow & { user_challenge?: boolean };
const none = (lines: string[]) => (lines.length ? lines : ['None.']);

/** The report both paths write: user challenges (direction kept), scope added, conservative choices, findings and the audit trail. */
function renderReport(state: RunState, items: GateItem[], rows: DecisionRow[], findings: FindingRow[]): string {
  const plan = fs.existsSync(state.active_plan) ? fs.readFileSync(state.active_plan, 'utf8') : '';
  const title = /^#\s+(.+)$/m.exec(plan)?.[1]?.trim() ?? path.basename(state.plan_input ?? state.plan_source);
  const outside = state.phases.ceo?.outside;
  const outsideLine = outside?.status === 'completed' ? `completed (${outside.model})` : `${outside?.status ?? 'disabled'}${outside?.reason ? ` (${outside.reason})` : outside?.detail ? ` (${outside.detail})` : ''}`;
  const challenges = [...voiceRows(state, 'ceo', 'native'), ...voiceRows(state, 'ceo', 'outside')].filter(f => (f as Challenge).user_challenge);
  const where = (f: FindingRow) => (f.file ? `${f.file}${f.line ? `:${f.line}` : ''}` : 'plan');
  return [
    `# CEO-only review: ${title}`, '',
    `Mode: gstack-autoplan driver, CEO phase only (run ${state.run}). Outside voice: ${outsideLine}. Not approved.`, '',
    '## User challenges (direction kept)', '',
    ...none(challenges.map(f => `- [${f.severity}] ${f.title} (${f.id}, ${f.voice}): proposal: ${f.resolution ?? 'unstated'}; the plan's direction is kept`)), '',
    '## Scope added', '', 'None. The driver never edits the plan; scope proposals are listed under Findings.', '',
    '## Conservative choices', '',
    ...none(rows.map((r, i) => `- ${r.label}: ${r.title}: ${r.chosen === null ? 'left open for the owner (not accepted)' : `kept ${r.chosen} (${items[i]!.options.find(o => o.key === r.chosen)?.text ?? r.chosen})`}; the reviewers recommended ${r.recommended}`)), '',
    '## Findings', '',
    ...none(findings.map(f => `- [${f.severity}] ${f.title} (${f.id}; ${where(f)}): fix: ${f.resolution ?? 'unstated'}; disposition: ${f.disposition ?? 'open'}${(f as { reconciliation?: string }).reconciliation ? `; voices: ${(f as { reconciliation?: string }).reconciliation}` : ''}`)), '',
    '## Decision Audit Trail', '',
    ...none(rows.map(r => `- ${r.id}: ${r.kind} ${r.status}, chosen ${r.chosen ?? 'none'}, recommended ${r.recommended}${r.recommended_basis ? ` (${r.recommended_basis})` : ''}`)), '',
  ].join('\n');
}
