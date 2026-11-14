/**
 * review-verdict: the one machine-readable line every blocking reader's reply carries (GST-2495), right under its
 * REVIEWED_TREE line: `REVIEW_VERDICT: blocking=<n>[ at=<path>:<line>[,<path>:<line>...]]`, n being how many findings
 * in the reply block the merge. collect reads it only when the reader's render asked for it (the `verdict: 1` render
 * event), so a reply to an older brief, or an old ledger, parses exactly as before. Lines inside fenced code blocks are
 * ignored, byte-identical repeats count once, and differing repeats are malformed. docs/review-policy.md#verdict-line.
 */

export type Verdict = { state: 'valid'; blocking: number; at: string[] } | { state: 'missing' } | { state: 'malformed'; why: string };

const FENCE = /^\s*(`{3,}|~{3,})/;
const LOCUS = /^[\w./-]+:\d+$/;
const GRAMMAR = /^REVIEW_VERDICT:\s*blocking=(\d+)(?:\s+at=(\S+))?$/;

/** A line that tries to be the verdict line, wrappers removed (list marker, heading mark, whole-line bold or backticks), or null. */
export function verdictAttempt(line: string): string | null {
  let t = line.trim().replace(/^(?:[-*>]\s+|\d+[.)]\s+|#+\s+)/, '');
  for (const w of ['**', '`']) if (t.length > 2 * w.length && t.startsWith(w) && t.endsWith(w)) t = t.slice(w.length, -w.length).trim();
  t = t.replace(/^\*\*REVIEW_VERDICT:\*\*/, 'REVIEW_VERDICT:');
  return /^REVIEW_VERDICT\s*(?:[:=]|blocking\b)/i.test(t) ? t : null;
}

/** Each line of a reply, marked when it is a verdict attempt outside a code fence. */
function scan(output: string): Array<{ line: string; attempt: string | null }> {
  let fence: string | null = null;
  return output.replace(/\r\n/g, '\n').split('\n').map(line => {
    const f = FENCE.exec(line)?.[1];
    if (f && (fence === null || f[0] === fence[0])) { fence = fence === null ? f : null; return { line, attempt: null }; }
    return { line, attempt: fence === null ? verdictAttempt(line) : null };
  });
}

export function parseVerdict(output: string): Verdict {
  const attempts = [...new Set(scan(output).flatMap(l => (l.attempt === null ? [] : [l.attempt])))];
  if (!attempts.length) return { state: 'missing' };
  if (attempts.length > 1) return { state: 'malformed', why: `${attempts.length} different REVIEW_VERDICT lines` };
  const m = GRAMMAR.exec(attempts[0]!);
  if (!m) return { state: 'malformed', why: `not REVIEW_VERDICT: blocking=<n>[ at=<path>:<line>,...]: ${JSON.stringify(attempts[0]!.slice(0, 120))}` };
  const blocking = Number(m[1]);
  if (blocking > 99) return { state: 'malformed', why: `blocking=${blocking} is over 99` };
  const at = m[2] ? m[2].split(',') : [];
  if (at.some(a => !LOCUS.test(a))) return { state: 'malformed', why: `at= holds something other than <path>:<line>: ${m[2]}` };
  if (at.length > blocking) return { state: 'malformed', why: `at= names ${at.length} locations for blocking=${blocking}` };
  return { state: 'valid', blocking, at };
}

/**
 * The reply with every well-formed verdict line outside a code fence removed, so the line never joins or colours a neighbouring
 * finding. A malformed attempt stays in the text, so a finding written on that line is still parsed and never lost.
 */
export const withoutVerdictLines = (output: string) => scan(output).filter(l => l.attempt === null || !GRAMMAR.test(l.attempt)).map(l => l.line).join('\n');
