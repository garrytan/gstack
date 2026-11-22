/**
 * A fix-check row that read its granted fixes clean still read UNVERIFIED once the owner ruled its deferred findings
 * (GST-3501, gbrain#10036 at 8e0159ab): the blockers it confirmed fixed (action fixed, blocking true) held the row open, and a
 * fixed finding cannot be ruled, so finish printed FIX_CHECK: not counted forever. The row below is GBRA-732's own
 * review-fix-check row, trimmed to the fields reviewFreshness reads.
 */
import { describe, expect, test } from 'bun:test';
import { holdsOpen, reviewFreshness } from '../lib/review-evidence';

const TREE = '2a5e2ee1807a5ef0d58716dd3a45c01297bd92ab';
const finding = (fingerprint: string, action: string, extra: Record<string, unknown> = {}) =>
  ({ fingerprint, severity: 'CRITICAL', blocking: true, kind: 'defect', action, ...extra });
const fixCheckRow = (findings: Record<string, unknown>[]) => ({
  skill: 'review-fix-check', status: 'clean', issues_found: 0, critical: 0, informational: 0, status_source: 'claimed',
  completed: true, converged: true, commit: 'fa9a4537', commit_full: 'fa9a4537df7ad5fb4f05daeb160dd930f7df33be',
  range_base: '879d764c9e006c28e7799c99f7411a6a13939af0', grant: 'a-685e316454ff', tree: TREE, wtree: TREE,
  review_binding: { state: 'verified', start_wtree: TREE, end_wtree: TREE },
  findings,
});
const GBRA_732 = [
  finding('src/core/telemetry/client.ts:547:consent-race', 'fixed', { ledger_id: 'p3/outside-voice#1' }),
  finding('src/cli/main.ts:2864:telemetry-coverage', 'deferred', { ledger_id: 'p3/outside-voice#2' }),
  finding('src/core/telemetry/client.ts:349:attribution', 'deferred', { ledger_id: 'p3/outside-voice#3' }),
  finding('src/core/telemetry/endpoint.ts:18:env-trust', 'fixed', { ledger_id: 'p3/adversarial-native#2' }),
  { fingerprint: 'src/core/telemetry/client.ts:456:fix-check', severity: 'INFORMATIONAL', blocking: false, kind: 'defect', action: 'noted' },
];
const DEFERRED = new Set(['src/cli/main.ts:2864:telemetry-coverage', 'src/core/telemetry/client.ts:349:attribution']);

describe('a fixed blocker no longer holds a ruled fix-check row open (GST-3501)', () => {
  // Value: protects=a granted fix-check that confirmed its blockers fixed counts once the owner rules the deferred ones;
  //   fails_when=holdsOpen keeps a fixed blocking finding open, so withoutRuledNotes never clears the row and it reads
  //   UNVERIFIED (gbrain#10036: FIX_CHECK: not counted after every finding was fixed or ruled); why_new=no ruled-row case
  //   mixed fixed and deferred blockers; seam=reviewFreshness -> withoutRuledNotes -> holdsOpen; no_claim=finish's chain walk
  test("GBRA-732's fix-check row reads CURRENT once its two deferred blockers are ruled", () => {
    expect(reviewFreshness(fixCheckRow(GBRA_732), TREE, DEFERRED)).toEqual({ status: 'CURRENT', reason: 'completed clean pass on unchanged content' });
  });

  // Value: protects=rulings still have to cover every blocker that is not fixed; fails_when=dropping the fixed exemption's
  //   action check lets an unruled deferred or open blocker clear with the rest; seam=holdsOpen; no_claim=gate findings
  test('an unruled deferred blocker still holds the row open, and an open or skipped blocker still needs a ruling', () => {
    expect(reviewFreshness(fixCheckRow(GBRA_732), TREE, new Set(['src/cli/main.ts:2864:telemetry-coverage']))?.status).toBe('UNVERIFIED');
    for (const action of ['fixed', 'auto-fixed']) expect(holdsOpen(finding('a.ts:1:x', action))).toBe(false);
    for (const action of ['open', 'deferred', 'noted', 'skipped']) expect(holdsOpen(finding('a.ts:1:x', action))).toBe(true);
  });
});
