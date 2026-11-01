/**
 * pregate check `secrets` (tier 1, preflight, never downgradable): the
 * branch's added lines (merge-base → working tree, untracked files included)
 * go through bin/gstack-redact. Exit 0 is clean; 2 (MEDIUM) and 3 (HIGH)
 * fail unless the policy's `allowlist` names each finding (lib/pregate/allowlist.ts;
 * never env.value); a scanner that does not finish or exits outside its
 * contract is PREGATE_ENVIRONMENT (kind tool), never a pass. Runs regardless
 * of lint tools.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runScriptSync } from '../../script-invocation';
import { allowlistDigest, applyAllowlist, describeAllowlisted, describeMissed, describeUntested, type AllowlistFinding } from '../allowlist';
import { baseInputs, sha256 } from '../context';
import { environmentResult, launchCause } from '../environment';
import { checkScratch } from '../run-scratch';
import type { CheckDef, CheckResult, PregateContext } from '../types';

const BIN_DIR = path.resolve(path.dirname(Bun.fileURLToPath(import.meta.url)), '..', '..', '..', 'bin');

/** The diff's added-line text per file, hunk-aware: a `+++` inside a hunk is content, not a header. */
export function parseAddedLines(diff: string): Map<string, string[]> {
  const files = new Map<string, string[]>();
  let file = '';
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --')) { file = ''; inHunk = false; continue; }
    if (line.startsWith('@@')) { inHunk = true; continue; }
    if (!inHunk) { if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : ''; continue; }
    if (line.startsWith('+')) files.set(file, [...(files.get(file) ?? []), line.slice(1)]);
  }
  return files;
}

/** Each file's added line numbers in the working-tree file, from the hunk headers' `+start`. */
export function parseAddedLineNumbers(diff: string): Map<string, number[]> {
  const files = new Map<string, number[]>();
  let file = '';
  let next = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --')) { file = ''; next = 0; continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { next = Number(hunk[1]); continue; }
    if (!next) { if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : ''; continue; }
    if (line.startsWith('+')) { if (!files.has(file)) files.set(file, []); files.get(file)!.push(next++); }
    else if (line.startsWith(' ')) next++;
  }
  return files;
}

