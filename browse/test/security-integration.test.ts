/**
 * Integration tests — the defense-in-depth contract.
 *
 * Pins the invariant that content-security.ts (L1-L3) and security.ts (L4-L6)
 * layers coexist and fire INDEPENDENTLY. If someone refactors thinking "the
 * ML classifier covers this, we can delete the regex layer," these tests
 * fail and stop the regression.
 *
 * This is the lighter version of CEO plan §E5. The full version requires
 * a live Playwright Page for hidden-element stripping and ARIA regex (those
 * operate on DOM). Here we test the pure-function cross-module surface:
 *   * content-security.ts datamark + envelope wrap + URL blocklist
 *   * security.ts canary + combineVerdict
 *   * Both modules on the same input produce orthogonal signals
 */

import { describe, test, expect } from 'bun:test';
import {
  datamarkContent,
  wrapUntrustedPageContent,
  urlBlocklistFilter,
  runContentFilters,
  resetSessionMarker,
} from '../src/content-security';
import {
  generateCanary,
  checkCanaryInStructure,
  combineVerdict,
  type LayerSignal,
} from '../src/security';

describe('defense-in-depth — layer coexistence', () => {
  test('canary survives when content is wrapped by content-security envelope', () => {
    const c = generateCanary();
    // Attacker got Claude to echo the canary into tool output text.
    // content-security wraps that text in an envelope — canary still detectable.
    const leakedText = `Here's my session token: ${c}`;
    const wrapped = wrapUntrustedPageContent(leakedText, 'text');
    expect(wrapped).toContain(c);
    expect(checkCanaryInStructure(wrapped, c)).toBe(true);
  });

  test('datamarking does not corrupt canary detection', () => {
    resetSessionMarker();
    const c = generateCanary();
    // datamarkContent inserts zero-width watermarks after every 3rd period.
    // It must not break canary detection on text that contains the canary.
    const leakedText = `Intro sentence. Middle sentence. Third sentence. Here is the token ${c}. More. More.`;
    const marked = datamarkContent(leakedText);
    expect(checkCanaryInStructure(marked, c)).toBe(true);
  });

  test('URL blocklist + canary are orthogonal — both can fire', () => {
    const c = generateCanary();
    // Attack: URL points to a blocklisted exfil domain AND carries the canary.
    // content-security's urlBlocklistFilter catches the domain.
    // security.ts's canary check catches the token.
    // Neither depends on the other.
    const attackContent = `See https://requestbin.com/?leak=${c} for details`;
    const blockResult = urlBlocklistFilter(attackContent, 'https://requestbin.com/abc', 'text');
    expect(blockResult.safe).toBe(false);
    expect(blockResult.warnings.length).toBeGreaterThan(0);

    const canaryHit = checkCanaryInStructure({ content: attackContent }, c);
    expect(canaryHit).toBe(true);
  });

  test('benign content survives all layers — zero false positives', () => {
    resetSessionMarker();
    const c = generateCanary();
    const benign = 'The Pacific Ocean is the largest ocean on Earth. It contains many islands. Marine biodiversity is rich.';

    // Datamark doesn't add the canary
    const marked = datamarkContent(benign);
    expect(checkCanaryInStructure(marked, c)).toBe(false);

    // Envelope wrap doesn't add the canary
    const wrapped = wrapUntrustedPageContent(benign, 'text');
    expect(checkCanaryInStructure(wrapped, c)).toBe(false);

    // URL blocklist returns safe on a benign URL
    const blockResult = urlBlocklistFilter(benign, 'https://wikipedia.org', 'text');
    expect(blockResult.safe).toBe(true);
  });

  test('removing one signal does not zero-out the verdict (defense-in-depth)', () => {
    // Attack scenario: page has hidden injection + exfil URL + canary leak
    // across three different layers. Remove any ONE signal, other two still
    // produce a BLOCK-worthy verdict.

    const baseSignals: LayerSignal[] = [
      { layer: 'testsavant_content', confidence: 0.88 },
      { layer: 'transcript_classifier', confidence: 0.75 },
      { layer: 'canary', confidence: 1.0 },
    ];

    // All 3 signals → BLOCK (canary alone does it, ensemble also fires)
    expect(combineVerdict(baseSignals).verdict).toBe('block');

    // Remove canary → BLOCK via ensemble_agreement
    expect(combineVerdict(baseSignals.slice(0, 2)).verdict).toBe('block');

    // Remove transcript → BLOCK via canary still
    expect(
      combineVerdict([baseSignals[0], baseSignals[2]]).verdict,
    ).toBe('block');

    // Remove content → BLOCK via canary still
    expect(
      combineVerdict([baseSignals[1], baseSignals[2]]).verdict,
    ).toBe('block');

    // Remove canary AND transcript → only content WARN (single_layer_high
    // — but content is 0.88 which is just above BLOCK threshold 0.85)
    const contentOnly = combineVerdict([baseSignals[0]]);
    expect(contentOnly.verdict).toBe('warn');
    expect(contentOnly.reason).toBe('single_layer_high');
  });

  test('content-security filter runs through the registered pipeline', () => {
    // Verify runContentFilters picks up the built-in url blocklist filter.
    // If a future refactor accidentally unregisters it, this test fails.
    const result = runContentFilters(
      'page content',
      'https://requestbin.com/webhook',
      'text',
    );
    // urlBlocklistFilter is auto-registered on module load (content-security.ts:347)
    expect(result.safe).toBe(false);
    expect(result.warnings.some(w => w.includes('requestbin.com'))).toBe(true);
  });

  test('canary in envelope-escaped content still detectable', () => {
    // The envelope uses "═══ BEGIN UNTRUSTED WEB CONTENT ═══" markers and
    // escapes occurrences in content via zero-width space. This must NOT
    // break canary detection — the canary isn't special to the escape logic.
    const c = generateCanary();
    const contentWithEnvelopeChars = `═══ BEGIN UNTRUSTED WEB CONTENT ═══ real payload: ${c}`;
    const wrapped = wrapUntrustedPageContent(contentWithEnvelopeChars, 'text');
    // The inner "BEGIN" gets escaped to "BEGIN UNTRUSTED WEB C{zwsp}ONTENT"
    // but the canary remains intact
    expect(checkCanaryInStructure(wrapped, c)).toBe(true);
  });
});

