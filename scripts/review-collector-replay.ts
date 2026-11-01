#!/usr/bin/env -S bun --no-env-file --config=/dev/null
/**
 * review-collector-replay: the GST-766 part (b) no-loss replay (test/fixtures/review-replay/PREREG.md). Free and deterministic:
 * it re-collects saved raw reviewer outputs with this checkout's parseFindings and compares every finding with the baseline
 * frozen in the manifest (the 6e6685f6 collector) and with the blind gold verdicts.
 *
 * Usage:
 *   bun run scripts/review-collector-replay.ts [--manifest test/fixtures/review-replay/manifest.json] [--root .]
 *   bun run scripts/review-collector-replay.ts --freeze [--manifest …]   (writes each entry's baseline and the candidate keys)
 *
 * Prints one LOWERED: line per lowered finding, then
 *   REPLAY: entries=<n> gold_blockers=<n> affected=<n> lowered=<n> lowered_gold_nonblocking=<n> lost=<n> negated_cases=<n>
 *           negated_lost=<n> controls_lowered=<n>/<n> confinement=ok|broken
 * Exit 0 when the bar holds, 1 when it fails, 2 on a missing, hash-mismatched or malformed input or an unresolved gold match.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promptHash } from '../lib/review-brief';
import { parseFindings } from '../lib/review-ledger';

export interface Baseline { label: string; raw_sha256: string }
export interface Entry { id: string; role: string; file: string; sha256: string; kind?: 'raw' | 'merged'; group?: string; source?: string; baseline?: Baseline[] }
export interface Gold { verdict: 'BLOCKING' | 'NOT_BLOCKING'; raw_sha256: string; judges?: Record<string, string> }
export interface NegatedCase { reader: string; text: string; labels: string[] }
export interface Manifest { schema: 1; baseline_commit: string; entries: Entry[]; negated: NegatedCase[]; controls: string[]; candidates?: string[]; gold: Record<string, Gold> }
export interface ReplayResult { code: 0 | 1 | 2; lines: string[] }

const ROLES = new Set(['specialist', 'specialist-batched', 'red-team', 'adversarial-native', 'outside-voice', 'fix-check', 'targeted']);

/** The findings an entry's input holds: a raw output parsed whole, or each merged.jsonl line's raw text parsed on its own lines. */
export function findingsOf(entry: Entry, text: string): Array<{ label: string; raw: string }> {
  if (entry.kind !== 'merged') return parseFindings(entry.role, text);
  return text.split('\n').filter(Boolean).flatMap(l => {
    const m = JSON.parse(l) as { reader?: string; raw?: string };
    return m.reader?.split('/')[0] === entry.role && typeof m.raw === 'string' ? parseFindings(entry.role, m.raw.split(' | ').join('\n')) : [];
  });
}

const isCandidate = (role: string, b: { label: string; raw: string }) => role === 'adversarial-native' && b.label === 'CRITICAL' && /(?<![A-Za-z0-9])FIXABLE(?![A-Za-z0-9])/.test(b.raw);

function load(root: string, entry: Entry): string | { error: string } {
  if (!ROLES.has(entry.role)) return { error: `${entry.id}: unknown role ${entry.role}` };
  const file = path.resolve(root, entry.file);
  if (!fs.existsSync(file)) return { error: `${entry.id}: missing input ${entry.file}` };
  const text = fs.readFileSync(file, 'utf8');
  if (promptHash(text) !== entry.sha256) return { error: `${entry.id}: ${entry.file} does not hash to its manifest sha256` };
  return text;
}

export function freeze(m: Manifest, root: string): Manifest | { error: string } {
  const candidates: string[] = [];
  const entries: Entry[] = [];
  for (const e of m.entries) {
    const text = load(root, e);
    if (typeof text !== 'string') return text;
    const found = findingsOf(e, text);
    found.forEach((f, i) => { if (isCandidate(e.role, f)) candidates.push(`${e.id}#${i + 1}`); });
    entries.push({ ...e, baseline: found.map(f => ({ label: f.label, raw_sha256: promptHash(f.raw) })) });
  }
  return { ...m, entries, candidates };
}

