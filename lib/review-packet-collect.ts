/**
 * review-packet-collect — the parent's only read of a packet review
 * (docs/review-policy.md#reviewer-packets): every packet's output file, parsed and
 * validated as /ship Step 9.2 stages 1–3 require, merged by identity, and a record
 * under COLLECT_MAX_LINES lines. Missing or unusable output is incomplete coverage.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyOutsideReview } from './outside-review-result';
import { sharedLibsFingerprint } from './review-evidence';
import { readManifest, type PacketEntry } from './review-packet';
import { resultLine } from './result-codes';

export const COLLECT_MAX_LINES = 60;
const LINE_MAX = 300;

export type Finding = Record<string, unknown> & { severity: 'CRITICAL' | 'INFORMATIONAL'; path: string; summary: string };
export type ReviewerStatus = 'clean' | 'findings' | 'missing' | 'invalid' | 'pending';
export interface ReviewerResult { packet: PacketEntry; status: ReviewerStatus; findings: Finding[]; records: number; invalid: number; recommendation?: string }
export interface Merged extends Finding { sources: string[] }

const str = (v: unknown) => typeof v === 'string' && v.trim().length > 0;
const NO_FINDINGS = /^[\s`*]*NO[ _]FINDINGS[\s`*.]*$/i;
const OUTSIDE_LINE = /^\s*(?:[-*]\s*)?\[(Critical|High|Medium|Low)\]\s+(\S+?)(?::(\d+))?\s+[—–-]\s+(.+)$/i;

/** A JSONL finding valid for its role, or null; the specialist roles need their whole required field set. */
export function validFinding(v: unknown, role: string): Finding | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const f = v as Record<string, unknown>;
  if (f.severity !== 'CRITICAL' && f.severity !== 'INFORMATIONAL') return null;
  if (!str(f.path) || !str(f.summary)) return null;
  if ((role === 'specialist' || role === 'red-team') && (typeof f.confidence !== 'number' || !str(f.category) || !str(f.specialist))) return null;
  return f as Finding;
}

/** One packet's output: stage 1 (parse, skip and count invalid lines) for its role. */
export function parseOutput(packet: PacketEntry, text: string | null): ReviewerResult {
  const r: ReviewerResult = { packet, status: 'missing', findings: [], records: 0, invalid: 0 };
  if (text === null || !text.trim()) return r;
  if (packet.role === 'outside-voice') return parseOutside(r, text);
  let clean = false, badCritical = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('```')) continue;
    if (NO_FINDINGS.test(line)) { clean = true; continue; }
    if (/^Recommendation:/i.test(line)) { r.recommendation = line; continue; }
    let v: unknown;
    try { v = JSON.parse(line); } catch { r.invalid++; if (/\bCRITICAL\b/i.test(line)) badCritical = true; continue; }
    if (v && typeof v === 'object' && !Array.isArray(v) && 'matrix' in v) {
      const m = (v as { matrix: unknown }).matrix;
      if (packet.checklists.includes('state-machines') && m && typeof m === 'object') r.records++; else r.invalid++;
      continue;
    }
    const f = validFinding(v, packet.role);
    if (!f) { r.invalid++; if (/^critical$/i.test(String((v as { severity?: unknown } | null)?.severity))) badCritical = true; continue; }
    r.findings.push({ ...f, specialist: str(f.specialist) ? f.specialist : packet.reviewer });
  }
  r.status = badCritical ? 'invalid' : r.findings.length ? 'findings' : clean || r.records ? 'clean' : 'invalid';
  return r;
}

function parseOutside(r: ReviewerResult, text: string): ReviewerResult {
  const verdict = classifyOutsideReview({ text, gate: 'review' });
  r.recommendation = text.split('\n').reverse().find(l => /^Recommendation:/i.test(l.trim()))?.trim();
  if (verdict.verdict === 'unavailable' || verdict.verdict === 'unverified') { r.status = 'invalid'; r.invalid = 1; return r; }
  for (const line of text.split('\n')) {
    const m = OUTSIDE_LINE.exec(line);
    if (m) r.findings.push({ severity: /critical|high/i.test(m[1]!) ? 'CRITICAL' : 'INFORMATIONAL', path: m[2]!, ...(m[3] ? { line: Number(m[3]) } : {}), category: 'outside-voice', summary: m[4]!.trim(), specialist: 'outside-voice' });
  }
  if (!r.findings.length && verdict.verdict === 'findings') {
    const blocking = verdict.findings.highest === 'P0' || verdict.findings.highest === 'P1';
    r.findings.push({ severity: blocking ? 'CRITICAL' : 'INFORMATIONAL', path: r.packet.out, category: 'outside-voice', summary: `outside voice findings not in line format (highest ${verdict.findings.highest}): read the output file`, specialist: 'outside-voice' });
  }
  r.status = r.findings.length ? 'findings' : 'clean';
  return r;
}

