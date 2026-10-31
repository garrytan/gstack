/**
 * review-targeted — the targeted review pass on money, gate, auth and secret code
 * (docs/review-policy.md#targeted-pass-on-money-gate-auth-and-secret-code; GST-257).
 * A pure function from a collected diff (lib/review-collect.ts: changed paths with
 * their added and deleted lines), gstack-diff-scope's flags and the gate scan to the
 * classes the diff touches. bin/gstack-review-plan prints them and dispatches one
 * `targeted` reader with the matching blocks of review/specialists/targeted.md;
 * gstack-ship-receipt records the pass and gstack-ship-queue reports it.
 *
 * Matching reads added and deleted lines, so removing a cap, a check or a redaction
 * counts. Path and identifier signals are token-bounded: `costume` never names cost.
 * Docs and tests paths never trigger. Any input the classifier cannot read fails
 * closed to all four classes, as a depth error fails the depth closed to full.
 *
 * The gate class is the gate scan's tagged hunks (a relaxed threshold, a skipped test, a
 * loosened check), not GATE_PATH: over the last 100 non-release commits on main, GATE_PATH
 * alone hit 43 (the precision gate allows 25), and those paths already get full depth.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyPath } from './review-depth';

export const TARGETED_CLASSES = ['money', 'gate', 'auth', 'secret'] as const;
export type TargetedClass = (typeof TARGETED_CLASSES)[number];

const MONEY_PATH_TOKENS = ['cost', 'costs', 'spend', 'spending', 'budget', 'budgets', 'ledger', 'billing', 'price', 'prices', 'pricing', 'fee', 'fees', 'invoice', 'invoices'];
/** Identifiers ending in _usd, Usd or cap_usd, any spend_cap spelling, and paid-provider call sites (the providers lib/pricing.ts prices). */
const MONEY_LINE = [
  /\b[A-Za-z0-9_]*_usd\b/i, /\b[a-z][A-Za-z0-9]*Usd\b/, /\bspend[_-]?cap\b/i,
  /\bapi\.(?:anthropic|openai|voyageai)\.com\b/, /\bgenerativelanguage\.googleapis\.com\b/, /\bopenrouter\.ai\b/,
  /\bnew\s+(?:Anthropic|OpenAI|AnthropicBedrock|AnthropicVertex)\s*\(/, /\.(?:messages|chat\.completions|responses|embeddings)\.create\s*\(/,
];
const AUTH_PATH_TOKENS = ['auth', 'authn', 'authz', 'oauth', 'oauth2', 'jwt', 'session', 'sessions', 'permission', 'permissions', 'role', 'roles'];
const AUTH_PATH_PREFIXES = ['authenticat', 'authoriz'];
const SECRET_PATH = /(^|\/)(secrets?|credentials?|keychain|token[s]?)([._/-]|$)/i;
/** An environment name whose underscore-separated segments include a key word: OPENAI_API_KEY, GH_TOKEN; never MAX_TOKENS. */
const KEY_NAME = String.raw`(?:[A-Z0-9]+_)*(?:API_?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|ACCESS_KEY|CREDENTIALS?)(?:_[A-Z0-9]+)*\b`;
const SECRET_LINE = [
  new RegExp(String.raw`\b(?:process\.env|Bun\.env|import\.meta\.env)(?:\.|\[\s*['"\x60])${KEY_NAME}`),
  new RegExp(String.raw`\b(?:os\.environ(?:\.get\(|\[)|os\.getenv\(|ENV(?:\.fetch\(|\[))\s*['"]${KEY_NAME}`),
  new RegExp(String.raw`\$\{?${KEY_NAME}`),
  /\b(?:keychain|keytar|find-generic-password|find-internet-password|secret-tool|git-credential|credential\.helper)\b/i, /\bgh auth token\b/, /(?:^|[\s'"/])\.netrc\b/,
];

/** A hash of the patterns that decide the classes, not of this file's bytes: a comment edit keeps it, a pattern edit changes it. */
export const TARGETED_RULES = createHash('sha256').update(JSON.stringify({
  TARGETED_CLASSES, MONEY_PATH_TOKENS, AUTH_PATH_TOKENS, AUTH_PATH_PREFIXES, KEY_NAME,
  patterns: Object.entries({ MONEY_LINE, SECRET_LINE, SECRET_PATH: [SECRET_PATH] }).map(([k, v]) => [k, v.map(r => `/${r.source}/${r.flags}`)]),
})).digest('hex').slice(0, 16);

export interface TargetedInput {
  paths: readonly string[];
  /** Added and deleted lines per path (lib/review-collect.ts). */
  added?: Record<string, readonly string[]>;
  removed?: Record<string, readonly string[]>;
  /** gstack-diff-scope output (SCOPE_* keys); missing or SCOPE_ERROR fails closed. */
  scope?: Record<string, string>;
  /** Gate hunks the gate scan tagged; null when it did not run, which fails closed once a code path changed. */
  gateTagged: number | null;
  root?: string | readonly string[];
  /** Collector failures (a diff git could not list). */
  errors?: readonly { code: string; input: string }[];
}
export interface TargetedResult { classes: TargetedClass[]; reasons: string[]; errors: string[]; rules: string }

const tokens = (p: string) => p.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** The classes a diff touches, in TARGETED_CLASSES order, with one reason per class; any input error returns all four. */
export function targetedClasses(i: TargetedInput): TargetedResult {
  const errors = (i.errors ?? []).map(e => `${e.code} (${e.input})`);
  const s = i.scope;
  if (!s) errors.push('scope unavailable (gstack-diff-scope did not run)');
  else if (s.SCOPE_ERROR) errors.push(`scope error: ${s.SCOPE_ERROR}`);
  const code = i.paths.filter(p => classifyPath(p, i.root) === 'code');
  if (code.length && i.gateTagged === null) errors.push('gate scan unavailable');
  if (errors.length) return { classes: [...TARGETED_CLASSES], reasons: errors.map(e => `fail-closed: ${e}`), errors, rules: TARGETED_RULES };
  const why = new Map<TargetedClass, string>();
  const hit = (c: TargetedClass, reason: string) => { if (!why.has(c)) why.set(c, reason); };
  if ((i.gateTagged ?? 0) > 0) hit('gate', `gate scan tagged ${i.gateTagged} hunk(s)`);
  for (const p of code) {
    const t = tokens(p);
    if (s!.SCOPE_AUTH === 'true' && t.some(x => AUTH_PATH_TOKENS.includes(x) || AUTH_PATH_PREFIXES.some(a => x.startsWith(a)))) hit('auth', `auth path: ${p}`);
    if (SECRET_PATH.test(p)) hit('secret', `secret path: ${p}`);
    if (t.some(x => MONEY_PATH_TOKENS.includes(x))) hit('money', `money path: ${p}`);
    for (const line of [...(i.added?.[p] ?? []), ...(i.removed?.[p] ?? [])]) {
      if (!why.has('money') && MONEY_LINE.some(r => r.test(line))) hit('money', `money line: ${p}`);
      if (!why.has('secret') && SECRET_LINE.some(r => r.test(line))) hit('secret', `secret line: ${p}`);
    }
  }
  const classes = TARGETED_CLASSES.filter(c => why.has(c));
  return { classes, reasons: classes.map(c => why.get(c)!), errors: [], rules: TARGETED_RULES };
}

/** The static brief every targeted reader gets its blocks from; its sha256 is the `brief` the plan prints and the receipt records. */
export const TARGETED_BRIEF_FILE = path.join(import.meta.dir, '..', 'review', 'specialists', 'targeted.md');
export function targetedBriefSha(file = TARGETED_BRIEF_FILE): string {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return 'missing'; }
}

/**
 * The patch the targeted reader reads: the patch-id of the whole committed diff from `mergeBase`, tests included, so a
 * test-only fix that adds a gate hunk changes it. `uncommitted` with tracked edits or untracked files, `none` for an empty
 * or unreadable diff; neither proves what a reader read. Not the receipt's product_patch_id (that leaves tests out).
 */
export function targetedPatchId(root: string, mergeBase: string): string {
  const git = (args: string[], input?: string) => spawnSync('git', args, { cwd: root, input, encoding: 'utf8', timeout: 60_000, maxBuffer: 256 * 1024 * 1024 });
  if (git(['diff', '--quiet', 'HEAD', '--']).status !== 0 || git(['ls-files', '--others', '--exclude-standard']).stdout?.trim()) return 'uncommitted';
  const diff = git(['diff', '--no-color', '--no-ext-diff', mergeBase, 'HEAD']);
  if (diff.status !== 0 || !diff.stdout.trim()) return 'none';
  return git(['patch-id', '--verbatim'], diff.stdout).stdout?.trim().split(/\s+/)[0] || 'none';
}

/** A class list as printed and recorded: comma-joined, or `none`. */
export const classList = (classes: readonly string[]) => (classes.length ? classes.join(',') : 'none');

/** Parse a printed class list (`money,gate` or `none`); an unknown name gives null. */
export function parseClassList(text: string): TargetedClass[] | null {
  const names = text.trim() === 'none' ? [] : text.split(',').map(s => s.trim()).filter(Boolean);
  if (names.some(n => !(TARGETED_CLASSES as readonly string[]).includes(n))) return null;
  return TARGETED_CLASSES.filter(c => names.includes(c));
}

/** The brief a targeted reader gets: review/specialists/targeted.md's preamble plus the `## <class>` block of each class that hit. */
export function targetedBrief(text: string, classes: readonly TargetedClass[]): string {
  const parts = text.replace(/\r\n/g, '\n').split(/\n(?=## )/);
  const blocks = new Map(parts.slice(1).map(b => [/^## (\w+)/.exec(b)?.[1] ?? '', b.trimEnd()]));
  const missing = classes.filter(c => !blocks.has(c));
  if (!classes.length || missing.length) throw new Error(`targeted brief: ${classes.length ? `no block for ${missing.join(', ')}` : 'no class to brief'}`);
  return [parts[0]!.trimEnd(), ...classes.map(c => blocks.get(c)!)].join('\n\n');
}