export function replay(m: Manifest, root: string): ReplayResult {
  const bad = (error: string): ReplayResult => ({ code: 2, lines: [`REPLAY_INPUT: ${error}`] });
  if (m?.schema !== 1 || !Array.isArray(m.entries) || !Array.isArray(m.negated) || !Array.isArray(m.controls) || !m.gold) return bad('manifest is not schema 1');
  const lines: string[] = [];
  const lowered = new Set<string>();
  let confinement = true;
  let affected = 0;
  let lost = 0;
  let loweredNonblocking = 0;
  for (const e of m.entries) {
    const text = load(root, e);
    if (typeof text !== 'string') return bad(text.error);
    if (!Array.isArray(e.baseline)) return bad(`${e.id}: no frozen baseline`);
    const head = findingsOf(e, text);
    if (head.length !== e.baseline.length) { confinement = false; lines.push(`CONFINEMENT: ${e.id} collects ${head.length} findings, baseline ${e.baseline.length}`); continue; }
    head.forEach((f, i) => {
      const key = `${e.id}#${i + 1}`;
      const b = e.baseline![i]!;
      if (promptHash(f.raw) !== b.raw_sha256) { confinement = false; lines.push(`CONFINEMENT: ${key} raw text differs from the baseline`); return; }
      if (f.label === b.label) return;
      if (b.label !== 'CRITICAL' || f.label === 'CRITICAL' || !(m.candidates ?? []).includes(key)) { confinement = false; lines.push(`CONFINEMENT: ${key} ${b.label} -> ${f.label} outside the candidates`); return; }
      const gold = m.gold[key];
      if (!gold || gold.raw_sha256 !== b.raw_sha256) { lines.push(`UNRESOLVED: ${key} has no gold verdict bound to its text`); confinement = false; return; }
      affected++;
      lowered.add(key);
      if (gold.verdict === 'BLOCKING') lost++; else loweredNonblocking++;
      lines.push(`LOWERED: ${key} ${b.label} -> ${f.label} gold=${gold.verdict}`);
    });
  }
  if (lines.some(l => l.startsWith('UNRESOLVED:'))) return { code: 2, lines };
  let negatedLost = 0;
  for (const c of m.negated) {
    const got = parseFindings(c.reader, c.text).map(f => f.label);
    if (JSON.stringify(got) !== JSON.stringify(c.labels)) { negatedLost++; lines.push(`NEGATED_LOST: ${c.reader} ${JSON.stringify(c.text)} collects ${JSON.stringify(got)}, want ${JSON.stringify(c.labels)}`); }
  }
  const controls = m.controls.filter(k => lowered.has(k)).length;
  const goldBlockers = Object.values(m.gold).filter(g => g.verdict === 'BLOCKING').length;
  lines.push(`REPLAY: entries=${m.entries.length} gold_blockers=${goldBlockers} affected=${affected} lowered=${lowered.size} lowered_gold_nonblocking=${loweredNonblocking} lost=${lost} negated_cases=${m.negated.length} negated_lost=${negatedLost} controls_lowered=${controls}/${m.controls.length} confinement=${confinement ? 'ok' : 'broken'}`);
  const pass = lost === 0 && negatedLost === 0 && controls === m.controls.length && confinement;
  return { code: pass ? 0 : 1, lines };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const at = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] ?? fallback : fallback; };
  const root = path.resolve(at('--root', process.cwd()));
  const file = path.resolve(root, at('--manifest', 'test/fixtures/review-replay/manifest.json'));
  if (!fs.existsSync(file)) { console.log(`REPLAY_INPUT: missing manifest ${file}`); process.exit(2); }
  const m = JSON.parse(fs.readFileSync(file, 'utf8')) as Manifest;
  if (args.includes('--freeze')) {
    const out = freeze(m, root);
    if ('error' in out) { console.log(`REPLAY_INPUT: ${out.error}`); process.exit(2); }
    fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
    console.log(`FROZEN: entries=${out.entries.length} candidates=${out.candidates!.length}`);
    process.exit(0);
  }
  const r = replay(m, root);
  for (const l of r.lines) console.log(l);
  process.exit(r.code);
}
