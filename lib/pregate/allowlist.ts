/**
 * pregate/allowlist — the policy's `allowlist` applied to the secrets check's
 * findings (Lane D, GSTA-112; harness-evals #81/#83, GSTA-102, GSTA-106). An
 * entry names a gstack-redact finding id or a non-secret category, and scopes
 * it by path globs and/or a regular expression matched at the finding's
 * position in the added line (anchored there, so a dummy token's shape never
 * covers a real key that happens to share its line). `env.value`, the real
 * value of a credential-named environment variable, is never consulted
 * against the list: validation refuses an entry naming it, and this matcher
 * keeps such a finding whatever the entries say (#3449).
 */
import { matchesAny } from '../ship-policy';
import { sha256 } from './context';
import { ALLOWLISTABLE_CATEGORIES, nonAllowlistable, type AllowlistEntry } from './config';

export interface AllowlistFinding {
  id: string; category: string; severity: string; file: string; line?: number; col?: number;
  /** The added line the finding sits on (for `pattern`); absent when the scanner gave no position. */
  lineText?: string;
  /** `line` numbers the whole file (a Dart or Python file scanned whole, #3630), not the added lines. */
  fileLine?: boolean;
}
export interface Allowlisted<F extends AllowlistFinding = AllowlistFinding> { finding: F; index: number; entry: AllowlistEntry }

/** Whether `entry` names this finding: its id, or its category when the category may be named whole. */
function names(entry: AllowlistEntry, f: AllowlistFinding): boolean {
  if (entry.finding === f.id) return true;
  return (ALLOWLISTABLE_CATEGORIES as readonly string[]).includes(entry.finding) && entry.finding === f.category;
}

/** Whether a finding has the position a `pattern` needs: the added line and a 1-based column. */
const positioned = (f: AllowlistFinding) => f.lineText !== undefined && !!f.col;

/** The pattern, anchored at the finding's column in its added line and ending at a token boundary (so a short pattern never covers the head of a longer value); a finding with no position never matches a pattern. */
function patternHits(entry: AllowlistEntry, f: AllowlistFinding): boolean {
  if (entry.pattern === undefined) return true;
  if (!positioned(f)) return false;
  let re: RegExp;
  try { re = new RegExp(`^(?:${entry.pattern})(?![\\w-])`); } catch { return false; }
  return re.test(f.lineText!.slice(f.col! - 1));
}

function matchesLine(pattern: string, line: string): boolean {
  try { return new RegExp(pattern).test(line); } catch { return false; }
}

/**
 * Split findings into the ones an entry covers (with the entry) and the ones
 * kept; env.value and engine.* are always kept. `untested` lists kept findings
 * that a pattern entry named by id and path but could not test because the
 * scanner gave no position, so the table says why the entry was inert;
 * `missed` lists kept findings that a pattern entry named by id and path
 * whose pattern matches the finding's line but not at its position (#3630:
 * the entry was written from the name, not the value).
 */
export function applyAllowlist<F extends AllowlistFinding>(findings: readonly F[], entries: readonly AllowlistEntry[]): { kept: F[]; allowlisted: Allowlisted<F>[]; untested: Allowlisted<F>[]; missed: Allowlisted<F>[] } {
  const kept: F[] = [];
  const allowlisted: Allowlisted<F>[] = [];
  const untested: Allowlisted<F>[] = [];
  const missed: Allowlisted<F>[] = [];
  for (const f of findings) {
    const scoped = (e: AllowlistEntry) => names(e, f) && (!e.paths || matchesAny(e.paths, f.file));
    const index = nonAllowlistable(f.id) ? -1 : entries.findIndex(e => scoped(e) && patternHits(e, f));
    if (index >= 0) { allowlisted.push({ finding: f, index, entry: entries[index]! }); continue; }
    kept.push(f);
    if (nonAllowlistable(f.id)) continue;
    const named = entries.findIndex(e => e.pattern !== undefined && scoped(e) && (!positioned(f) || matchesLine(e.pattern, f.lineText!)));
    if (named >= 0) (positioned(f) ? missed : untested).push({ finding: f, index: named, entry: entries[named]! });
  }
  return { kept, allowlisted, untested, missed };
}

/** sha256 of the entries, for the check's `inputs.allowlist`. */
export const allowlistDigest = (entries: readonly AllowlistEntry[]) => sha256(JSON.stringify(entries));

/** One table line per finding a pattern entry named but could not test: the finding is kept. */
export function describeUntested(a: Allowlisted): string {
  return `allowlist[${a.index}] ${a.entry.finding} not tested on ${a.finding.id} (${a.finding.file}): the scanner gave no position for its pattern; the finding is kept`;
}

/** One table line per finding a pattern entry named but did not match: the pattern is tested from where the flagged value starts, never the name before it. */
export function describeMissed(a: Allowlisted): string {
  return `allowlist[${a.index}] ${a.entry.finding} pattern did not match ${a.finding.id} (${a.finding.file}${a.finding.line ? `, ${a.finding.fileLine ? 'line' : 'added line'} ${a.finding.line}` : ''}, col ${a.finding.col}): a pattern is matched from where the flagged value starts, not from the name; the finding is kept`;
}

/** One table line per allowlisted finding: what, where, and which entry (with its reason) covered it. */
export function describeAllowlisted(a: Allowlisted): string {
  const where = a.finding.line ? ` (${a.finding.file}, ${a.finding.fileLine ? 'line' : 'added line'} ${a.finding.line})` : ` (${a.finding.file})`;
  return `allowlisted ${a.finding.id}${where} by allowlist[${a.index}] ${a.entry.finding}: ${a.entry.reason}`;
}