/** Stage 3's identity: shared-code advice by its evidence (never a supplied hash), else fingerprint, else path:line:category. */
export function identity(f: Finding): string | null {
  if (f.category === 'shared-libs' || (typeof f.fingerprint === 'string' && f.fingerprint.startsWith('shared-libs:'))) return sharedLibsFingerprint(f) ?? null;
  if (str(f.fingerprint)) return f.fingerprint as string;
  const cat = str(f.category) ? f.category : 'uncategorized';
  return typeof f.line === 'number' ? `${f.path}:${f.line}:${cat}` : `${f.path}:${cat}`;
}

/** Stages 2–3: an advisory CRITICAL stays CRITICAL; defects and advice merge apart by identity, keeping the highest confidence and every source. */
export function mergeFindings(results: readonly ReviewerResult[]): Merged[] {
  const merged = new Map<string, Merged>();
  const out: Merged[] = [];
  for (const r of results) for (const raw of r.findings) {
    const f: Finding = { ...raw };
    if (f.severity === 'CRITICAL' && 'advisory' in f) delete f.advisory;
    const advisory = f.advisory === true;
    const id = identity(f);
    const source = String(f.specialist ?? r.packet.reviewer);
    if (id === null) { out.push({ ...f, sources: [source] }); continue; }
    const key = `${advisory ? 'advice' : 'defect'}\0${id}`;
    const prior = merged.get(key);
    if (!prior) { const m = { ...f, sources: [source] }; merged.set(key, m); out.push(m); continue; }
    const conf = (x: Finding) => (typeof x.confidence === 'number' ? x.confidence : 0);
    const sources = [...new Set([...prior.sources, source])];
    const best = conf(f) > conf(prior) ? f : prior;
    const severity = prior.severity === 'CRITICAL' || f.severity === 'CRITICAL' ? 'CRITICAL' : 'INFORMATIONAL';
    const boost = sources.length > 1 && prior.sources.length === 1 && typeof best.confidence === 'number' ? Math.min(10, best.confidence + 1) : best.confidence;
    Object.assign(prior, { ...best, severity, sources, ...(boost === undefined ? {} : { confidence: boost }) }, sources.length > 1 ? { confirmed: `MULTI-SPECIALIST CONFIRMED (${sources.join(' + ')})` } : {});
  }
  return out;
}

const oneLine = (s: string) => (s.length > LINE_MAX ? s.slice(0, LINE_MAX - 1) + '…' : s);
const where = (f: Finding) => `${f.path}${typeof f.line === 'number' ? `:${f.line}` : ''}`;

export interface CollectResult { lines: string[]; complete: boolean; results: ReviewerResult[]; merged: Merged[] }

