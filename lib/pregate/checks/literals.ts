/**
 * pregate check `literals` (tier 1, preflight): for every exported constant,
 * timeout, retry or delay literal the branch changed, grep the whole test
 * tree, nightly-only and Heavy-only files included, for the old value next to
 * the constant's name or its module. Incident p0-4-heavy-old-constant: a
 * nightly-only test still asserted the old number and went red a week after
 * the merge.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { baseInputs, sha256 } from '../context';
import { isTestFile, listRepoFiles, scansLiterals } from '../import-graph';
import type { CheckDef, CheckResult, PregateContext } from '../types';

export interface ChangedLiteral { name: string; old: string; new: string; file: string }

const CONST_PATTERNS: RegExp[] = [
  /^\s*export\s+(?:const|let|var)\s+([A-Z][A-Z0-9_]{1,})\s*(?::\s*[^=]+?)?\s*=\s*(.+?);?\s*$/,
  /^\s*(?:module\.)?exports\.([A-Z][A-Z0-9_]{1,})\s*=\s*(.+?);?\s*$/,
  /^\s*(?:export\s+)?(?:static\s+)?readonly\s+([A-Z][A-Z0-9_]{1,})\s*(?::\s*[^=]+?)?\s*=\s*(.+?);?\s*$/,
  /^([A-Z][A-Z0-9_]{2,})\s*=\s*(.+?)\s*$/,
  /^(?:export\s+|readonly\s+)?([A-Z][A-Z0-9_]{2,})=(\S+)\s*$/,
];
const CALL_PATTERN = /\b(timeout(?:Ms|_ms)?|retries|maxRetries|max_retries|attempts|maxAttempts|delay(?:Ms)?|interval(?:Ms)?|budget|cap|limit)\s*[:=]\s*(\d+(?:_\d+)*)\b/g;
const LITERAL = /^(?:-?\d+(?:_\d+)*(?:\.\d+)?|'[^']*'|"[^"]*"|`[^`$]*`|true|false|null|\[[^\]]*\])$/;

/** `NAME → literal` for one source text; only literal right-hand sides count. */
export function constantsIn(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    for (const re of CONST_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const value = m[2]!.trim();
      if (LITERAL.test(value)) out.set(m[1]!, value);
      break;
    }
  }
  return out;
}

/** Named numeric call sites (`timeout: 5000`) keyed by name; the last value per name wins, which is enough to spot a change. */
export function callLiteralsIn(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of text.matchAll(CALL_PATTERN)) out.set(m[1]!, m[2]!);
  return out;
}

export function changedLiterals(file: string, oldText: string, newText: string): ChangedLiteral[] {
  const out: ChangedLiteral[] = [];
  const oldC = constantsIn(oldText); const newC = constantsIn(newText);
  for (const [name, old] of oldC) { const now = newC.get(name); if (now !== undefined && now !== old) out.push({ name, old, new: now, file }); }
  const oldCall = callLiteralsIn(oldText); const newCall = callLiteralsIn(newText);
  for (const [name, old] of oldCall) { const now = newCall.get(name); if (now !== undefined && now !== old && !oldC.has(name)) out.push({ name, old, new: now, file }); }
  return out;
}

