/**
 * Dial typography.
 *
 * The dial is used at several sizes across the product. Its inner type was
 * fixed in px, so it overflowed the ring wherever a caller asked for a small
 * one. These pin the scaling and, more importantly, pin that the default size
 * still renders exactly as it did.
 */

import { describe, expect, it } from 'vitest';
import { dialTypography } from '@/components/propiq/score-dial';

describe('dialTypography', () => {
  it('leaves the default size exactly as it was drawn', () => {
    expect(dialTypography(132)).toEqual({ scoreFontPx: 30, labelFontPx: 10, showLabel: true });
  });

  it('scales the score with the ring', () => {
    expect(dialTypography(66).scoreFontPx).toBe(15);
    expect(dialTypography(198).scoreFontPx).toBe(45);
  });

  it('drops the caption rather than clipping it once the ring is too small', () => {
    // "PropIQ Score" at 10px tracked is wider than the inner diameter here.
    expect(dialTypography(96).showLabel).toBe(false);
    expect(dialTypography(110).showLabel).toBe(true);
  });

  it('never renders type too small to read', () => {
    expect(dialTypography(24).labelFontPx).toBeGreaterThanOrEqual(8);
  });
});
