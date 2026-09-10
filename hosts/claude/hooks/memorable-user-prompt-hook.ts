#!/usr/bin/env bun
/**
 * memorable-user-prompt-hook — gstack-mediated bridge from Claude Code's
 * UserPromptSubmit event to the third-party `memorable` CLI (memorable.sh).
 *
 * The vendor's own installer registers `memorable hook user-prompt` directly.
 * Registering it THROUGH gstack instead buys the user what gstack gives every
 * other off-machine sink: an explicit consent key, a receipt per attempted
 * send, a secret pre-scan, a trust envelope around what comes back, healing
 * and clean removal. This file is that mediation.
 *
 *   stdin JSON -> cap 1 MiB -> parse -> MEMORABLE=0? -> gate memorable_recall == on?
 *      -> win32? -> trust policy (deny / read-only veto, by session cwd; fail-closed)
 *      -> HIGH-tier secret scan (raw bytes AND decoded string leaves, each admitted by the clock)
 *      -> resolve vendor -> budget >= 500 ms? -> gate re-check
 *      -> receipt (fail-closed: no receipt, no send)
 *      -> VENDOR SPAWN (own process group, allowlisted env, group-killed on timeout)
 *      -> parse vendor JSON -> additionalContext only -> control-strip
 *      -> 8 KiB cap (UTF-8 boundary) -> trust envelope -> stdout (awaited)
 *      -> outcome (bounded by the same clock) -> exit 0
 *   every REFUSAL above is: one rate-limited line in hook-errors.log, empty stdout, exit 0
 *   (gate off, MEMORABLE=0, empty or non-object stdin are silent: nothing was refused).
 *
 * CONTRACT
 *   - ALWAYS exits 0 with either one hookSpecificOutput JSON or nothing. The
 *     vendor can never block a prompt or speak as gstack: only a string
 *     `hookSpecificOutput.additionalContext` is accepted from its output.
 *   - One deadline clock (BUDGET_MS) undercuts Claude Code's 5 s hook kill;
 *     every stage, the two ledger writes and the secret scans included, gets
 *     min(cap, remaining). A receipt with no outcome means the host killed us
 *     or the clock ran out (reported as `unknown`), never success.
 *   - Fail-closed on the receipt: if the ledger cannot be written, recall is
 *     skipped for that prompt. What the receipt attests is the bytes handed to
 *     a LOCAL binary running with the user's privileges (host `local:<path>`);
 *     what that binary sends is the vendor's claim.
 *   - The vendor sees an allowlisted environment (PATH, HOME, locale, TMP,
 *     the standard proxy/TLS/XDG variables, MEMORABLE*), never Claude Code's
 *     full env (which can carry API keys).
 *   - The vendor's stderr reaches hook-errors.log only when the redaction
 *     engine finds no HIGH- or MEDIUM-tier shape in it (a CLI that echoes its
 *     input on a parse error would otherwise copy the prompt into the log).
 *     The log is chmod 0600 on every append (sibling hooks share the file).
 *   - If the host terminates the hook mid-flight (SIGTERM/SIGINT/SIGHUP,
 *     forwarded by the bash shim), the vendor's process group is killed on
 *     the way out; the receipt then stands with outcome `unknown`.
 *   - Windows is refused here (no process groups to contain the vendor);
 *     bin/gstack-memorable enable refuses there too. TODOS.md: Windows support (D21).
 *
 * Pure helpers are exported for unit tests; main() runs only under import.meta.main.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runBin, runExternal } from './spawn-bin';
import {
  LEDGER_WARN_BYTES, egressLedgerPath, ledgerSizeWarning, resolveEgressHome, sha256Hex, writeOutcome, writeReceipt,
} from '../../../lib/egress-receipt';
import { wrapUntrustedTrackerContent } from '../../../lib/tracker-guard';
import { scan } from '../../../lib/redact-engine';
import { hasRepoPolicyStore, repoPolicyTier } from '../../../lib/gbrain-repo-policy-client';

export const BUDGET_MS = 4500;
export const STDIN_CAP_BYTES = 1024 * 1024;
export const OUTPUT_CAP_BYTES = 8192;
/** Left on the clock for post-processing, the stdout write and one ledger append after the vendor. */
export const RESERVE_MS = 300;
/** Below this many ms left before the spawn, the vendor is not started at all. */
export const MIN_SPAWN_MS = 500;
/** Cap for each pre-spawn subprocess stage (stdin read, gate, git, policy); always min(cap, remaining). */
export const STAGE_CAP_MS = 1000;
/** Cap for the pre-spawn gate re-check. */
export const RECHECK_CAP_MS = 500;
/** Below this many ms left, the outcome append is skipped (the receipt stands, outcome reads as unknown). */
export const OUTCOME_MIN_MS = 80;
/** Kept back from the clock when an outcome append is given the rest of it. */
export const OUTCOME_RESERVE_MS = 50;
export const LOG_RATE_LIMIT_MS = 10 * 60 * 1000;
export const ENVELOPE_SOURCE = 'memorable recall (third-party)';
export const SINK = 'memorable-recall';
export const CONSENT = 'memorable_recall=on';
export const RESOLUTION_ORDER = 'GSTACK_MEMORABLE_BIN, MEMORABLE_BIN, ~/.memorable/bin/memorable, PATH';
/** Receipt payload class: a stable token (the prose lives in docs/memorable-workflow-memory.md), so a per-prompt sink does not repeat a sentence per line. */
export const PAYLOAD_CLASS = 'claude-user-prompt-json->local-vendor-cli';
const HOOK_NAME = 'memorable-user-prompt-hook';
/** Per-KiB allowance added to the scan admission check: ~1.5x the measured worst case of scan(). */
const SCAN_MS_PER_KIB = 1;
/** Distinct rate-limit keys remembered at once (the marker file is rewritten on every log line). */
const RATE_LIMIT_KEYS = 32;
/** Candidate objects tried by the tolerant stdout parser before giving up (bounds a hostile brace soup). */
const JSON_CANDIDATES = 64;
const GIT_MAX_BUFFER = 64 * 1024;
const TRUNCATION_MARKER = `[truncated by gstack at ${OUTPUT_CAP_BYTES / 1024} KiB]`;

