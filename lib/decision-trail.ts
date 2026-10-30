/**
 * decision-trail — the append rules of a run's decision trail (docs/unattended.md#the-decision-trail):
 * a TSV with one line per decision (ts, phase, decision, why, evidence, result). The header is
 * written once and only ever appended, cells lose their tabs and line breaks, and a cell whose first
 * byte a spreadsheet would run as a formula (=, +, -, @) gets a leading apostrophe. Shared by
 * bin/gstack-decision-trail and the autoplan runner (lib/autoplan-carry.ts records its carry verdicts).
 * The rules are a port of pstack's show-me-your-work/scripts/log.sh (Copyright Lauren Tan, MIT);
 * licenses/MIT-pstack.txt, NOTICE.md.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const TRAIL_COLUMNS = ["ts", "phase", "decision", "why", "evidence", "result"] as const;
export const TRAIL_HEADER = TRAIL_COLUMNS.join("\t") + "\n";

export type TrailRow = { line: number; cells: string[] };

function clean(cell: string): string {
  const flat = cell.replace(/[\t\n\r]/g, " ");
  return /^[=+\-@]/.test(flat) ? `'${flat}` : flat;
}

export function readTrailRows(file: string): TrailRow[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const rows: TrailRow[] = [];
  lines.forEach((raw, i) => {
    let text = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (i === 0 && text.startsWith("\uFEFF")) text = text.slice(1);
    // A repeated header (the append-on-flaky-mount case) is never a row.
    if (text === "" || text === TRAIL_HEADER.trimEnd()) return;
    rows.push({ line: i + 1, cells: text.split("\t") });
  });
  return rows;
}

/** Append one row (ts stamped in UTC) and return the row count. */
export function appendTrailRow(file: string, cells: readonly string[]): number {
  const dir = path.dirname(file);
  if (dir && dir !== "." && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  // Append the header too, never truncate: on a flaky mount the worst case is
  // one stray header line, not lost rows.
  // A file with no header line anywhere (empty, blank, or rows written by hand)
  // gets one appended once; readTrailRows skips a header line wherever it sits.
  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  if (size > 0 && !endsWithNewline(file, size)) fs.appendFileSync(file, "\n");
  if (size === 0 || !hasHeader(file)) fs.appendFileSync(file, TRAIL_HEADER);
  const ts = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  fs.appendFileSync(file, [ts, ...cells.map(clean)].join("\t") + "\n");
  return readTrailRows(file).length;
}

function hasHeader(file: string): boolean {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").split("\n")
    .some(line => line.replace(/\r$/, "") === TRAIL_HEADER.trimEnd());
}

function endsWithNewline(file: string, size: number): boolean {
  const fd = fs.openSync(file, "r");
  try {
    const last = Buffer.alloc(1);
    fs.readSync(fd, last, 0, 1, size - 1);
    return last[0] === 0x0a;
  } finally {
    fs.closeSync(fd);
  }
}
