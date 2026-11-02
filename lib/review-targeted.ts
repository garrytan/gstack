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
import { AUTH_PATH_PREFIXES, AUTH_PATH_TOKENS, KEY_NAME, MONEY_LINE, MONEY_PATH_TOKENS, SECRET_LINE, SECRET_PATH, matchRisk } from './review-risk';

export const TARGETED_CLASSES = ['money', 'gate', 'auth', 'secret'] as const;
export type TargetedClass = (typeof TARGETED_CLASSES)[number];

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
  if ((i.gateTagged ?? 0) > 0) why.set('gate', `gate scan tagged ${i.gateTagged} hunk(s)`);
  for (const [c, reason] of matchRisk({ codePaths: code, added: i.added, removed: i.removed, scopeAuth: s!.SCOPE_AUTH === 'true' })) if ((TARGETED_CLASSES as readonly string[]).includes(c)) why.set(c as TargetedClass, reason);
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
