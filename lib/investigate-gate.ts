/**
 * investigate-gate — shared logic for /investigate's opt-in reproduce-first gate
 * (GST-938 plan v3). One copy of every rule, read by three consumers:
 *   - hosts/claude/hooks/investigate-gate.ts (the Claude Code hook; enforces)
 *   - bin/gstack-investigate-step (the record-only helper the model calls)
 *   - scripts/investigate-gate/{recorder,score}.ts (eval recorder and scorer;
 *     observe only, identical in every arm)
 * "Source" is a git-tracked file outside test paths. Untracked files (repro
 * scripts, scratch) are never source. Change is measured against a baseline
 * fingerprint captured when the investigation opens, so a dirty worktree at
 * start is the baseline, never a block. The gate is off unless the config key
 * `investigate_gates` is `true` (or GSTACK_INVESTIGATE_GATES=1).
 */
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readConfigKey, resolveStateRoot } from './state-root';

export const GATE_SCHEMA = 1;
export const HELPER = 'gstack-investigate-step';
export const TEST_PATH_RE = /(^|\/)(test|tests|__tests__)\/|(^|\/)[^/]*_test\.[^/]+$|(^|\/)test_[^/]*\.py$|\.(test|spec)\.[^/]+$/;
export const FAILURE_MARKER_RE = /(^|\s)(FAIL|FAILED|FAILURES|ERRORS?)(\s|:|$)|\b\d+ (failed|failing|errors?)\b|Traceback \(most recent call last\)|AssertionError|panicked at|^not ok\b/m;
const READ_ONLY = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'find', 'pwd', 'echo', 'printf', 'wc', 'less', 'more', 'file', 'stat', 'which', 'type', 'tree', 'du', 'df', 'date', 'sort', 'uniq', 'cut', 'diff', 'awk', 'sed', 'jq', 'env', 'whoami', 'uname', 'realpath', 'dirname', 'basename', 'cd']);
const TRIVIAL = new Set(['true', 'false', ':', 'exit', 'return', 'test', '[', '[[', 'sleep']);
const GIT_READ = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame', 'grep', 'remote', 'describe']);
const FORMATTER_RE = /\b(prettier\b.*--write|black\b|gofmt\b.*-w|rustfmt\b|eslint\b.*--fix|ruff\b.*(--fix|\bformat\b)|autopep8\b.*-i|clang-format\b.*-i|isort\b)/;
const INLINE_WRITE_RE = /open\([^)]*['"][wa]\+?b?['"]|\.write_text\(|\.write_bytes\(|writeFileSync\(|fs\.writeFile\(|Bun\.write\(/;

export type Fingerprint = Record<string, string>;

export interface Run {
  ts: string;
  command: string;
  exit: number | null;
  background: boolean;
  tail: string;
  delta: string[];
}

export interface Investigation {
  id: number;
  opened_at: string;
  baseline: Fingerprint;
  runs: Run[];
  hypothesis?: { claim: string; ts: string; bound_run?: number; no_repro?: string };
  bypasses: Array<{ ts: string; kind: 'bash-edit' | 'report-unbound'; detail: string }>;
  denials: number;
  closed_at?: string;
}

export interface SessionState {
  schema: number;
  session: string;
  top: string;
  investigations: Investigation[];
}

export function gatesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.GSTACK_INVESTIGATE_GATES === '1') return true;
  if (env.GSTACK_INVESTIGATE_GATES === '0') return false;
  return readConfigKey('investigate_gates', env) === 'true';
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

export function repoTop(cwd: string): string | null {
  const out = git(cwd, ['rev-parse', '--show-toplevel']);
  return out ? out.trim() : null;
}

export function isTestPath(rel: string): boolean {
  return TEST_PATH_RE.test(rel.split(path.sep).join('/'));
}

