/** Review-specific completion evidence, separate from provider transport success. */
export type OutsideGate = 'review' | 'structured' | 'spec';
export function validateOutsideReview(text: string, gate: OutsideGate): { completed: boolean; reason?: string; score?: number; gate?: 'pass' | 'fail' } {
  if (!text.trim()) return { completed: false, reason: 'empty response' };
  // "I cannot find any issues" is a legitimate clean conclusion. Match a
  // refused/unavailable review, not every use of a negative auxiliary verb.
  if (/\b(?:(?:I (?:cannot|can't|won't|will not|am unable to)|I'm unable to)\s+(?:review|analy[sz]e|evaluate|assess|inspect|access|complete|perform|provide|assist|help|proceed)|unable to (?:review|analy[sz]e)|I must (?:decline|refuse))\b/i.test(text)) return { completed: false, reason: 'review refused' };
  if (gate === 'spec') {
    const scores = [...text.matchAll(/^SCORE:[\t ]*(10|[0-9])[\t ]*\r?$/gm)];
    const ambiguities = [...text.matchAll(/^AMBIGUITIES:[\t ]*(\S[^\r\n]*)\r?$/gm)];
    if (scores.length !== 1 || ambiguities.length !== 1) return { completed: false, reason: 'missing or invalid SCORE/AMBIGUITIES markers' };
    const score = Number(scores[0][1]);
    return { completed: true, score, gate: score >= 7 ? 'pass' : 'fail' };
  }
  if (gate === 'structured') {
    const plain = plainReview(text);
    const severity = /\[P[0-3]\]|^P[0-3]:/m.test(plain);
    const clear = /\bNO_FINDINGS\b|\bno (?:actionable |significant |new |concrete )?(?:bugs|issues|findings|problems)\b|\b(?:did not|didn't) (?:find|identify) any (?:actionable |new |concrete )?(?:bugs|issues|findings|problems)\b/i.test(text);
    if (!severity && !clear) return { completed: false, reason: 'missing severity or explicit no-findings conclusion' };
    return { completed: true, gate: /\[P1\]|^P1:/m.test(plain) ? 'fail' : 'pass' };
  }
  // Formatting the requested marker in bold, inline code, or a list does not
  // invalidate a completed review. Preserve the explicit action + reason gate.
  const plain = plainReview(text);
  if (!/^Recommendation:[\t ]*[^\r\n]+\bbecause\b[\t ]*\S[^\r\n]+$/im.test(plain)) return { completed: false, reason: 'missing review completion recommendation' };
  return { completed: true };
}
function plainReview(text: string): string {
  return text.split(/\r?\n/).map(line => line.replace(/^[\t ]*(?:#{1,6}[\t ]+|[-+*][\t ]+)?/, '').replace(/[*_`]/g, '')).join('\n');
}
if (import.meta.main) {
  const [gate, path] = process.argv.slice(2);
  if (!['review', 'structured', 'spec'].includes(gate) || !path) { console.error('Usage: outside-review-result.ts review|structured|spec <response-file>'); process.exit(2); }
  try {
    const result = validateOutsideReview(await Bun.file(path).text(), gate as OutsideGate);
    if (!result.completed) { console.error(`Outside review unavailable: ${result.reason}; missing coverage.`); process.exit(1); }
  } catch (error) { console.error(`Outside review unavailable: ${error}`); process.exit(1); }
}
