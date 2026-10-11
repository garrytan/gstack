/**
 * autoplan-reconcile — canonical reviewer findings and the reconciliation of
 * an outside pass against the native one (plan B11, B0). Every reviewer
 * returns, beside its prose, a full-read receipt (`INPUT: <phase> <sha256>`)
 * and one ```gstack-findings fence of JSONL rows; `parseReviewResult` checks
 * both. `canonicalRows` binds the rows to run-bound ids
 * (`<run>-<phase>-<voice>-<n>`, the findings.jsonl shape in
 * lib/headless-artifacts.ts). `reconcile` records, for each outside finding,
 * `confirmed`, `disagree` or `new` against the native result from exact ids,
 * keeping disagreement and resolution as separate fields; a parent may hand in
 * a semantic reconciliation that overrides the structural one, validated
 * against the same ids. The consensus table is rendered from these rows, so
 * the reconciliation is the completeness check a prose hash cannot be.
 */
import type { FindingRow, Severity, Voice } from './headless-artifacts';

export const SEVERITIES: readonly Severity[] = ['Critical', 'High', 'Medium', 'Low', 'Informational'];
const SEVERITY_ALIASES: Record<string, Severity> = {
  critical: 'Critical', p0: 'Critical', blocker: 'Critical',
  high: 'High', p1: 'High', major: 'High',
  medium: 'Medium', p2: 'Medium', moderate: 'Medium',
  low: 'Low', p3: 'Low', minor: 'Low',
  informational: 'Informational', info: 'Informational', note: 'Informational',
};

export interface CanonicalFinding {
  severity: Severity; title: string; file?: string; line?: number; fix?: string; local_id?: string;
  user_challenge?: boolean; urgent?: boolean; suggested_owner?: string; plan_items?: string[]; dimension?: string;
}
export interface ParsedReviewResult {
  receipt: { ok: boolean; phase?: string; sha256?: string; line?: string };
  findings: CanonicalFinding[];
  fenceFound: boolean;
  errors: string[];
}

export function severityOf(value: unknown): Severity | undefined {
  if (typeof value !== 'string') return undefined;
  return SEVERITY_ALIASES[value.trim().toLowerCase()];
}

/** Parse a reviewer's result: the INPUT receipt for this phase and snapshot, then the canonical findings fence(s). */
export function parseReviewResult(text: string, expected: { phase: string; sha256: string }): ParsedReviewResult {
  const errors: string[] = [];
  const head = text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 5);
  const receiptLine = head.find(l => /^INPUT:\s*\S+\s+[0-9a-f]{64}\b/i.test(l));
  const m = receiptLine ? /^INPUT:\s*(\S+)\s+([0-9a-f]{64})/i.exec(receiptLine) : null;
  const receipt = m
    ? { ok: m[1]!.toLowerCase() === expected.phase && m[2]!.toLowerCase() === expected.sha256.toLowerCase(), phase: m[1]!.toLowerCase(), sha256: m[2]!.toLowerCase(), line: receiptLine }
    : { ok: false };
  if (!receipt.ok) errors.push(m ? `receipt names ${m[1]} ${m[2]!.slice(0, 12)}…, expected ${expected.phase} ${expected.sha256.slice(0, 12)}…` : 'no INPUT: <phase> <sha256> line in the first five lines');

  const findings: CanonicalFinding[] = [];
  let fenceFound = false;
  for (const fence of text.matchAll(/^[ \t]*(`{3,}|~{3,})gstack-findings[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*$/gm)) {
    fenceFound = true;
    fence[2]!.split('\n').forEach((raw, i) => {
      const line = raw.trim();
      if (!line) return;
      let row: any;
      try { row = JSON.parse(line); } catch (e: any) { errors.push(`findings row ${i + 1}: ${e.message}`); return; }
      if (!row || typeof row !== 'object' || Array.isArray(row)) { errors.push(`findings row ${i + 1}: not an object`); return; }
      const severity = severityOf(row.severity);
      if (!severity) { errors.push(`findings row ${i + 1}: severity ${JSON.stringify(row.severity)} is not one of ${SEVERITIES.join('|')}`); return; }
      if (typeof row.title !== 'string' || !row.title.trim()) { errors.push(`findings row ${i + 1}: title is required`); return; }
      const finding: CanonicalFinding = { severity, title: row.title.trim() };
      if (typeof row.file === 'string' && row.file) finding.file = row.file;
      if (Number.isInteger(row.line)) finding.line = row.line;
      if (typeof row.fix === 'string' && row.fix) finding.fix = row.fix;
      if (typeof row.id === 'string' && row.id) finding.local_id = row.id;
      if (row.user_challenge === true) finding.user_challenge = true;
      if (row.urgent === true) finding.urgent = true;
      if (typeof row.suggested_owner === 'string') finding.suggested_owner = row.suggested_owner;
      if (Array.isArray(row.plan_items)) finding.plan_items = row.plan_items.filter((p: unknown): p is string => typeof p === 'string');
      if (typeof row.dimension === 'string') finding.dimension = row.dimension;
      findings.push(finding);
    });
  }
  if (!fenceFound) errors.push('no ```gstack-findings fence');
  return { receipt, findings, fenceFound, errors };
}

/** Run-bound findings.jsonl rows for one voice of one phase. */
export function canonicalRows(findings: CanonicalFinding[], ctx: { run: string; phase: string; voice: Voice; model?: string }): FindingRow[] {
  return findings.map((f, i) => ({
    schema_version: 1, run: ctx.run, id: `${ctx.run}-${ctx.phase}-${ctx.voice}-${i + 1}`, phase: ctx.phase, voice: ctx.voice,
    severity: f.severity, title: f.title, disposition: 'open',
    ...(ctx.model ? { model: ctx.model } : {}), ...(f.file ? { file: f.file } : {}), ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.fix ? { resolution: f.fix } : {}), ...(f.plan_items?.length ? { plan_items: f.plan_items } : {}),
    ...(f.local_id ? { source: f.local_id } : {}),
    ...(f.user_challenge ? { user_challenge: true } : {}), ...(f.urgent ? { urgent: true } : {}),
    ...(f.suggested_owner ? { suggested_owner: f.suggested_owner } : {}), ...(f.dimension ? { dimension: f.dimension } : {}),
  } as FindingRow));
}

export type ReconciliationDisposition = 'confirmed' | 'disagree' | 'new';
export interface ReconciliationRow {
  outside_id: string; native_id: string | null; disposition: ReconciliationDisposition;
  /** Why this disposition: the matched location or title, or the parent's override reason. */
  resolution: string;
  basis: 'file_line' | 'title' | 'override' | 'none';
  severity: { outside: Severity; native: Severity | null };
}
export interface ReconciliationOverride { outside_id: string; native_id?: string | null; disposition: ReconciliationDisposition; resolution: string }

const tokens = (title: string) => new Set(title.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t.length > 2));
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
const level = (s: Severity) => SEVERITIES.indexOf(s);

