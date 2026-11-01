/**
 * autoplan-shadow-reader — the read side of shadow mode (lib/autoplan-shadow.ts,
 * docs/unattended.md#shadow-mode). `exportShadow` is `gstack-autoplan shadow
 * --out <dir> | --runs <file>`, the export gstack-evals reads for taste-replay
 * R2: one row per item of each answered gate revision, with the shadow's
 * status (recorded, malformed, failed with its code, missing, retrospective, or
 * off when the run never turned shadow on), the shadow fields when present, and
 * the owner's answer with its provenance (owner_mode, owner_named, carried,
 * answered_role, rec_hash at record and at answer). It computes no agreement
 * number, only counts. A revision whose plan approval is unanswered or answered
 * c (interrogate) refuses SHADOW_BEFORE_ANSWER (a courtesy for honest tools,
 * not access control: the journaled sha256 is the tamper evidence), and a
 * CEO-only run CEO_ONLY_NO_GATE. Read-only. `validateShadow` is the private
 * check `gstack-artifact validate <run.json>` adds: each record's schema and
 * its journaled sha256.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { previousGate } from './autoplan-gate';
import { readDecisions, readJournal, readState } from './autoplan-state';
import type { ResultCodeName } from './result-codes';
import type { ValidationError } from './headless-artifacts';
import { RECORD_RE, SHADOW_ACTIONS, recordFile, shadowDir } from './autoplan-shadow';

export type ShadowStatus = 'recorded' | 'malformed' | 'failed' | 'missing' | 'retrospective' | 'off';
export interface ShadowExportRow {
  run: string; gate_rev: number; item: string; decision: string; item_class: string | null; ceo_eligible: boolean; status: ShadowStatus; code?: string;
  shadow: Record<string, unknown> | null;
  owner: { chosen: string | null; status: string; owner_mode: string | null; owner_named: boolean | null; carried: boolean; carried_from: string | null; answered_role: string | null; answered_by: string | null; rec_hash_at_answer: string | null; rec_hash_at_record: string | null };
}
export interface ShadowExport { rows: ShadowExportRow[]; counts: Record<string, Record<string, number>>; refused: Array<{ run: string; gate_rev?: number; code: ResultCodeName; detail: string }> }

const readRows = (file: string) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, any>);

/** Every answered revision of every run, deduped by run, gate_rev and item. */
export function exportShadow(dirs: string[]): ShadowExport {
  const rows = new Map<string, ShadowExportRow>();
  const refused: ShadowExport['refused'] = [];
  for (const dir of dirs) {
    let state;
    try { state = readState(dir); } catch (e: any) { refused.push({ run: dir, code: e.code ?? 'RUN_NOT_INITIALIZED', detail: `${dir}: ${e.detail ?? e.message}` }); continue; }
    if (state.ceo_only) { refused.push({ run: state.run, code: 'CEO_ONLY_NO_GATE', detail: `${dir} is CEO-only run ${state.run}: no gate, nothing answered` }); continue; }
    const decisions = readDecisions(dir).filter(r => r.gate_rev >= 1);
    const journal = readJournal(dir);
    for (const rev of [...new Set(decisions.map(r => r.gate_rev))].sort((a, b) => a - b)) {
      const revRows = decisions.filter(r => r.gate_rev === rev);
      const p1 = revRows.find(r => (r.label ?? '').toLowerCase() === 'p1');
      if (!p1?.chosen || p1.status === 'pending' || p1.chosen === 'c') {
        refused.push({ run: state.run, gate_rev: rev, code: 'SHADOW_BEFORE_ANSWER', detail: `${dir} gate_rev ${rev}: the plan approval is ${p1?.chosen === 'c' ? 'answered c (interrogate)' : 'unanswered'}; the export waits for the owner` });
        continue;
      }
      const record = fs.existsSync(recordFile(dir, rev)) ? new Map(readRows(recordFile(dir, rev)).map(r => [String(r.item), r])) : undefined;
      const failed = journal.find(r => r.event === 'shadow_failed' && r.gate_rev === rev);
      const gate = previousGate(dir, rev);
      for (const d of revRows) {
        const item = (d.label ?? d.id).toLowerCase();
        const s = record?.get(item);
        const status: ShadowStatus = s ? (s.retrospective ? 'retrospective' : s.status) : failed ? 'failed' : state.shadow?.enabled ? 'missing' : 'off';
        const gateItem = gate?.items.find(i => i.id === item);
        const row: ShadowExportRow = {
          run: state.run, gate_rev: rev, item, decision: d.id, item_class: s?.item_class ?? gateItem?.item_class ?? null, ceo_eligible: s?.ceo_eligible ?? (item === 'p1' || d.phase === 'ceo'), status,
          ...(status === 'failed' ? { code: String(failed!.code) } : {}),
          shadow: s ? Object.fromEntries(['action', 'pick', 'confidence', 'cites', 'reason', 'malformed', 'rule_pick', 'audit', 'model', 'prompt_version', 'prompt_sha256', 'rec_hash', 'rec_rev', 'recorded_at', 'retrospective'].filter(k => k in s).map(k => [k, s[k]])) : null,
          owner: { chosen: d.chosen ?? null, status: d.status, owner_mode: d.owner_mode ?? null, owner_named: d.owner_named ?? null, carried: !!(d.carried_from || d.carried_gate_from), carried_from: d.carried_from ?? d.carried_gate_from ?? null,
            answered_role: d.answered_role ?? null, answered_by: d.answered_by ?? null, rec_hash_at_answer: d.rec_hash ?? null, rec_hash_at_record: s?.rec_hash ?? null },
        };
        rows.set(`${row.run}|${rev}|${item}`, row);
      }
    }
  }
  const all = [...rows.values()];
  const count = (key: (r: ShadowExportRow) => string) => all.reduce<Record<string, number>>((c, r) => { const k = key(r); c[k] = (c[k] ?? 0) + 1; return c; }, {});
  return { rows: all, refused, counts: { status: count(r => r.status), item_class: count(r => r.item_class ?? 'unknown'), owner_mode: count(r => r.owner.owner_mode ?? 'none'), ceo_eligible: count(r => String(r.ceo_eligible)) } };
}

