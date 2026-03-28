/**
 * Integration test for the design comparison board feedback loop.
 *
 * Tests the DOM polling pattern that plan-design-review, office-hours,
 * and design-consultation use to read user feedback from the comparison board.
 *
 * Flow: generate board HTML → open in browser → verify DOM elements →
 *       simulate user interaction → verify structured JSON feedback.
 *
 * No LLM involved — this is a deterministic functional test.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { BrowserManager } from '../src/browser-manager';
import { handleReadCommand } from '../src/read-commands';
import { handleWriteCommand } from '../src/write-commands';
import { generateCompareHtml } from '../../design/src/compare';
import * as fs from 'fs';
import * as path from 'path';

let bm: BrowserManager;
let boardUrl: string;
let server: ReturnType<typeof Bun.serve>;
let tmpDir: string;

// Create a minimal 1x1 pixel PNG for test variants
function createTestPng(filePath: string): void {
  // Minimal valid PNG: 1x1 red pixel
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/58BAwAI/AL+hc2rNAAAAABJRU5ErkJggg==',
    'base64'
  );
  fs.writeFileSync(filePath, png);
}

beforeAll(async () => {
  // Create test PNG files
  tmpDir = '/tmp/compare-board-test-' + Date.now();
  fs.mkdirSync(tmpDir, { recursive: true });

  createTestPng(path.join(tmpDir, 'variant-A.png'));
  createTestPng(path.join(tmpDir, 'variant-B.png'));
  createTestPng(path.join(tmpDir, 'variant-C.png'));

  // Generate comparison board HTML using the real compare module
  const html = generateCompareHtml([
    path.join(tmpDir, 'variant-A.png'),
    path.join(tmpDir, 'variant-B.png'),
    path.join(tmpDir, 'variant-C.png'),
  ]);

  // Serve the board via HTTP (browse blocks file:// URLs for security)
  server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    },
  });
  boardUrl = `http://localhost:${server.port}`;

  // Launch browser and navigate to the board
  bm = new BrowserManager();
  await bm.launch();
  await handleWriteCommand('goto', [boardUrl], bm);
});

afterAll(() => {
  try { server.stop(); } catch {}
  fs.rmSync(tmpDir, { recursive: true, force: true });
  setTimeout(() => process.exit(0), 500);
});

// ─── DOM Structure ──────────────────────────────────────────────

describe('Comparison board DOM structure', () => {
  test('has hidden status element', async () => {
    const status = await handleReadCommand('js', [
      'document.getElementById("status").textContent'
    ], bm);
    expect(status).toBe('');
  });

  test('has hidden feedback-result element', async () => {
    const result = await handleReadCommand('js', [
      'document.getElementById("feedback-result").textContent'
    ], bm);
    expect(result).toBe('');
  });

  test('has submit button', async () => {
    const exists = await handleReadCommand('js', [
      '!!document.getElementById("submit-btn")'
    ], bm);
    expect(exists).toBe('true');
  });

  test('has regenerate button', async () => {
    const exists = await handleReadCommand('js', [
      '!!document.getElementById("regen-btn")'
    ], bm);
    expect(exists).toBe('true');
  });

  test('has 3 variant cards', async () => {
    const count = await handleReadCommand('js', [
      'document.querySelectorAll(".variant").length'
    ], bm);
    expect(count).toBe('3');
  });

  test('has pick radio buttons for each variant', async () => {
    const count = await handleReadCommand('js', [
      'document.querySelectorAll("input[name=\\"preferred\\"]").length'
    ], bm);
    expect(count).toBe('3');
  });

  test('has star ratings for each variant', async () => {
    const count = await handleReadCommand('js', [
      'document.querySelectorAll(".stars").length'
    ], bm);
    expect(count).toBe('3');
  });
});

// ─── Submit Flow ────────────────────────────────────────────────

describe('Submit feedback flow', () => {
  test('submit without interaction returns empty preferred', async () => {
    // Reset page state
    await handleWriteCommand('goto', [boardUrl], bm);

    // Click submit without picking anything
    await handleReadCommand('js', [
      'document.getElementById("submit-btn").click()'
    ], bm);

    // Status should be "submitted"
    const status = await handleReadCommand('js', [
      'document.getElementById("status").textContent'
    ], bm);
    expect(status).toBe('submitted');

    // Read feedback JSON
    const raw = await handleReadCommand('js', [
      'document.getElementById("feedback-result").textContent'
    ], bm);
    const feedback = JSON.parse(raw);
    expect(feedback.preferred).toBeNull();
    expect(feedback.regenerated).toBe(false);
    expect(feedback.ratings).toBeDefined();
  });

  test('submit with pick + rating + comment returns structured JSON', async () => {
    // Fresh page
    await handleWriteCommand('goto', [boardUrl], bm);

    // Pick variant B
    await handleReadCommand('js', [
      'document.querySelectorAll("input[name=\\"preferred\\"]")[1].click()'
    ], bm);

    // Rate variant A: 4 stars (click the 4th star)
    await handleReadCommand('js', [
      'document.querySelectorAll(".stars")[0].querySelectorAll(".star")[3].click()'
    ], bm);

    // Rate variant B: 5 stars
    await handleReadCommand('js', [
      'document.querySelectorAll(".stars")[1].querySelectorAll(".star")[4].click()'
    ], bm);

    // Add comment on variant A
    await handleReadCommand('js', [
      'document.querySelectorAll(".feedback-input")[0].value = "Good spacing but wrong colors"'
    ], bm);

    // Add overall feedback
    await handleReadCommand('js', [
      'document.getElementById("overall-feedback").value = "Go with B, make the CTA bigger"'
    ], bm);

    // Submit
    await handleReadCommand('js', [
      'document.getElementById("submit-btn").click()'
    ], bm);

    // Verify status
    const status = await handleReadCommand('js', [
      'document.getElementById("status").textContent'
    ], bm);
    expect(status).toBe('submitted');

    // Read and verify structured feedback
    const raw = await handleReadCommand('js', [
      'document.getElementById("feedback-result").textContent'
    ], bm);
    const feedback = JSON.parse(raw);

    expect(feedback.preferred).toBe('B');
    expect(feedback.ratings.A).toBe(4);
    expect(feedback.ratings.B).toBe(5);
    expect(feedback.comments.A).toBe('Good spacing but wrong colors');
    expect(feedback.overall).toBe('Go with B, make the CTA bigger');
    expect(feedback.regenerated).toBe(false);
  });

  test('submit button is disabled after submission', async () => {
    const disabled = await handleReadCommand('js', [
      'document.getElementById("submit-btn").disabled'
    ], bm);
    expect(disabled).toBe('true');
  });

  test('success message is visible after submission', async () => {
    const display = await handleReadCommand('js', [
      'document.getElementById("success-msg").style.display'
    ], bm);
    expect(display).toBe('block');
  });
});

// ─── Regenerate Flow ────────────────────────────────────────────

describe('Regenerate flow', () => {
  test('regenerate button sets status to "regenerate"', async () => {
    // Fresh page
    await handleWriteCommand('goto', [boardUrl], bm);

    // Click "Totally different" chiclet then regenerate
    await handleReadCommand('js', [
      'document.querySelector(".regen-chiclet[data-action=\\"different\\"]").click()'
    ], bm);
    await handleReadCommand('js', [
      'document.getElementById("regen-btn").click()'
    ], bm);

    const status = await handleReadCommand('js', [
      'document.getElementById("status").textContent'
    ], bm);
    expect(status).toBe('regenerate');

    // Verify regenerate action in feedback
    const raw = await handleReadCommand('js', [
      'document.getElementById("feedback-result").textContent'
    ], bm);
    const feedback = JSON.parse(raw);
    expect(feedback.regenerated).toBe(true);
    expect(feedback.regenerateAction).toBe('different');
  });

  test('"More like this" sets regenerate with variant reference', async () => {
    // Fresh page
    await handleWriteCommand('goto', [boardUrl], bm);

    // Click "More like this" on variant B
    await handleReadCommand('js', [
      'document.querySelectorAll(".more-like-this")[1].click()'
    ], bm);

    const status = await handleReadCommand('js', [
      'document.getElementById("status").textContent'
    ], bm);
    expect(status).toBe('regenerate');

    const raw = await handleReadCommand('js', [
      'document.getElementById("feedback-result").textContent'
    ], bm);
    const feedback = JSON.parse(raw);
    expect(feedback.regenerated).toBe(true);
    expect(feedback.regenerateAction).toBe('more_like_B');
  });

  test('regenerate with custom text', async () => {
    // Fresh page
    await handleWriteCommand('goto', [boardUrl], bm);

    // Type custom regeneration text
    await handleReadCommand('js', [
      'document.getElementById("regen-custom-input").value = "V3 layout with V1 colors"'
    ], bm);

    // Click regenerate (no chiclet selected = custom)
    await handleReadCommand('js', [
      'document.getElementById("regen-btn").click()'
    ], bm);

    const raw = await handleReadCommand('js', [
      'document.getElementById("feedback-result").textContent'
    ], bm);
    const feedback = JSON.parse(raw);
    expect(feedback.regenerated).toBe(true);
    expect(feedback.regenerateAction).toBe('V3 layout with V1 colors');
  });
});

// ─── Agent Polling Pattern ──────────────────────────────────────

describe('Agent polling pattern (simulates what $B eval does)', () => {
  test('status is empty before user action', async () => {
    // Fresh page — simulates agent's first poll
    await handleWriteCommand('goto', [boardUrl], bm);

    const status = await handleReadCommand('js', [
      'document.getElementById("status").textContent'
    ], bm);
    expect(status).toBe('');
  });

  test('full polling cycle: empty → submitted → read JSON', async () => {
    await handleWriteCommand('goto', [boardUrl], bm);

    // Poll 1: empty (user hasn't acted)
    const poll1 = await handleReadCommand('js', [
      'document.getElementById("status").textContent'
    ], bm);
    expect(poll1).toBe('');

    // User acts: pick A, submit
    await handleReadCommand('js', [
      'document.querySelectorAll("input[name=\\"preferred\\"]")[0].click()'
    ], bm);
    await handleReadCommand('js', [
      'document.getElementById("submit-btn").click()'
    ], bm);

    // Poll 2: submitted
    const poll2 = await handleReadCommand('js', [
      'document.getElementById("status").textContent'
    ], bm);
    expect(poll2).toBe('submitted');

    // Read feedback (what the agent does after seeing "submitted")
    const raw = await handleReadCommand('js', [
      'document.getElementById("feedback-result").textContent'
    ], bm);
    const feedback = JSON.parse(raw);
    expect(feedback.preferred).toBe('A');
    expect(typeof feedback.ratings).toBe('object');
    expect(typeof feedback.comments).toBe('object');
  });
});
