/**
 * Welcome page E2E test — verifies the sidebar arrow hint and key elements
 * render correctly when the welcome page is served via HTTP.
 *
 * Spins up a real Bun.serve, fetches the HTML, and parses it to verify
 * the sidebar prompt arrow, feature cards, and branding are present.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

const WELCOME_PATH = path.join(import.meta.dir, '../src/welcome.html');
const welcomeHtml = fs.readFileSync(WELCOME_PATH, 'utf-8');

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;

beforeAll(() => {
  // Serve the welcome page exactly as the browse server does
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      return new Response(welcomeHtml, {
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server?.stop();
});

describe('welcome page served via HTTP', () => {
  let html: string;

  beforeAll(async () => {
    const resp = await fetch(baseUrl);
    expect(resp.ok).toBe(true);
    expect(resp.headers.get('content-type')).toContain('text/html');
    html = await resp.text();
  });

  // ─── Sidebar arrow hint (the bug that triggered this test) ────────

  test('sidebar prompt arrow is present and visible', () => {
    // The arrow element with class "arrow-right" must exist
    expect(html).toContain('class="arrow-right"');
    // It should contain the right-arrow character (→ = &#x2192;)
    expect(html).toContain('&#x2192;');
  });

  test('sidebar prompt container is visible by default (no hidden class)', () => {
    // The prompt div should NOT have the "hidden" class on initial load
    expect(html).toContain('id="sidebar-prompt"');
    // Check it doesn't start hidden
    expect(html).not.toMatch(/class="sidebar-prompt[^"]*hidden/);
  });

  test('sidebar prompt has instruction text', () => {
    expect(html).toContain('Open the sidebar to get started');
    expect(html).toContain('puzzle piece');
  });

  test('sidebar prompt is positioned on the right side', () => {
    // CSS should position it on the right
    expect(html).toMatch(/\.sidebar-prompt\s*\{[^}]*right:\s*\d+px/);
  });

  test('arrow has nudge animation', () => {
    expect(html).toContain('@keyframes nudge');
    expect(html).toMatch(/\.arrow-right\s*\{[^}]*animation:\s*nudge/);
  });

  // ─── Branding ─────────────────────────────────────────────────────

  test('has GStack Browser title and branding', () => {
    expect(html).toContain('<title>GStack Browser</title>');
    expect(html).toContain('GStack Browser');
  });

  test('has amber dot logo', () => {
    expect(html).toContain('class="logo-dot"');
    expect(html).toContain('class="logo-text"');
  });

  // ─── Feature cards ────────────────────────────────────────────────

  test('has all six feature cards', () => {
    expect(html).toContain('Talk to the sidebar');
    expect(html).toContain('Or use your main agent');
    expect(html).toContain('Import your cookies');
    expect(html).toContain('Clean up any page');
    expect(html).toContain('Smart screenshots');
    expect(html).toContain('Modify any page');
  });

  // ─── Try it section ───────────────────────────────────────────────

  test('has try-it section with example prompts', () => {
    expect(html).toContain('Try it now');
    expect(html).toContain('news.ycombinator.com');
  });

  // ─── Extension auto-hide ──────────────────────────────────────────

  test('hides sidebar prompt when extension is detected', () => {
    // Should listen for the extension-ready event
    expect(html).toContain("'gstack-extension-ready'");
    // Should add 'hidden' class to sidebar-prompt
    expect(html).toContain("classList.add('hidden')");
  });

  test('does NOT auto-hide based on extension detection alone', () => {
    // The arrow should only hide when the sidebar actually opens,
    // not when the content script loads (which happens on every page)
    expect(html).not.toContain('gstack-status-pill');
    expect(html).not.toContain('checkPill');
  });

  // ─── Dark theme ───────────────────────────────────────────────────

  test('uses dark theme colors', () => {
    expect(html).toContain('--base: #0C0C0C');
    expect(html).toContain('--surface: #141414');
  });

  // ─── Left-aligned text ────────────────────────────────────────────

  test('text is left-aligned, not centered', () => {
    expect(html).not.toMatch(/text-align:\s*center/);
  });

  // ─── Footer ───────────────────────────────────────────────────────

  test('has footer with attribution', () => {
    expect(html).toContain('Garry Tan');
    expect(html).toContain('github.com/garrytan/gstack');
  });
});
