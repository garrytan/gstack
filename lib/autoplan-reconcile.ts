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
  /** What a user challenge changes: scope, cost or direction (plan B2a), or packaging/ordering (settled without a plan edit). */
  changes?: Changes;
}
export const CHANGES = ['scope', 'cost', 'direction', 'packaging', 'ordering'] as const;
/** Accepted changes of these kinds need no Implementation-plan edit: `revise --settle` records them. */
export const SETTLEABLE_CHANGES: readonly string[] = ['packaging', 'ordering'];
export type Changes = typeof CHANGES[number];
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
  const receipt = parseReceipt(text, expected);
  if (!receipt.ok) errors.push(receipt.error!);
  const { findings, fenceFound } = parseFences(text, errors);
  if (!fenceFound) errors.push('no ```gstack-findings fence');
  return { receipt, findings, fenceFound, errors };
}

/** The full-read receipt: `INPUT: <phase> <sha256>` in the first five non-empty lines, matching this phase and snapshot. */
export function parseReceipt(text: string, expected: { phase: string; sha256: string }): ParsedReviewResult['receipt'] & { present: boolean; error?: string } {
  const head = text.split('\n').map(l => l.trim()).filter(Boolean).slice(0, 5);
  const receiptLine = head.find(l => /^INPUT:\s*\S+\s+[0-9a-f]{64}\b/i.test(l));
  const m = receiptLine ? /^INPUT:\s*(\S+)\s+([0-9a-f]{64})/i.exec(receiptLine) : null;
  if (!m) return { ok: false, present: false, error: 'no INPUT: <phase> <sha256> line in the first five lines' };
  const ok = m[1]!.toLowerCase() === expected.phase && m[2]!.toLowerCase() === expected.sha256.toLowerCase();
  return { ok, present: true, phase: m[1]!.toLowerCase(), sha256: m[2]!.toLowerCase(), line: receiptLine,
    ...(ok ? {} : { error: `receipt names ${m[1]} ${m[2]!.slice(0, 12)}…, expected ${expected.phase} ${expected.sha256.slice(0, 12)}…` }) };
}

