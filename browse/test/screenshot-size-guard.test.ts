/**
 * Unit tests for the screenshot size guard (#1214).
 *
 * Verifies that images exceeding 2000px on the longest dimension get
 * downscaled to fit the Anthropic vision API cap, while images already
 * inside the cap pass through untouched.
 *
 * Integration with the three callsites (snapshot.ts, meta-commands.ts,
 * write-commands.ts) is exercised by the existing browse E2E suite — we
 * don't need to spin up Chromium just to verify the helper. The static
 * invariant test below pins that all three callsites import the guard.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import sharp from 'sharp';
import {
  SCREENSHOT_MAX_DIMENSION_PX,
  guardScreenshotBuffer,
  guardScreenshotPath,
} from '../src/screenshot-size-guard';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'screenshot-guard-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function makePng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .png()
    .toBuffer();
}

describe('guardScreenshotBuffer', () => {
  test('passes through images already within the cap', async () => {
    const input = await makePng(1500, 1800);
    const { buffer, result } = await guardScreenshotBuffer(input);
    expect(result.resized).toBe(false);
    expect(result.width).toBe(1500);
    expect(result.height).toBe(1800);
    expect(buffer).toBe(input); // identity — no re-encode
  });

  test('downscales a 5000px-tall image to fit the cap', async () => {
    const input = await makePng(1200, 5000);
    const { buffer, result } = await guardScreenshotBuffer(input);
    expect(result.resized).toBe(true);
    expect(result.originalHeight).toBe(5000);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(
      SCREENSHOT_MAX_DIMENSION_PX,
    );
    // Aspect ratio preserved.
    expect(result.height / result.width).toBeCloseTo(5000 / 1200, 1);
    // Buffer is a different (smaller) PNG.
    expect(buffer.length).toBeLessThan(input.length);
  });

  test('downscales a 6000px-wide image', async () => {
    const input = await makePng(6000, 1200);
    const { buffer, result } = await guardScreenshotBuffer(input);
    expect(result.resized).toBe(true);
    expect(result.originalWidth).toBe(6000);
    expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(
      SCREENSHOT_MAX_DIMENSION_PX,
    );
    expect(buffer.length).toBeGreaterThan(0);
  });

  test('treats exactly-2000px images as in-bounds (no resize)', async () => {
    const input = await makePng(2000, 1000);
    const { result } = await guardScreenshotBuffer(input);
    expect(result.resized).toBe(false);
  });
});

describe('guardScreenshotPath', () => {
  test('rewrites the file in place when downscale is needed', async () => {
    const filePath = join(tmp, 'tall.png');
    writeFileSync(filePath, await makePng(1200, 5000));
    const result = await guardScreenshotPath(filePath);
    expect(result.resized).toBe(true);
    const written = readFileSync(filePath);
    const meta = await sharp(written).metadata();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(
      SCREENSHOT_MAX_DIMENSION_PX,
    );
  });

  test('leaves the file untouched when already within cap', async () => {
    const filePath = join(tmp, 'short.png');
    const original = await makePng(800, 600);
    writeFileSync(filePath, original);
    const result = await guardScreenshotPath(filePath);
    expect(result.resized).toBe(false);
    const written = readFileSync(filePath);
    expect(written.equals(original)).toBe(true);
  });
});

describe('static invariant: all three full-page callsites import the guard', () => {
  test('snapshot.ts, meta-commands.ts, and write-commands.ts wire the size guard', () => {
    const browseSrc = join(import.meta.dir, '..', 'src');
    const paths = ['snapshot.ts', 'meta-commands.ts', 'write-commands.ts'];
    for (const rel of paths) {
      const content = readFileSync(join(browseSrc, rel), 'utf-8');
      expect(content).toContain('screenshot-size-guard');
    }
  });
});