/** Milliseconds left on a deadline that started at startMs. Pure; unit-tested. */
export function budgetFor(startMs: number, nowMs: number, cap: number = BUDGET_MS): number {
  return Math.max(0, startMs + cap - nowMs);
}

/** The deadline: BUDGET_MS, or a test-only override that can only shorten it. */
export function budgetMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.GSTACK_MEMORABLE_TEST_BUDGET_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, BUDGET_MS) : BUDGET_MS;
}

/** Truncate to maxBytes of UTF-8 without splitting a multibyte character. */
export function capUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--; // back off to a UTF-8 boundary
  return { text: buf.subarray(0, end).toString('utf8'), truncated: true };
}

// C0 controls minus tab (9) and newline (10), plus DEL. Carriage return (13)
// is stripped too: a CR can visually overwrite earlier text in a rendering of
// the injected context while staying one line for the envelope. Built from
// char codes so the source file itself carries no control bytes.
const cc = (n: number): string => String.fromCharCode(n);
const CONTROL_RE = new RegExp(`[${cc(0)}-${cc(8)}${cc(11)}-${cc(31)}${cc(127)}]`, 'g');
// Unicode format characters (bidi overrides, zero-width spaces, soft hyphens)
// hide text from a reader while the model still sees it; the envelope detects
// them but emits the original, so this sink strips them at egress. The
// zero-width joiner stays: emoji sequences need it.
const FORMAT_RE = /(?!\u200D)\p{Cf}/gu;

/** Strip control and format characters except newline, tab and ZWJ (the envelope handles the rest). */
export function stripControl(text: string): string {
  return text.replace(CONTROL_RE, '').replace(FORMAT_RE, '');
}

/**
 * Every string leaf of a parsed JSON value, bounded so a hostile payload
 * cannot monopolize the clock. `exhausted` is true when the bound cut the
 * walk short: the caller must then treat the payload as unscanned (and refuse
 * the hand-off), never as clean.
 */
