/**
 * eval-plan-report: the results check behind `gstack-eval-plan results --check`.
 * A preregistration that says `stack: loaded` names its no-gstack arms; its
 * results file must hold one markdown table with a filled row for every Arms
 * identity, so each no-gstack row sits beside its variants
 * (docs/TESTING_INTERNALS.md#no-gstack-arm). Reads text only; executes nothing.
 */
import { armIdentities, checkPrereg } from './eval-plan';

export interface ResultsCheck { ok: boolean; required: string[]; no_gstack: string[]; found: string[]; missing: string[]; problems: string[] }

const PLACEHOLDER = /^(?:|-+|—|–|n\/a|tbd|todo|\?)$/i;
const cellsOf = (line: string) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
const separator = (line: string | undefined) => !!line && /^\s*\|[\s:|-]+\|?\s*$/.test(line) && line.includes('-');

/** The filled-row identities of each markdown table: first cell, backticks stripped, header and separator rows skipped. */
export function resultTables(text: string): Array<Set<string>> {
  const lines = text.split('\n');
  const tables: Array<Set<string>> = [];
  let current: Set<string> | null = null;
  lines.forEach((line, i) => {
    if (!/^\s*\|/.test(line)) { current = null; return; }
    if (!current) { current = new Set(); tables.push(current); }
    if (separator(line) || separator(lines[i + 1])) return;
    const [first, ...rest] = cellsOf(line);
    const id = (first ?? '').replace(/`/g, '').trim();
    if (id && rest.some(c => !PLACEHOLDER.test(c.replace(/`/g, '').trim()))) current.add(id);
  });
  return tables;
}

export function checkResults(preregText: string, resultsText: string): ResultsCheck {
  const prereg = checkPrereg(preregText);
  if (prereg.comparison.stack === 'none') return { ok: true, required: [], no_gstack: [], found: [], missing: [], problems: [] };
  const required = [...new Set(armIdentities(preregText))];
  const noGstack = prereg.no_gstack.arms;
  const problems: string[] = [];
  if (!prereg.ok) problems.push('the preregistration does not pass prereg --check');
  const tables = resultTables(resultsText);
  const best = tables.reduce<Set<string>>((b, t) => (required.filter(id => t.has(id)).length > required.filter(id => b.has(id)).length ? t : b), new Set());
  const found = required.filter(id => best.has(id));
  const missing = required.filter(id => !best.has(id));
  if (!tables.length) problems.push('no markdown table in the results file');
  else for (const id of missing) problems.push(`no filled row for ${id} in the table that holds the other arms`);
  return { ok: problems.length === 0, required, no_gstack: noGstack, found, missing, problems };
}