/**
 * Structural reconciliation: a file:line match (±3 lines) is `confirmed`
 * unless severities differ by two or more levels (`disagree`); otherwise a
 * title overlap of at least half the words is `confirmed`; else `new`. Each
 * native finding is matched at most once. Overrides replace the structural
 * row for their outside id and must name ids from these two lists.
 */
export function reconcile(native: FindingRow[], outside: FindingRow[], overrides: ReconciliationOverride[] = []): { rows: ReconciliationRow[]; native_only: string[]; errors: string[] } {
  const errors: string[] = [];
  const nativeIds = new Set(native.map(n => n.id));
  const outsideIds = new Set(outside.map(o => o.id));
  const byOutside = new Map<string, ReconciliationOverride>();
  for (const o of overrides) {
    if (!outsideIds.has(o.outside_id)) { errors.push(`override names unknown outside id ${o.outside_id}`); continue; }
    if (o.native_id && !nativeIds.has(o.native_id)) { errors.push(`override for ${o.outside_id} names unknown native id ${o.native_id}`); continue; }
    if (!['confirmed', 'disagree', 'new'].includes(o.disposition)) { errors.push(`override for ${o.outside_id}: disposition ${JSON.stringify(o.disposition)} is not confirmed|disagree|new`); continue; }
    if (o.disposition !== 'new' && !o.native_id) { errors.push(`override for ${o.outside_id}: ${o.disposition} needs a native_id`); continue; }
    if (typeof o.resolution !== 'string' || !o.resolution.trim()) { errors.push(`override for ${o.outside_id}: resolution is required`); continue; }
    byOutside.set(o.outside_id, o);
  }
  const used = new Set<string>();
  const rows: ReconciliationRow[] = [];
  for (const o of outside) {
    const override = byOutside.get(o.id);
    if (override) {
      const n = override.native_id ? native.find(x => x.id === override.native_id) : undefined;
      if (n) used.add(n.id);
      rows.push({ outside_id: o.id, native_id: n?.id ?? null, disposition: override.disposition, resolution: override.resolution, basis: 'override', severity: { outside: o.severity, native: n?.severity ?? null } });
      continue;
    }
    let match: FindingRow | undefined;
    let basis: ReconciliationRow['basis'] = 'none';
    if (o.file && o.line !== undefined) {
      match = native.find(n => !used.has(n.id) && n.file === o.file && n.line !== undefined && Math.abs(n.line - o.line!) <= 3);
      if (match) basis = 'file_line';
    }
    if (!match) {
      const ot = tokens(o.title);
      let best = 0;
      for (const n of native) {
        if (used.has(n.id)) continue;
        const score = jaccard(ot, tokens(n.title));
        if (score >= 0.5 && score > best) { best = score; match = n; }
      }
      if (match) basis = 'title';
    }
    if (!match) { rows.push({ outside_id: o.id, native_id: null, disposition: 'new', resolution: 'not raised by the native voice', basis: 'none', severity: { outside: o.severity, native: null } }); continue; }
    used.add(match.id);
    const delta = Math.abs(level(match.severity) - level(o.severity));
    rows.push({
      outside_id: o.id, native_id: match.id, disposition: delta >= 2 ? 'disagree' : 'confirmed',
      resolution: delta >= 2 ? `severity: native ${match.severity}, outside ${o.severity} (${basis === 'file_line' ? `${o.file}:${o.line}` : 'same title'})` : `both voices (${basis === 'file_line' ? `${o.file}:${o.line}` : 'same title'}): ${match.title}`,
      basis, severity: { outside: o.severity, native: match.severity },
    });
  }
  return { rows, native_only: native.filter(n => !used.has(n.id)).map(n => n.id), errors };
}