/** Read every packet's output in `dir`, write merged.jsonl and informational.md there, and return the compact record. */
export function collect(dir: string): CollectResult | { error: string } {
  const manifest = readManifest(dir);
  if (!manifest) return { error: `no readable manifest.json in ${dir}; run gstack-review-packet build first` };
  const reviewers = manifest.packets.filter(p => p.role !== 'audit');
  const pending = reviewers.filter(p => p.deferred);
  const results = reviewers.filter(p => !p.deferred).map(p => { let text: string | null = null; try { text = fs.readFileSync(p.out, 'utf8'); } catch {} return parseOutput(p, text); });
  const merged = mergeFindings(results);
  fs.writeFileSync(path.join(dir, 'merged.jsonl'), merged.map(m => JSON.stringify(m)).join('\n') + (merged.length ? '\n' : ''), { mode: 0o600 });
  const info = merged.filter(m => m.severity === 'INFORMATIONAL');
  const crit = merged.filter(m => m.severity === 'CRITICAL').sort((a, b) => Number(b.confidence ?? 0) - Number(a.confidence ?? 0));
  const note = (m: Merged) => `- ${m.advisory === true ? '[ADVISORY] ' : ''}\`${where(m)}\` (${m.sources.join(' + ')}): ${String(m.summary).replace(/\s+/g, ' ')}${str(m.fix) ? ` Fix: ${String(m.fix).replace(/\s+/g, ' ')}` : ''}`;
  fs.writeFileSync(path.join(dir, 'informational.md'), `## Review notes (informational)\n\n${info.length ? info.map(note).join('\n') : 'None.'}\n`, { mode: 0o600 });
  const lines: string[] = [];
  const count = (r: ReviewerResult, s: string) => r.findings.filter(f => f.severity === s).length;
  const shown = results.length > 25 ? results.filter(r => r.status !== 'clean') : results;
  for (const r of shown) lines.push(`REVIEWER: ${r.packet.name} status=${r.status} crit=${count(r, 'CRITICAL')} info=${count(r, 'INFORMATIONAL')}${r.packet.fixtures === 'summary' ? ' fixtures=summary' : ''}${r.invalid ? ` invalid_lines=${r.invalid}` : ''}`);
  for (const p of pending) lines.push(`REVIEWER: ${p.name} status=pending (build its packet with --findings ${path.join(dir, 'merged.jsonl')}, dispatch it, collect again)`);
  if (shown.length < results.length) lines.push(`REVIEWERS_CLEAN: ${results.length - shown.length} more, each status=clean`);
  for (const a of manifest.packets.filter(p => p.role === 'audit')) {
    let last = '';
    try { last = fs.readFileSync(a.out, 'utf8').trimEnd().split('\n').at(-1) ?? ''; } catch {}
    let ok = false;
    try { ok = !!last && typeof JSON.parse(last) === 'object'; } catch {}
    lines.push(`AUDIT: ${a.name} status=${ok ? 'present' : last ? 'invalid' : 'missing'} out=${a.out}`);
    if (!ok) results.push({ packet: a, status: last ? 'invalid' : 'missing', findings: [], records: 0, invalid: 0 });
  }
  const incomplete = results.filter(r => r.status === 'missing' || r.status === 'invalid');
  const tail = 6;
  const room = COLLECT_MAX_LINES - lines.length - tail;
  for (const m of crit.slice(0, Math.max(room, 0))) lines.push(oneLine(`CRITICAL: ${where(m)} [${m.sources.join('+')}]${typeof m.confidence === 'number' ? ` conf=${m.confidence}` : ''} ${String(m.summary).replace(/\s+/g, ' ')}${str(m.fix) ? ` fix: ${String(m.fix).replace(/\s+/g, ' ')}` : ''}`));
  if (crit.length > Math.max(room, 0)) lines.push(`CRITICAL_MORE: ${crit.length - Math.max(room, 0)} more in ${path.join(dir, 'merged.jsonl')}`);
  lines.push(`INFORMATIONAL: ${info.length} (advisory ${info.filter(m => m.advisory === true).length}) in ${path.join(dir, 'informational.md')}`);
  for (const r of results.filter(x => x.recommendation).slice(0, 2)) lines.push(oneLine(`RECOMMENDATION: ${r.packet.name}: ${r.recommendation!.replace(/^Recommendation:\s*/i, '')}`));
  const invalid = results.reduce((n, r) => n + r.invalid, 0);
  lines.push(`COLLECT: reviewers=${reviewers.length} clean=${results.filter(r => r.status === 'clean').length} findings=${results.filter(r => r.status === 'findings').length} missing=${results.filter(r => r.status === 'missing').length} invalid=${results.filter(r => r.status === 'invalid').length} crit=${crit.length} info=${info.length} invalid_lines=${invalid} pending=${pending.length} merged=${path.join(dir, 'merged.jsonl')}`);
  if (incomplete.length) lines.push(resultLine('gstack-review-packet collect', 'REVIEW_COVERAGE_INCOMPLETE', oneLine(incomplete.map(r => `${r.packet.name}=${r.status}`).join(' ')).slice(0, 160)));
  return { lines: lines.slice(0, COLLECT_MAX_LINES), complete: !incomplete.length, results, merged };
}
