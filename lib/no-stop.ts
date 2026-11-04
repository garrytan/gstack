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
 * - autoplan-regate: a later autoplan gate revision whose plan-file edit only adds ELI5 lines that name no
 *   number, spend, cap, arm or verdict (lib/autoplan-carry.ts asks notEli5Only before it carries).
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
/** Words that mean spend, a cap, an eval arm, a model or a verdict: an ELI5 addition naming one goes to the owner. */
const REGATE_WORDS = /\$|\b(?:spend|spending|spent|costs?|budgets?|prices?|caps?|capped|credits?|limits?|max|maximum|arms?|models?|judges?|verdicts?|thresholds?|bars?|pass(?:es)? at|trials?|samples?|stop rules?|kill rules?|paid|evals?|opus|sonnet|haiku|gpt[\w.-]*|gemini|claude)\b|\bn\s*=/i;

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

const TEST_CALL = /^\s*(?:test|it|describe|bench|beforeAll|beforeEach|afterAll|afterEach)(?:\.\w+)*\(/;
/** A trailing `}, N)` is a timeout only where the same line opens the test call it closes; a multi-line callback's `}, N);` could close any call. */
const isTimeout = (s: string, key: string, at: number, len: number) => !key.startsWith('}') || (TEST_CALL.test(s) && /\)\s*;?\s*$/.test(s.slice(at + len)));
const timeoutValues = (s: string) => [...s.matchAll(TIMEOUT_VALUE)].filter(m => isTimeout(s, m[1]!, m.index!, m[0].length)).map(m => Number(m[2]!.replace(/_/g, '')));
const maskTimeouts = (s: string) => s.replace(TIMEOUT_VALUE, (_m, key: string, _n: string, at: number) => (isTimeout(s, key, at, _m.length) ? `${key}#` : _m));

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

const HEADING = /^#{1,6}\s+(.*)$/;
const ELI5 = /^eli5\b/i;

/**
 * Why a plan-file edit (lineDiff rows) is not an ELI5-only addition, or null. Every changed line must be added (none
 * removed or rewritten), inside the plan's `## ELI5` section (an added `## ELI5` heading opens one), and hold no digit
 * and no spend, cap, arm, model or verdict word. Anything else goes to the owner: the carry exports the reviewed
 * plan, so the added explanation is never built.
 */
export function notEli5Only(lines: ReadonlyArray<{ op: string; text: string }>): string | null {
  let section = '';
  let added = 0;
  for (const l of lines) {
    const heading = l.text.match(HEADING);
    if (l.op === '-') return `it removes or rewrites a line: ${l.text.trim().slice(0, 80)}`;
    if (l.op !== '+') { if (heading) section = heading[1]!.trim(); continue; }
    if (!l.text.trim()) continue;
    if (heading && !ELI5.test(heading[1]!.trim())) return `it adds a heading: ${l.text.trim().slice(0, 80)}`;
    if (heading) { section = heading[1]!.trim(); continue; }
    if (!ELI5.test(section)) return `it adds a line outside ## ELI5: ${l.text.trim().slice(0, 80)}`;
    if (/\d/.test(l.text.replace(/\bELI5\b/gi, '')) || REGATE_WORDS.test(l.text)) return `it names a number, spend, a cap, an arm, a model or a verdict: ${l.text.trim().slice(0, 80)}`;
    added++;
  }
  return added ? null : 'the edit adds no ELI5 line';
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