export function stringLeavesBounded(value: unknown, maxNodes = 10_000, maxDepth = 32): { leaves: string[]; exhausted: boolean } {
  const leaves: string[] = [];
  let nodes = 0;
  let exhausted = false;
  const walk = (v: unknown, depth: number): void => {
    if (nodes++ > maxNodes || depth > maxDepth) { exhausted = true; return; }
    if (typeof v === 'string') { leaves.push(v); return; }
    if (Array.isArray(v)) { for (const item of v) walk(item, depth + 1); return; }
    if (v && typeof v === 'object') {
      // keys are forwarded bytes too; a credential can sit in one
      for (const [k, item] of Object.entries(v as Record<string, unknown>)) { leaves.push(k); walk(item, depth + 1); }
    }
  };
  walk(value, 0);
  return { leaves, exhausted };
}

/** The leaves alone (see stringLeavesBounded). */
export function stringLeaves(value: unknown, maxNodes = 10_000, maxDepth = 32): string[] {
  return stringLeavesBounded(value, maxNodes, maxDepth).leaves;
}

// Identity, locale and temp; the standard proxy, TLS and XDG knobs the vendor
// needs to reach its own service through the user's proxy or private CA (it
// already gets them from the user's shell); plus MEMORABLE* (its own knobs,
// matched by prefix below). Never API keys, never GSTACK_* or CLAUDE_*.
const ENV_ALLOW = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'TERM', 'TMPDIR', 'TEMP', 'TMP',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
]);

/** The vendor's environment: an allowlist, never Claude Code's full env. */
export function vendorEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    if (ENV_ALLOW.has(k) || k.startsWith('LC_') || k.startsWith('MEMORABLE')) out[k] = v;
  }
  return out;
}

/** Index of the `}` closing the object that opens at `start`, or -1 when it never closes. */
function balancedObjectEnd(raw: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i;
  }
  return -1;
}

/**
 * Every complete top-level JSON object in `raw`, in order (at most
 * JSON_CANDIDATES attempts). A vendor whose background helper logs a line to
 * the inherited stdout after the answer, or prints a banner before it (even
 * one with braces in it), must not cost the user the answer. Whole-input JSON
 * is the normal case and is yielded alone.
 */
export function* jsonObjects(raw: string): Generator<unknown> {
  try { yield JSON.parse(raw); return; } catch { /* fall through to the scan */ }
  let start = raw.indexOf('{');
  for (let tries = 0; start >= 0 && tries < JSON_CANDIDATES; tries++) {
    const end = balancedObjectEnd(raw, start);
    let parsed: unknown;
    let ok = false;
    // An unbalanced candidate (a lone brace in a banner) is skipped like an
    // unparsable one: the complete object after it must still be found.
    if (end >= 0) { try { parsed = JSON.parse(raw.slice(start, end + 1)); ok = true; } catch { /* a brace in prose */ } }
    if (ok) { yield parsed; start = raw.indexOf('{', end + 1); }
    else start = raw.indexOf('{', start + 1);
  }
}

/** The first complete top-level JSON object in `raw`, or null. */
export function firstJsonObject(raw: string): unknown {
  for (const obj of jsonObjects(raw)) return obj;
  return null;
}

/** Only a string hookSpecificOutput.additionalContext survives; decision/continue/systemMessage are dropped. */
export function pickAdditionalContext(raw: string): string | null {
  for (const parsed of jsonObjects(raw)) {
    const hso = (parsed as { hookSpecificOutput?: { additionalContext?: unknown } } | null)?.hookSpecificOutput;
    const ctx = hso?.additionalContext;
    if (typeof ctx === 'string' && ctx.length > 0) return ctx;
  }
  return null;
}

/** Cap + envelope: the text Claude will see. */
export function renderContext(vendorText: string): string {
  const { text, truncated } = capUtf8(stripControl(vendorText), OUTPUT_CAP_BYTES);
  const body = truncated ? `${text}\n${TRUNCATION_MARKER}` : text;
  return wrapUntrustedTrackerContent(body, ENVELOPE_SOURCE);
}

