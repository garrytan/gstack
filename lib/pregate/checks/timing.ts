/**
 * pregate check `timing` (tier 1, preflight; field list 2 W4): added or
 * changed test lines that compare an elapsed wall-clock or CPU time against a
 * bound, or that sleep and then assert. Each hit prints
 * TIMING_ASSERTION: <file>:<line> <pattern>; a hit is escaped by
 * gstack-timing-ok: <reason> in any comment syntax on the line or the line
 * above (the reason is required). The check warns; see docs/pregate.md#timing
 * for the measurement behind warn rather than block. Field incident: gbrain's
 * master went red on a 461 ms run against a 400 ms bound, and five such flakes
 * were fixed by hand in one week.
 */
import { spawnSync } from '../../spawn-sync';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { baseInputs, sha256 } from '../context';
import { isTestFile } from '../import-graph';
import type { CheckDef, CheckResult, PregateContext } from '../types';

export type TimingPattern = 'wall-time-bound' | 'cpu-time-bound' | 'sleep-then-assert';
export interface TimingHit { file: string; line: number; pattern: TimingPattern; escape?: { reason: string } | { missingReason: true } }

const CODE_EXT = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|exs?|php|cs)$/;
const TEST_DIR = /(?:^|\/)(?:test|tests|spec|__tests__)\//;
const FIXTURE_DIR = /(?:^|\/)(?:fixtures|__fixtures__|testdata)\//;

