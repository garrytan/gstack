/**
 * The five no-stop defaults (GSTA-258 plan K1, docs/review-policy.md#no-stop): routine stops /ship and
 * /autoplan record in the receipt's `no_stop` field and go on past instead of waiting for a Captain.
 * Each class has one deterministic test here; anything that fails it, and any stop outside the five,
 * still stops for the owner.
 *
 * - scoped-fix-check: one scoped fix-check past R51's two-round cap when the round-2 fix is docs-only
 *   (docs class, lib/review-depth.ts classifyPath) or timeout-only. One per branch.
 * - test-timeout-fix: a fix whose every changed line, all in test files, only raises a timeout value.
 * - pregate-flake-rerun: one rerun of a failed pregate case at the same tree (CREW rule 16). One per branch.
 * - stamp-only-carry: a refused receipt carry whose changes since the receipt head are version stamps only.
 * - autoplan-regate: a later autoplan gate revision whose plan delta names no spend, cap, arm or verdict
 *   (lib/autoplan-carry.ts asks regateTouches before it carries).
 *
 * The ledger is a JSON array of {class, reason, evidence} under the checkout's git dir, one file per
 * branch, so `gstack-ship-receipt write --no-stop @<ledger>` takes it as it stands.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { branchKey } from './approval-record';
import { NO_STOP_CLASSES, type NoStopClass } from './headless-artifacts';
import { classifyPath } from './review-depth';

export interface NoStopRecord { class: NoStopClass; reason: string; evidence: string }
export type NoStopVerdict = { ok: true; record: NoStopRecord; detail: string } | { ok: false; reason: string };

export interface FileDiff { path: string; pairs: Array<[string, string]>; added: string[]; removed: string[]; whole: boolean; inHunk?: boolean }

/** A number that is a timeout's value: after a timeout key (`timeout: 5`, `timeoutMs = 5`, `setDefaultTimeout(5)`, `--timeout=5`) or bun's and jest's trailing per-test argument (`}, 30_000);`). */
const TIMEOUT_VALUE = /(\b[a-z]*timeout\w*\s*(?::|=|\()\s*|--timeout[= ]|\}\s*,\s*)(\d[\d_]*)/gi;
const ASSERTION = /\b(?:expect|assert\w*)\b|\s[<>]=?\s/;
const VERSION = /\d+\.\d+\.\d+(?:\.\d+)?/g;
const TEST_PATH = /(?:^|\/)(?:test|tests|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const STAMP_PATHS = ['VERSION', 'package.json', 'CHANGELOG.md', 'agents-digest/gstack-AGENTS.md'];
/** Plan-delta words that mean spend, a cap, an eval arm or a verdict changed: those re-gates go to the owner. */
export const REGATE_WORDS = /\$|\b(?:spend|spending|spent|costs?|budgets?|prices?|caps?|capped|credits?|limits?|max|maximum|arms?|models?|judges?|verdicts?|thresholds?|bars?|pass(?:es)? at|trials?|samples?|stop rules?|kill rules?)\b|\bn\s*=/i;

/** Unified diff (git diff) to files, each with its one-for-one changed line pairs; a run of unequal - and + counts is unpaired. */
export function parseDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let cur: FileDiff | undefined;
  let minus: string[] = []; let plus: string[] = [];
  const flush = () => {
    if (!cur) return;
    if (minus.length === plus.length) minus.forEach((m, i) => cur!.pairs.push([m, plus[i]!]));
    else { cur.removed.push(...minus); cur.added.push(...plus); }
    minus = []; plus = [];
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      cur = { path: line.replace(/^diff --git a\/(.*) b\/.*$/, '$1'), pairs: [], added: [], removed: [], whole: false };
      files.push(cur);
    } else if (!cur) continue;
    else if (!cur.inHunk && line.startsWith('+++ ')) { if (line !== '+++ /dev/null') cur.path = line.slice(4).replace(/^b\//, ''); }
    else if (!cur.inHunk && line.startsWith('--- ')) continue;
    else if (!cur.inHunk && /^(?:new|deleted) file mode|^rename (?:from|to) |^Binary files /.test(line)) cur.whole = true;
    else if (line.startsWith('@@')) { flush(); cur.inHunk = true; }
    else if (line.startsWith('-')) { if (plus.length) flush(); minus.push(line.slice(1)); }
    else if (line.startsWith('+')) plus.push(line.slice(1));
    else flush();
  }
  flush();
  return files;
}

const timeoutValues = (s: string) => [...s.matchAll(TIMEOUT_VALUE)].filter(m => !m[1]!.startsWith('}') || /\)\s*;?\s*$/.test(s.slice(m.index! + m[0].length))).map(m => Number(m[2]!.replace(/_/g, '')));
const maskTimeouts = (s: string) => s.replace(TIMEOUT_VALUE, (_m, key: string, _n: string, at: number) => (!key.startsWith('}') || /\)\s*;?\s*$/.test(s.slice(at + _m.length)) ? `${key}#` : _m));