function escape(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function unquote(v: string): string { return /^['"`]/.test(v) ? v.slice(1, -1) : v; }

/**
 * Test files that still carry the old literal beside the constant's name or
 * its module. The module counts as its full file name (`install.sh`) or as a
 * path fragment (`/retry.js`, `/retry'`): a bare stem such as `install` or `retry` is an
 * English word in half the test tree, and a one-character old value (`2`)
 * sits in every test, so that value needs the constant's name (a wrapper
 * version 2 → 3 flagged 575 consumers through the stem alone).
 *
 * A version-history row (`[45, "<digest>"]`, the old value first in a
 * bracketed row) is skipped when the same table, a run of consecutive
 * `[…` lines, holds a new-value row and `baseText` (the file at the merge
 * base; null for a file the base lacks, undefined when it cannot be read)
 * has no new-value row: the branch extended the table. A table it did not
 * extend, a file that already held a new-value row, and an unreadable base
 * still count, and the scan goes on past skipped rows to the first real consumer.
 */
export function consumersOf(repoRoot: string, testFiles: readonly string[], change: ChangedLiteral, baseText?: (rel: string) => string | null | undefined): string[] {
  const value = unquote(change.old);
  const valueRe = /^-?\d/.test(value) ? new RegExp(`(?<![\\w.])${escape(value)}(?![\\w.])`) : new RegExp(`['"\`]${escape(value)}['"\`]`);
  const row = (raw: string) => new RegExp(`^[ \\t]*\\[[ \\t]*${/^['"`]/.test(raw) ? `['"\`]${escape(unquote(raw))}['"\`]` : escape(raw)}[ \\t]*,`, 'm');
  const oldRowRe = row(change.old);
  const newRowRe = row(change.new);
  const base = path.basename(change.file);
  const stem = base.replace(/\.[^.]+$/, '');
  const moduleRe = new RegExp(`(?:(?:^|[/\\\\])${escape(stem)}|(?<![\\w-])${escape(base)})(?![\\w-])`, 'm');
  const nameRe = new RegExp(`\\b${escape(change.name)}\\b`);
  const nameRequired = value.length < 2;
  const hits: string[] = [];
  for (const rel of testFiles) {
    let text: string;
    try { text = fs.readFileSync(path.join(repoRoot, rel), 'utf8'); } catch { continue; }
    if (!(nameRe.test(text) || (!nameRequired && moduleRe.test(text)))) continue;
    const lines = text.split('\n');
    const table: number[] = [];
    const tableHasNew: boolean[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!/^[ \t]*\[/.test(lines[i]!)) { table.push(-1); continue; }
      if (table[i - 1] === undefined || table[i - 1] === -1) tableHasNew.push(false);
      table.push(tableHasNew.length - 1);
      if (newRowRe.test(lines[i]!)) tableHasNew[tableHasNew.length - 1] = true;
    }
    let extended: boolean | undefined;
    const skip = (i: number) => {
      const line = lines[i]!;
      if (!oldRowRe.test(line) || !tableHasNew[table[i]!] || valueRe.test(line.slice(line.indexOf(']') + 1))) return false;
      if (extended === undefined) { const base = baseText?.(rel); extended = base === null || (base !== undefined && !newRowRe.test(base)); }
      return extended;
    };
    for (let i = 0; i < lines.length; i++) if (valueRe.test(lines[i]!) && !skip(i)) { hits.push(`${rel}:${i + 1}`); break; }
  }
  return hits;
}

function run(ctx: PregateContext): CheckResult {
  const candidates = ctx.touched.filter(t => (t.status === 'M' || t.status === 'R') && !isTestFile(t.path) && /\.(?:[cm]?[jt]sx?|py|rb|sh|bash)$/.test(t.path));
  const changes: ChangedLiteral[] = [];
  for (const t of candidates) {
    const old = spawnSync('git', ['show', `${ctx.mergeBase}:${t.renamedFrom ?? t.path}`], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: ctx.env });
    if (old.status !== 0) continue;
    let now = '';
    try { now = fs.readFileSync(path.join(ctx.repoRoot, t.path), 'utf8'); } catch { continue; }
    changes.push(...changedLiterals(t.path, old.stdout, now));
  }
  const inputs = baseInputs(ctx, { changes: sha256(changes.map(c => `${c.file}:${c.name}:${c.old}→${c.new}`).join('\n')) });
  if (!changes.length) return { id: 'literals', stage: 'preflight', status: 'pass', inputs, detail: `no exported constant or named timeout literal changed in ${candidates.length} modified source file(s)` };
  const testFiles = listRepoFiles(ctx.repoRoot).filter(f => scansLiterals(f) && !f.startsWith('bin/'));
  const lines: string[] = [];
  for (const c of changes) {
    const hits = consumersOf(ctx.repoRoot, testFiles, c, rel => {
      const from = ctx.touched.find(t => t.path === rel)?.renamedFrom ?? rel;
      const r = spawnSync('git', ['show', `${ctx.mergeBase}:${from}`], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 30_000, maxBuffer: 64 * 1024 * 1024, env: ctx.env });
      if (r.status === 0) return r.stdout;
      const ls = spawnSync('git', ['ls-tree', ctx.mergeBase, '--', from], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 30_000, env: ctx.env });
      return ls.status === 0 && !ls.stdout.trim() ? null : undefined;
    });
    ctx.explain.push(`literals: ${c.file} ${c.name} ${c.old} → ${c.new}: ${hits.length} test file(s) still carry ${c.old}`);
    for (const h of hits) lines.push(`${h}: ${c.name} still ${c.old} (now ${c.new} in ${c.file})`);
  }
  if (lines.length) return { id: 'literals', stage: 'preflight', status: 'fail', inputs, lines, code: 'PREGATE_LITERALS', detail: `${lines.length} test location(s) still carry an old literal`, fix: 'update each listed test to the new value (nightly- and Heavy-only files included), or keep the old constant' };
  return { id: 'literals', stage: 'preflight', status: 'pass', inputs, detail: `${changes.length} changed literal(s), no test still carries an old value (${testFiles.length} test-tree files scanned)` };
}

export const literalsCheck: CheckDef = { id: 'literals', stage: 'preflight', tier: 1, downgradable: true, needsRepoCommands: false, run };