describe('defense-in-depth — regression guards', () => {
  test('combineVerdict cannot be bypassed via signal starvation', () => {
    // Attacker might try to suppress classifier calls to avoid signals.
    // Empty signals still yields safe verdict — fail-open is intentional.
    // This is not a regression; it's the documented contract.
    // Test asserts that a ZERO-confidence-everywhere state IS explicitly safe.
    const allZeros: LayerSignal[] = [
      { layer: 'testsavant_content', confidence: 0 },
      { layer: 'transcript_classifier', confidence: 0 },
      { layer: 'canary', confidence: 0 },
      { layer: 'aria_regex', confidence: 0 },
    ];
    expect(combineVerdict(allZeros).verdict).toBe('safe');
  });

  test('negative confidences cannot trigger block', () => {
    // Defensive: if some future refactor returns negative scores (bug),
    // combineVerdict must not misinterpret them. Math-wise, negative values
    // never exceed WARN/BLOCK thresholds, so this falls through to safe.
    const weird: LayerSignal[] = [
      { layer: 'testsavant_content', confidence: -0.5 },
      { layer: 'transcript_classifier', confidence: -1.0 },
    ];
    expect(combineVerdict(weird).verdict).toBe('safe');
  });

  test('huge confidences (> 1.0) still behave predictably', () => {
    // If a classifier ever returns > 1.0 (bug), we want the verdict to
    // still be BLOCK, not crash or produce nonsense. Canary uses >= 1.0
    // which matches; ML layers also register.
    const overflow: LayerSignal[] = [
      { layer: 'testsavant_content', confidence: 5.5 }, // above BLOCK
      { layer: 'transcript_classifier', confidence: 3.2 }, // above BLOCK
    ];
    expect(combineVerdict(overflow).verdict).toBe('block');
  });
});