const WALL_SOURCE = /\b(?:Date\.now|performance\.now|process\.hrtime(?:\.bigint)?|Bun\.nanoseconds|time\.(?:time|monotonic|perf_counter)(?:_ns)?|System\.(?:nanoTime|currentTimeMillis)|Instant\.now|time\.Now|time\.Since|Process\.clock_gettime)\s*\(|\bnew Date\(\)\.getTime\(\)/;
const CPU_SOURCE = /\b(?:process\.cpuUsage|process\.resourceUsage|time\.(?:process_time|thread_time)(?:_ns)?|resource\.getrusage|\w*[cC]pu(?:Ms|Time|Usage|Nanos|Micros)\w*)\s*\(/;
const BOUND_NAME = /timeout|deadline|budget|limit|max|min|interval|delay|grace|ttl|cap\b|wait/i;
const ELAPSED_NAME = /^(?:ms|dt|secs?|seconds|nanos)$|^(?:elapsed|duration|took|latency|wall|cpu)|(?:Elapsed|Duration|Latency|Took|Ms|_ms|Millis|Nanos|_ns|Seconds|Secs)$/;
const ASSERT_CALL = /\bexpect\s*\(|\bassert\w*\b|\bt\.(?:ok|true|false|is)\s*\(|\.should\b/;
const SLEEP = /\b(?:await\s+(?:Bun\.sleep|sleep|delay|wait|setTimeoutPromise|timers\.setTimeout|scheduler\.wait)\s*\(|await\s+new\s+Promise\s*(?:<[^>]*>)?\s*\(\s*\(?\s*\w*\s*\)?\s*=>\s*setTimeout\s*\(|time\.sleep\s*\(|Thread\.sleep\s*\(|Bun\.sleepSync\s*\(|Atomics\.wait\s*\()/;
const ZERO_SLEEP = /^(?:await\s+)?(?:\w+(?:\.\w+)?\s*\(\s*0\s*\)|new\s+Promise[^;]*?setTimeout\s*\(\s*\w+\s*,\s*0\s*\))/;
const POLL = /\bwhile\b|\buntil\b|\bfor\s*\(|\bdo\s*\{/;
const ESCAPE = /(?:\/\/|\/\*|#|--|<!--|;|%|^\s*\*|^\s*')[^\n]*?\bgstack-timing-ok:([^\n]*)$/;
const ASSIGN = /^\s*(?:(?:const|let|var|val|final)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=]+)?(?<![=!<>])=(?!=)\s*(.+?);?\s*$/;
const ARITHMETIC = /^[\w$.()\s+\-*/!]+$/;
const NOT_ELAPSED = /mtime|ctime|birthtime|timestamp|stamp|At$|_at$/i;

/** Test code the check reads: test files and code under test directories, never fixture trees. */
export function scansTiming(rel: string): boolean {
  return CODE_EXT.test(rel) && (isTestFile(rel) || TEST_DIR.test(rel)) && !FIXTURE_DIR.test(rel);
}

function escapeReason(line: string | undefined): TimingHit['escape'] | undefined {
  const m = line === undefined ? null : ESCAPE.exec(line);
  if (!m) return undefined;
  const reason = m[1]!.replace(/\*\/|-->/g, '').trim();
  return /[A-Za-z]{2}/.test(reason) ? { reason } : { missingReason: true };
}

const identRe = (name: string) => new RegExp('(?<![\\w$.])' + name.replace(/\$/g, '\\$') + '(?![\\w$])');

/** Variables holding a clock reading or an elapsed time: assigned a clock call, or arithmetic over clocks and such variables. */
function clockVariables(lines: readonly string[]): Map<string, 'wall' | 'cpu'> {
  const vars = new Map<string, 'wall' | 'cpu'>();
  for (let pass = 0; pass < 2; pass++) {
    for (const line of lines) {
      const m = ASSIGN.exec(line);
      if (!m || vars.has(m[1]!)) continue;
      const rhs = m[2]!.replace(/^await\s+/, '');
      const leads = (re: RegExp) => { const r = re.exec(rhs); return !!r && r.index === 0; };
      if (leads(CPU_SOURCE)) { vars.set(m[1]!, 'cpu'); continue; }
      if (leads(WALL_SOURCE)) { vars.set(m[1]!, 'wall'); continue; }
      if (!ARITHMETIC.test(rhs) || /[\w$]\s*\(/.test(rhs.replace(WALL_SOURCE, '0').replace(CPU_SOURCE, '0').replace(/\bMath\.\w+\s*\(/g, '('))) continue;
      if (CPU_SOURCE.test(rhs)) { vars.set(m[1]!, 'cpu'); continue; }
      if (WALL_SOURCE.test(rhs)) { vars.set(m[1]!, 'wall'); continue; }
      for (const [name, kind] of vars) if (identRe(name).test(rhs)) { vars.set(m[1]!, kind); break; }
    }
  }
  return vars;
}

/** The clock kind a code fragment measures, from a clock call, a clock variable or an elapsed-time name; null when it reads no time. */
function timeOperand(code: string, vars: Map<string, 'wall' | 'cpu'>): 'wall' | 'cpu' | null {
  if (CPU_SOURCE.test(code)) return 'cpu';
  if (WALL_SOURCE.test(code)) return 'wall';
  let kind: 'wall' | 'cpu' | null = null;
  for (const [, ident] of code.matchAll(/(?<![\w$])([A-Za-z_$][\w$]*)(?![\w$])/g)) {
    const tracked = vars.get(ident!);
    if (tracked) { if (tracked === 'cpu') return 'cpu'; kind = 'wall'; continue; }
    if (/^[A-Z][A-Z0-9_]+$/.test(ident!) || BOUND_NAME.test(ident!) || NOT_ELAPSED.test(ident!) || !ELAPSED_NAME.test(ident!)) continue;
    if (/cpu/i.test(ident!)) return 'cpu';
    kind = 'wall';
  }
  return kind;
}

/** The text inside the parentheses opening at `open` (to the line's end when unbalanced). */
function parenArgs(line: string, open: number): string {
  let depth = 0;
  for (let i = open; i < line.length; i++) {
    if (line[i] === '(') depth++;
    else if (line[i] === ')' && --depth === 0) return line.slice(open + 1, i);
  }
  return line.slice(open + 1);
}

const isZero = (s: string) => /^\s*0(?:\.0+)?n?\s*$/.test(s);
const bareClock = (s: string) => /^\s*(?:Date\.now\(\)|performance\.now\(\)|new Date\(\)\.getTime\(\))\s*$/.test(s);

/** The clock kind of an asserted comparison between a time operand and a bound; a comparison with 0 is a sanity check, and a timestamp ordered against a bare now() is not an elapsed time. */
function boundKind(line: string, vars: Map<string, 'wall' | 'cpu'>): 'wall' | 'cpu' | null {
  const code = line.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''").replace(/\s\/\/.*$|^\s*\/\/.*$|\s#\s.*$/, '');
  for (const m of code.matchAll(/\.(?:toBeLessThan|toBeLessThanOrEqual|toBeGreaterThan|toBeGreaterThanOrEqual|toBeWithin)\s*\(/g)) {
    const bound = parenArgs(code, m.index! + m[0].length - 1);
    const open = code.lastIndexOf('expect(', m.index!);
    if (open < 0 || isZero(bound)) continue;
    const actual = parenArgs(code, open + 'expect'.length);
    if (bareClock(bound) && !timeOperand(actual, vars)) continue;
    const kind = timeOperand(actual, vars) ?? timeOperand(bound, vars);
    if (kind) return kind;
  }
  for (const m of code.matchAll(/\b(?:assertLess|assertLessEqual|assertGreater|assertGreaterEqual)\s*\(/g)) {
    const args = parenArgs(code, m.index! + m[0].length - 1);
    if (isZero(args.split(',')[1] ?? '')) continue;
    const kind = timeOperand(args, vars);
    if (kind) return kind;
  }
  const asserted: string[] = [];
  for (const m of code.matchAll(/\b(?:expect|assert(?:\.\w+)?|t\.(?:ok|true|false))\s*\(/g)) asserted.push(parenArgs(code, m.index! + m[0].length - 1));
  const py = /^\s*assert\s+(.+)$/.exec(code);
  if (py) asserted.push(py[1]!);
  for (const segment of asserted) {
    const clean = segment.replace(/=>/g, '  ');
    for (const c of clean.matchAll(/([^<>=!&|,(]+?)\s*(<=?|>=?)\s*([^<>=&|,)]+)/g)) {
      if (isZero(c[3]!) || isZero(c[1]!)) continue;
      if (bareClock(c[3]!) && !timeOperand(c[1]!, vars)) continue;
      const kind = timeOperand(c[1]!, vars) ?? timeOperand(c[3]!, vars);
      if (kind) return kind;
    }
  }
  return null;
}

/** True when the sleep sits outside a string literal and outside a polling loop. */
function fixedSleepAt(lines: readonly string[], i: number): boolean {
  const line = lines[i]!;
  const at = line.search(SLEEP);
  if (at < 0) return false;
  const before = line.slice(0, at);
  if (((before.match(/'/g)?.length ?? 0) % 2) || ((before.match(/"/g)?.length ?? 0) % 2) || ((before.match(/`/g)?.length ?? 0) % 2)) return false;
  if (ZERO_SLEEP.test(line.slice(at)) || POLL.test(line)) return false;
  for (let k = i - 1; k >= 0 && k >= i - 2; k--) {
    const prev = lines[k]!.trim();
    if (!prev) continue;
    if (POLL.test(prev) && /\{\s*$/.test(prev)) return false;
    break;
  }
  return true;
}

/**
 * Timing hits in one file's text. `added` holds the 1-based line numbers the
 * branch added or changed; 'all' scans every line (the measurement mode).
 */
export function scanTiming(file: string, text: string, added: ReadonlySet<number> | 'all'): TimingHit[] {
  const lines = text.split('\n');
  const isAdded = (n: number) => added === 'all' || added.has(n);
  const vars = clockVariables(lines);
  const hits: TimingHit[] = [];
  const escapeAt = (...ns: number[]) => {
    for (const n of ns) { const e = escapeReason(lines[n - 1]); if (e) return e; }
    return undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const n = i + 1;
    const line = lines[i]!;
    const kind = boundKind(line, vars);
    if (kind && isAdded(n)) { hits.push({ file, line: n, pattern: kind === 'cpu' ? 'cpu-time-bound' : 'wall-time-bound', escape: escapeAt(n, n - 1) }); continue; }
    if (!fixedSleepAt(lines, i)) continue;
    let seen = 0;
    for (let j = i + 1; j < lines.length && seen < 3; j++) {
      const next = lines[j]!.trim();
      if (!next || /^(?:\/\/|#|\*|\/\*)/.test(next)) continue;
      seen++;
      if (SLEEP.test(next)) break;
      if (!ASSERT_CALL.test(next)) continue;
      if (isAdded(n) || isAdded(j + 1)) hits.push({ file, line: n, pattern: 'sleep-then-assert', escape: escapeAt(n, n - 1, j + 1, j) });
      break;
    }
  }
  return hits;
}

/** Added line numbers per test file, merge-base to the working tree; an untracked test file counts whole. */
export function addedTestLines(ctx: PregateContext): Map<string, Set<number> | 'all'> | { error: string } {
  const out = new Map<string, Set<number> | 'all'>();
  const files = ctx.touched.filter(t => t.status !== 'D' && scansTiming(t.path));
  if (!files.length) return out;
  const diff = spawnSync('git', ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/', '--unified=0', '--diff-filter=ACMR', '-M', ctx.mergeBase, '--', ...files.map(t => t.path)], { cwd: ctx.repoRoot, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024, env: ctx.env });
  if (diff.error || diff.status !== 0) return { error: 'git diff ' + (diff.error ? 'did not finish (' + diff.error.message + ')' : 'exited ' + diff.status + ': ' + (diff.stderr ?? '').trim().split('\n').pop()) };
  let current: Set<number> | null = null;
  for (const line of diff.stdout.split('\n')) {
    const header = /^\+\+\+ b\/(.+)$/.exec(line);
    if (header) { current = new Set(); out.set(header[1]!, current); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) { const start = Number(hunk[1]); const count = hunk[2] === undefined ? 1 : Number(hunk[2]); for (let k = 0; k < count; k++) current.add(start + k); }
  }
  for (const t of files) if (!out.has(t.path) && t.uncommitted && t.status === 'A') out.set(t.path, 'all');
  return out;
}

function run(ctx: PregateContext): CheckResult {
  const added = addedTestLines(ctx);
  if (!(added instanceof Map)) return { id: 'timing', stage: 'preflight', status: 'incomplete', inputs: baseInputs(ctx), code: 'PREGATE_INCOMPLETE', detail: added.error + '; the added test lines were not read', fix: 'fix the git error and rerun gstack-pregate; an unread diff never passes' };
  const hits: TimingHit[] = [];
  for (const [file, lines] of added) {
    let text: string;
    try { text = fs.readFileSync(path.join(ctx.repoRoot, file), 'utf8'); } catch { continue; }
    hits.push(...scanTiming(file, text, lines));
  }
  const inputs = baseInputs(ctx, { hits: sha256(hits.map(h => h.file + ':' + h.line + ':' + h.pattern + ':' + (h.escape && 'reason' in h.escape ? h.escape.reason : '')).join('\n')) });
  const open = hits.filter(h => !h.escape || 'missingReason' in h.escape);
  const escaped = hits.filter(h => h.escape && 'reason' in h.escape);
  const summary = 'TIMING_ASSERTIONS: found=' + open.length + ' escaped=' + escaped.length + ' files=' + added.size;
  for (const h of escaped) ctx.explain.push('timing: ' + h.file + ':' + h.line + ' ' + h.pattern + ' escaped: ' + (h.escape as { reason: string }).reason);
  if (!open.length) return { id: 'timing', stage: 'preflight', status: 'pass', inputs, lines: escaped.length ? [summary] : undefined, detail: 'no timing assertion in the added lines of ' + added.size + ' test file(s)' + (escaped.length ? ' (' + escaped.length + ' escaped with gstack-timing-ok)' : '') };
  const counts = (['wall-time-bound', 'cpu-time-bound', 'sleep-then-assert'] as const).map(p => [p, open.filter(h => h.pattern === p).length] as const).filter(([, c]) => c > 0);
  return {
    id: 'timing', stage: 'preflight', status: 'warn', inputs, code: 'PREGATE_TIMING_ASSERTION',
    lines: [...open.map(h => 'TIMING_ASSERTION: ' + h.file + ':' + h.line + ' ' + h.pattern + (h.escape ? ' (gstack-timing-ok needs a reason)' : '')), summary],
    detail: open.length + ' timing-dependent assertion(s) in added test lines (' + counts.map(([p, c]) => c + ' ' + p).join(', ') + ')' + (escaped.length ? '; ' + escaped.length + ' escaped' : ''),
    fix: 'assert on the outcome, an injected clock or a forced deadline instead of elapsed time or a fixed sleep; when the bound is the contract, add gstack-timing-ok: <reason> in a comment on the line or the line above (docs/pregate.md#timing)',
  };
}

export const timingCheck: CheckDef = { id: 'timing', stage: 'preflight', tier: 1, downgradable: true, needsRepoCommands: false, run };