export function renderShadowExport(r: ShadowExport): string[] {
  const counts = Object.entries(r.counts).map(([k, c]) => `SHADOW_COUNTS: ${k} ${Object.entries(c).map(([v, n]) => `${v}=${n}`).join(' ') || 'none'}`);
  return [...r.rows.map(row => `SHADOW_ROW: ${JSON.stringify(row)}`), ...counts, `SHADOW_EXPORT: rows=${r.rows.length} refused=${r.refused.length} (no agreement number: gstack-evals computes it)`];
}

/** The private check behind gstack-artifact validate: each shadow record matches its journaled sha256 and its rows the schema. */
export function validateShadow(runDir: string): ValidationError[] {
  const dir = shadowDir(runDir);
  let st: fs.Stats;
  try { st = fs.lstatSync(dir); } catch { return []; }
  if (!st.isDirectory()) return [{ code: 'ARTIFACT_PATH_ESCAPE', path: 'shadow', message: 'the shadow folder is a symlink or not a directory' }];
  const errors: ValidationError[] = [];
  const journal = readJournal(runDir);
  for (const name of fs.readdirSync(dir)) {
    const m = RECORD_RE.exec(name);
    if (!m) continue;
    const rev = Number(m[1]);
    const rel = `shadow/${name}`;
    const bytes = fs.readFileSync(path.join(dir, name));
    const recorded = journal.filter(r => r.event === 'shadow_recorded' && r.gate_rev === rev).at(-1);
    const sha = createHash('sha256').update(bytes).digest('hex');
    if (!recorded) errors.push({ code: 'ARTIFACT_STALE', path: rel, message: `no shadow_recorded journal row names gate_rev ${rev}` });
    else if (recorded.sha256 !== sha) errors.push({ code: 'ARTIFACT_STALE', path: rel, message: `sha256 ${sha.slice(0, 12)} is not the journaled ${String(recorded.sha256).slice(0, 12)}` });
    bytes.toString('utf8').split('\n').filter(Boolean).forEach((line, i) => {
      let row: Record<string, any>;
      try { row = JSON.parse(line); } catch { errors.push({ code: 'ARTIFACT_SCHEMA', path: `${rel}:${i + 1}`, message: 'not JSON' }); return; }
      const problem = rowProblem(row, rev);
      if (problem) errors.push({ code: 'ARTIFACT_SCHEMA', path: `${rel}:${i + 1}`, message: problem });
    });
  }
  return errors;
}

function rowProblem(r: Record<string, any>, rev: number): string | undefined {
  if (r.schema_version !== 1 || r.gate_rev !== rev) return `schema_version 1 and gate_rev ${rev} expected`;
  for (const k of ['run', 'decision', 'item', 'model', 'prompt_sha256', 'recorded_at']) if (typeof r[k] !== 'string' || !r[k]) return `${k} must be a non-empty string`;
  if (typeof r.retrospective !== 'boolean' || typeof r.audit !== 'boolean' || typeof r.ceo_eligible !== 'boolean') return 'retrospective, audit and ceo_eligible must be booleans';
  if (r.status === 'malformed') return r.pick === null && !r.audit ? undefined : 'a malformed row carries no pick and no audit mark';
  if (r.status !== 'recorded') return `status ${JSON.stringify(r.status)} is not recorded or malformed`;
  if (!SHADOW_ACTIONS.includes(r.action)) return 'action must be decide, send_back or hold';
  if (typeof r.pick !== 'string' || !Array.isArray(r.item_frozen?.options) || !r.item_frozen.options.some((o: { key?: string }) => o.key === r.pick)) return 'pick must be one of the frozen item\'s options';
  if (typeof r.confidence !== 'number' || !(r.confidence >= 0 && r.confidence <= 1)) return 'confidence must be a number from 0 to 1';
  if (!Array.isArray(r.cites) || typeof r.reason !== 'string' || r.reason.length > 400) return 'cites must be a list and reason a string of at most 400 characters';
  if (r.audit && r.action !== 'decide') return 'only a decide row carries the audit mark';
  return undefined;
}
