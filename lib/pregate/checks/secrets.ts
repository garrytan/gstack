/**
 * pregate check `secrets` (tier 1, preflight, never downgradable): the
 * branch's added lines (merge-base → working tree, untracked files included)
 * go through bin/gstack-redact. Exit 0 is clean; 2 (MEDIUM) and 3 (HIGH)
 * fail unless the policy's `allowlist` names each finding (lib/pregate/allowlist.ts;
 * never env.value); a scanner that does not finish or exits outside its
 * contract is PREGATE_ENVIRONMENT (kind tool), never a pass, and so is a
 * merge-base diff git did not finish. Files git calls binary are read too
 * (scannableText). Runs regardless of lint tools.
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

/** Each file's whole postimage from a diff with full context: one hunk starting at line 1, its context and added lines; a file with any other shape is left out. */
export function parsePostimages(diff: string): Map<string, string[]> {
  const files = new Map<string, string[]>();
  let file = '';
  let lines: string[] | null = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --')) { file = ''; lines = null; continue; }
    if (line.startsWith('@@')) {
      const first: boolean = lines === null && file !== '' && /^@@ -\d+(?:,\d+)? \+1(?:,\d+)? @@/.test(line);
      files.delete(file);
      lines = first ? [] : null;
      if (lines) files.set(file, lines); else file = '';
      continue;
    }
    if (lines === null) { if (line.startsWith('+++ ')) file = line.startsWith('+++ b/') ? line.slice(6) : ''; continue; }
    if (line.startsWith('+') || line.startsWith(' ')) lines.push(line.slice(1));
  }
  return files;
}

/**
 * Text the scanner can read from a file git calls binary, which the diff
 * passes through with --text (GST-2195). Text with no NUL is returned as is.
 * Each line is read two ways. The plain reading turns each run of NUL, other
 * control bytes or bytes that are not UTF-8 (an image chunk, an executable's
 * padding) into one space. The UTF-16 reading first drops the NULs inside
 * every run of character-and-NUL pairs, which UTF-16 text puts beside each
 * character of its ASCII range however much of the file is Cyrillic or CJK.
 * When the two differ the line holds both, so a plain token that a
 * NUL-flanked byte beside it would glue or cut in the UTF-16 reading is still
 * found. Line breaks stay, so line numbers still hold. Callers keep only credential
 * findings from such a file: privacy patterns read its bytes as noise (a run
 * of digits in a compressed icon reads as a phone number).
 */
export function scannableText(text: string): string {
  if (!text.includes('\0')) return text;
  const noise = /[\0-\x08\x0b\x0c\x0e-\x1f\x7f\uFFFD]+/g;
  return text.split('\n').map(line => {
    const plain = line.replace(noise, ' ');
    const utf16 = line.replace(/(?:[^\0-\x08\x0b\x0c\x0e-\x1f\x7f\uFFFD]\0){2,}|(?:\0[^\0-\x08\x0b\x0c\x0e-\x1f\x7f\uFFFD]){2,}/g, run => run.replaceAll('\0', '')).replace(noise, ' ');
    return utf16 === plain ? plain : `${utf16} ${plain}`;
  }).join('\n');
}

