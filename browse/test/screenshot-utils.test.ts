/**
 * Unit tests for the screenshot font pre-flight helper.
 *
 * `waitForFonts` lets `document.fonts.ready` settle before a capture so text
 * renders in the intended typeface instead of a fallback (the "bad fonts" seen
 * from qa / design-review / responsive screenshots). The contract is
 * best-effort: it must pass the page a numeric cap and must never throw, since
 * a font wait failing should not abort the screenshot.
 *
 * The real Chromium capture paths are exercised by the browse E2E suite — we
 * don't spin up a browser here. The static invariant below pins that every
 * full-page callsite waits for fonts.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { waitForFonts } from '../src/screenshot-utils';

// Minimal Page stub — only `evaluate` is touched by the helper.
function fakePage(evaluate: (fn: unknown, arg: unknown) => Promise<unknown>) {
  return { evaluate } as any;
}

describe('waitForFonts', () => {
  test('awaits page.evaluate with a numeric timeout argument', async () => {
    let seenArg: unknown;
    await waitForFonts(
      fakePage(async (_fn, arg) => {
        seenArg = arg;
        return undefined;
      }),
      1234,
    );
    expect(seenArg).toBe(1234);
  });

  test('defaults to a finite timeout when none is given', async () => {
    let seenArg: unknown;
    await waitForFonts(
      fakePage(async (_fn, arg) => {
        seenArg = arg;
        return undefined;
      }),
    );
    expect(typeof seenArg).toBe('number');
    expect(Number.isFinite(seenArg as number)).toBe(true);
  });

  test('never throws when evaluate rejects (navigation/teardown race)', async () => {
    await expect(
      waitForFonts(
        fakePage(() => Promise.reject(new Error('Execution context was destroyed'))),
        10,
      ),
    ).resolves.toBeUndefined();
  });
});

describe('static invariant: every full-page callsite waits for fonts', () => {
  test('snapshot.ts, meta-commands.ts, and write-commands.ts wire waitForFonts', () => {
    const browseSrc = join(import.meta.dir, '..', 'src');
    const paths = ['snapshot.ts', 'meta-commands.ts', 'write-commands.ts'];
    for (const rel of paths) {
      const content = readFileSync(join(browseSrc, rel), 'utf-8');
      expect(content).toContain('waitForFonts');
    }
  });
});
