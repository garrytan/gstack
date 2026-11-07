/**
 * Findings and the output contract of the design lint.
 *
 *   LINT: <blocks|ask|polish|waived> <rule-id> <file>:<line> <evidence> | fix: <fix>
 *   LINT_SUMMARY: blocks=N ask=N waived=N polish=N render=<ran|skipped: reason>
 *
 * Blocking and waived are never summed: a waived finding leaves the ask count
 * and lands in waived, so blocks=0 is always a true sentence about the Floor.
 * Exit 2 when anything blocks, 1 when an ask is unanswered, 0 otherwise.
 */
import * as path from 'node:path';
import { RULES, ruleMeta, type Tier } from './rules/ids';

export type Grade = Tier | 'waived';

export type Source = 'static' | 'render' | 'copy';

export interface Finding {
  rule: string;
  tier: Tier;
  grade: Grade;
  file: string;
  line: number;
  evidence: string;
  fix: string;
  source: Source;
  /** Set when a waiver answered the finding: the reason it recorded. */
  waiver?: string;
  /** An app-profile finding's measurement (--scope app): kept whole, never truncated. */
  app?: AppMeasure;
}

export interface AppMeasure {
  state: string;
  viewport: string;
  locator: string;
  measured: number;
  threshold: number;
}

export interface ReportOptions {
  fix?: string;
  /** A tell the rule can only suspect: a blocking rule reports at ask so a person confirms it. */
  suspected?: boolean;
  source?: Source;
}

export const trunc = (s: string, n = 120): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/** One printable line: control characters, line separators and runs of whitespace become one space, so no value a page controls can forge a LINT line or drive the terminal. */
export const oneLine = (s: string): string => s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\s]+/g, ' ').trim();

export const relPath = (file: string, cwd = process.cwd()): string =>
  /^https?:\/\//.test(file) ? file : path.isAbsolute(file) && file.startsWith(cwd + path.sep) ? file.slice(cwd.length + 1) : file;

/** Collects findings for one context (a page and its stylesheets, or a directory of components). */
export class Reporter {
  readonly findings: Finding[] = [];

  constructor(readonly scope: 'page' | 'component' | 'app' = 'page', readonly cwd = process.cwd()) {}

  /** Records one finding and returns it; null when the rule is page-only and the scope is component. */
  report(rule: string, file: string, line: number | null | undefined, evidence: string, opts: ReportOptions = {}): Finding | null {
    const meta = ruleMeta(rule);
    if (!meta) throw new Error(`design-lint: unknown rule id ${rule}`);
    if (this.scope === 'component' && meta.pageOnly) return null;
    if (meta.app && this.scope !== 'app') return null;
    const tier: Tier = opts.suspected && meta.tier === 'blocks' ? 'ask' : meta.tier;
    const finding: Finding = {
      rule, tier, grade: tier,
      file: oneLine(relPath(file, this.cwd)), line: line || 1,
      evidence: trunc(field(evidence)),
      fix: trunc(field(opts.fix ?? meta.fix), 240),
      source: opts.source ?? (meta.render ? 'render' : 'static'),
    };
    this.findings.push(finding);
    return finding;
  }
}

/** One line, with the LINT line's own separator kept out of page-supplied text, so a parser splitting on the first ` | fix: ` reads the fix. */
const field = (s: unknown): string => oneLine(String(s)).replace(/ \| fix: /g, ' / fix: ');

const GRADE_RANK: Record<Grade, number> = { blocks: 0, ask: 1, waived: 2, polish: 3 };

/** Drop exact duplicates and order findings: blocks, ask, waived, polish; then rule, file, line. */
export function finalize(findings: Finding[]): Finding[] {
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const k = `${f.rule}|${f.grade}|${f.file}|${f.line}|${f.evidence}` + (f.app ? `|${f.app.state}|${f.app.viewport}|${f.app.locator}` : '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return unique.sort((a, b) =>
    GRADE_RANK[a.grade] - GRADE_RANK[b.grade]
    || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0)
    || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    || a.line - b.line);
}

export interface Summary {
  blocks: number;
  ask: number;
  waived: number;
  polish: number;
  render: string;
}

export function summarize(findings: Finding[], render: string): Summary {
  const count = (g: Grade) => findings.filter((f) => f.grade === g).length;
  return { blocks: count('blocks'), ask: count('ask'), waived: count('waived'), polish: count('polish'), render };
}

export function formatFinding(f: Finding): string {
  const fix = f.grade === 'waived' ? `waived (${f.waiver ?? 'on the record'})` : f.fix;
  return oneLine(`LINT: ${f.grade} ${f.rule} ${f.file}:${f.line} ${f.evidence} | fix: ${fix}`);
}

export function formatSummary(s: Summary): string {
  return `LINT_SUMMARY: blocks=${s.blocks} ask=${s.ask} waived=${s.waived} polish=${s.polish} render=${s.render}`;
}

export function exitCodeOf(s: Summary): 0 | 1 | 2 {
  if (s.blocks > 0) return 2;
  if (s.ask > 0) return 1;
  return 0;
}

/** Every rule id, so a caller can list the contract. */
export const ruleTable = (): Array<{ id: string; tier: Tier; gate: string; title: string }> =>
  Object.entries(RULES).map(([id, m]) => ({ id, tier: m.tier, gate: m.gate, title: m.title }));