export interface ConsensusRecord {
  schema_version: 1; phase: string;
  native: { model: string | null; findings: number; by_severity: Record<Severity, number> } | null;
  outside: { model: string | null; provider: string | null; findings: number; by_severity: Record<Severity, number> } | null;
  confirmed: number; disagree: number; new: number; native_only: number;
  rows: ReconciliationRow[]; native_only_ids: string[];
  /** CONFIRMED requires both voices completed. */
  coverage: 'both' | 'native_only' | 'outside_only' | 'none';
}

function bySeverity(rows: FindingRow[]): Record<Severity, number> {
  const out = Object.fromEntries(SEVERITIES.map(s => [s, 0])) as Record<Severity, number>;
  for (const r of rows) out[r.severity]++;
  return out;
}

export function consensusRecord(phase: string, native: { rows: FindingRow[]; model?: string } | null, outside: { rows: FindingRow[]; model?: string; provider?: string } | null, rec: ReturnType<typeof reconcile>): ConsensusRecord {
  const rows = native && outside ? rec.rows : [];
  return {
    schema_version: 1, phase,
    native: native ? { model: native.model ?? null, findings: native.rows.length, by_severity: bySeverity(native.rows) } : null,
    outside: outside ? { model: outside.model ?? null, provider: outside.provider ?? null, findings: outside.rows.length, by_severity: bySeverity(outside.rows) } : null,
    confirmed: rows.filter(r => r.disposition === 'confirmed').length, disagree: rows.filter(r => r.disposition === 'disagree').length,
    new: rows.filter(r => r.disposition === 'new').length, native_only: native && outside ? rec.native_only.length : (native?.rows.length ?? 0),
    rows, native_only_ids: native && outside ? rec.native_only : (native?.rows.map(r => r.id) ?? []),
    coverage: native && outside ? 'both' : native ? 'native_only' : outside ? 'outside_only' : 'none',
  };
}

/** The consensus table and per-finding reconciliation, rendered from canonical ids. */
export function renderConsensus(c: ConsensusRecord, findings: FindingRow[]): string {
  const title = (id: string | null) => findings.find(f => f.id === id)?.title ?? '';
  const nat = c.native ? `${c.native.model ?? 'unknown'}(native)` : 'native: N/A';
  const out = c.outside ? `${c.outside.model ?? 'unknown'}(${c.outside.provider ?? 'outside'})` : 'outside: N/A';
  const lines = [
    `${c.phase.toUpperCase()} DUAL VOICES — CONSENSUS TABLE:`,
    `  Severity        ${nat.padEnd(28)} ${out}`,
    ...SEVERITIES.map(s => `  ${s.padEnd(15)} ${String(c.native?.by_severity[s] ?? '—').padEnd(28)} ${c.outside?.by_severity[s] ?? '—'}`),
    `  Findings        ${String(c.native?.findings ?? '—').padEnd(28)} ${c.outside?.findings ?? '—'}`,
    c.coverage === 'both'
      ? `CONFIRMED ${c.confirmed} · DISAGREE ${c.disagree} · NEW (outside only) ${c.new} · native only ${c.native_only}. Both completed.`
      : `Consensus: N/A (voice coverage: ${c.coverage.replace('_', ' ')}); confirmed counts require both voices.`,
    '',
    'Reconciliation (each outside finding against the native result):',
    '| outside | native | disposition | resolution |',
    '|---|---|---|---|',
    ...c.rows.map(r => `| ${r.outside_id} ${title(r.outside_id)} | ${r.native_id ? `${r.native_id} ${title(r.native_id)}` : '—'} | ${r.disposition} | ${r.resolution} |`),
    ...c.native_only_ids.map(id => `| — | ${id} ${title(id)} | native_only | not raised by the outside voice |`),
  ];
  return lines.join('\n') + '\n';
}
