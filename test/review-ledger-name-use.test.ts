/**
 * A severity word that a reader uses as the name of something in the code under review is no severity (GSTA-711). On a /ship
 * review of #4612 the native adversarial reader wrote "In the redact-doc HIGH and scanner-failure branches" and "runs after the HIGH
 * branch" about redact-doc's HIGH exit path, and both lines collected as HIGH findings the lead could not lower, beside the reply's real
 * findings, which each state Severity: Medium or Low. Such a line now collects at INFORMATIONAL; a severity word that rates a finding
 * still collects as written.
 */
import { describe, expect, test } from 'bun:test';
import { parseFindings } from '../lib/review-ledger';

const CAPTURED_4612_NATIVE = [
  'REVIEWED_TREE: e92bbfcdb1cd8727b991a3800c2e21f094f50d4c /workspace/gstack',
  'REVIEW_VERDICT: blocking=0',
  '',
  'I found nothing that blocks the merge.',
  '',
  '**What I reviewed and checked**',
  '- Every unforced `rm` on a required file follows a guard that proves the file exists:',
  '  - In the redact-doc HIGH and scanner-failure branches, `[ -s "$REDACT_FILE" ]` runs before the scan, so exit codes 3 and 1 are kept.',
  '  - The brief, feedback and prompt files are all checked with `-s` first.',
  '',
  '**Findings**',
  '',
  '1. `gstack-upgrade/SKILL.md.tmpl:280`: the vendored-sync removal now hides every failure. FIXABLE. Severity: Medium. Blocks: no.',
  '',
  '3. Unforced `rm` on files that may already be gone now prints errors. Three cases:',
  '   - The redact-doc cleanup at `scripts/resolvers/redact-doc.ts:112` runs after the HIGH branch has already removed `REDACT_FILE`.',
  '',
  '   No data or exit gate depends on these lines. FIXABLE: add `2>/dev/null || true`. Severity: Low. Blocks: no.',
].join('\n');

const label = (line: string) => parseFindings('red-team', line).map(f => f.label);

describe('a severity word naming code is no severity (GSTA-711)', () => {
  test('the captured #4612 reply: the two lines quoting the HIGH branch collect at INFORMATIONAL, the real findings at their fields', () => {
    expect(parseFindings('adversarial-native', CAPTURED_4612_NATIVE).map(f => [f.label, f.raw.slice(0, 30)])).toEqual([
      ['INFORMATIONAL', '- In the redact-doc HIGH and s'],
      ['Medium', '1. `gstack-upgrade/SKILL.md.tm'],
      ['INFORMATIONAL', '- The redact-doc cleanup at `s'],
      ['Low', 'No data or exit gate depends o'],
    ]);
  });

  test('negative controls: CRITICAL, and a severity word that rates a finding, leads, stands apart or is spelled as prose, keep their label', () => {
    for (const [line, want] of [
      ['- the HIGH finding above still stands', ['HIGH']],
      ['- HIGH: the auth check is skipped at auth.ts:9', ['HIGH']],
      ['- The HIGH branch drops the token check, so this is HIGH.', ['HIGH']],
      ['- the CRITICAL fix is covered by the new test', ['CRITICAL']],
      ['- Unauthenticated input reaches the CRITICAL write path.', ['CRITICAL']],
      ['- the LOW risk path is fine', ['LOW']],
      ['- the High branch drops the token check', ['High']],
      ['- the HIGH branch drops the token check. Blocks: yes', ['CRITICAL']],
      ['- the MEDIUM and LOW tiers both skip the check', ['INFORMATIONAL']],
      ['- the HIGH and CRITICAL write paths drop the auth check (store.ts:40)', ['CRITICAL']],
      ['- the HIGH and P0 paths skip validation at store.ts:40', ['P0']],
      ['- The HIGH and CRITICAL vulnerabilities remain unresolved', ['CRITICAL']],
      ['- the HIGH vulnerability in auth.ts:9 is still open', ['HIGH']],
      ['- There is the HIGH chance of a torn write that loses data at store.ts:40', ['HIGH']],
    ] as const) expect([line, label(line)]).toEqual([line, [...want]]);
  });
});