/** Files whose source-syntax exemption needs the whole file: a line added inside an existing `'''`/`"""` block is a literal (#3630). */
const LEXICAL_CONTEXT_SOURCE = /\.(?:dart|pyi?)$/i;
const WHOLE_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Added lines from the merge-base to the working tree, plus every line of
 * untracked files, grouped by file so gstack-redact can use each file's type
 * (#3211). A tracked Dart or Python file is passed whole with `keep`, its
 * added line numbers, so the scanner sees the strings an added line sits in
 * and only findings on those lines count (#3630); an untracked one keeps every
 * line. One too large, unreadable, not a regular file, or whose working copy
 * no longer holds the diff's added lines at their numbers
 * to read whole is scanned under a neutral name, without that exemption. External diff and textconv
 * drivers are off: either can empty or rewrite the diff, and an empty diff
 * reads as clean.
 */
export function addedLines(ctx: PregateContext): Array<{ file: string; text: string; keep?: number[] }> {
  const diff = spawnSync('git', ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', '--diff-filter=ACMR', ctx.mergeBase, '--'], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024, env: ctx.env });
  const files = parseAddedLines(diff.stdout ?? '');
  const numbers = parseAddedLineNumbers(diff.stdout ?? '');
  const whole = new Map<string, { text: string; keep: number[] }>();
  for (const [file, keep] of numbers) {
    if (!LEXICAL_CONTEXT_SOURCE.test(file)) continue;
    try {
      const st = fs.lstatSync(path.join(ctx.repoRoot, file));
      if (!st.isFile() || st.size > WHOLE_FILE_MAX_BYTES) continue;
      const text = fs.readFileSync(path.join(ctx.repoRoot, file), 'utf8');
      const lines = text.split('\n');
      const added = files.get(file) ?? [];
      if (keep.length === added.length && keep.every((n, k) => lines[n - 1] === added[k])) whole.set(file, { text, keep });
    } catch { /* unreadable: its added lines are scanned alone */ }
  }
  for (const t of ctx.touched) {
    if (!t.uncommitted || t.status === 'D') continue;
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', t.path], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 15_000 }).status === 0;
    if (tracked) continue;
    try {
      const st = fs.statSync(path.join(ctx.repoRoot, t.path));
      if (!st.isFile() || st.size > WHOLE_FILE_MAX_BYTES) continue;
      const lines = fs.readFileSync(path.join(ctx.repoRoot, t.path), 'utf8').split('\n');
      if (LEXICAL_CONTEXT_SOURCE.test(t.path) && !files.has(t.path)) whole.set(t.path, { text: lines.join('\n'), keep: lines.map((_, n) => n + 1) });
      files.set(t.path, [...(files.get(t.path) ?? []), ...lines]);
    } catch { /* unreadable: skipped */ }
  }
  return [...files].map(([file, lines]) => whole.get(file) ? { file, ...whole.get(file)! } : { file, text: lines.join('\n') }).filter(p => p.text.trim());
}
type Finding = { id?: string; description?: string; severity?: string; category?: string; line?: number; col?: number; file: string; fileLine?: boolean };
type Scanned = Finding & AllowlistFinding;

function run(ctx: PregateContext): CheckResult {
  const parts = addedLines(ctx);
  const inputs = baseInputs(ctx, { added_lines: sha256(JSON.stringify(parts)), ...(ctx.config.allowlist.length ? { allowlist: allowlistDigest(ctx.config.allowlist) } : {}) });
  if (!parts.length) return { id: 'secrets', stage: 'preflight', status: 'pass', detail: 'no added lines', inputs };
  // A run killed mid-scan under the same --run id must not keep its added-line copies: clear them before writing new ones.
  fs.rmSync(path.join(ctx.scratch, 'secrets'), { recursive: true, force: true });
  const tmp = checkScratch(ctx.scratch, 'secrets');
  const base: CheckResult = { id: 'secrets', stage: 'preflight', status: 'incomplete', inputs };
  try {
    const findings: Scanned[] = [];
    let high = false;
    let medium = false;
    let parsedAll = true;
    for (const [i, part] of parts.entries()) {
      const file = path.join(tmp, String(i), (!part.keep && LEXICAL_CONTEXT_SOURCE.test(part.file) ? '' : path.basename(part.file)) || 'added.txt');
      fs.mkdirSync(path.dirname(file), { mode: 0o700 });
      fs.writeFileSync(file, part.text, { mode: 0o600 });
      const r = runScriptSync(path.join(BIN_DIR, 'gstack-redact'), ['--from-file', file, '--json', '--max-bytes', String(64 * 1024 * 1024)], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: Math.min(ctx.timeoutMs, 300_000), maxBuffer: 64 * 1024 * 1024, env: ctx.env });
      if (r.error || r.status === null) return environmentResult(base, launchCause('tool', `gstack-redact did not finish on ${part.file || 'added lines'} (${r.error?.message ?? 'killed'})`), `gstack-redact did not finish on ${part.file || 'added lines'}; an incomplete scan never passes`);
      if (r.status !== 0 && r.status !== 2 && r.status !== 3) return environmentResult(base, launchCause('tool', `gstack-redact exited ${r.status} on ${part.file || 'added lines'}: ${(r.stderr ?? '').trim().split('\n').pop() ?? ''}`), `gstack-redact exited ${r.status}; an incomplete scan never passes`);
      high ||= r.status === 3;
      medium ||= r.status === 2;
      const lines = part.text.split('\n');
      try { findings.push(...(JSON.parse(r.stdout).findings ?? []).filter((f: Omit<Finding, 'file'>) => !part.keep || f.id?.startsWith('engine.') || (f.line !== undefined && part.keep.includes(f.line))).map((f: Omit<Finding, 'file'>) => ({ ...f, id: f.id ?? 'finding', category: f.category ?? '?', severity: f.severity ?? '?', file: part.file, fileLine: !!part.keep, lineText: f.line ? lines[f.line - 1] : undefined }))); } catch { parsedAll = false; }
    }
    // The allowlist applies only to findings the scanner reported in full; an unparsed report keeps its exit-code verdict.
    const applied = parsedAll && ctx.config.allowlist.length ? applyAllowlist(findings, ctx.config.allowlist) : { kept: findings, allowlisted: [], untested: [], missed: [] };
    const kept = applied.kept;
    if (parsedAll) { high = kept.some(f => f.severity === 'HIGH'); medium = kept.some(f => f.severity === 'MEDIUM'); }
    const render = (f: Scanned) => `${f.severity} ${f.id} [${f.category}]: ${f.description ?? ''}${f.line ? ` (${f.file ? `${f.file}, ` : ''}${f.fileLine ? 'line' : 'added line'} ${f.line})` : ''}`;
    const allowLines = [...applied.allowlisted.map(describeAllowlisted), ...applied.untested.map(describeUntested), ...applied.missed.map(describeMissed)];
    const allowNote = applied.allowlisted.length ? `; ${applied.allowlisted.length} allowlisted (${[...new Set(applied.allowlisted.map(a => a.finding.id))].join(', ')})` : '';
    // HIGH and any MEDIUM credential fail; a MEDIUM hygiene/internal/pii/legal
    // hit in code (a `.local` property reads as a hostname) is listed as warn:
    // there is no user to answer gstack-redact's per-finding question here.
    const blocking = kept.filter(f => f.severity === 'HIGH' || (f.severity === 'MEDIUM' && f.category === 'secret'));
    const advisory = kept.filter(f => f.severity === 'MEDIUM' && f.category !== 'secret');
    const lineCount = parts.reduce((n, p) => n + (p.keep?.length ?? p.text.split('\n').length), 0);
    const fail = (lines: string[], detail: string): CheckResult => ({ ...base, status: 'fail', cause: 'diff', lines: [...lines, ...allowLines], code: 'PREGATE_SECRETS', detail: `${detail}${allowNote}`, fix: 'rotate and remove the credential from the added lines (history included); secrets cannot be downgraded (a benign finding is allowlisted by id, path and pattern in the policy, never env.value)' });
    if (!high && !medium) return { ...base, status: 'pass', ...(allowLines.length ? { lines: allowLines } : {}), detail: `${lineCount} added lines clean${kept.length ? ` (${kept.length} WARN)` : ''}${allowNote}` };
    if (blocking.length) return fail([...blocking, ...advisory].map(render), `${blocking.length} credential finding(s) in added lines (${blocking.map(f => f.id).join(', ')})`);
    if (high) return fail(kept.map(render), 'HIGH finding(s) in added lines');
    return { ...base, status: 'warn', cause: 'diff', lines: [...advisory.map(render), ...allowLines], code: 'PREGATE_SECRETS', detail: `${advisory.length} MEDIUM non-credential finding(s) in added lines (${[...new Set(advisory.map(f => f.id))].join(', ')})${allowNote}`, fix: 'read each listed line; gstack-post asks about the same findings when the PR body quotes them; a benign one is allowlisted by id or category, path and pattern in the policy' };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export const secretsCheck: CheckDef = { id: 'secrets', stage: 'preflight', tier: 1, downgradable: false, needsRepoCommands: false, run };
