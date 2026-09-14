/**
 * Tests for the $D gallery command — design history timeline generation.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { generateGalleryHtml } from '../src/gallery';
import * as fs from 'fs';
import * as path from 'path';

let tmpDir: string;

function createTestPng(filePath: string): void {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(filePath, png);
}

beforeAll(() => {
  tmpDir = '/tmp/gallery-test-' + Date.now();
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Gallery generation', () => {
  test('empty directory returns "No history" page', () => {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });

    const html = generateGalleryHtml(emptyDir);
    expect(html).toContain('No design history yet');
    expect(html).toContain('/design-shotgun');
  });

  test('nonexistent directory returns "No history" page', () => {
    const html = generateGalleryHtml('/nonexistent/path');
    expect(html).toContain('No design history yet');
  });

  test('single session with approved variant', () => {
    const sessionDir = path.join(tmpDir, 'designs', 'homepage-20260327');
    fs.mkdirSync(sessionDir, { recursive: true });

    createTestPng(path.join(sessionDir, 'variant-A.png'));
    createTestPng(path.join(sessionDir, 'variant-B.png'));
    createTestPng(path.join(sessionDir, 'variant-C.png'));

    fs.writeFileSync(path.join(sessionDir, 'approved.json'), JSON.stringify({
      approved_variant: 'B',
      feedback: 'Great spacing and colors',
      date: '2026-03-27T12:00:00Z',
      screen: 'homepage',
    }));

    const html = generateGalleryHtml(path.join(tmpDir, 'designs'));
    expect(html).toContain('Design History');
    expect(html).toContain('1 exploration');
    expect(html).toContain('homepage');
    expect(html).toContain('2026-03-27');
    expect(html).toContain('approved');
    expect(html).toContain('Great spacing and colors');
    // Should have 3 variant images (base64)
    expect(html).toContain('data:image/png;base64,');
  });

  test('multiple sessions sorted by date (newest first)', () => {
    const dir = path.join(tmpDir, 'multi');
    const session1 = path.join(dir, 'settings-20260301');
    const session2 = path.join(dir, 'dashboard-20260315');
    fs.mkdirSync(session1, { recursive: true });
    fs.mkdirSync(session2, { recursive: true });

    createTestPng(path.join(session1, 'variant-A.png'));
    createTestPng(path.join(session2, 'variant-A.png'));

    fs.writeFileSync(path.join(session1, 'approved.json'), JSON.stringify({
      approved_variant: 'A', date: '2026-03-01T12:00:00Z',
    }));
    fs.writeFileSync(path.join(session2, 'approved.json'), JSON.stringify({
      approved_variant: 'A', date: '2026-03-15T12:00:00Z',
    }));

    const html = generateGalleryHtml(dir);
    expect(html).toContain('2 explorations');
    // Dashboard (Mar 15) should appear before settings (Mar 1)
    const dashIdx = html.indexOf('dashboard');
    const settingsIdx = html.indexOf('settings');
    expect(dashIdx).toBeLessThan(settingsIdx);
  });

  test('corrupted approved.json is handled gracefully', () => {
    const dir = path.join(tmpDir, 'corrupt');
    const session = path.join(dir, 'broken-20260327');
    fs.mkdirSync(session, { recursive: true });

    createTestPng(path.join(session, 'variant-A.png'));
    fs.writeFileSync(path.join(session, 'approved.json'), 'NOT VALID JSON {{{');

    const html = generateGalleryHtml(dir);
    // Should still render the session, just without any variant marked as approved
    expect(html).toContain('Design History');
    expect(html).toContain('broken');
    // The class "approved" should not appear on any variant div (only in CSS definition)
    expect(html).not.toContain('class="gallery-variant approved"');
  });

  test('session without approved.json still renders', () => {
    const dir = path.join(tmpDir, 'no-approved');
    const session = path.join(dir, 'draft-20260327');
    fs.mkdirSync(session, { recursive: true });

    createTestPng(path.join(session, 'variant-A.png'));
    createTestPng(path.join(session, 'variant-B.png'));

    const html = generateGalleryHtml(dir);
    expect(html).toContain('draft');
    // No variant should be marked as approved
    expect(html).not.toContain('class="gallery-variant approved"');
  });

  test('HTML is self-contained (no external dependencies)', () => {
    const dir = path.join(tmpDir, 'self-contained');
    const session = path.join(dir, 'test-20260327');
    fs.mkdirSync(session, { recursive: true });
    createTestPng(path.join(session, 'variant-A.png'));

    const html = generateGalleryHtml(dir);
    // No external CSS/JS/image links
    expect(html).not.toContain('href="http');
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('<link');
    // All images are base64
    expect(html).toContain('data:image/png;base64,');
  });
});
