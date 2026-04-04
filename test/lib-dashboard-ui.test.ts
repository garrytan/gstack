/**
 * Tests for dashboard UI HTML generation.
 */

import { describe, test, expect } from 'bun:test';
import { getDashboardHTML } from '../supabase/functions/dashboard/ui';

const SUPABASE_URL = 'https://test-project.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.test-anon-key';

describe('getDashboardHTML', () => {
  const html = getDashboardHTML(SUPABASE_URL, ANON_KEY);

  test('returns valid HTML document', () => {
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html');
    expect(html).toContain('</html>');
  });

  test('contains page title', () => {
    expect(html).toContain('<title>gstack Dashboard</title>');
  });

  test('embeds supabase URL', () => {
    expect(html).toContain(SUPABASE_URL);
  });

  test('embeds anon key', () => {
    expect(html).toContain(ANON_KEY);
  });

  test('contains login UI elements', () => {
    expect(html).toContain('Sign in with GitHub');
  });

  test('contains tab navigation', () => {
    expect(html).toContain('Overview');
    expect(html).toContain('Evals');
    expect(html).toContain('Ships');
    expect(html).toContain('Costs');
    expect(html).toContain('Leaderboard');
    expect(html).toContain('QA');
  });

  test('contains auto-refresh logic', () => {
    expect(html).toContain('visibilitychange');
    expect(html).toContain('setInterval');
  });

  test('contains PKCE auth code', () => {
    expect(html).toContain('code_challenge');
    expect(html).toContain('code_verifier');
  });

  test('uses textContent for XSS prevention', () => {
    expect(html).toContain('textContent');
  });

  test('contains dark theme styling', () => {
    expect(html).toContain('#0a0a0a');
  });

  test('contains SVG chart elements', () => {
    expect(html).toContain('svg');
  });

  test('fetches from eval_runs endpoint', () => {
    expect(html).toContain('eval_runs');
  });

  test('fetches from ship_logs endpoint', () => {
    expect(html).toContain('ship_logs');
  });

  test('fetches from sync_heartbeats for who\'s online', () => {
    expect(html).toContain('sync_heartbeats');
  });

  test('contains sign out functionality', () => {
    expect(html).toContain('Sign out');
  });
});
