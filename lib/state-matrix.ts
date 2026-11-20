/**
 * state-matrix — the round-trip matrix for proposal, hold and approval state
 * machines (field list 2, W3; #6792: accepting a deactivate or a same-claim
 * replace proposal deleted the take because only the remove path was
 * tested). Two deterministic halves around the /review state-machines
 * specialist (review/specialists/state-machines.md):
 *
 * - `detectStateMachine` decides dispatch: added code lines (tests and docs
 *   excluded) that name a pending record (proposal, hold, approval, pending)
 *   and an owner action (accept, approve, drop, reject, ...).
 * - `checkStateMatrix` reads the specialist's output: one `matrix` record
 *   per machine (kinds × owner actions → resulting row → test) plus findings.
 *   Every kind × action pair needs a cell with a resulting row; a test
 *   reference must exist in the checkout; an untested cell needs a CRITICAL
 *   `state-matrix` finding for that cell (the rule's High tier). With an
 *   expectation file (a fixture's ground truth) every expected kind, action
 *   and untested cell must be named.
 *
 * Caller: bin/gstack-state-matrix (detect, check).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isReviewedTreeLine } from './review-brief';
import { parseVerdict } from './review-verdict';

const SUBJECT = new Set(['proposal', 'proposals', 'propose', 'proposed', 'hold', 'holds', 'held', 'approval', 'approvals', 'pending']);
const ACTION = new Set(['accept', 'accepted', 'accepts', 'approve', 'approved', 'approves', 'drop', 'dropped', 'drops', 'reject', 'rejected', 'rejects', 'deny', 'denied', 'dismiss', 'dismissed', 'withdraw', 'withdrawn', 'release', 'released']);
const NOT_CODE = [/(^|\/)(test|tests|spec|__tests__|fixtures?|docs?)\//, /\.(test|spec)\.[a-z0-9]+$/i, /_(test|spec)\.[a-z0-9]+$/i, /\.(md|txt|json|ya?ml|lock)$/i];

/** Identifier words: camelCase, snake_case and kebab-case split, lowercased. */
export function words(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[^A-Za-z0-9]+/).filter(Boolean).map(w => w.toLowerCase());
}

export interface StateMachineHit { file: string; line: number; subject: string[]; action: string[] }

/** Added code lines that name a pending record or an owner action; dispatch needs both somewhere in the diff. */
export function detectStateMachine(files: Map<string, Array<{ line: number; text: string }>>): { detected: boolean; hits: StateMachineHit[] } {
  const hits: StateMachineHit[] = [];
  for (const [file, lines] of files) {
    if (NOT_CODE.some(re => re.test(file))) continue;
    for (const l of lines) {
      const w = words(l.text);
      const subject = [...new Set(w.filter(x => SUBJECT.has(x)))];
      const action = [...new Set(w.filter(x => ACTION.has(x)))];
      if (subject.length || action.length) hits.push({ file, line: l.line, subject, action });
    }
  }
  const detected = hits.some(h => h.subject.length) && hits.some(h => h.action.length);
  return { detected, hits: detected ? hits : [] };
}

export interface MatrixCell { kind: string; action: string; row: string; test: string | null }
export interface Matrix { machine: string; kinds: string[]; actions: string[]; cells: MatrixCell[] }
export interface MatrixFinding { severity?: string; category?: string; cell?: { kind?: string; action?: string }; summary?: string; path?: string }
export interface Expectation { kinds: string[]; actions: string[]; untested: Array<{ kind: string; action: string }> }
export interface Gap { code: string; cell?: string; detail: string }
export interface MatrixCheck { machines: Array<{ machine: string; kinds: number; actions: number; cells: number; tested: number; untested: number; reported: number }>; gaps: Gap[]; findings: number; noFindings: boolean }

/**
 * Matrix records, findings and whether the output is the literal `NO FINDINGS`; unparseable lines are gaps. The header a
 * dispatched reader's brief requires (lib/review-brief.ts workspaceStep: a `REVIEWED_TREE` first line, then a well-formed
 * `REVIEW_VERDICT` line) is read by the same parsers collect uses and skipped; anywhere else such a line is a gap.
 */
export function parseSpecialistOutput(text: string): { matrices: Matrix[]; findings: MatrixFinding[]; noFindings: boolean; gaps: Gap[] } {
  const matrices: Matrix[] = [];
  const findings: MatrixFinding[] = [];
  const gaps: Gap[] = [];
  let lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines[0] !== undefined && isReviewedTreeLine(lines[0])) lines = lines.slice(lines[1] !== undefined && parseVerdict(lines[1]).state === 'valid' ? 2 : 1);
  const noFindings = lines.length === 1 && lines[0] === 'NO FINDINGS';
  if (noFindings) return { matrices, findings, noFindings, gaps };
  for (const line of lines) {
    let obj: any;
    try { obj = JSON.parse(line); } catch { gaps.push({ code: 'unparsed-line', detail: line.slice(0, 120) }); continue; }
    if (obj && typeof obj === 'object' && obj.matrix) {
      const m = obj.matrix;
      const ok = typeof m.machine === 'string' && Array.isArray(m.kinds) && Array.isArray(m.actions) && Array.isArray(m.cells) && m.kinds.length && m.actions.length;
      if (!ok) { gaps.push({ code: 'matrix-malformed', detail: 'a matrix record needs machine, non-empty kinds and actions, and cells' }); continue; }
      matrices.push({ machine: m.machine, kinds: m.kinds.map(String), actions: m.actions.map(String), cells: m.cells.map((c: any) => ({ kind: String(c?.kind ?? ''), action: String(c?.action ?? ''), row: typeof c?.row === 'string' ? c.row : '', test: typeof c?.test === 'string' && c.test.trim() ? c.test.trim() : null })) });
    } else if (obj && typeof obj === 'object') findings.push(obj);
  }
  return { matrices, findings, noFindings, gaps };
}

