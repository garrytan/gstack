import { describe, expect, test } from 'bun:test';
import { parsePrettyScreenshotArgs } from '../src/write-commands';

describe('parsePrettyScreenshotArgs', () => {
  test('treats trailing path after --hide as output path', () => {
    const parsed = parsePrettyScreenshotArgs(['--hide', 'header', '/tmp/case-a.png']);

    expect(parsed.hideSelectors).toEqual(['header']);
    expect(parsed.outputPath).toBe('/tmp/case-a.png');
  });

  test('keeps multiple trailing --hide selectors when no output path is present', () => {
    const parsed = parsePrettyScreenshotArgs(['--hide', 'header', 'footer']);

    expect(parsed.hideSelectors).toEqual(['header', 'footer']);
    expect(parsed.outputPath).toBeUndefined();
  });

  test('handles multiple --hide flags with explicit trailing output path', () => {
    const parsed = parsePrettyScreenshotArgs(['--hide', 'header', '--hide', 'footer', './shot.webp']);

    expect(parsed.hideSelectors).toEqual(['header', 'footer']);
    expect(parsed.outputPath).toBe('./shot.webp');
  });

  test('still honors paths after a later flag', () => {
    const parsed = parsePrettyScreenshotArgs(['--hide', 'header', '--cleanup', '/tmp/case-b.png']);

    expect(parsed.hideSelectors).toEqual(['header']);
    expect(parsed.doCleanup).toBe(true);
    expect(parsed.outputPath).toBe('/tmp/case-b.png');
  });
});