/** Tracked non-test files that differ from HEAD (or are staged), each with a content hash. */
export function sourceFingerprint(top: string): Fingerprint {
  const listed = git(top, ['diff', '--name-only', '-z', 'HEAD']) ?? git(top, ['ls-files', '-m', '-z']) ?? '';
  const fp: Fingerprint = {};
  for (const rel of listed.split('\0').filter(Boolean)) {
    if (isTestPath(rel)) continue;
    try {
      fp[rel] = createHash('sha256').update(fs.readFileSync(path.join(top, rel))).digest('hex').slice(0, 16);
    } catch {
      fp[rel] = 'deleted';
    }
  }
  return fp;
}

export function fingerprintDelta(baseline: Fingerprint, current: Fingerprint): string[] {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  return [...keys].filter((k) => baseline[k] !== current[k]).sort();
}

export function isTrackedSource(top: string, cwd: string, file: string): boolean {
  const abs = path.resolve(cwd, file);
  const rel = path.relative(top, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || isTestPath(rel)) return false;
  const out = git(top, ['ls-files', '--', rel]);
  return !!out && out.trim().length > 0;
}

/** Split a shell command into simple segments on &&, ||, ;, |, & and newlines, outside quotes. */
export function splitSegments(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') { cur += c + (command[i + 1] ?? ''); i++; continue; }
      cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === '\\') { cur += c + (command[i + 1] ?? ''); i++; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (c === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) { cur += c; continue; }
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      if ((c === '|' || c === '&') && command[i + 1] === c) i++;
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function tokens(segment: string): string[] {
  return (segment.match(/'[^']*'|"(?:\\.|[^"])*"|\S+/g) ?? []).map((t) => t.replace(/^['"]|['"]$/g, ''));
}

function commandWords(segment: string): string[] {
  const t = tokens(segment);
  let i = 0;
  while (i < t.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t[i]) || t[i] === 'sudo' || t[i] === 'time' || t[i] === 'command' || t[i] === 'nice')) i++;
  if (t[i] === 'timeout') { i++; while (i < t.length && (t[i].startsWith('-') || /^\d/.test(t[i]))) i++; }
  return t.slice(i);
}

export function isHelperSegment(segment: string): boolean {
  const w = commandWords(segment)[0] ?? '';
  return path.basename(w) === HELPER;
}

function isReadOnlySegment(segment: string): boolean {
  const w = commandWords(segment);
  const head = path.basename(w[0] ?? '');
  if (head === 'git') return GIT_READ.has(w[1] ?? '');
  if (head === 'sed') return !w.some((x) => /^-[a-zA-Z]*i/.test(x) || x === '--in-place');
  if (head === 'find') return !w.some((x) => x === '-delete' || x === '-exec' || x === '-execdir');
  return READ_ONLY.has(head) && !/(^|[^>&0-9])>{1,2}\s*[^&\s]/.test(segment.replace(/>\s*\/dev\/null|2>&1/g, ''));
}

/** Helper calls, read-only lookups and trivial builtins: never a repro, never a test. */
export function isNonQualifyingCommand(command: string): boolean {
  const segs = splitSegments(command);
  if (segs.length === 0) return true;
  return segs.every((s) => isHelperSegment(s) || isReadOnlySegment(s) || TRIVIAL.has(path.basename(commandWords(s)[0] ?? '')));
}

export function isBackground(command: string, runInBackground?: boolean): boolean {
  return runInBackground === true || /(^|[^&])&\s*$/.test(command.trim());
}