/** A test reference `path[:line]` (anything after a space is a test name) that exists in the checkout. */
export function testRefExists(repoRoot: string, ref: string): boolean {
  const m = /^([^\s:#]+)(?::(\d+))?/.exec(ref);
  if (!m) return false;
  const abs = path.resolve(repoRoot, m[1]!);
  if (!abs.startsWith(path.resolve(repoRoot) + path.sep) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return false;
  return !m[2] || Number(m[2]) <= fs.readFileSync(abs, 'utf8').split('\n').length;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** A fixture's expected kind matches a matrix kind that contains it (`deactivate` ~ `takes_deactivate`). */
const names = (actual: string, expected: string) => actual.toLowerCase().includes(expected.toLowerCase());

function checkMatrix(m: Matrix, findings: MatrixFinding[], repoRoot: string, gaps: Gap[]): MatrixCheck['machines'][number] {
  let tested = 0; let untested = 0; let reported = 0;
  for (const kind of m.kinds) for (const action of m.actions) {
    const cell = `${kind}×${action}`;
    const cells = m.cells.filter(c => same(c.kind, kind) && same(c.action, action));
    if (!cells.length) { gaps.push({ code: 'cell-absent', cell, detail: `${m.machine} has no row for this kind and owner action` }); continue; }
    if (cells.length > 1) gaps.push({ code: 'cell-duplicate', cell, detail: `${cells.length} rows` });
    const c = cells[0]!;
    if (!c.row.trim()) gaps.push({ code: 'row-missing', cell, detail: 'no resulting row' });
    if (c.test) {
      tested += 1;
      if (!testRefExists(repoRoot, c.test)) gaps.push({ code: 'test-unresolved', cell, detail: `${c.test} is not a file (and line) in this checkout` });
      continue;
    }
    untested += 1;
    const f = findings.filter(x => x.category === 'state-matrix' && x.cell && same(String(x.cell.kind ?? ''), kind) && same(String(x.cell.action ?? ''), action));
    if (!f.length) gaps.push({ code: 'unreported', cell, detail: 'untested cell without a state-matrix finding' });
    else if (!f.some(x => x.severity === 'CRITICAL')) gaps.push({ code: 'not-high', cell, detail: `reported as ${f[0]!.severity ?? 'no severity'}; an untested cell is CRITICAL` });
    else reported += 1;
  }
  for (const c of m.cells) if (!m.kinds.some(k => same(k, c.kind)) || !m.actions.some(a => same(a, c.action))) gaps.push({ code: 'cell-unlisted', cell: `${c.kind}×${c.action}`, detail: 'a row whose kind or action is not in the lists' });
  return { machine: m.machine, kinds: m.kinds.length, actions: m.actions.length, cells: m.cells.length, tested, untested, reported };
}

function checkExpectation(matrices: Matrix[], expect: Expectation, gaps: Gap[]): void {
  if (!matrices.length) { gaps.push({ code: 'no-matrix', detail: 'the diff has a state machine, but the output has no matrix record' }); return; }
  for (const kind of expect.kinds) if (!matrices.some(m => m.kinds.some(k => names(k, kind)))) gaps.push({ code: 'kind-missing', detail: `no matrix lists the kind ${kind}` });
  for (const action of expect.actions) if (!matrices.some(m => m.actions.some(a => names(a, action)))) gaps.push({ code: 'action-missing', detail: `no matrix lists the owner action ${action}` });
  for (const u of expect.untested) {
    const cell = matrices.flatMap(m => m.cells).find(c => names(c.kind, u.kind) && names(c.action, u.action));
    if (cell?.test) gaps.push({ code: 'untested-cell-claimed', cell: `${u.kind}×${u.action}`, detail: `mapped to ${cell.test}, which does not exercise this cell` });
  }
}

/** Every gap the output leaves; an empty list means the matrix is complete and every untested cell is reported CRITICAL. */
export function checkStateMatrix(text: string, repoRoot: string, expect?: Expectation): MatrixCheck {
  const parsed = parseSpecialistOutput(text);
  const gaps = [...parsed.gaps];
  const machines = parsed.matrices.map(m => checkMatrix(m, parsed.findings, repoRoot, gaps));
  if (expect) checkExpectation(parsed.matrices, expect, gaps);
  if (!expect && !parsed.matrices.length && parsed.findings.some(f => f.category === 'state-matrix')) gaps.push({ code: 'no-matrix', detail: 'state-matrix findings without the matrix they come from' });
  return { machines, gaps, findings: parsed.findings.length, noFindings: parsed.noFindings };
}

export function renderStateMatrixCheck(r: MatrixCheck): string {
  const lines = [
    ...r.machines.map(m => `STATE_MATRIX: ${m.machine} kinds=${m.kinds} actions=${m.actions} cells=${m.cells} tested=${m.tested} untested=${m.untested} reported=${m.reported}`),
    ...r.gaps.map(g => `STATE_MATRIX_GAP: ${g.code}${g.cell ? ' ' + g.cell : ''} — ${g.detail}`),
    `STATE_MATRIX_CHECK: ${r.gaps.length ? `incomplete gaps=${r.gaps.length}` : 'ok'} machines=${r.machines.length}`,
  ];
  return lines.join('\n') + '\n';
}