/** Why the diff is not timeout-only, or null: every changed line pairs with one that differs only in larger timeout values (never an assertion). */
export function notTimeoutOnly(files: FileDiff[]): string | null {
  if (!files.length) return 'the fix changes nothing';
  for (const f of files) {
    if (f.whole || f.added.length || f.removed.length || !f.pairs.length) return `${f.path} adds, removes or replaces whole lines`;
    for (const [was, now] of f.pairs) {
      if (ASSERTION.test(now) || maskTimeouts(was) !== maskTimeouts(now)) return `${f.path} changes more than a timeout value: ${now.trim().slice(0, 80)}`;
      const a = timeoutValues(was); const b = timeoutValues(now);
      if (a.length !== b.length || b.some((n, i) => n < a[i]!) || b.every((n, i) => n === a[i])) return `${f.path} does not raise a timeout: ${now.trim().slice(0, 80)}`;
    }
  }
  return null;
}

/** Why the paths are not docs-only, or null: each is docs class as /ship's review classifies it (agent-read and skill prose is not). */
export function notDocsOnly(paths: string[], root: string): string | null {
  if (!paths.length) return 'the fix changes nothing';
  const code = paths.filter(p => classifyPath(p, root) !== 'docs');
  return code.length ? `not docs: ${code.slice(0, 3).join(', ')}` : null;
}

/** Why the diff is not a version stamp, or null: only stamp files change, and in VERSION or package.json only a version string moves. */
export function notStampOnly(files: FileDiff[]): string | null {
  if (!files.length) return 'nothing changed since the receipt head';
  for (const f of files) {
    if (!STAMP_PATHS.includes(f.path) && !/^changelog\.d\/[^/]+\.md$/.test(f.path)) return `${f.path} is not a stamp file`;
    if (f.path !== 'VERSION' && f.path !== 'package.json') continue;
    if (f.whole || f.added.length || f.removed.length) return `${f.path} adds or removes lines`;
    const bad = f.pairs.find(([was, now]) => was.replace(VERSION, 'V') !== now.replace(VERSION, 'V') || (f.path === 'package.json' && !/^\s*"version"\s*:/.test(now)));
    if (bad) return `${f.path} changes more than the version: ${bad[1].trim().slice(0, 80)}`;
  }
  return null;
}

const QUANTITY = /^[$~]?-?\d[\d_,.]*(?:%|x|[a-z]{1,3})?$/i;
const tokens = (line: string) => line.split(/\s+/).map(t => t.replace(/[,.;:!?)]+$/, '')).filter(Boolean);

/** The tokens of a and b outside their longest common subsequence: what the edit changed, in place. */
function changedTokens(a: string[], b: string[]): string[] {
  const m = a.map(() => new Array<number>(b.length + 1).fill(0));
  m.push(new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) m[i]![j] = a[i] === b[j] ? m[i + 1]![j + 1]! + 1 : Math.max(m[i + 1]![j]!, m[i]![j + 1]!);
  const out: string[] = [];
  let i = 0; let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; } else if (m[i + 1]![j]! >= m[i]![j + 1]!) out.push(a[i++]!); else out.push(b[j++]!);
  }
  return [...out, ...a.slice(i), ...b.slice(j)];
}

/**
 * The plan-delta lines (lineDiff's "+ " and "- " rows) whose edit changes spend, a cap, an arm, a verdict or any
 * number. A run of removed lines pairs in order with the added run after it; the tokens outside the pair's
 * longest common subsequence are its change. A pair counts when that change holds one of those words or a number,
 * or when the line names one and anything on it changed, so swapping two caps or doubling a budget counts. An
 * unpaired line counts when it holds one. An untouched line never counts. An autoplan re-gate with none is a no-stop.
 */
