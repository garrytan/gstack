/**
 * GST-3562 Q: /ship's refusal codes may only shrink. On 2026-11-22, 25 of 67 merged gstack PRs were gstack repairing its own gates,
 * so a new refusal in /ship's review, receipt, pregate or queue code needs a stated R56 reason (evidence that it helps, or a
 * reason and a plan to measure it) in test/fixtures/ship-refusal-codes.json; a code that leaves the source leaves the list.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const LIST = path.join(ROOT, 'test', 'fixtures', 'ship-refusal-codes.json');
const BASELINE_MAX = 131;
const SOURCES = /^(lib\/(ship-|review-|fix-check-clearing|pr-review-history|approval-record|ci-carry|tree-receipt|restamp)[^/]*\.ts|lib\/pregate\/.*\.ts|crew\/lib\/ship-[^/]*\.ts|bin\/gstack-(ship-[a-z-]+|review-[a-z-]+|pregate|approvals|ci-carry|tree-receipt|restamp))$/;

function walk(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

/** Every `code: 'X'` or `refused('X', …)`-style refusal in /ship's machinery, with the first file that raises it. */
function refusalCodes(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of [...walk('lib'), ...walk('crew/lib'), ...walk('bin')].map(f => f.split(path.sep).join('/')).filter(f => SOURCES.test(f) && !f.endsWith('.test.ts')).sort()) {
    for (const m of fs.readFileSync(path.join(ROOT, file), 'utf8').matchAll(/(?:code: |\b(?:refused|refuse|budgetError|BudgetError|ReviewLogError)\()'([A-Z][A-Z0-9_]+)'/g)) if (!found.has(m[1]!)) found.set(m[1]!, file);
  }
  return found;
}

describe('ship refusal-code ratchet (GST-3562 Q)', () => {
  // Value: protects=GST-3562 Q, no new /ship refusal without an R56 reason, and the list shrinks as codes are deleted;
  //   fails_when=a new code: '...' or refused('...')-style refusal appears in /ship's review, receipt, pregate or queue code
  //   without a reason, a new code is filed under the baseline, or a listed code disappears from the source and stays listed;
  //   why_new=GST-3562 Q; seam=the source text; no_claim=that a reason is true
  test('every refusal code is listed, every new one names an R56 reason, the baseline only shrinks, and no listed code is gone', () => {
    const list: { baseline: string[]; codes: Record<string, string> } = JSON.parse(fs.readFileSync(LIST, 'utf8'));
    const listed = new Set([...list.baseline, ...Object.keys(list.codes)]);
    const now = refusalCodes();
    const unlisted = [...now].filter(([c]) => !listed.has(c)).map(([c, f]) => `${c} (${f}): add it to codes in test/fixtures/ship-refusal-codes.json with its R56 reason`);
    const unreasoned = Object.entries(list.codes).filter(([, why]) => !/^R56: .{20,}/.test(why)).map(([c]) => `${c}: a new code's reason starts with "R56: " and says what evidence or measurement plan admits it`);
    const grown = list.baseline.length > BASELINE_MAX ? [`baseline grew to ${list.baseline.length} of ${BASELINE_MAX}: a new code goes in codes with its R56 reason`] : [];
    const gone = [...listed].filter(c => !now.has(c)).map(c => `${c}: no longer raised, so remove it from the list`);
    expect([...unlisted, ...unreasoned, ...grown, ...gone]).toEqual([]);
  });
});