/** Exit status that cannot be trusted: a pipe without pipefail, or a trailing || true / ; echo $? / ; true. */
export function exitMasked(command: string): boolean {
  if (/\|\|\s*(true|:)\s*$|;\s*(echo\s+["']?\$\?["']?|true|:)\s*$/.test(command.trim())) return true;
  return /[^|]\|[^|]/.test(command) && !/pipefail/.test(command);
}

/** A run that shows the bug failing: not background, not command-not-found, not a lookup, and a non-zero exit or a failure marker. */
export function qualifiesAsFailingRun(run: Pick<Run, 'command' | 'exit' | 'background' | 'tail'>): boolean {
  if (run.background || run.exit === null || run.exit === 126 || run.exit === 127) return false;
  if (isNonQualifyingCommand(run.command)) return false;
  return run.exit !== 0 || FAILURE_MARKER_RE.test(run.tail);
}

/** A run that shows the fix passing: exit 0, no failure marker, exit status not masked. */
export function qualifiesAsPassingRun(run: Pick<Run, 'command' | 'exit' | 'background' | 'tail'>): boolean {
  if (run.background || run.exit !== 0 || exitMasked(run.command) || isNonQualifyingCommand(run.command)) return false;
  return !FAILURE_MARKER_RE.test(run.tail);
}

export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

/** Test targets a repro names: paths, pytest node ids and file names with a code extension. */
export function testTargets(command: string): string[] {
  return tokens(command).filter((t) => /::|\.(py|ts|tsx|js|jsx|mjs|go|rs|rb|java|kt|php|c|cc|cpp)$|\//.test(t) && !t.startsWith('-'));
}

/** The fix run pairs with the repro when it is the same command or names one of the repro's test targets. */
export function pairsWithRepro(repro: string, later: string): boolean {
  if (normalizeCommand(repro) === normalizeCommand(later)) return true;
  const targets = testTargets(repro);
  const laterTokens = new Set(tokens(later));
  return targets.some((t) => laterTokens.has(t) || [...laterTokens].some((l) => l.startsWith(t.split('::')[0]) && t.startsWith(l)));
}

/** Why a Bash command would write tracked source, or null. Best effort; the post-run delta is authoritative. */
export function bashSourceWrite(command: string, isSource: (file: string) => boolean): string | null {
  if (/\bgit\s+(apply|am|stash\s+pop|cherry-pick)\b/.test(command)) return 'git apply';
  if (/(^|[\s;&|])patch(\s|$)/.test(command)) return 'patch';
  for (const seg of splitSegments(command)) {
    const w = commandWords(seg);
    const head = path.basename(w[0] ?? '');
    const args = w.slice(1).filter((x) => !x.startsWith('-'));
    const named = args.find((a) => isSource(a));
    if ((head === 'sed' && w.some((x) => /^-[a-zA-Z]*i/.test(x) || x === '--in-place')) || (head === 'perl' && w.some((x) => /^-[a-zA-Z]*i/.test(x)))) {
      if (named) return `${head} -i ${named}`;
    }
    if ((head === 'cp' || head === 'mv' || head === 'install') && args.length >= 2 && isSource(args[args.length - 1])) return `${head} onto ${args[args.length - 1]}`;
    if (head === 'tee' && named) return `tee ${named}`;
    if (head === 'git' && (w[1] === 'checkout' || w[1] === 'restore') && named) return `git ${w[1]} ${named}`;
    if (FORMATTER_RE.test(seg) && named) return `formatter on ${named}`;
    for (const m of seg.matchAll(/(?:^|[^>&0-9])>{1,2}\s*([^\s&;|]+)/g)) {
      if (m[1] !== '/dev/null' && isSource(m[1])) return `redirect onto ${m[1]}`;
    }
    if (INLINE_WRITE_RE.test(seg)) {
      const quoted = [...seg.matchAll(/['"]([^'"\s]+)['"]/g)].map((m) => m[1]).find((p) => isSource(p));
      if (quoted) return `inline write to ${quoted}`;
    }
  }
  return null;
}

/** Exit status from a native Bash hook payload: 0 on PostToolUse, the "Exit code N" line on PostToolUseFailure. */
export function exitFromPayload(event: string, payload: { error?: unknown; is_interrupt?: unknown }): number | null {
  if (event === 'PostToolUse') return 0;
  if (payload.is_interrupt === true) return null;
  const m = /^Exit code (\d+)/.exec(String(payload.error ?? ''));
  return m ? Number(m[1]) : null;
}

export function outputTail(event: string, payload: { tool_response?: unknown; error?: unknown }, lines = 20): string {
  let text = '';
  if (event === 'PostToolUseFailure') text = String(payload.error ?? '');
  else if (payload.tool_response && typeof payload.tool_response === 'object') {
    const r = payload.tool_response as { stdout?: unknown; stderr?: unknown };
    text = `${String(r.stdout ?? '')}\n${String(r.stderr ?? '')}`;
  } else text = String(payload.tool_response ?? '');
  return redact(text.split('\n').filter((l) => l.trim()).slice(-lines).join('\n'));
}

export function redact(text: string): string {
  return text
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{12,}/g, '[redacted]')
    .replace(/\b([A-Z][A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD))=\S+/g, '$1=[redacted]');
}

export function statePath(top: string, session: string, env: NodeJS.ProcessEnv = process.env): string {
  const host = os.hostname().replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'host';
  const repo = createHash('sha256').update(top).digest('hex').slice(0, 12);
  const safe = session.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
  return path.join(resolveStateRoot(env), 'investigate', `${host}-${repo}`, `${safe}.json`);
}

export function openInvestigation(state: SessionState, now: string): Investigation {
  const inv: Investigation = { id: state.investigations.length + 1, opened_at: now, baseline: sourceFingerprint(state.top), runs: [], bypasses: [], denials: 0 };
  state.investigations.push(inv);
  return inv;
}

export function currentInvestigation(state: SessionState): Investigation | undefined {
  const last = state.investigations[state.investigations.length - 1];
  return last && !last.closed_at ? last : undefined;
}

export function unlocked(inv: Investigation | undefined): boolean {
  return !inv || !!inv.hypothesis;
}

/** Most recent qualifying failing run since open, skipping lookups and helper calls; it must have run with no source change. */
export function bindableRun(inv: Investigation): { index: number; run: Run } | { error: string } {
  for (let i = inv.runs.length - 1; i >= 0; i--) {
    const run = inv.runs[i];
    if (isNonQualifyingCommand(run.command)) continue;
    if (!qualifiesAsFailingRun(run)) continue;
    if (run.delta.length > 0) return { error: `the latest failing run (${run.command}) ran after source changed (${run.delta.join(', ')}); reproduce on unchanged source first` };
    return { index: i, run };
  }
  return { error: 'no failing run recorded since this investigation opened; run a command that shows the bug failing (exit non-zero, no pipe or || true, not in the background), then bind it' };
}

export function missingSteps(inv: Investigation | undefined): string[] {
  if (!inv) return [];
  return inv.hypothesis ? [] : [`bind a reproduction: ${HELPER} hypothesis "<claim>" --repro-last (or --no-repro "<why this bug cannot fail on demand>")`];
}

export function denyReason(file: string): string {
  return [
    `[investigate gate] ${file} is tracked source and no reproduction is bound yet.`,
    `1. Run a command that shows the bug failing (a test or script; exit non-zero; no pipe, || true or background).`,
    `2. ~/.claude/skills/gstack/bin/${HELPER} hypothesis "<one-sentence root-cause claim>" --repro-last`,
    `If this bug cannot fail on demand (flaky, race, prod-only, UI, perf): ${HELPER} hypothesis "<claim>" --no-repro "<why>" (logged).`,
    `New files and test files are always allowed.`,
  ].join('\n');
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Read-modify-write the session state under an exclusive lock; atomic temp+rename, mode 0600. */
export function withState<T>(file: string, top: string, session: string, fn: (state: SessionState) => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + 3000;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lock, 'wx', 0o600);
    } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 10_000) fs.unlinkSync(lock); } catch { /* raced */ }
      if (Date.now() > deadline) throw new Error(`state lock busy: ${lock}`);
      sleepMs(25);
    }
  }
  try {
    let state: SessionState;
    try {
      state = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionState;
      if (state.schema !== GATE_SCHEMA || !Array.isArray(state.investigations)) throw new Error('schema');
    } catch {
      state = { schema: GATE_SCHEMA, session, top, investigations: [] };
    }
    const result = fn(state);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return result;
  } finally {
    fs.closeSync(fd);
    try { fs.unlinkSync(lock); } catch { /* gone */ }
  }
}
