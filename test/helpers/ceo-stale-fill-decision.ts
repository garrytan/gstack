/**
 * The CEO section-loading fixture's real defect is the stale cache fill: a read
 * that misses before a write commits can store its old value after the write's
 * invalidation. /plan-ceo-review records every contract conflict in two
 * structures it defines (plan-ceo-review/SKILL.md.tmpl): a decision-ledger row
 * (`| ID and owner | … | Status | Exact approval and scope |`) and a saved
 * `## currentDecision (ROW-ID)` block whose `Question:` names the decision.
 * Reading those records, rather than matching prose phrasings, is what proves
 * the review found the race and approved a remedy.
 */

const LEDGER_HEADER = /^\|\s*ID and owner\s*\|\s*Contract and evidence\s*\|\s*Current\s*\|\s*Proposed\s*\|\s*Status\s*\|\s*Exact approval and scope\s*\|\s*$/;
const FILL = /\b(?:fill\w*|refill\w*|repopulat\w*)\b|\bcache\.set\b/i;
const WRITE = /\b(?:writes?|written|writer|commit\w*)\b/i;
const RACE = /\b(?:stale|race|racing|overwrit\w*|newer|old|older|before|after|overlap\w*|in[- ]flight|concurrent\w*)\b/i;

/** Asserted lines only: fenced blocks, block quotes and indented code become blank. */
function proseLines(report: string): string[] {
  let fence: { char: string; length: number } | null = null;
  return report.split('\n').map(line => {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const run = delimiter[1]!;
      if (!fence) fence = { char: run[0]!, length: run.length };
      else if (run[0] === fence.char && run.length >= fence.length && !delimiter[2]!.trim()) fence = null;
      return '';
    }
    return fence || /^\s*>/.test(line) || /^(?: {4}|\t)/.test(line) ? '' : line;
  });
}

/** The latest ledger row per ID, from tables under the skill's exact ledger header. */
function ledgerRows(lines: string[]): Map<string, string> {
  const rows = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    if (!LEDGER_HEADER.test(lines[i]!)) continue;
    for (let j = i + 2; j < lines.length && lines[j]!.trimStart().startsWith('|'); j++) {
      const cells = lines[j]!.trim().slice(1, -1).split('|').map(cell => cell.trim());
      const id = /^([A-Za-z][\w-]*)(?=\s|$)/.exec(cells[0] ?? '')?.[1];
      // A row that does not split into the six ledger cells is not a record.
      if (!id || cells.length !== 6) continue;
      rows.set(id, cells[4]!);
    }
  }
  return rows;
}

/** An approved ledger decision whose saved question is the stale-fill race. */
export function hasApprovedStaleFillDecision(report: string): boolean {
  const lines = proseLines(report);
  const rows = ledgerRows(lines);
  for (let i = 0; i < lines.length; i++) {
    const rowId = /^#{2,3}\s+currentDecision \(([A-Za-z][\w-]*)\)\s*$/.exec(lines[i]!)?.[1];
    if (!rowId) continue;
    for (let j = i + 1; j < lines.length && !/^#{1,6}\s/.test(lines[j]!); j++) {
      const subject = /^Question:\s*D[1-9]\d*\s*[—–-]\s*(.+)$/.exec(lines[j]!)?.[1];
      if (!subject) continue;
      if (FILL.test(subject) && WRITE.test(subject) && RACE.test(subject) && /^[*_]*approved\b/i.test(rows.get(rowId) ?? '')) return true;
      break;
    }
  }
  return false;
}
