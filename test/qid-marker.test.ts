import { describe, expect, test } from 'bun:test';
import { parseQidMarker } from '../scripts/qid-marker';
import { resolveHintedOptionKey, signalKeyLines } from '../scripts/psychographic-signals';

describe('parseQidMarker (#3442)', () => {
  test('reads a plain marker and strips it', () => {
    expect(parseQidMarker('D1 — Ship? <gstack-qid:ship-test-failure-triage>')).toEqual({ id: 'ship-test-failure-triage', stripped: 'D1 — Ship?' });
  });

  test('reads a signal hint and strips the whole marker', () => {
    expect(parseQidMarker('Add caching? <gstack-qid:plan-ceo-review-add-caching;signal=scope-appetite>')).toEqual({
      id: 'plan-ceo-review-add-caching',
      signal_key: 'scope-appetite',
      stripped: 'Add caching?',
    });
  });

  test('lowercases an uppercase marker', () => {
    expect(parseQidMarker('<gstack-qid:Plan-CEO-X;signal=Scope-Appetite> q')).toMatchObject({ id: 'plan-ceo-x', signal_key: 'scope-appetite' });
  });

  test('no marker returns undefined', () => {
    expect(parseQidMarker('plain question')).toBeUndefined();
  });
});

describe('resolveHintedOptionKey (#3442)', () => {
  test('an exact option key passes through', () => {
    expect(resolveHintedOptionKey('scope-appetite', 'expand')).toBe('expand');
  });

  test('a label that starts with the key words maps to the key', () => {
    expect(resolveHintedOptionKey('scope-appetite', 'B) Reduce scope (recommended)')).toBe('reduce');
    expect(resolveHintedOptionKey('architecture-care', 'Accept risk and move on')).toBe('accept-risk');
  });

  test('a cue-table word never maps, so a yes cannot invert a signal', () => {
    expect(resolveHintedOptionKey('scope-appetite', 'Yes, cut it')).toBeUndefined();
    expect(resolveHintedOptionKey('architecture-care', 'Fix it later')).toBeUndefined();
  });

  test('an unknown signal key maps nothing', () => {
    expect(resolveHintedOptionKey('made-up', 'expand')).toBeUndefined();
  });

  test('signalKeyLines lists every signal with its option keys', () => {
    expect(signalKeyLines()).toContain('architecture-care: fix-now | defer | accept-risk');
  });
});