export function regateTouches(delta: string): string[] {
  const rows = delta.split('\n').filter(l => /^[+-] /.test(l));
  const hits = (ts: string[]) => ts.some(t => REGATE_WORDS.test(t) || QUANTITY.test(t));
  const out: string[] = [];
  for (let i = 0; i < rows.length;) {
    const minus: string[] = []; const plus: string[] = [];
    while (i < rows.length && rows[i]![0] === '-') minus.push(rows[i++]!);
    while (i < rows.length && rows[i]![0] === '+') plus.push(rows[i++]!);
    for (let k = 0; k < Math.max(minus.length, plus.length); k++) {
      const a = minus[k]; const b = plus[k];
      const changed = a && b ? changedTokens(tokens(a.slice(2)), tokens(b.slice(2))) : tokens((a ?? b)!.slice(2));
      const named = [a, b].some(l => l && REGATE_WORDS.test(l.slice(2)));
      if (hits(changed) || (named && changed.length)) out.push(...[a, b].filter((l): l is string => !!l).map(l => l.slice(0, 100)));
    }
  }
  return out;
}

export interface NoStopInput { cls: string; reason: string; evidence: string; prior: readonly NoStopRecord[]; diff?: string; root?: string }

/** The verdict for one stop: the record to add, or why it still stops. */
export function checkNoStop(i: NoStopInput): NoStopVerdict {
  if (!(NO_STOP_CLASSES as readonly string[]).includes(i.cls)) return { ok: false, reason: `${i.cls} is not one of the five no-stop classes (${NO_STOP_CLASSES.join(', ')})` };
  const cls = i.cls as NoStopClass;
  if (!i.reason.trim() || !i.evidence.trim()) return { ok: false, reason: 'a no-stop record needs a reason and evidence that resolves (run id, commit or file)' };
  const record = { class: cls, reason: i.reason.trim(), evidence: i.evidence.trim() };
  if ((cls === 'scoped-fix-check' || cls === 'pregate-flake-rerun') && i.prior.some(r => r.class === cls)) return { ok: false, reason: `one ${cls} per branch is recorded already; a second goes to the owner` };
  if (cls === 'pregate-flake-rerun') return { ok: true, record, detail: 'one rerun at the same tree (rule 16): green is flaky, red again is real' };
  if (cls === 'autoplan-regate') return { ok: false, reason: 'gstack-autoplan decides re-gates at the gate (lib/autoplan-carry.ts), never by hand' };
  const files = parseDiff(i.diff ?? '');
  const where = files.map(f => f.path).join(', ');
  if (cls === 'stamp-only-carry') {
    const why = notStampOnly(files);
    return why ? { ok: false, reason: why } : { ok: true, record, detail: `version stamp only in ${where}` };
  }
  const timeout = notTimeoutOnly(files);
  if (cls === 'test-timeout-fix') {
    const outside = files.filter(f => !TEST_PATH.test(f.path)).map(f => f.path);
    if (outside.length) return { ok: false, reason: `not a test file: ${outside.slice(0, 3).join(', ')}` };
    return timeout ? { ok: false, reason: timeout } : { ok: true, record, detail: `timeout raised in ${where}` };
  }
  if (!timeout) return { ok: true, record, detail: `timeout-only fix in ${where}` };
  const docs = notDocsOnly(files.map(f => f.path), i.root ?? process.cwd());
  return docs ? { ok: false, reason: `the fix is neither docs-only (${docs}) nor timeout-only (${timeout})` } : { ok: true, record, detail: `docs-only fix in ${where}` };
}

/** The branch's ledger under the checkout's git dir, or null outside a git checkout. */
export function ledgerPath(cwd: string): string | null {
  const run = (args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30_000 });
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dir = run(['rev-parse', '--git-path', 'gstack']);
  if (branch.status !== 0 || dir.status !== 0) return null;
  return path.resolve(cwd, dir.stdout.trim(), `no-stop-${branchKey(branch.stdout.trim())}.json`);
}

export function readLedger(file: string | null): NoStopRecord[] {
  if (!file || !fs.existsSync(file)) return [];
  const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Array.isArray(rows) ? rows : [];
}

export function appendLedger(file: string, record: NoStopRecord): NoStopRecord[] {
  const rows = [...readLedger(file), record];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rows, null, 2) + '\n');
  return rows;
}