/** Files whose source-syntax exemption needs the whole file: a line added inside an existing `'''`/`"""` block is a literal (#3630). */
const LEXICAL_CONTEXT_SOURCE = /\.(?:dart|pyi?)$/i;
const WHOLE_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Added lines from the merge-base to the working tree, plus every line of
 * untracked files, grouped by file so gstack-redact can use each file's type
 * (#3211). A tracked Dart or Python file is passed whole with `keep`, its
 * added line numbers, so the scanner sees the strings an added line sits in
 * and only findings on those lines count (#3630). The whole text is the
 * postimage git diffed (a full-context diff), never the working copy, which
 * assume-unchanged can hide from git (GST-738); an untracked file keeps every
 * line. One too large, or whose full diff does not parse as one hunk holding
 * its added lines, is scanned under a neutral name, without that exemption. External diff and textconv
 * drivers are off: either can empty or rewrite the diff, and an empty diff
 * reads as clean. --text keeps a file git calls binary (a NUL byte, UTF-16, a
 * `-diff` attribute the branch itself can add) from printing "Binary files
 * differ" in place of its added lines; each such file is marked `binary`,
 * read through scannableText and held to its credential findings. A diff git did not finish (an exit, a kill, a
 * full buffer) throws: its partial output is never scanned as complete.
 */
export function addedLines(ctx: PregateContext): Array<{ file: string; text: string; keep?: number[]; binary?: boolean }> {
  const diff = spawnSync('git', ['diff', '--text', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', '--diff-filter=ACMR', ctx.mergeBase, '--'], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024, env: ctx.env });
  if (diff.error || diff.status !== 0) throw new Error(`git diff ${ctx.mergeBase.slice(0, 12)} did not finish (${diff.error?.message ?? (diff.status === null ? `killed by ${diff.signal}` : `exit ${diff.status}: ${(diff.stderr ?? '').trim().split('\n').pop() ?? ''}`)})`);
  const files = parseAddedLines(diff.stdout ?? '');
  const numbers = parseAddedLineNumbers(diff.stdout ?? '');
  const whole = new Map<string, { text: string; keep: number[] }>();
  const sources = [...numbers.keys()].filter(file => LEXICAL_CONTEXT_SOURCE.test(file));
  if (sources.length) {
    const full = spawnSync('git', ['-c', 'diff.suppressBlankEmpty=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', '--unified=100000000', '--diff-filter=ACMR', ctx.mergeBase, '--', ...sources.map(file => `:(literal)${file}`)], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024, env: ctx.env });
    for (const [file, post] of parsePostimages(full.status === 0 ? full.stdout ?? '' : '')) {
      const keep = numbers.get(file) ?? [];
      const added = files.get(file) ?? [];
      const text = post.join('\n');
      if (text.length <= WHOLE_FILE_MAX_BYTES && keep.length === added.length && keep.every((n, k) => post[n - 1] === added[k])) whole.set(file, { text, keep });
    }
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
  return [...files]
    .map(([file, lines]) => whole.get(file) ? { file, ...whole.get(file)! } : { file, text: lines.join('\n') })
    .map(p => p.text.includes('\0') ? { ...p, text: scannableText(p.text), binary: true } : p)
    .filter(p => p.text.trim());
}
type Finding = { id?: string; description?: string; severity?: string; category?: string; line?: number; col?: number; file: string; fileLine?: boolean };
type Scanned = Finding & AllowlistFinding;

function run(ctx: PregateContext): CheckResult {
  let parts: ReturnType<typeof addedLines>;
  try { parts = addedLines(ctx); } catch (err) {
    return environmentResult({ id: 'secrets', stage: 'preflight', status: 'incomplete', inputs: baseInputs(ctx) }, launchCause('tool', (err as Error).message), 'git diff of the added lines did not finish; an incomplete scan never passes');
  }
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
      try { for (const f of (JSON.parse(r.stdout).findings ?? []).filter((f: Omit<Finding, 'file'>) => (!part.binary || f.category === 'secret') && (!part.keep || f.id?.startsWith('engine.') || (f.line !== undefined && part.keep.includes(f.line)))).map((f: Omit<Finding, 'file'>) => ({ ...f, id: f.id ?? 'finding', category: f.category ?? '?', severity: f.severity ?? '?', file: part.file, fileLine: !!part.keep, lineText: f.line ? lines[f.line - 1] : undefined }))) findings.push(f); } catch { parsedAll = false; }
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
    const binary = parts.filter(p => p.binary).length;
    const scanned = `${parts.length} file${parts.length === 1 ? '' : 's'}${binary ? ` (${binary} binary)` : ''}`;
    const lineCount = parts.reduce((n, p) => n + (p.keep?.length ?? p.text.split('\n').length), 0);
    const fail = (lines: string[], detail: string): CheckResult => ({ ...base, status: 'fail', cause: 'diff', lines: [...lines, ...allowLines], code: 'PREGATE_SECRETS', detail: `${detail}${allowNote}`, fix: 'rotate and remove the credential from the added lines (history included); secrets cannot be downgraded (a benign finding is allowlisted by id, path and pattern in the policy, never env.value)' });
    if (!high && !medium) return { ...base, status: 'pass', ...(allowLines.length ? { lines: allowLines } : {}), detail: `${lineCount} added lines clean in ${scanned}${kept.length ? ` (${kept.length} WARN)` : ''}${allowNote}` };
    if (blocking.length) return fail([...blocking, ...advisory].map(render), `${blocking.length} credential finding(s) in added lines (${blocking.map(f => f.id).join(', ')})`);
    if (high) return fail(kept.map(render), 'HIGH finding(s) in added lines');
    return { ...base, status: 'warn', cause: 'diff', lines: [...advisory.map(render), ...allowLines], code: 'PREGATE_SECRETS', detail: `${advisory.length} MEDIUM non-credential finding(s) in added lines (${[...new Set(advisory.map(f => f.id))].join(', ')})${allowNote}`, fix: 'read each listed line; gstack-post asks about the same findings when the PR body quotes them; a benign one is allowlisted by id or category, path and pattern in the policy' };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

export const secretsCheck: CheckDef = { id: 'secrets', stage: 'preflight', tier: 1, downgradable: false, needsRepoCommands: false, run };