/**
 * The vendor's stderr tail as it may appear in hook-errors.log: control-stripped,
 * whitespace-collapsed, last 300 chars, and WITHHELD when the redaction engine
 * finds a HIGH or MEDIUM shape in it (a CLI that echoes its input on a parse
 * error would otherwise copy prompt text into a log the pre-scan only cleared
 * of HIGH-tier shapes).
 */
export function safeStderrTail(tail: string): string {
  // Scan everything runExternal kept, THEN crop for the log: cropping first
  // could cut a credential's identifying prefix off and log its secret half.
  const whole = stripControl(tail).replace(/\s+/g, ' ').trim();
  if (!whole) return '';
  const r = scan(whole, { repoVisibility: 'unknown' });
  const n = r.counts.HIGH + r.counts.MEDIUM;
  return r.oversize || n > 0 ? `[stderr withheld: ${n} redaction finding(s)]` : whole.slice(-300);
}

function stripQuotes(v: string): string {
  return v.trim().replace(/^"(.*)"$/, '$1');
}

function executable(p: string): boolean {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32') fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * GSTACK_MEMORABLE_BIN -> MEMORABLE_BIN -> ~/.memorable/bin/memorable -> PATH.
 * An explicit override that does not resolve is an error (null), never a
 * fall-through to something else (lib/claude-bin.ts contract).
 */
export function resolveVendor(env: Record<string, string | undefined>, homeDir: string): string | null {
  // Empty means unset, exactly as bash's ${GSTACK_MEMORABLE_BIN:-${MEMORABLE_BIN:-}} reads it
  // in bin/gstack-memorable: the binary enable checked is the binary the hook runs.
  const override = (env.GSTACK_MEMORABLE_BIN ?? '').trim() || (env.MEMORABLE_BIN ?? '').trim();
  if (override) {
    const o = stripQuotes(override);
    const resolved = path.isAbsolute(o) ? o : (Bun.which(o) ?? null);
    return resolved && executable(resolved) ? resolved : null;
  }
  const pinned = path.join(homeDir, '.memorable', 'bin', 'memorable');
  if (executable(pinned)) return pinned;
  const onPath = Bun.which('memorable');
  return onPath && executable(onPath) ? onPath : null;
}

function stateRoot(): string {
  return process.env.GSTACK_STATE_ROOT || process.env.GSTACK_HOME || process.env.GSTACK_STATE_DIR
    || path.join(os.homedir(), '.gstack');
}

/**
 * Best-effort, rate-limited: a message with the same `key` (default: the
 * message itself) within LOG_RATE_LIMIT_MS is not re-logged, so a vendor that
 * fails on every prompt with a different timestamp in its stderr still costs
 * one line per ten minutes, and two alternating failures cost two. The marker
 * (up to RATE_LIMIT_KEYS live `digest:ts` lines) is per hook so hooks never
 * contend. The log is chmod 0600 on every append: sibling hooks create the
 * same file without a mode, and it can name the session's cwd and vendor
 * diagnostics.
 */
export function logHookError(msg: string, nowMs: number = Date.now(), key: string = msg): void {
  try {
    const root = stateRoot();
    fs.mkdirSync(root, { recursive: true });
    const marker = path.join(root, `hook-errors.${HOOK_NAME}.last`);
    const digest = sha256Hex(key).slice(0, 16);
    const live: string[] = [];
    try {
      for (const line of fs.readFileSync(marker, 'utf8').split('\n')) {
        const [d, ts] = line.trim().split(':');
        if (!d || !ts || nowMs - Number(ts) >= LOG_RATE_LIMIT_MS) continue;
        if (d === digest) return;
        live.push(line.trim());
      }
    } catch { /* no marker yet */ }
    live.push(`${digest}:${nowMs}`);
    fs.writeFileSync(marker, `${live.slice(-RATE_LIMIT_KEYS).join('\n')}\n`, { mode: 0o600 });
    const log = path.join(root, 'hook-errors.log');
    fs.appendFileSync(log, `${new Date(nowMs).toISOString()} ${HOOK_NAME}: ${msg}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') { try { fs.chmodSync(log, 0o600); } catch { /* not ours to tighten */ } }
  } catch {
    // best-effort; never block the session because logging failed
  }
}

function readStdin(maxBytes: number, timeoutMs: number): Promise<{ buf: Buffer; oversize: boolean; timedOut: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    let oversize = false;
    const finish = (timedOut: boolean): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { process.stdin.destroy(); } catch { /* already closed */ }
      resolve({ buf: Buffer.concat(chunks), oversize, timedOut });
    };
    const timer = setTimeout(() => finish(true), Math.max(1, timeoutMs));
    process.stdin.on('data', (d: Buffer | string) => {
      if (done) return;
      const chunk = typeof d === 'string' ? Buffer.from(d, 'utf8') : d;
      total += chunk.length;
      if (total > maxBytes) { oversize = true; finish(false); return; }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => finish(false));
    process.stdin.on('error', () => finish(false));
  });
}

function gateIsOn(timeoutMs: number): 'on' | 'off' | 'error' {
  const r = runBin('gstack-config', ['get', 'memorable_recall'], { encoding: 'utf8', timeout: Math.max(1, timeoutMs), env: process.env });
  if (r.status !== 0) return 'error';
  return String(r.stdout ?? '').trim() === 'on' ? 'on' : 'off';
}

/**
 * git exit 2 = no such remote; exit 128 whose message STARTS with this text
 * (git is run with LC_ALL=C so the text is English) = not inside a repository.
 * Anchored, never a substring test: other exit-128 messages echo the
 * repository path, which a directory name could make carry the phrase.
 */
const GIT_NO_REMOTE = 2;
const GIT_FATAL = 128;
const NOT_A_REPO_RE = /^fatal: not a git repository\b/;

/** Kills the in-flight detached child (git for the policy lookup, then the vendor); read by the signal handlers. */
let killInflight: (() => void) | null = null;

/**
 * git's environment for the policy lookup: English messages, and NO inherited
 * GIT_* repository selectors (GIT_DIR, GIT_WORK_TREE, GIT_COMMON_DIR,
 * GIT_CONFIG_*, ...): cwd does not override them, so an inherited GIT_DIR
 * would make the veto inspect a different repository than the one the
 * session works in. Exported for tests.
 */
export function gitEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v == null || k.startsWith('GIT_')) continue;
    out[k] = v;
  }
  out.LC_ALL = 'C'; out.LANGUAGE = ''; out.LC_MESSAGES = 'C';
  return out;
}

/**
 * Trust-policy veto by the session's repo (keyed by its origin remote).
 * Every half fails CLOSED once a store exists: a git that could not run or
 * answer in time, a git that could not read the repository (corrupt or
 * unreadable config, dubious ownership: exit 128 without "not a git
 * repository"), or a store that could not be read is a failed lookup
 * (`error`), never "no remote". Only "no such remote" and "not a repository"
 * mean nothing can be set for this directory.
 */
async function policyVeto(cwd: string, timeoutMs: number, remaining: () => number): Promise<'ok' | 'skip' | 'error'> {
  if (!hasRepoPolicyStore()) return 'ok';
  const git = await runExternal('git', ['remote', 'get-url', 'origin'], {
    cwd, timeoutMs: Math.max(1, timeoutMs), maxBuffer: GIT_MAX_BUFFER, env: gitEnv(process.env),
    onSpawn: (kill) => { killInflight = kill; }, // a host cancellation must not leak this git either
  });
  killInflight = null;
  if (git.timedOut || git.error) return 'error';
  if (git.status === GIT_NO_REMOTE) return 'ok';
  if (git.status === GIT_FATAL && NOT_A_REPO_RE.test(git.stderrTail.trim())) return 'ok';
  if (git.status !== 0) return 'error';
  const url = git.stdout.toString('utf8').trim();
  if (!url) return 'ok';
  const res = repoPolicyTier(url, process.env, Math.max(1, Math.min(STAGE_CAP_MS, remaining())));
  if (res.error) return 'error';
  // `deny` and `read-only` are the tiers a user picks so a repo's content
  // never lands in a shared store; a third-party memory service is one.
  return res.tier === 'deny' || res.tier === 'read-only' ? 'skip' : 'ok';
}

function writeStdout(text: string): Promise<void> {
  return new Promise((resolve) => { process.stdout.write(text, () => resolve()); });
}


/** Best-effort: the ledger's size warning goes to stderr, which the host discards for an exit-0 hook; log it where `status` looks. */
function noteLedgerSize(): void {
  try {
    const ledger = egressLedgerPath(resolveEgressHome());
    const size = fs.statSync(ledger).size;
    if (size > LEDGER_WARN_BYTES) logHookError(ledgerSizeWarning(ledger, size).replace(/\s+/g, ' ').trim(), Date.now(), 'ledger-size');
  } catch { /* no ledger yet */ }
}

export async function main(): Promise<void> {
  const start = Date.now();
  const cap = budgetMs();
  const remaining = (): number => budgetFor(start, Date.now(), cap);

  const stdin = await readStdin(STDIN_CAP_BYTES, Math.min(STAGE_CAP_MS, remaining()));
  if (stdin.oversize) { logHookError(`oversize: stdin exceeded ${STDIN_CAP_BYTES / (1024 * 1024)} MiB, recall skipped`); return; }
  const raw = stdin.buf;
  if (raw.length === 0) return;
  const rawText = raw.toString('utf8');
  let payload: unknown;
  try { payload = JSON.parse(rawText); } catch {
    logHookError(stdin.timedOut
      ? 'stdin was not closed within the read budget (incomplete JSON), recall skipped'
      : 'stdin was not JSON, recall skipped');
    return;
  }
  if (!payload || typeof payload !== 'object') return;

  if (process.env.MEMORABLE === '0') return; // the vendor's own kill switch

  const gate = gateIsOn(Math.min(STAGE_CAP_MS, remaining()));
  if (gate === 'error') { logHookError('gstack-config get memorable_recall failed, recall skipped (fail-closed)'); return; }
  if (gate !== 'on') return;

  if (process.platform === 'win32') { logHookError('Windows is not supported by this bridge yet (TODOS.md D21), recall skipped'); return; }

  const payloadCwd = (payload as { cwd?: unknown }).cwd;
  const cwd = typeof payloadCwd === 'string' && isDirectory(payloadCwd) ? payloadCwd : process.cwd();
  const veto = await policyVeto(cwd, Math.min(STAGE_CAP_MS, remaining()), remaining);
  if (veto === 'skip') { logHookError(`trust policy for ${cwd} is deny or read-only, recall skipped`, Date.now(), 'trust policy skip'); return; }
  if (veto === 'error') { logHookError('trust policy lookup failed (store or repository unreadable), recall skipped (fail-closed)'); return; }

  // HIGH-tier pre-scan over the raw text and the decoded string leaves (a JSON
  // escape must not hide a key). scan() is synchronous and uninterruptible and
  // its cost is roughly linear in bytes, so each scan is admitted by the clock
  // with a size-derived allowance: a scan we cannot afford skips recall
  // instead of letting the host kill us mid-scan.
  const walked = stringLeavesBounded(payload);
  if (walked.exhausted) {
    // A payload too deep or too wide to walk is unscanned, not clean.
    logHookError('refused:payload-too-complex: the prompt JSON exceeded the scan walk bounds, nothing handed to the vendor');
    return;
  }
  const leaves = walked.leaves.join('\n');
  for (const text of [rawText, leaves]) {
    const allowance = MIN_SPAWN_MS + Math.ceil(Buffer.byteLength(text, 'utf8') / 1024) * SCAN_MS_PER_KIB;
    if (remaining() < allowance) { logHookError('budget-exhausted before the secret scan, recall skipped'); return; }
    const result = scan(text, { repoVisibility: 'unknown' });
    if (result.oversize || result.counts.HIGH > 0) {
      logHookError('refused:redaction-high: the prompt carries a HIGH-tier credential shape, nothing handed to the vendor');
      return;
    }
  }

  const vendor = resolveVendor(process.env, os.homedir());
  if (!vendor) { logHookError(`memorable CLI not found (checked ${RESOLUTION_ORDER}), recall skipped`); return; }

  if (remaining() < MIN_SPAWN_MS) { logHookError('budget-exhausted before the vendor spawn, recall skipped'); return; }
  const again = gateIsOn(Math.min(RECHECK_CAP_MS, remaining()));
  if (again === 'error') { logHookError('gstack-config get memorable_recall failed on the pre-spawn re-check, recall skipped (fail-closed)'); return; }
  if (again !== 'on') return; // a disable that landed while we worked wins

  let receiptId: string;
  try {
    const { id } = writeReceipt({
      sink: SINK,
      host: `local:${vendor}`,
      payloadClass: PAYLOAD_CLASS,
      bytes: raw.length,
      sha256: sha256Hex(raw),
      consent: CONSENT,
      lockBudgetMs: Math.max(0, remaining() - RESERVE_MS),
    });
    receiptId = id;
    noteLedgerSize();
  } catch (err) {
    // fail-closed: no receipt, no send
    const why = err instanceof Error ? err.message : String(err);
    logHookError(`refused:receipt-unwritable: ${why}`);
    process.stderr.write(`gstack: memorable recall skipped, the egress receipt could not be written (${why}). See gstack-egress.\n`);
    return;
  }
  if (remaining() < MIN_SPAWN_MS) {
    logHookError('budget-exhausted after the receipt, recall skipped');
    try { writeOutcome({ receipt: receiptId, status: 'budget-exhausted', lockBudgetMs: Math.max(0, remaining() - OUTCOME_RESERVE_MS) }); } catch { /* bookkeeping */ }
    return;
  }

  const gstackMs = Date.now() - start;
  // VENDOR SPAWN: everything above is gstack's own boundary; from here the bytes are the vendor's.
  const r = await runExternal(vendor, ['hook', 'user-prompt'], {
    input: raw,
    timeoutMs: Math.max(1, remaining() - RESERVE_MS),
    maxBuffer: 1024 * 1024,
    env: vendorEnv(process.env),
    cwd,
    onSpawn: (kill) => { killInflight = kill; },
  });
  killInflight = null;

  let status: string;
  let delivered = false;
  if (r.timedOut) status = 'timeout';
  else if (r.error) status = `spawn-error:${r.error}`;
  else if (r.status !== 0) status = `exit:${r.status} injected=no`;
  else {
    const ctx = pickAdditionalContext(r.stdout.toString('utf8'));
    if (!ctx) status = 'exit:0 injected=no';
    else {
      const rendered = renderContext(ctx);
      const out = JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: rendered } });
      await writeStdout(out);
      delivered = true;
      status = `exit:0 output-written bytes=${Buffer.byteLength(rendered, 'utf8')} gstack_ms=${gstackMs}`;
    }
  }
  // A vendor that exited before reading its stdin (EPIPE) is advisory when it
  // still answered; the outcome records it, the answer is kept.
  if (r.stdinError) status += ` stdin=${r.stdinError}`;
  if (!delivered && (r.timedOut || r.error || r.status !== 0)) {
    // Logged whether or not the vendor said anything: a silently hanging
    // vendor taxes every prompt and must show up in `gstack-memorable status`.
    const tail = safeStderrTail(r.stderrTail);
    logHookError(`vendor ${status}${tail ? `: ${tail}` : ''}`, Date.now(), `vendor ${status}`);
  }
  // The vendor's timeout already left RESERVE_MS on the clock for exactly
  // this: the stdout write above and one bounded ledger append.
  if (remaining() > OUTCOME_MIN_MS) {
    try { writeOutcome({ receipt: receiptId, status, lockBudgetMs: Math.max(0, remaining() - OUTCOME_RESERVE_MS) }); } catch { /* the receipt is the invariant; the outcome is bookkeeping */ }
  }
}

if (import.meta.main) {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(sig, () => {
      // The host is ending us (its 5 s hook kill, or a session teardown): the
      // vendor must not outlive the hook that spawned it.
      if (killInflight) { killInflight(); killInflight = null; }
      logHookError(`terminated by ${sig} mid-flight; the vendor process group was killed, the receipt (if any) reads unknown`, Date.now(), 'terminated');
      process.exit(0);
    });
  }
  main()
    .catch((err) => logHookError(`unexpected: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`))
    .finally(() => { process.exitCode = 0; });
}