function parseFences(text: string, errors: string[]): { findings: CanonicalFinding[]; fenceFound: boolean } {
  const findings: CanonicalFinding[] = [];
  let fenceFound = false;
  for (const fence of text.matchAll(/^[ \t]*(`{3,}|~{3,})gstack-findings[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??[ \t]*\1[ \t]*$/gm)) {
    fenceFound = true;
    (fence[2] ?? '').split('\n').forEach((raw, i) => {
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
      if (row.changes !== undefined) {
        if (!(CHANGES as readonly unknown[]).includes(row.changes)) { errors.push(`findings row ${i + 1}: changes ${JSON.stringify(row.changes)} is not one of ${CHANGES.join('|')}`); return; }
        finding.changes = row.changes;
      }
      findings.push(finding);
    });
  }
  return { findings, fenceFound };
}

export const RECORD_SHAPES = 'a ```gstack-findings fence, exactly one findings table (Severity and Title columns), one severity-tagged list (`- [High] title`), or an exact `No findings.` line';
const SEVERITY_HEADER = /^(severity|sev|priority)$/i;
const TITLE_HEADER = /^(finding|title|issue|summary)$/i;
const cells = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());

/** Findings tables in a record: header row with severity and title columns, a delimiter row, then body rows. */
function recordTables(lines: string[]): Array<{ header: string[]; rows: Array<{ cells: string[]; n: number }> }> {
  const tables: Array<{ header: string[]; rows: Array<{ cells: string[]; n: number }> }> = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!/^\s*\|/.test(lines[i]!) || !/^\s*\|?\s*:?-{3,}/.test(lines[i + 1]!)) continue;
    const header = cells(lines[i]!).map(h => h.replace(/[*_`]/g, '').trim());
    if (!header.some(h => SEVERITY_HEADER.test(h)) || !header.some(h => TITLE_HEADER.test(h))) continue;
    const rows: Array<{ cells: string[]; n: number }> = [];
    let j = i + 2;
    for (; j < lines.length && /^\s*\|/.test(lines[j]!); j++) rows.push({ cells: cells(lines[j]!), n: rows.length + 1 });
    tables.push({ header, rows });
    i = j - 1;
  }
  return tables;
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[([^\]]+)\]|\*\*([^*]+)\*\*|\(([^)]+)\))\s*:?\s*(\S.*)$/;

/**
 * Findings from a hand-run record (`submit --record`): the canonical fence
 * when present; else exactly one of a findings table, a severity-tagged list
 * or an exact `No findings.` line. More than one candidate shape, none, or a
 * table row whose severity is not recognized is an error: the parser never
 * guesses a severity.
 */
export function parseRecordFindings(text: string): { findings: CanonicalFinding[]; source: 'fence' | 'table' | 'list' | 'none'; errors: string[] } {
  const errors: string[] = [];
  const fenced = parseFences(text, errors);
  if (fenced.fenceFound) return { findings: fenced.findings, source: 'fence', errors };
  const lines = text.split('\n');
  const tables = recordTables(lines);
  const listBlocks: Array<CanonicalFinding[]> = [];
  let current: CanonicalFinding[] | null = null;
  for (const line of lines) {
    const m = LIST_ITEM.exec(line);
    const severity = m ? severityOf(m[1] ?? m[2] ?? m[3]) : undefined;
    if (m && severity) { (current ??= (listBlocks.push([]), listBlocks[listBlocks.length - 1]!)).push({ severity, title: m[4]!.trim() }); continue; }
    if (line.trim()) current = null;
  }
  const none = lines.some(l => l.trim() === 'No findings.');
  const shapes = [...tables.map(() => 'table'), ...listBlocks.map(() => 'list'), ...(none ? ['No findings.'] : [])];
  if (shapes.length === 0) return { findings: [], source: 'none', errors: [`no findings shape; expected ${RECORD_SHAPES}`] };
  if (shapes.length > 1) return { findings: [], source: 'none', errors: [`more than one findings shape (${shapes.join(', ')}); keep exactly one of ${RECORD_SHAPES}`] };
  if (none) return { findings: [], source: 'none', errors };
  if (listBlocks.length) return { findings: listBlocks[0]!, source: 'list', errors };
  const { header, rows } = tables[0]!;
  const col = (re: RegExp) => header.findIndex(h => re.test(h));
  const at = { sev: col(SEVERITY_HEADER), title: col(TITLE_HEADER), file: col(/^(file|location|where)$/i), fix: col(/^(fix|recommendation|remedy|resolution)$/i), id: col(/^(id|#)$/i), uc: col(/^user[ _]challenge$/i), changes: col(/^changes$/i) };
  const findings: CanonicalFinding[] = [];
  for (const row of rows) {
    const cell = (i: number) => (i >= 0 ? (row.cells[i] ?? '').trim() : '');
    const severity = severityOf(cell(at.sev).replace(/[*_`]/g, ''));
    if (!severity) { errors.push(`table row ${row.n}: severity ${JSON.stringify(cell(at.sev))} is not one of ${SEVERITIES.join('|')}`); continue; }
    if (!cell(at.title)) { errors.push(`table row ${row.n}: title is required`); continue; }
    const f: CanonicalFinding = { severity, title: cell(at.title) };
    const loc = /^`?([^`\s:]+?)(?::(\d+))?`?$/.exec(cell(at.file));
    if (loc?.[1]) { f.file = loc[1]; if (loc[2]) f.line = Number(loc[2]); }
    if (cell(at.fix)) f.fix = cell(at.fix);
    if (cell(at.id)) f.local_id = cell(at.id);
    if (/^(yes|true|y)$/i.test(cell(at.uc))) f.user_challenge = true;
    if (cell(at.changes)) {
      if (!(CHANGES as readonly string[]).includes(cell(at.changes).toLowerCase())) { errors.push(`table row ${row.n}: changes ${JSON.stringify(cell(at.changes))} is not one of ${CHANGES.join('|')}`); continue; }
      f.changes = cell(at.changes).toLowerCase() as Changes;
    }
    findings.push(f);
  }
  return { findings, source: 'table', errors };
}

/** Run-bound findings.jsonl rows for one voice of one phase. */
/** Ids are `<run>-<phase>-<voice>-<n>`; a confirm round r > 1 qualifies them as `<run>-<phase>-r<r>-<voice>-<n>`. */
export function canonicalRows(findings: CanonicalFinding[], ctx: { run: string; phase: string; voice: Voice; model?: string; round?: number }): FindingRow[] {
  const stem = `${ctx.run}-${ctx.phase}${(ctx.round ?? 1) > 1 ? `-r${ctx.round}` : ''}-${ctx.voice}`;
  return findings.map((f, i) => ({
    schema_version: 1, run: ctx.run, id: `${stem}-${i + 1}`, phase: ctx.phase, voice: ctx.voice,
    severity: f.severity, title: f.title, disposition: 'open',
    ...(ctx.model ? { model: ctx.model } : {}), ...(f.file ? { file: f.file } : {}), ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.fix ? { resolution: f.fix } : {}), ...(f.plan_items?.length ? { plan_items: f.plan_items } : {}),
    ...(f.local_id ? { source: f.local_id } : {}),
    ...(f.user_challenge ? { user_challenge: true } : {}), ...(f.urgent ? { urgent: true } : {}),
    ...(f.suggested_owner ? { suggested_owner: f.suggested_owner } : {}), ...(f.dimension ? { dimension: f.dimension } : {}),
    ...(f.changes ? { changes: f.changes } : {}),
  } as FindingRow));
}

/** `unverified`: the same file:line with no other shared evidence (titles unalike): associated, agreement unverified. */
export type ReconciliationDisposition = 'confirmed' | 'unverified' | 'disagree' | 'new';
export interface ReconciliationRow {
  outside_id: string; native_id: string | null; disposition: ReconciliationDisposition;
  /** Why this disposition: the matched location or title, or the parent's override reason. */
  resolution: string;
  basis: 'file_line' | 'file' | 'title' | 'override' | 'none';
  severity: { outside: Severity; native: Severity | null };
  /** A parent override's one shared proposal for both voices' user challenge; the gate renders it as option b. */
  proposal?: string;
}
export interface ReconciliationOverride { outside_id: string; native_id?: string | null; disposition: ReconciliationDisposition; resolution: string; proposal?: string }

/** A DX cap code (`CAP4:<path>:<item>`) names a location, not the problem, so title comparison skips it. */
export const tokens = (title: string) => new Set(title.replace(/^\s*CAP[46]\s*:[^:]*:\s*/i, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(t => t.length > 2));
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}
const level = (s: Severity) => SEVERITIES.indexOf(s);
/** A remedy compared as words: case, punctuation and spacing ignored. */
export const remedyKey = (text: string | undefined) => (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const NEGATING = /\b(keep|leave|retain|not|no|never|without|avoid|remove|drop|revert|skip)\b|n't\b/;
/** Opposite remedies: they name the same thing and exactly one of them keeps, drops or negates it. */
function contradictory(a: string, b: string): boolean {
  const ka = remedyKey(a), kb = remedyKey(b);
  if (NEGATING.test(ka) === NEGATING.test(kb)) return false;
  const words = (k: string) => new Set(k.split(' ').filter(t => t.length > 3 && !NEGATING.test(t)));
  const wb = words(kb);
  return [...words(ka)].some(t => wb.has(t));
}

/**
 * Structural reconciliation. Findings associate by a title overlap of at least
 * half the words (a leading CAP code ignored), or by file:line (±3 lines), or,
 * when either finding has no line, by the same file. Association alone never
 * confirms: a title association is `confirmed` only when both voices state the
 * same remedy, `disagree` when severities differ by two or more levels or the
 * remedies contradict (one keeps, drops or negates what the other changes),
 * and otherwise `unverified` (remedies differ or one is missing); a
 * location-only association is `unverified`; else `new`.
 * Each native finding is matched at most once. Overrides (the parent's
 * semantic reconciliation, with an optional shared `proposal`) replace the
 * structural row for their outside id and must name ids from these two lists.
 */
export function reconcile(native: FindingRow[], outside: FindingRow[], overrides: ReconciliationOverride[] = []): { rows: ReconciliationRow[]; native_only: string[]; errors: string[] } {
  const errors: string[] = [];
  const nativeIds = new Set(native.map(n => n.id));
  const outsideIds = new Set(outside.map(o => o.id));
  const byOutside = new Map<string, ReconciliationOverride>();
  for (const o of overrides) {
    if (!outsideIds.has(o.outside_id)) { errors.push(`override names unknown outside id ${o.outside_id}`); continue; }
    if (o.native_id && !nativeIds.has(o.native_id)) { errors.push(`override for ${o.outside_id} names unknown native id ${o.native_id}`); continue; }
    if (!['confirmed', 'unverified', 'disagree', 'new'].includes(o.disposition)) { errors.push(`override for ${o.outside_id}: disposition ${JSON.stringify(o.disposition)} is not confirmed|unverified|disagree|new`); continue; }
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
      rows.push({ outside_id: o.id, native_id: n?.id ?? null, disposition: override.disposition, resolution: override.resolution, basis: 'override', severity: { outside: o.severity, native: n?.severity ?? null },
        ...(typeof override.proposal === 'string' && override.proposal.trim() ? { proposal: override.proposal.trim() } : {}) });
      continue;
    }
    const near = (n: FindingRow) => !!o.file && o.line !== undefined && n.file === o.file && n.line !== undefined && Math.abs(n.line - o.line) <= 3;
    const ot = tokens(o.title);
    let match: FindingRow | undefined;
    let best = 0;
    for (const n of native) {
      if (used.has(n.id)) continue;
      const score = jaccard(ot, tokens(n.title)) + (near(n) ? 0.01 : 0);
      if (score >= 0.5 && score > best) { best = score; match = n; }
    }
    const titled = !!match;
    match ??= native.find(n => !used.has(n.id) && near(n));
    let fileOnly = false;
    if (!match && o.file) {
      // Plan reviews name a file without a line: same file, a line missing on either side.
      const sameFile = native.filter(n => !used.has(n.id) && n.file === o.file && (o.line === undefined || n.line === undefined));
      match = sameFile.reduce<FindingRow | undefined>((b, n) => (!b || jaccard(ot, tokens(n.title)) > jaccard(ot, tokens(b.title)) ? n : b), undefined);
      fileOnly = !!match;
    }
    if (!match) { rows.push({ outside_id: o.id, native_id: null, disposition: 'new', resolution: 'not raised by the native voice', basis: 'none', severity: { outside: o.severity, native: null } }); continue; }
    used.add(match.id);
    if (fileOnly) {
      rows.push({ outside_id: o.id, native_id: match.id, disposition: 'unverified', resolution: `same file, agreement unverified (${o.file}): ${match.title}`, basis: 'file', severity: { outside: o.severity, native: match.severity } });
      continue;
    }
    const basis: ReconciliationRow['basis'] = near(match) ? 'file_line' : 'title';
    const where = near(match) ? `${o.file}:${o.line}` : 'same title';
    if (!titled) {
      rows.push({ outside_id: o.id, native_id: match.id, disposition: 'unverified', resolution: `same location, agreement unverified (${where}): ${match.title}`, basis, severity: { outside: o.severity, native: match.severity } });
      continue;
    }
    const severity = { outside: o.severity, native: match.severity };
    const pair = (disposition: ReconciliationDisposition, resolution: string) => rows.push({ outside_id: o.id, native_id: match!.id, disposition, resolution, basis, severity });
    if (Math.abs(level(match.severity) - level(o.severity)) >= 2) { pair('disagree', `severity: native ${match.severity}, outside ${o.severity} (${where})`); continue; }
    if (!match.resolution || !o.resolution) { pair('unverified', `same title, a remedy is missing (${where}): ${match.title}`); continue; }
    if (contradictory(match.resolution, o.resolution)) { pair('disagree', `remedies conflict (${where}): native "${match.resolution}", outside "${o.resolution}"`); continue; }
    if (remedyKey(match.resolution) !== remedyKey(o.resolution)) { pair('unverified', `same title, remedies differ (${where}): ${match.title}`); continue; }
    pair('confirmed', `both voices, same remedy (${where}): ${match.title}`);
  }
  return { rows, native_only: native.filter(n => !used.has(n.id)).map(n => n.id), errors };
}

export interface ConsensusRecord {
  schema_version: 1; phase: string;
  native: { model: string | null; findings: number; by_severity: Record<Severity, number> } | null;
  outside: { model: string | null; provider: string | null; findings: number; by_severity: Record<Severity, number> } | null;
  confirmed: number; disagree: number; new: number; native_only: number;
  /** Same location, agreement unverified (absent on records written before it existed). */
  unverified?: number;
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
    confirmed: rows.filter(r => r.disposition === 'confirmed').length, unverified: rows.filter(r => r.disposition === 'unverified').length, disagree: rows.filter(r => r.disposition === 'disagree').length,
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
      ? `CONFIRMED ${c.confirmed} · SAME LOCATION, UNVERIFIED ${c.unverified ?? 0} · DISAGREE ${c.disagree} · NEW (outside only) ${c.new} · native only ${c.native_only}. Both completed.`
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
